// SessionFeedDO — the per-business realtime fan-out for the session sidebar
// (ARC-1322). Keyed by `businessId`, it holds the sidebar WebSocket sockets for
// every member of a business and broadcasts each published `FeedDelta` to them,
// gated per recipient by repo access.
//
// Layering (each piece reasoned about in isolation):
//   - `/feed/ws`      accept a subscriber socket and (re)seed that user's
//                     accessible-repo set into DO SQLite.
//   - `/feed/publish` fan a delta out: for each open socket, call the pure
//                     `decideFeedDelivery` gate against the sender's stored
//                     repo set and send only on `deliver: true`.
//   - the gate (`feed-gate.ts`) owns all authorization; this DO owns none.
//
// The feed is advisory: a missed delta is recovered by the frontend's
// refetch-on-(re)connect plus existing focus/poll. So there is no recovery
// cursor or event log — just a per-user repo-access snapshot, refreshed on
// every connect and survivable across hibernation.

import * as Sentry from "@sentry/cloudflare";
import { DurableObject } from "cloudflare:workers";

import type { FeedDelta } from "../../../../shared/types/session-feed.js";
import type { Logger, LogLevel } from "../logger";
import { createLogger } from "../logger";
import { emitFeedDeliveryMetrics } from "../observability/feed-metrics";
import { resolveSentryRuntimeOptions } from "../observability/sentry";
import type { Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { decideFeedDelivery } from "./feed-gate";

const FEED_TAG = "feed";
const UID_TAG_PREFIX = "uid:";
const WEBSOCKET_READY_STATE_OPEN = 1;

class SessionFeedDOBase extends DurableObject<Env> {
  private readonly log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.log = createLogger({
      level: (env.LOG_LEVEL as LogLevel) || undefined,
      bindings: { component: "session-feed-do" },
    });
    // Idempotent schema init; the table is the only persistent state.
    void ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private ensureSchema(): void {
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS feed_repo_access (
        user_id TEXT PRIMARY KEY,
        repos_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/feed/ws") {
      return this.handleFeedWebSocket(request);
    }
    if (request.method === "POST" && url.pathname === "/feed/publish") {
      return this.handlePublish(request);
    }
    return jsonErrorResponse("Not found", 404);
  }

  /**
   * Accept a sidebar subscriber. The caller (the `/api/users/me/feed/ws` route)
   * has already authenticated the user and resolved their accessible repos; we
   * persist that snapshot keyed by user id (deduping across tabs, surviving
   * hibernation) and tag the socket with the user id for gating on publish.
   */
  private handleFeedWebSocket(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonErrorResponse("Expected websocket upgrade request", 426);
    }
    const userId = request.headers.get("x-auth-user-id");
    if (!userId) {
      return jsonErrorResponse("Missing user", 400);
    }

    const repos = this.parseReposHeader(request.headers.get("x-feed-repos"));
    this.upsertRepoAccess(userId, repos);

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    this.ctx.acceptWebSocket(serverSocket, [FEED_TAG, `${UID_TAG_PREFIX}${userId}`]);
    this.log.debug({ event: "feed_ws_connected", uid: userId, repoCount: repos.length }, "Feed WebSocket connected");

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  /**
   * Fan a published delta out to every open subscriber socket, gated per
   * recipient. Errors here are swallowed by the publisher; we still return a
   * structured count so callers/tests can observe the split.
   */
  private async handlePublish(request: Request): Promise<Response> {
    const delta = (await parseJsonBody(request)) as FeedDelta | null;
    if (!delta) {
      return jsonErrorResponse("Invalid feed delta", 400);
    }
    // Structurally validate the gate-relevant fields. parseJsonBody only proves
    // valid JSON; a body missing `ownerUserId` would make `decideFeedDelivery`
    // silently suppress the owner (uid === undefined is never true), so reject
    // it rather than fan out a malformed delta.
    if (
      typeof delta.type !== "string" ||
      typeof delta.sessionId !== "string" ||
      typeof delta.ownerUserId !== "string"
    ) {
      return jsonErrorResponse("Malformed feed delta", 400);
    }

    const payload = JSON.stringify(delta);
    let delivered = 0;
    let suppressed = 0;
    // Read each distinct user's stored repo set at most once per publish (a user
    // with multiple tabs has multiple sockets but one row).
    const repoSetByUid = new Map<string, Set<string>>();

    for (const socket of this.ctx.getWebSockets(FEED_TAG)) {
      if (socket.readyState !== WEBSOCKET_READY_STATE_OPEN) continue;
      const uid = this.uidForSocket(socket);
      if (!uid) {
        suppressed += 1;
        continue;
      }
      let repoSet = repoSetByUid.get(uid);
      if (!repoSet) {
        repoSet = this.readRepoSet(uid);
        repoSetByUid.set(uid, repoSet);
      }
      const decision = decideFeedDelivery(uid, delta, repoSet);
      this.log.debug(
        {
          event: "feed_deliver",
          uid,
          sessionId: delta.sessionId,
          type: delta.type,
          source: delta.source,
          delivered: decision.deliver,
          reason: decision.reason,
        },
        "Feed delivery decision",
      );
      if (decision.deliver) {
        // Count the gate decision regardless of send outcome, so the
        // delivered/suppressed ratio reflects the gate and stays balanced
        // (delivered + suppressed == sockets considered) under socket churn.
        delivered += 1;
        try {
          socket.send(payload);
        } catch {
          // Socket closed between the readyState check and send; the next
          // publish (or close handler) reaps it.
        }
      } else {
        suppressed += 1;
      }
    }

    this.ctx.waitUntil(emitFeedDeliveryMetrics(this.env, { type: delta.type, delivered, suppressed }));

    return jsonResponse({ ok: true, delivered, suppressed });
  }

  private uidForSocket(socket: WebSocket): string | null {
    for (const tag of this.ctx.getTags(socket)) {
      if (tag.startsWith(UID_TAG_PREFIX)) {
        return tag.slice(UID_TAG_PREFIX.length);
      }
    }
    return null;
  }

  private parseReposHeader(header: string | null): string[] {
    if (!header) return [];
    try {
      const parsed = JSON.parse(header);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      return [];
    }
  }

  private upsertRepoAccess(userId: string, repos: string[]): void {
    this.sql.exec(
      `INSERT INTO feed_repo_access (user_id, repos_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET repos_json = excluded.repos_json, updated_at = excluded.updated_at`,
      userId,
      JSON.stringify(repos),
      Date.now(),
    );
  }

  private readRepoSet(userId: string): Set<string> {
    const rows = this.sql.exec("SELECT repos_json FROM feed_repo_access WHERE user_id = ?", userId).toArray();
    if (rows.length === 0) return new Set();
    try {
      const repos = JSON.parse(rows[0].repos_json as string);
      return Array.isArray(repos) ? new Set(repos.filter((r): r is string => typeof r === "string")) : new Set();
    } catch {
      return new Set();
    }
  }

  // Hibernation handlers are required by the runtime but carry no per-message
  // logic: the feed is push-only. `webSocketClose` drops the user's repo-access
  // row only when no other socket for that user remains (it is re-seeded on the
  // next connect regardless).
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // No inbound frames on the feed.
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const uid = this.uidForSocket(ws);
    if (!uid) return;
    const stillConnected = this.ctx
      .getWebSockets(FEED_TAG)
      .some((socket) => socket !== ws && this.uidForSocket(socket) === uid);
    if (!stillConnected) {
      this.sql.exec("DELETE FROM feed_repo_access WHERE user_id = ?", uid);
    }
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // No-op: close handling reaps state.
  }
}

const sentryConfig = (env: Env) => ({
  ...resolveSentryRuntimeOptions(env),
  release: env.SENTRY_RELEASE,
  tracesSampleRate: 0,
});

export const SessionFeedDO = Sentry.instrumentDurableObjectWithSentry(sentryConfig, SessionFeedDOBase);
