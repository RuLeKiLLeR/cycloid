import * as Sentry from "@sentry/cloudflare";

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PROTOCOL_VERSION_HEADER,
  isWorkerVersionHandoff,
  normalizeWorkerVersionId,
} from "../../../../shared/constants/bridge-protocol.js";
import { REPLAY_PAGE_SIZE, REPLAY_WINDOW_SIZE } from "../../../../shared/constants/session.js";
import type { ClientReplayPage } from "../../../../shared/types/session-websocket.js";
import type { SandboxIdlePauseReason } from "../enums/sandbox.js";
import type { Logger } from "../logger";
import type { SessionState } from "../types";
import { jsonErrorResponse } from "../utils";
import type { ServerMessage } from "../ws/types.js";
import type * as doDb from "./do-db.js";
import { validateReplayPageRequest } from "./replay-contract.js";

const WEBSOCKET_READY_STATE_OPEN = 1;
export const SANDBOX_WS_AUTH_STORAGE_PREFIX = "sandbox_ws_auth:";
const SANDBOX_WS_SESSION_KEY_BYTES = 32;
const SANDBOX_WS_SESSION_KEY_ROLLING_TTL_MS = 60_000;
// Per-session HMAC key for the bridge's durable outbox. Generated once per
// session and held in DO storage so it is stable across reconnects (a restarted
// bridge can still verify records it wrote earlier). Sent only over the
// authenticated sandbox WebSocket frame, never to the sandbox environment, so a
// same-user agent cannot read it to forge outbox records.
export const OUTBOX_SIGNING_KEY_STORAGE_KEY = "outbox_signing_key";
export const ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY = "accepted_sandbox_handoff";
const OUTBOX_SIGNING_KEY_BYTES = 32;

type SandboxReconnectState = {
  sandboxId: string | null;
  status: string | null;
  runtimeProvider: string | null;
  runtimeBackend: string | null;
  runtimeState: string | null;
  disconnectStartedAt: number | null;
  autoCloseScheduledAt: number | null;
  promptLastActivityAt: number | null;
  activePromptId: string | null;
  spawnDurationMs: number | null;
  intentionalPauseReason: SandboxIdlePauseReason | null;
  stopReason: doDb.SandboxStopReason | null;
};

type AcceptedSandboxHandoff = {
  acceptedVersionId: string | null;
  authenticatedRuntimeSandboxId: string | null;
  connectionGeneration: number;
  acceptedAtMs: number;
};

type SandboxCloseDecision =
  | "ignored_already_handled_generation"
  | "missing_or_archived_session_close"
  | "active_prompt_reconnect_grace"
  | "clean_idle_close"
  | "abnormal_reconnect_grace";

function getSocketTagValue(tags: string[], prefix: string): string | null {
  const tag = tags.find((entry) => entry.startsWith(prefix));
  return tag ? tag.slice(prefix.length) : null;
}

function getSocketKind(tags: string[]): "sandbox" | "client" | null {
  if (tags.includes("sandbox")) return "sandbox";
  if (tags.includes("client")) return "client";
  return null;
}

function isReadOnlyClientSocket(tags: string[]): boolean {
  return tags.includes("readonly");
}

function isReadOnlyClientMessage(type: string | undefined): boolean {
  return type === "resume" || type === "request_replay_page" || type === "ping";
}

