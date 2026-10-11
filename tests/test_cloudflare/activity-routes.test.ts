// Route + service + DAO tests for GET /api/activity. In-memory D1 loaded from
// the real migrations; handler invoked directly with synthesized auth.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { activityRoutes } from "../../apps/control-plane-worker/src/routes/activity";
import type { Route } from "../../apps/control-plane-worker/src/routes/shared";
import { appendPrCoordinationEvent } from "../../apps/control-plane-worker/src/session/pr-coordination-events-db";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async run() {
    const result = this.db.prepare(this.query).run(...this.boundValues);
    return {
      success: true as const,
      meta: { last_row_id: Number(result.lastInsertRowid ?? 0), changes: result.changes },
    };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
}

class SqliteD1 {
  readonly sqlite = new Database(":memory:");
  constructor() {
    this.sqlite.pragma("foreign_keys = ON");
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.sqlite.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.sqlite, query);
  }
}

function makeEnv(d1: SqliteD1): Env {
  return { DB: d1 as unknown } as unknown as Env;
}

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    userId: "42",
    tokenSource: "session",
    authMode: "user_session",
    canAccessAllSessions: false,
    // `id` is what the internal-feature gate resolves against D1; businessId
    // scopes the activity query itself.
    user: { id: 42, businessId: "biz-a", businessRole: "member" } as AuthInfo["user"],
    ...overrides,
  } as AuthInfo;
}

