import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionRoutes } from "../../apps/control-plane-worker/src/routes/sessions";
import type { AuthInfo, Env } from "../../apps/control-plane-worker/src/types";

class FakeD1BoundStatement {
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
    private readonly boundValues: unknown[],
  ) {}

  async run(): Promise<{ success: true }> {
    const [sessionId] = this.boundValues as [string];

    if (this.query.includes("DELETE FROM session_index WHERE session_id = ?")) {
      this.db.sessionIndex.delete(sessionId);
      return { success: true };
    }
    if (this.query.includes("DELETE FROM durable_event_replay_metadata WHERE session_id = ?")) {
      this.db.replayMetadata.delete(sessionId);
      return { success: true };
    }
    if (this.query.includes("DELETE FROM session_webhook_refs WHERE session_id = ?")) {
      this.db.sessionWebhookRefs.delete(sessionId);
      return { success: true };
    }
    if (this.query.includes("DELETE FROM slack_thread_session_refs WHERE session_id = ?")) {
      this.db.slackThreadRefs.delete(sessionId);
      return { success: true };
    }
    if (this.query.includes("DELETE FROM linear_issue_session_refs WHERE session_id = ?")) {
      this.db.linearIssueRefs.delete(sessionId);
      return { success: true };
    }

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async first<T>(): Promise<T | null> {
    const [sessionId] = this.boundValues as [string];

    if (
      this.query.includes("SELECT owner_user_id, business_id FROM session_index WHERE session_id = ? LIMIT 1") ||
      this.query.includes(
        "SELECT owner_user_id, business_id, repo_owner, repo_name FROM session_index WHERE session_id = ? LIMIT 1",
      )
    ) {
      const row = this.db.sessionIndex.get(sessionId);
      return row
        ? ({
            owner_user_id: row.owner_user_id,
            business_id: row.business_id,
            repo_owner: null,
            repo_name: null,
          } as T)
        : null;
    }

    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

class FakeD1Statement {
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): FakeD1BoundStatement {
    return new FakeD1BoundStatement(this.db, this.query, values);
  }
}

class FakeD1 {
  sessionIndex = new Map<string, { owner_user_id: number; business_id: string | null }>();
  replayMetadata = new Map<string, { session_id: string }>();
  sessionWebhookRefs = new Map<string, { session_id: string }>();
  slackThreadRefs = new Map<string, { session_id: string }>();
  linearIssueRefs = new Map<string, { session_id: string }>();
  sessionFeedback = new Map<string, { session_id: string }>();
  usageRecords = new Map<string, { session_id: string }>();
  promptRuns = new Map<string, { session_id: string }>();
  sessionCompletions = new Map<string, { session_id: string }>();
  sessionEvaluations = new Map<string, { session_id: string }>();
  sessionMemoryUsage = new Map<string, { session_id: string }>();
  memoryAnalysisJobs = new Map<string, { session_id: string }>();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1BoundStatement[]): Promise<Array<{ success: true }>> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class FakeExecutionContext implements ExecutionContext {
  private readonly tracked = new Set<Promise<unknown>>();

  waitUntil(promise: Promise<unknown>): void {
    this.tracked.add(promise);
    promise.finally(() => {
      this.tracked.delete(promise);
    });
  }

  passThroughOnException(): void {}

  async flush(): Promise<void> {
    while (this.tracked.size > 0) {
      await Promise.all([...this.tracked]);
    }
  }
}

function createMissingSessionNamespace() {
  return {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch() {
          return new Response(JSON.stringify({ ok: false, error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        },
      };
    },
  };
}

function createAuth(userId: string, canAccessAllSessions = false): AuthInfo {
  return {
    userId,
    tokenSource: "session",
    authMode: "session",
    canAccessAllSessions,
    user: {
      id: Number(userId),
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId: "biz-1",
      sharedSessions: false,
      businessMemberIds: [],
    },
  };
}

function createSharedSessionMemberAuth(userId: string, businessMemberIds: string[]): AuthInfo {
  return {
    userId,
    tokenSource: "session",
    authMode: "session",
    canAccessAllSessions: false,
    user: {
      id: Number(userId),
      login: `user-${userId}`,
      name: null,
      email: null,
      businessId: "biz-1",
      sharedSessions: true,
      businessMemberIds,
    },
  };
}

function createEnv(db: FakeD1): Env {
  return {
    DB: db as unknown as D1Database,
    SESSION: createMissingSessionNamespace() as unknown as Env["SESSION"],
  } as Env;
}

function getSessionViewRoute() {
  const route = sessionRoutes.find(
    (candidate) =>
      candidate.method === "GET" &&
      String(candidate.pattern) === String(/^\/api\/sessions\/(?<sessionId>[^/]+)\/view$/),
  );
  if (!route) throw new Error("Session view route not found");
  return route;
}

function seedOrphanedSession(db: FakeD1, sessionId: string, ownerUserId: number) {
  db.sessionIndex.set(sessionId, { owner_user_id: ownerUserId, business_id: "biz-1" });
  db.replayMetadata.set(sessionId, { session_id: sessionId });
  db.sessionWebhookRefs.set(sessionId, { session_id: sessionId });
  db.slackThreadRefs.set(sessionId, { session_id: sessionId });
  db.linearIssueRefs.set(sessionId, { session_id: sessionId });
  db.sessionFeedback.set(sessionId, { session_id: sessionId });
  db.usageRecords.set(sessionId, { session_id: sessionId });
  db.promptRuns.set(sessionId, { session_id: sessionId });
  db.sessionCompletions.set(sessionId, { session_id: sessionId });
  db.sessionEvaluations.set(sessionId, { session_id: sessionId });
  db.sessionMemoryUsage.set(sessionId, { session_id: sessionId });
  db.memoryAnalysisJobs.set(sessionId, { session_id: sessionId });
}

describe("session orphan cleanup route", () => {
  const route = getSessionViewRoute();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("cleans up orphaned D1 rows for the session owner after a view 404", async () => {
    const db = new FakeD1();
    const env = createEnv(db);
    const ctx = new FakeExecutionContext();
    const sessionId = "s-orphaned-owner";
    seedOrphanedSession(db, sessionId, 1);

    const path = `/api/sessions/${sessionId}/view`;
    const match = route.pattern.exec(path);
    expect(match).toBeTruthy();

    const response = await route.handler(new Request(`https://worker.test${path}`), env, match!, createAuth("1"), ctx);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Session not found" });

    await ctx.flush();

    expect(db.sessionIndex.has(sessionId)).toBe(false);
    expect(db.replayMetadata.has(sessionId)).toBe(false);
    expect(db.sessionWebhookRefs.has(sessionId)).toBe(false);
    expect(db.slackThreadRefs.has(sessionId)).toBe(false);
    expect(db.linearIssueRefs.has(sessionId)).toBe(false);

    expect(db.sessionFeedback.has(sessionId)).toBe(true);
    expect(db.usageRecords.has(sessionId)).toBe(true);
    expect(db.promptRuns.has(sessionId)).toBe(true);
    expect(db.sessionCompletions.has(sessionId)).toBe(true);
    expect(db.sessionEvaluations.has(sessionId)).toBe(true);
    expect(db.sessionMemoryUsage.has(sessionId)).toBe(true);
    expect(db.memoryAnalysisJobs.has(sessionId)).toBe(true);
  });

  it("does not clean up orphaned rows when the caller does not own the session", async () => {
    const db = new FakeD1();
    const env = createEnv(db);
    const ctx = new FakeExecutionContext();
    const sessionId = "s-orphaned-other-user";
    seedOrphanedSession(db, sessionId, 1);

    const path = `/api/sessions/${sessionId}/view`;
    const match = route.pattern.exec(path);
    expect(match).toBeTruthy();

    const response = await route.handler(new Request(`https://worker.test${path}`), env, match!, createAuth("2"), ctx);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Session not found" });

    await ctx.flush();

    expect(db.sessionIndex.has(sessionId)).toBe(true);
    expect(db.replayMetadata.has(sessionId)).toBe(true);
    expect(db.sessionWebhookRefs.has(sessionId)).toBe(true);
    expect(db.slackThreadRefs.has(sessionId)).toBe(true);
    expect(db.linearIssueRefs.has(sessionId)).toBe(true);
  });

  it("cleans up orphaned rows when the caller has shared-session access to the owner", async () => {
    const db = new FakeD1();
    const env = createEnv(db);
    const ctx = new FakeExecutionContext();
    const sessionId = "s-orphaned-shared-member";
    seedOrphanedSession(db, sessionId, 1);

    const path = `/api/sessions/${sessionId}/view`;
    const match = route.pattern.exec(path);
    expect(match).toBeTruthy();

    const response = await route.handler(
      new Request(`https://worker.test${path}`),
      env,
      match!,
      createSharedSessionMemberAuth("2", ["1", "2"]),
      ctx,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "Session not found" });

    await ctx.flush();

    expect(db.sessionIndex.has(sessionId)).toBe(false);
    expect(db.replayMetadata.has(sessionId)).toBe(false);
    expect(db.sessionWebhookRefs.has(sessionId)).toBe(false);
    expect(db.slackThreadRefs.has(sessionId)).toBe(false);
    expect(db.linearIssueRefs.has(sessionId)).toBe(false);
  });
});