function getSandboxConnectionGeneration(tags: string[]): number | null {
  const value = getSocketTagValue(tags, "gen:");
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSandboxIdFromTags(tags: string[]): string | null {
  return getSocketTagValue(tags, "sid:");
}

function sandboxWsAuthStorageKey(connectionGeneration: number): string {
  return `${SANDBOX_WS_AUTH_STORAGE_PREFIX}${connectionGeneration}`;
}

function sandboxPendingOneTimeAuthStorageKey(sessionId: string, sandboxId: string): string {
  return `sandbox_pending_one_time_auth:${sessionId}:${sandboxId}`;
}

function stripSandboxMessageAuth(message: string | ArrayBuffer): string | ArrayBuffer {
  const parsed = JSON.parse(String(message)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return message;
  const { auth: _auth, ...rest } = parsed as Record<string, unknown>;
  return JSON.stringify(rest);
}

function countOpenSockets(sockets: WebSocket[]): number {
  return sockets.filter((ws) => ws.readyState === WEBSOCKET_READY_STATE_OPEN).length;
}

function ageMs(timestamp: number | null | undefined, now = Date.now()): number | null {
  return typeof timestamp === "number" ? Math.max(0, now - timestamp) : null;
}

function parseBridgeProtocolVersionHeader(request: Request): number | null {
  const raw = request.headers.get(BRIDGE_PROTOCOL_VERSION_HEADER);
  if (raw === null || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildReplayTruncatedMessage(
  replay: ClientReplayPage,
): Extract<ServerMessage, { type: "replay_truncated" }> | null {
  if (replay.droppedCount <= 0 || replay.firstSequence == null || replay.lastSequence == null) {
    return null;
  }

  return {
    type: "replay_truncated",
    requestedAfterSequence: replay.afterSequence,
    firstReturnedSequence: replay.firstSequence,
    lastReturnedSequence: replay.lastSequence,
    droppedCount: replay.droppedCount,
  };
}

/**
 * Phase 1B contract stub for the future WebSocket helper.
 *
 * Ownership boundary:
 * - `/session/ws` sandbox/client accept flows
 * - `webSocketMessage`, `webSocketClose`, and `webSocketError` delegation
 * - socket tagging, sandbox generation tracking, reconnect grace, and client replay handshake
 *
 * Keep on `SessionDO`:
 * - lifecycle entrypoints themselves (`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`, `alarm`)
 * - sandbox event translation/persistence in `processSandboxMessage()` and `session/events.ts`
 * - prompt failure/drain behavior beyond the explicit `failActivePromptOnDisconnect()` callback
 *
 * Invariants:
 * - helper remains stateless; all authoritative socket/cache state stays on the DO host
 * - sandbox generation tags gate reconnect/close handling so superseded sockets are ignored
 * - connect/close ordering must preserve the current `sandbox_ready` / session_status reconnect substate / disconnected-heartbeat behavior
 */
interface SessionWsManagerHost {
  readonly state: DurableObjectState;
  getWorkerVersionId?: () => string | null;
  readonly log: Logger;
  resolveSessionId(): string | null;
  ensureSocketCachesLoaded(): Promise<void>;
  listAcceptedWebSockets(tag?: string): WebSocket[];
  acceptTaggedWebSocket(ws: WebSocket, tags: string[]): void;
  getSocketTags(ws: WebSocket): string[];
  getSession(sessionId: string): SessionState | null;
  getSandboxReconnectState(sessionId: string): SandboxReconnectState | null;
  updateSandboxState(
    sessionId: string,
    patch: {
      sandboxId?: string | null;
      sandboxAuthTokenHash?: string | null;
      bridgeProtocolVersion?: number | null;
      intentionalPauseReason?: SandboxIdlePauseReason | null;
      status?: string;
      stopReason?: doDb.SandboxStopReason | null;
    },
  ): void;
  // Rotate the sandbox HTTP auth-token hash, rolling the prior live hash into a
  // bounded grace-overlap window so a not-yet-rotated bridge keeps authenticating.
  rotateSandboxAuthTokenHash(sessionId: string, nextHash: string): void;
  recordPromptActivityFromTransport(sessionId: string, at: number): void;
  resetSpawnRetryFromTransport(sessionId: string): void;
  clearTransportMarkersFromTransport(sessionId: string): void;
  getSandboxSocket(): WebSocket | null;
  setSandboxSocket(ws: WebSocket | null): void;
  nextSandboxConnectionGeneration(): Promise<number>;
  closeSupersededSandboxSockets(currentGen: number, excludeSocket?: WebSocket): void;
  getCachedSandboxConnectionGeneration(): number | null;
  hasHandledSandboxDisconnectGeneration(generation: number): boolean;
  markSandboxDisconnectGenerationHandled(generation: number): void;
  processSandboxMessage(
    message: string | ArrayBuffer,
    session: SessionState,
    connectionGeneration?: number | null,
  ): Promise<void>;
  processSandboxDisconnectForLifecycle(
    sessionId: string,
    sandboxId: string | null,
    detail: { connectionGeneration: number | null; detectedAt: number },
  ): Promise<void>;
  dispatchSandboxConnected(sessionId: string, sandboxId: string): Promise<void>;
  finalizeTransportStop(sessionId: string, stopReason: "user" | "reaped" | null, reason: string): Promise<void>;
  completeIntentionalPauseClose(sessionId: string): Promise<void>;
  notifyE2BBridgeWebSocketConnected(sessionId: string): void;
  // ARC-876 fast path: resume a publish stalled by a deploy-induced DO eviction
  // when the bridge reconnects. Fire-and-forget (the DO detaches it) so it never
  // blocks the WebSocket upgrade; a no-op unless the session is stuck `publishing`.
  resumeStuckPublishOnReconnect(sessionId: string): void;
  sendPendingPromptToSandbox(sessionId: string): Promise<boolean>;
  // 9.3: redeliver an answer whose `respond` frame was lost to a mid-flight
  // disconnect so the bridge is not stranded awaiting it. No-op unless a pending
  // answer is stored for the still-active prompt.
  sendPendingAnswerToSandbox(sessionId: string): Promise<void>;
  putSandboxStatus(
    sessionId: string,
    status: string,
    options?: { stopReason?: doDb.SandboxStopReason | null },
  ): Promise<void>;
  buildClientSubscription(
    sessionId: string,
    userId: string,
    afterSequenceRaw: unknown,
  ): Promise<{ message: ServerMessage }>;
  buildReplayPage(sessionId: string, afterSequenceRaw: unknown, limitRaw: unknown, maxLimit?: number): ClientReplayPage;
  buildReplayPageBeforeSequence(sessionId: string, beforeSequenceRaw: unknown, limitRaw: unknown): ClientReplayPage;
  sendReplayPageMessage(ws: WebSocket, page: ClientReplayPage): void;
  durableWrite(
    operation: string,
    entries: Record<string, unknown> | [string, unknown],
    sessionId?: string,
  ): Promise<void>;
  computeSha256Hex(value: string): Promise<string>;
  generateRandomHex(bytes: number): string;
  timingSafeEqualString(left: string, right: string): boolean;
  flushBufferedEventsBeforeDisconnect(): Promise<void>;
  scheduleAutoCloseAfterDisconnect(sessionId: string): Promise<void>;
  failActivePromptOnDisconnect(session: SessionState, activePromptId: string): Promise<void>;
  schedulePromptExecutionAlarm(): Promise<void>;
  rescheduleSessionAlarm(): Promise<void>;
  broadcast(message: ServerMessage): void;
}

export interface SessionWsManager {
  handleSandboxWebSocket(request: Request, session: SessionState): Promise<Response>;
  handleClientWebSocket(request: Request, url: URL, session: SessionState): Promise<Response>;
  handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  handleWebSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  handleWebSocketError(ws: WebSocket, error: unknown): Promise<void>;
}

class SessionWsManagerImpl implements SessionWsManager {
  constructor(private readonly host: SessionWsManagerHost) {}

  async handleSandboxWebSocket(request: Request, session: SessionState): Promise<Response> {
    const sessionId = session.sessionId;
    if (session.status === "archived") {
      return jsonErrorResponse("Session is archived", 409);
    }

    const incomingSandboxId =
      request.headers.get("x-sandbox-id") || new URL(request.url).searchParams.get("sandboxId") || null;
    const bridgeProtocolVersion = parseBridgeProtocolVersionHeader(request);
    const edgeColo = request.headers.get("cf-ray")?.split("-").pop() || "unknown";
    this.host.log.info(
      {
        sandboxId: incomingSandboxId,
        sessionId,
        edgeColo,
      },
      "Accepting sandbox WebSocket",
    );

    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    const connectionGeneration = await this.host.nextSandboxConnectionGeneration();
    const currentVersionId = normalizeWorkerVersionId(this.host.getWorkerVersionId?.());
    const reconnectState = this.host.getSandboxReconnectState(sessionId);
    const previousHandoff = await this.host.state.storage.get<AcceptedSandboxHandoff>(
      ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY,
    );
    const sameAuthenticatedRuntime =
      incomingSandboxId !== null &&
      reconnectState?.sandboxId !== null &&
      incomingSandboxId === reconnectState?.sandboxId;
    const plannedHandoff =
      previousHandoff &&
      sameAuthenticatedRuntime &&
      isWorkerVersionHandoff({
        currentVersionId,
        persistedVersionId: previousHandoff.acceptedVersionId,
        currentRuntimeSandboxId: reconnectState?.sandboxId ?? null,
        persistedRuntimeSandboxId: previousHandoff.authenticatedRuntimeSandboxId,
        currentConnectionGeneration: connectionGeneration,
        persistedConnectionGeneration: previousHandoff.connectionGeneration,
      });
    const sessionKey = this.host.generateRandomHex(SANDBOX_WS_SESSION_KEY_BYTES);
    const nextAuthToken = this.host.generateRandomHex(SANDBOX_WS_SESSION_KEY_BYTES);
    const nextAuthTokenHash = await this.host.computeSha256Hex(nextAuthToken);
    const sessionKeyHash = await this.host.computeSha256Hex(sessionKey);
    const pendingOneTimeAuthKey = incomingSandboxId
      ? await this.host.state.storage.get<string>(sandboxPendingOneTimeAuthStorageKey(sessionId, incomingSandboxId))
      : null;
    await this.host.state.storage.put(sandboxWsAuthStorageKey(connectionGeneration), {
      sessionKeyHash,
      lastNonce: 0,
      expiresAt: Date.now() + SANDBOX_WS_SESSION_KEY_ROLLING_TTL_MS,
      oneTimeAuthKey: pendingOneTimeAuthKey ?? null,
    });
    if (pendingOneTimeAuthKey && incomingSandboxId) {
      await this.host.state.storage.delete(sandboxPendingOneTimeAuthStorageKey(sessionId, incomingSandboxId));
    }
    // Record the adoption before any reducer event clears reconnect deadlines.
    // A failed durable write leaves the existing grace path authoritative.
    let handoffRecordPersisted = false;
    try {
      await this.host.state.storage.put(ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY, {
        acceptedVersionId: currentVersionId,
        // Never trust the upgrade header to establish identity. Only carry
        // forward the provider-facing runtime id already held by the session.
        authenticatedRuntimeSandboxId: reconnectState?.sandboxId ?? null,
        connectionGeneration,
        acceptedAtMs: Date.now(),
      } satisfies AcceptedSandboxHandoff);
      handoffRecordPersisted = true;
    } catch (error) {
      this.host.log.error(
        { event: "sandbox_handoff_record_persist_failed", sessionId, connectionGeneration, error: String(error) },
        "Failed to persist sandbox adoption record; preserving reconnect grace",
      );
      await this.host.state.storage.delete(sandboxWsAuthStorageKey(connectionGeneration));
      if (pendingOneTimeAuthKey && incomingSandboxId) {
        await this.host.state.storage.put(
          sandboxPendingOneTimeAuthStorageKey(sessionId, incomingSandboxId),
          pendingOneTimeAuthKey,
        );
      }
      throw error;
    }
    // Rotate the HTTP auth token, preserving the prior hash for a bounded grace
    // window so a bridge that reconnected but has not yet adopted the new token
    // is not 403'd on its in-flight REST calls.
    this.host.rotateSandboxAuthTokenHash(sessionId, nextAuthTokenHash);
    this.host.updateSandboxState(sessionId, {
      ...(incomingSandboxId ? { sandboxId: incomingSandboxId } : {}),
      bridgeProtocolVersion,
    });
    if (bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.host.log.warn(
        {
          event: "bridge.protocol_skew",
          sessionId,
          sandboxId: incomingSandboxId,
          bridgeVersion: bridgeProtocolVersion ?? "pre-versioning",
          workerVersion: BRIDGE_PROTOCOL_VERSION,
        },
        "Sandbox bridge protocol version differs from control-plane worker version",
      );
    }
    const outboxSigningKey = await this.getOrCreateOutboxSigningKey();
    this.host.acceptTaggedWebSocket(serverSocket, [
      "sandbox",
      `sid:${incomingSandboxId || "unknown"}`,
      `gen:${connectionGeneration}`,
    ]);
    serverSocket.send(
      JSON.stringify({
        type: "sandbox_session",
        sessionKey,
        connectionGeneration,
        nextAuthToken,
        bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
        ...(currentVersionId ? { workerVersionId: currentVersionId } : {}),
        outboxSigningKey,
      }),
    );

    this.host.setSandboxSocket(serverSocket);
    this.host.closeSupersededSandboxSockets(connectionGeneration, serverSocket);

    const sandboxDisconnectAt = reconnectState?.disconnectStartedAt ?? null;
    const autoCloseScheduledAt = reconnectState?.autoCloseScheduledAt ?? null;
    const activePromptId = reconnectState?.activePromptId ?? null;
    // Resolve a sandboxId for the lifecycle event — prefer the incoming header,
    // fall back to whatever is stored. Skipping the dispatch when neither is
    // present matches existing call sites (durable-object alarm + putSandboxStatus).
    const lifecycleSandboxId = incomingSandboxId || reconnectState?.sandboxId || null;
    // Fallback for the (very unlikely) case where neither the incoming header
    // nor the stored sandboxId resolves: clear the D1 transport markers directly
    // so rescheduleSessionAlarm doesn't re-arm a phantom grace deadline from
    // stale state. The reducer normally owns these clears via ws_connected.
    const clearStaleTransportMarkers = (): void => {
      if (!lifecycleSandboxId && (sandboxDisconnectAt || autoCloseScheduledAt)) {
        this.host.log.warn(
          { event: "sandbox_reconnect_missing_sandboxid_fallback", sessionId },
          "Reconnect without a resolvable sandboxId — clearing transport markers directly",
        );
        this.host.clearTransportMarkersFromTransport(sessionId);
      }
    };
    if (sandboxDisconnectAt) {
      const elapsedMs = Date.now() - sandboxDisconnectAt;
      // Route the marker clears through the reducer (`sandbox.ws_connected`)
      // before rescheduling the alarm; otherwise rescheduleSessionAlarm reads a
      // stale disconnectStartedAt from D1 and re-arms a phantom grace deadline.
      // The same event fires again from putSandboxStatus("ready") below — it is
      // idempotent at the D1 level.
      if (lifecycleSandboxId && handoffRecordPersisted) {
        await this.host.dispatchSandboxConnected(sessionId, lifecycleSandboxId);
      } else {
        clearStaleTransportMarkers();
      }
      if (activePromptId) {
        await this.host.schedulePromptExecutionAlarm();
      } else {
        await this.host.rescheduleSessionAlarm();
      }
      this.host.log.info(
        {
          event:
            plannedHandoff && handoffRecordPersisted ? "sandbox_control_plane_handoff" : "sandbox_reconnected_in_grace",
          sessionId,
          elapsedMs,
          disconnectDurationMs: elapsedMs,
          runtimeSandboxId: reconnectState?.sandboxId ?? null,
          previousVersionId: previousHandoff?.acceptedVersionId ?? null,
          newVersionId: currentVersionId,
          connectionGeneration,
          activePromptSurvived: Boolean(activePromptId && plannedHandoff),
        },
        "Sandbox reconnected during grace period",
      );
    } else if (autoCloseScheduledAt) {
      if (lifecycleSandboxId && handoffRecordPersisted) {
        await this.host.dispatchSandboxConnected(sessionId, lifecycleSandboxId);
      } else {
        clearStaleTransportMarkers();
      }
      await this.host.rescheduleSessionAlarm();
    }

    this.host.resetSpawnRetryFromTransport(sessionId);
    const dispatched = await this.host.sendPendingPromptToSandbox(sessionId);
    // 9.3: a `respond` frame lost to the disconnect that caused this reconnect
    // would deadlock a prompt blocked on its pending question; redeliver it now.
    await this.host.sendPendingAnswerToSandbox(sessionId);
    await this.host.putSandboxStatus(sessionId, "ready");
    this.host.notifyE2BBridgeWebSocketConnected(sessionId);
    // ARC-876 fast path: a deploy may have evicted the DO mid-publish. The bridge
    // has just reconnected, so resume the stalled publish now (detached so it does
    // not block the WS upgrade); it converges well before the 20-min publishing
    // watchdog. No-op unless the session is stuck in `publishing`.
    this.host.resumeStuckPublishOnReconnect(sessionId);
    if (dispatched && this.host.getSandboxSocket()) {
      // Use the prompt id D1 currently considers active. The reconnect
      // snapshot's `activePromptId` may have shifted across earlier awaits;
      // the dispatched prompt is whatever sendPendingPromptToSandbox just
      // read, which is the same row this helper reads.
      this.host.recordPromptActivityFromTransport(sessionId, Date.now());
      await this.host.schedulePromptExecutionAlarm();
      this.host.log.info({ sessionId }, "Alarm upgraded to stale prompt timeout on sandbox connect");
    }

    this.host.broadcast({
      type: "sandbox_ready",
      sandboxId: incomingSandboxId || "unknown",
      spawnDurationMs: reconnectState?.spawnDurationMs ?? null,
    });

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  /** Get the per-session durable-outbox HMAC key, generating and persisting it on
   * first use. Stable across reconnects so a restarted bridge can verify records
   * it wrote in a prior life; never exposed to the sandbox environment. */
  private async getOrCreateOutboxSigningKey(): Promise<string> {
    const existing = await this.host.state.storage.get<string>(OUTBOX_SIGNING_KEY_STORAGE_KEY);
    if (typeof existing === "string" && existing.length > 0) return existing;
    const key = this.host.generateRandomHex(OUTBOX_SIGNING_KEY_BYTES);
    await this.host.state.storage.put(OUTBOX_SIGNING_KEY_STORAGE_KEY, key);
    return key;
  }

  async handleClientWebSocket(request: Request, url: URL, session: SessionState): Promise<Response> {
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];

    const wsId = crypto.randomUUID();
    const userId = request.headers.get("x-auth-user-id") || session.ownerUserId;
    const tags = ["client", `wsid:${wsId}`, `uid:${userId}`];
    const impersonationId = request.headers.get("x-auth-impersonation-id");
    const readOnly = request.headers.get("x-auth-read-only") === "true" || Boolean(impersonationId);
    if (readOnly) tags.push("readonly");
    if (impersonationId) tags.push(`imp:${impersonationId}`);
    this.host.acceptTaggedWebSocket(serverSocket, tags);
    this.host.log.info(
      {
        action: "ws_connected",
        sessionId: session.sessionId,
        clientCount: countOpenSockets(this.host.listAcceptedWebSockets("client")),
      },
      "Client WebSocket connected",
    );

    const { message } = await this.host.buildClientSubscription(
      session.sessionId,
      userId,
      url.searchParams.get("afterSequence"),
    );
    serverSocket.send(JSON.stringify(message));
    if (message.type === "subscribed") {
      const replayTruncated = buildReplayTruncatedMessage(message.replay);
      if (replayTruncated) {
        serverSocket.send(JSON.stringify(replayTruncated));
      }
    }

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  async handleWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.host.ensureSocketCachesLoaded();
    const tags = this.host.getSocketTags(ws);
    const kind = getSocketKind(tags);

    if (kind === "sandbox") {
      const sessionId = this.host.resolveSessionId();
      const session = sessionId ? this.host.getSession(sessionId) : null;
      if (!session) return;
      const connectionGeneration = getSandboxConnectionGeneration(tags);
      const authResult = await this.authenticateSandboxMessage(ws, message, session, connectionGeneration);
      if (!authResult.ok) return;
      try {
        await this.host.processSandboxMessage(stripSandboxMessageAuth(message), session, connectionGeneration);
      } catch (err) {
        this.host.log.error({ sessionId: session.sessionId, error: String(err) }, "Error processing sandbox message");
        Sentry.captureException(err, { tags: { sessionId: session.sessionId, operation: "processSandboxMessage" } });
      }
      return;
    }

    if (kind === "client") {
      await this.handleClientWebSocketMessage(ws, message);
      return;
    }

    this.host.log.warn({ tags }, "Ignoring WebSocket message with unknown tags");
  }

  async handleWebSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.host.ensureSocketCachesLoaded();
    const tags = this.host.getSocketTags(ws);
    const kind = getSocketKind(tags);

    if (kind === "client") {
      const sessionId = this.host.resolveSessionId();
      const session = sessionId ? this.host.getSession(sessionId) : null;
      this.host.log.info(
        {
          action: "ws_disconnected",
          sessionId: session?.sessionId,
          clientCount: countOpenSockets(this.host.listAcceptedWebSockets("client")),
        },
        "Client WebSocket disconnected",
      );
      return;
    }

    if (kind !== "sandbox") return;

    const sessionId = this.host.resolveSessionId();
    const session = sessionId ? this.host.getSession(sessionId) : null;
    const connectionGeneration = getSandboxConnectionGeneration(tags);
    const currentGeneration = this.host.getCachedSandboxConnectionGeneration();
    const sandboxId = getSandboxIdFromTags(tags);
    const reconnectState = session?.sessionId ? this.host.getSandboxReconnectState(session.sessionId) : null;
    const activePromptId = reconnectState?.activePromptId ?? null;
    const closeContext = {
      event: "sandbox_ws_closed",
      sessionId: session?.sessionId ?? sessionId,
      sessionStatus: session?.status ?? null,
      code,
      reason,
      wasClean,
      connectionGeneration,
      currentGeneration,
      sandboxId,
      runtimeProvider: reconnectState?.runtimeProvider ?? null,
      runtimeBackend: reconnectState?.runtimeBackend ?? null,
      runtimeState: reconnectState?.runtimeState ?? null,
      openSandboxSocketCount: countOpenSockets(this.host.listAcceptedWebSockets("sandbox")),
      activePromptId,
      activePromptInFlight: Boolean(activePromptId),
      promptLastActivityAgeMs: ageMs(reconnectState?.promptLastActivityAt),
      disconnectStartedAgeMs: ageMs(reconnectState?.disconnectStartedAt),
      autoCloseScheduledAgeMs: ageMs(reconnectState?.autoCloseScheduledAt),
    };

    if (connectionGeneration !== null && this.host.hasHandledSandboxDisconnectGeneration(connectionGeneration)) {
      this.host.log.info(
        { ...closeContext, closeDecision: "ignored_already_handled_generation" satisfies SandboxCloseDecision },
        "Sandbox WebSocket close already handled for generation",
      );
      return;
    }
    if (connectionGeneration !== null) {
      this.host.markSandboxDisconnectGenerationHandled(connectionGeneration);
    }

    if (!session || session.status === "archived") {
      this.logSandboxCloseDecision(closeContext, "missing_or_archived_session_close");
      await this.handleSandboxClose(session, connectionGeneration);
      return;
    }

    if (activePromptId) {
      this.logSandboxCloseDecision(closeContext, "active_prompt_reconnect_grace");
      await this.handleSandboxReconnectGrace(session, sandboxId, connectionGeneration, closeContext);
      return;
    }

    if (wasClean) {
      this.logSandboxCloseDecision(closeContext, "clean_idle_close");
      await this.handleSandboxClose(session, connectionGeneration);
      return;
    }

    this.logSandboxCloseDecision(closeContext, "abnormal_reconnect_grace");
    await this.handleSandboxReconnectGrace(session, sandboxId, connectionGeneration, closeContext);
  }

  async handleWebSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const tags = this.host.getSocketTags(ws);
    const kind = getSocketKind(tags);
    const sessionId = this.host.resolveSessionId();
    const session = sessionId ? this.host.getSession(sessionId) : null;
    if (kind !== "sandbox") {
      this.host.log.warn({ sessionId: session?.sessionId, kind, error: String(error) }, "WebSocket error");
      return;
    }

    const reconnectState = session?.sessionId ? this.host.getSandboxReconnectState(session.sessionId) : null;
    this.host.log.warn(
      {
        event: "sandbox_ws_error",
        sessionId: session?.sessionId,
        kind,
        error: String(error),
        sandboxId: reconnectState?.sandboxId ?? getSandboxIdFromTags(tags),
        runtimeProvider: reconnectState?.runtimeProvider ?? null,
        runtimeBackend: reconnectState?.runtimeBackend ?? null,
        runtimeState: reconnectState?.runtimeState ?? null,
      },
      "WebSocket error",
    );
  }

  private async authenticateSandboxMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
    session: SessionState,
    connectionGeneration: number | null,
  ): Promise<{ ok: true } | { ok: false }> {
    if (connectionGeneration === null) {
      this.logSandboxMessageRejected(session, "missing_connection_generation");
      return { ok: false };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(message)) as unknown;
    } catch {
      this.logSandboxMessageRejected(session, "invalid_json");
      return { ok: false };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.logSandboxMessageRejected(session, "invalid_payload");
      return { ok: false };
    }

    const auth = (parsed as { auth?: unknown }).auth;
    if (typeof auth !== "object" || auth === null || Array.isArray(auth)) {
      this.logSandboxMessageRejected(session, "missing_auth");
      return { ok: false };
    }

    const sessionKey = (auth as { sessionKey?: unknown }).sessionKey;
    const nonce = (auth as { nonce?: unknown }).nonce;
    if (typeof sessionKey !== "string" || sessionKey.length === 0 || typeof nonce !== "number") {
      this.logSandboxMessageRejected(session, "invalid_auth_shape");
      return { ok: false };
    }

    const storageKey = sandboxWsAuthStorageKey(connectionGeneration);
    const record = await this.host.state.storage.get<{
      sessionKeyHash?: unknown;
      lastNonce?: unknown;
      expiresAt?: unknown;
      oneTimeAuthKey?: unknown;
    }>(storageKey);
    if (
      !record ||
      typeof record.sessionKeyHash !== "string" ||
      typeof record.lastNonce !== "number" ||
      typeof record.expiresAt !== "number"
    ) {
      this.logSandboxMessageRejected(session, "missing_session_key", { connectionGeneration });
      return { ok: false };
    }

    const now = Date.now();
    if (now > record.expiresAt) {
      this.logSandboxMessageRejected(session, "expired_session_key", { connectionGeneration });
      try {
        ws.send(JSON.stringify({ type: "auth_error", reason: "expired_session_key" }));
        ws.close(4003, "Sandbox session key expired");
      } catch {
        // Best-effort feedback before the bridge reconnect path takes over.
      }
      return { ok: false };
    }

    const sessionKeyHash = await this.host.computeSha256Hex(sessionKey);
    if (!this.host.timingSafeEqualString(sessionKeyHash, record.sessionKeyHash)) {
      this.logSandboxMessageRejected(session, "invalid_session_key", { connectionGeneration });
      return { ok: false };
    }

    if (!Number.isSafeInteger(nonce) || nonce <= record.lastNonce) {
      this.logSandboxMessageRejected(session, "invalid_nonce", {
        connectionGeneration,
        nonce,
        lastNonce: record.lastNonce,
      });
      return { ok: false };
    }

    await this.host.state.storage.put(storageKey, {
      sessionKeyHash: record.sessionKeyHash,
      lastNonce: nonce,
      expiresAt: now + SANDBOX_WS_SESSION_KEY_ROLLING_TTL_MS,
      oneTimeAuthKey: typeof record.oneTimeAuthKey === "string" ? record.oneTimeAuthKey : null,
    });
    if (typeof record.oneTimeAuthKey === "string") {
      const consumedRecord = await this.host.state.storage.get<{ consumedAt?: unknown; confirmedAt?: unknown }>(
        record.oneTimeAuthKey,
      );
      if (
        consumedRecord &&
        typeof consumedRecord.consumedAt === "number" &&
        typeof consumedRecord.confirmedAt !== "number"
      ) {
        await this.host.state.storage.put(record.oneTimeAuthKey, {
          ...consumedRecord,
          confirmedAt: now,
        });
      }
    }
    return { ok: true };
  }

  private logSandboxMessageRejected(session: SessionState, reason: string, extra: Record<string, unknown> = {}): void {
    const reconnectState = this.host.getSandboxReconnectState(session.sessionId);
    this.host.log.warn(
      {
        event: "sandbox_ws_message_rejected",
        sessionId: session.sessionId,
        reason,
        sandboxId: reconnectState?.sandboxId ?? null,
        runtimeProvider: reconnectState?.runtimeProvider ?? null,
        runtimeBackend: reconnectState?.runtimeBackend ?? null,
        runtimeState: reconnectState?.runtimeState ?? null,
        ...extra,
      },
      "Rejected sandbox WebSocket message",
    );
  }

  private async handleClientWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let payload: {
      type?: string;
      afterSequence?: unknown;
      lastEventId?: unknown;
      lastEventSequence?: unknown;
      beforeSequence?: unknown;
      limit?: unknown;
    };
    try {
      payload = JSON.parse(String(data)) as typeof payload;
    } catch {
      return;
    }

    const sessionId = this.host.resolveSessionId();
    if (!sessionId) return;

    const tags = this.host.getSocketTags(ws);
    if (isReadOnlyClientSocket(tags) && !isReadOnlyClientMessage(payload?.type)) {
      this.host.log.warn(
        {
          event: "readonly_client_ws_message_rejected",
          sessionId,
          type: payload?.type ?? null,
          impersonationId: getSocketTagValue(tags, "imp:"),
        },
        "Rejected read-only client WebSocket message",
      );
      ws.send(
        JSON.stringify({
          type: "replay_error",
          message: "Forbidden: session WebSocket is read-only",
        } satisfies ServerMessage),
      );
      return;
    }

    if (payload?.type === "resume") {
      const afterSequenceRaw = payload.afterSequence ?? payload.lastEventId ?? payload.lastEventSequence;
      const replay = this.host.buildReplayPage(sessionId, afterSequenceRaw, REPLAY_WINDOW_SIZE, REPLAY_WINDOW_SIZE);
      for (const event of replay.events) {
        ws.send(JSON.stringify({ type: "replay_event", event }));
      }
      const replayTruncated = buildReplayTruncatedMessage(replay);
      if (replayTruncated) {
        ws.send(JSON.stringify(replayTruncated));
      }
      return;
    }

    if (payload?.type === "request_replay_page") {
      const validation = validateReplayPageRequest(
        {
          afterSequence: payload.afterSequence,
          beforeSequence: payload.beforeSequence,
          limit: payload.limit,
        },
        REPLAY_PAGE_SIZE,
      );
      if (!validation.ok) {
        // Log the rejected param name (not its value — may be user-supplied
        // garbage). The connection stays open so the client can retry with a
        // corrected payload.
        this.host.log.info(
          {
            event: "ws_replay_page_rejected",
            sessionId,
            param: validation.param,
          },
          "Rejected malformed request_replay_page payload",
        );
        ws.send(JSON.stringify({ type: "replay_error", message: validation.error } satisfies ServerMessage));
        return;
      }

      const validated = validation.value;
      if (validated.beforeSequence !== undefined) {
        const page = this.host.buildReplayPageBeforeSequence(sessionId, validated.beforeSequence, validated.limit);
        this.host.sendReplayPageMessage(ws, page);
        return;
      }

      const page = this.host.buildReplayPage(
        sessionId,
        validated.afterSequence ?? 0,
        validated.limit ?? REPLAY_PAGE_SIZE,
      );
      this.host.sendReplayPageMessage(ws, page);
    }
  }

  private logSandboxCloseDecision(context: Record<string, unknown>, closeDecision: SandboxCloseDecision): void {
    this.host.log.info({ ...context, closeDecision }, "Sandbox WebSocket closed");
  }

  private async handleSandboxReconnectGrace(
    session: SessionState,
    sandboxId: string | null,
    connectionGeneration: number | null,
    closeContext?: Record<string, unknown>,
  ): Promise<void> {
    const currentGeneration = this.host.getCachedSandboxConnectionGeneration();
    if (connectionGeneration !== null && currentGeneration !== null && connectionGeneration !== currentGeneration) {
      return;
    }

    await this.host.flushBufferedEventsBeforeDisconnect();
    this.host.setSandboxSocket(null);
    await this.deleteSandboxAuthRecord(connectionGeneration);

    // Resurrection guard (sandbox-death wedge, proven via live repro): a late
    // socket-close for a sandbox whose runtime is already killed/stopped must NOT
    // flip the lifecycle back to `reconnecting` — there is nothing to reconnect
    // to. A killed VM's close frame can arrive >100s after liveness expiry already
    // routed the row to `stopped`; resurrecting `reconnecting` here lets a
    // review-loop prompt admit against a dead runtime and wedge to the
    // max-duration ceiling. The runtime is already converged, so the late close is
    // vestigial — tear the socket down (above) and stop.
    const closingState = this.host.getSandboxReconnectState(session.sessionId);
    if (closingState && (closingState.runtimeState === "killed" || closingState.status === "stopped")) {
      this.host.log.info(
        {
          event: "sandbox_ws_close_ignored_dead_runtime",
          sessionId: session.sessionId,
          sandboxId: sandboxId || "unknown",
          runtimeState: closingState.runtimeState,
          status: closingState.status,
          connectionGeneration,
        },
        "Ignoring sandbox reconnect-grace for already-dead runtime",
      );
      return;
    }

    const disconnectedAt = Date.now();
    await this.host.putSandboxStatus(session.sessionId, "reconnecting");
    // disconnectStartedAt is now written by the sandbox.ws_disconnected reducer
    // patch (applied below). No direct D1 write needed.
    await this.host.processSandboxDisconnectForLifecycle(session.sessionId, sandboxId, {
      connectionGeneration,
      detectedAt: disconnectedAt,
    });
    await this.host.rescheduleSessionAlarm();

    this.host.broadcast({
      type: "sandbox_event",
      event: {
        type: "heartbeat",
        sandboxId: sandboxId || "unknown",
        status: "reconnecting",
        timestamp: disconnectedAt,
      },
    });
    this.host.log.info(
      {
        ...(closeContext ?? {}),
        event: "sandbox_reconnect_grace_start",
        sessionId: session.sessionId,
        sandboxId: sandboxId || "unknown",
        connectionGen: connectionGeneration,
      },
      "Sandbox reconnect grace period started",
    );
  }

  private async handleSandboxClose(session: SessionState | null, closingGeneration: number | null): Promise<void> {
    const currentGeneration = this.host.getCachedSandboxConnectionGeneration();
    if (closingGeneration !== null && currentGeneration !== null && closingGeneration !== currentGeneration) {
      return;
    }

    await this.host.flushBufferedEventsBeforeDisconnect();
    this.host.setSandboxSocket(null);
    await this.deleteSandboxAuthRecord(closingGeneration);

    const sessionId = this.host.resolveSessionId();
    // disconnectStartedAt is cleared by whichever lifecycle event we dispatch
    // below (boundary.intentional_pause_close OR boundary.transport_stop_finalize).
    // Both go through the reducer/applier — no direct D1 clear needed here.

    const reconnectState = sessionId ? this.host.getSandboxReconnectState(sessionId) : null;
    const activePromptId = reconnectState?.activePromptId ?? null;
    const previousSandboxId = reconnectState?.sandboxId ?? null;
    const intentionalPauseReason = reconnectState?.intentionalPauseReason ?? null;
    if (intentionalPauseReason && sessionId) {
      // Reducer clears transport markers (disconnectStartedAt + autoCloseScheduledAt)
      // via boundary.intentional_pause_close; host clears intentionalPauseReason
      // since that marker is owned by the E2B pause flow, not the lifecycle reducer.
      await this.host.completeIntentionalPauseClose(sessionId);
      this.host.log.info(
        {
          event: "sandbox_ws_closed_intentional_pause",
          sessionId,
          sandboxId: previousSandboxId || "unknown",
          intentionalPauseReason,
          connectionGeneration: closingGeneration,
        },
        "Sandbox WebSocket closed after intentional runtime pause",
      );
      return;
    }
    // Default transport-driven stop reason is "reaped"; the applier preserves
    // an existing non-null sandbox.stopReason (first-authoritative-wins), so an
    // earlier user-initiated stop's "user" survives this WS-close.
    if (sessionId) {
      await this.host.finalizeTransportStop(sessionId, "reaped", "sandbox_ws_closed");
      if (session) {
        if (activePromptId) {
          await this.host.failActivePromptOnDisconnect(session, activePromptId);
        } else if (session.status !== "archived") {
          await this.host.scheduleAutoCloseAfterDisconnect(sessionId);
        } else {
          // deleteAlarm is correct here (ARC-1196 audit): only reachable for
          // archived sessions whose transport just finalized, so no lifecycle
          // deadline can be valid.
          await this.host.state.storage.deleteAlarm();
        }
      }
    }

    this.host.broadcast({
      type: "sandbox_event",
      event: {
        type: "heartbeat",
        sandboxId: previousSandboxId || "unknown",
        status: "disconnected",
        timestamp: Date.now(),
      },
    });
  }

  private async deleteSandboxAuthRecord(connectionGeneration: number | null): Promise<void> {
    if (connectionGeneration === null) return;
    try {
      await this.host.state.storage.delete(sandboxWsAuthStorageKey(connectionGeneration));
    } catch (err) {
      this.host.log.warn(
        { connectionGeneration, error: String(err) },
        "Failed to delete sandbox WebSocket auth record",
      );
    }
  }
}

export function createSessionWsManager(host: SessionWsManagerHost): SessionWsManager {
  return new SessionWsManagerImpl(host);
}