// The route is gated to Cycloid members (verifyCycloidMember resolves the
// user's business from D1), so tests seed the caller into a business row.
function seedGateUser(d1: SqliteD1, input: { userId: number; businessId: string }): void {
  const now = Date.now();
  d1.sqlite
    .prepare(
      "INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    )
    .run(input.businessId, `biz-${input.businessId.slice(0, 8)}`, now, now);
  d1.sqlite
    .prepare("INSERT INTO users (id, github_id, login, business_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.userId, 1000 + input.userId, `user-${input.userId}`, input.businessId, now, now);
}

const NOW_ISO = new Date().toISOString();

function seedSession(
  d1: SqliteD1,
  s: {
    sessionId: string;
    ownerUserId: number;
    initiationMode?: string;
    scheduledRuleId?: string | null;
    callbackContextJson?: string | null;
    createdAt?: string;
    businessId?: string;
  },
): void {
  d1.sqlite
    .prepare(
      `INSERT INTO session_index
       (session_id, owner_user_id, business_id, status, created_at, updated_at, initiation_mode, scheduled_rule_id, callback_context_json)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .run(
      s.sessionId,
      s.ownerUserId,
      s.businessId ?? "biz-a",
      s.createdAt ?? NOW_ISO,
      s.createdAt ?? NOW_ISO,
      s.initiationMode ?? "user",
      s.scheduledRuleId ?? null,
      s.callbackContextJson ?? null,
    );
}

function seedUsage(
  d1: SqliteD1,
  input: {
    id: string;
    sessionId: string;
    promptId: string;
    ownerUserId: string;
    cost: number;
    inputTokens: number;
    outputTokens?: number;
    businessId?: string;
  },
): void {
  d1.sqlite
    .prepare(
      `INSERT INTO usage_records
       (id, session_id, prompt_id, owner_user_id, business_id, source, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_micros, created_at)
       VALUES (?, ?, ?, ?, ?, 'sandbox', 'gpt-5.4', ?, ?, 0, 0, ?, ?)`,
    )
    .run(
      input.id,
      input.sessionId,
      input.promptId,
      input.ownerUserId,
      input.businessId ?? "biz-a",
      input.inputTokens,
      input.outputTokens ?? 10,
      input.cost,
      Date.now(),
    );
}

function getRoute(): Route {
  const route = activityRoutes.find((r) => r.method === "GET" && r.pattern.test("/api/activity"));
  if (!route) throw new Error("GET /api/activity not registered");
  return route;
}

async function invoke(env: Env, auth: AuthInfo | null, query = ""): Promise<Response> {
  const route = getRoute();
  const url = `https://example.com/api/activity${query}`;
  const request = new Request(url, { method: "GET" });
  const match = new URL(url).pathname.match(route.pattern);
  return route.handler(request, env, match!, auth);
}

describe("GET /api/activity", () => {
  let d1: SqliteD1;
  let env: Env;
  beforeEach(() => {
    d1 = new SqliteD1();
    env = makeEnv(d1);
    // Default caller (user 42) is a Cycloid member so the internal gate
    // passes; individual tests seed non-members to prove the 403.
    seedGateUser(d1, { userId: 42, businessId: SEEDED_BUSINESS_IDS.cycloid });
  });

  it("returns user activity to an authenticated business member", async () => {
    const res = await invoke(env, makeAuth(), "?scope=user");
    expect(res.status).toBe(200);
  });

  it("rejects non-Cycloid businesses with 403 (internal-only surface)", async () => {
    seedGateUser(d1, { userId: 43, businessId: "biz-external" });
    const res = await invoke(
      env,
      makeAuth({ user: { id: 43, businessId: "biz-external", businessRole: "admin" } as AuthInfo["user"] }),
      "?scope=user",
    );
    expect(res.status).toBe(403);
  });

  it("requires a business admin for organization activity", async () => {
    const res = await invoke(env, makeAuth(), "?scope=organization");
    expect(res.status).toBe(403);
  });

  it("rejects activity without a business membership", async () => {
    const res = await invoke(env, makeAuth({ user: undefined }));
    expect(res.status).toBe(403);
  });

  it("aggregates source counts, usage, and recent events (owner-scoped)", async () => {
    seedSession(d1, { sessionId: "u1", ownerUserId: 42, initiationMode: "user" });
    seedSession(d1, {
      sessionId: "slk",
      ownerUserId: 42,
      initiationMode: "user",
      callbackContextJson: JSON.stringify({ source: "slack", channel: "C1", slackTeamId: "T1" }),
    });
    seedSession(d1, { sessionId: "auto", ownerUserId: 42, initiationMode: "automation", scheduledRuleId: "rule-1" });
    seedSession(d1, { sessionId: "kid", ownerUserId: 42, initiationMode: "child" });
    // Another user's session must NOT be counted.
    seedSession(d1, { sessionId: "other", ownerUserId: 99, initiationMode: "user" });

    seedUsage(d1, {
      id: "usage-1",
      sessionId: "u1",
      promptId: "p1",
      ownerUserId: "42",
      cost: 5_000_000,
      inputTokens: 100,
    });
    seedUsage(d1, {
      id: "usage-2",
      sessionId: "u1",
      promptId: "p2",
      ownerUserId: "42",
      cost: 2_500_000,
      inputTokens: 50,
    });
    seedUsage(d1, {
      id: "usage-other",
      sessionId: "other",
      promptId: "p1",
      ownerUserId: "99",
      cost: 9_000_000,
      inputTokens: 999,
    });

    d1.sqlite
      .prepare(
        `INSERT INTO pr_coordination (session_id, state, pr_url) VALUES ('u1', 'MERGED', 'https://github.com/acme/repo/pull/1')`,
      )
      .run();

    await appendPrCoordinationEvent(d1 as unknown as D1Database, {
      sessionId: "u1",
      version: 1,
      fromState: "PUBLISHING",
      toState: "REVIEW",
      event: "publish.pr_opened",
      at: Date.now() - 500,
      actor: "publish",
      metadata: { type: "publish.pr_opened", diffStats: { insertions: 25, deletions: 5 } },
    });

    const res = await invoke(env, makeAuth());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        windowDays: number;
        scope: string;
        sessionsBySource: { total: number; slack: number; automation: number; child: number; user: number };
        totals: {
          sessions: number;
          sessionsMerged: number;
          sessionsWithFeedback: number;
          feedbackTurns: number;
          costUsdMicros: number;
          inputTokens: number;
          mergedAdditions: number;
          mergedDeletions: number;
        };
        sessions: Array<{ sessionId: string; feedbackTurns: number; prStatus: string; mergedAdditions: number }>;
        recentEvents: Array<{ sessionId: string; event: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.windowDays).toBe(7);
    expect(body.data.scope).toBe("user");
    expect(body.data.sessionsBySource).toEqual({ total: 4, slack: 1, automation: 1, child: 1, user: 1 });
    expect(body.data.totals).toMatchObject({
      sessions: 4,
      sessionsMerged: 1,
      sessionsWithFeedback: 1,
      feedbackTurns: 1,
      costUsdMicros: 7_500_000,
      inputTokens: 150,
      mergedAdditions: 25,
      mergedDeletions: 5,
    });
    expect(body.data.sessions.find((session) => session.sessionId === "u1")).toMatchObject({
      feedbackTurns: 1,
      prStatus: "merged",
      mergedAdditions: 25,
    });
    expect(body.data.recentEvents).toHaveLength(1);
    expect(body.data.recentEvents[0]).toMatchObject({ sessionId: "u1", event: "publish.pr_opened" });
  });

  it("excludes sessions/usage/events outside the look-back window", async () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    seedSession(d1, { sessionId: "old", ownerUserId: 42, createdAt: old });
    seedUsage(d1, {
      id: "usage-old",
      sessionId: "old",
      promptId: "p1",
      ownerUserId: "42",
      cost: 1_000_000,
      inputTokens: 1,
    });

    const res = await invoke(env, makeAuth(), "?windowDays=7");
    const body = (await res.json()) as {
      data: { sessionsBySource: { total: number }; totals: { inputTokens: number } };
    };
    expect(body.data.sessionsBySource.total).toBe(0);
    expect(body.data.totals.inputTokens).toBe(0);

    const res30 = await invoke(env, makeAuth(), "?windowDays=30");
    const body30 = (await res30.json()) as { data: { sessionsBySource: { total: number } } };
    // 40 days old is still outside 30d.
    expect(body30.data.sessionsBySource.total).toBe(0);
  });

  it("returns organization activity for an admin without crossing businesses", async () => {
    seedSession(d1, { sessionId: "a", ownerUserId: 42 });
    seedSession(d1, { sessionId: "b", ownerUserId: 99 });
    seedSession(d1, { sessionId: "other-business", ownerUserId: 100, businessId: "biz-b" });
    const res = await invoke(
      env,
      makeAuth({
        userId: "1",
        canAccessAllSessions: true,
        user: { id: 42, businessId: "biz-a", businessRole: "admin" } as AuthInfo["user"],
      }),
      "?scope=organization",
    );
    const body = (await res.json()) as { data: { scope: string; sessionsBySource: { total: number } } };
    expect(body.data.scope).toBe("organization");
    expect(body.data.sessionsBySource.total).toBe(2);
  });

  it("uses completion outcomes for historical PRs without inventing merged LOC", async () => {
    seedSession(d1, { sessionId: "legacy-merged", ownerUserId: 42 });
    d1.sqlite
      .prepare(
        `INSERT INTO session_completions
         (id, session_id, prompt_id, owner_user_id, business_id, repo_owner, repo_name,
          prompt_text, success, completed_at, pr_url, pr_outcome)
         VALUES ('completion-1', 'legacy-merged', 'p1', 42, 'biz-a', 'acme', 'repo',
                 'Ship it', 1, ?, 'https://github.com/acme/repo/pull/9', 'merged')`,
      )
      .run(Date.now());

    const res = await invoke(env, makeAuth());
    const body = (await res.json()) as {
      data: {
        totals: { sessionsWithPr: number; sessionsMerged: number; mergedLocSessions: number };
        sessions: Array<{ sessionId: string; prStatus: string; mergedAdditions: number | null }>;
      };
    };

    expect(body.data.totals).toMatchObject({ sessionsWithPr: 1, sessionsMerged: 1, mergedLocSessions: 0 });
    expect(body.data.sessions[0]).toMatchObject({
      sessionId: "legacy-merged",
      prStatus: "merged",
      mergedAdditions: null,
    });
  });

  it("rejects an unsupported window with 400", async () => {
    const res = await invoke(env, makeAuth(), "?windowDays=90");
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported scope with 400", async () => {
    const res = await invoke(env, makeAuth(), "?scope=all");
    expect(res.status).toBe(400);
  });
});
