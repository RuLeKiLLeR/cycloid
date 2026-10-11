/**
 * Tests for DO storage write error handling (ARC-364).
 *
 * Verifies that critical storage.put/delete failures are caught, logged,
 * and reported to Sentry rather than silently swallowed.
 */
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sentrySpy = {
  captureException: vi.fn(),
};

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: (...args: unknown[]) => sentrySpy.captureException(...args),
}));

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

const mockPostStructuredEventToDd = vi.fn().mockResolvedValue(undefined);
vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", async () => {
  const actual = await vi.importActual<
    typeof import("../../apps/control-plane-worker/src/observability/events-exporter")
  >("../../apps/control-plane-worker/src/observability/events-exporter");
  return {
    ...actual,
    postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
  };
});

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

class FakeStorage {
  readonly map = new Map<string, unknown>();
  private alarm: number | null = null;
  /** Optional interceptor for put -- throw to simulate failure. */
  putInterceptor: ((key: string, value: unknown) => void) | null = null;
  async get<T>(key: string): Promise<T | undefined>;
  async get(keys: string[]): Promise<Map<string, unknown>>;
  async get<T>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, unknown>> {
    if (Array.isArray(keyOrKeys)) {
      const result = new Map<string, unknown>();
      for (const k of keyOrKeys) {
        if (this.map.has(k)) result.set(k, this.map.get(k));
      }
      return result;
    }
    return this.map.get(keyOrKeys) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (this.putInterceptor) {
      if (typeof keyOrEntries === "string") {
        this.putInterceptor(keyOrEntries, value);
      } else {
        for (const [k, v] of Object.entries(keyOrEntries)) {
          this.putInterceptor(k, v);
        }
      }
    }
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, value);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) {
        this.map.set(k, v);
      }
    }
  }

  async list<T>(
    options: { prefix?: string; start?: string; limit?: number; reverse?: boolean } = {},
  ): Promise<Map<string, T>> {
    let entries = [...this.map.entries()];
    if (options.prefix) entries = entries.filter(([key]) => key.startsWith(options.prefix!));
    if (options.start) entries = entries.filter(([key]) => key >= options.start!);
    entries.sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    if (options.limit != null) entries = entries.slice(0, options.limit);
    return new Map(entries as Array<[string, T]>);
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) {
      for (const key of keyOrKeys) this.map.delete(key);
      return true;
    }
    return this.map.delete(keyOrKeys);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  sql = (() => {
    const db = new Database(":memory:");
    // Mirror Cloudflare's SqlStorageCursor surface: callers rely on `rowsWritten`
    // to detect INSERT-OR-IGNORE collisions (see do-db.ts appendEventsInternal).
    // Omitting it makes those retry loops spin forever, hanging the worker.
    const makeResult = (rows: unknown[], rowsWritten: number) => ({
      toArray: () => rows,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
      rowsRead: rows.length,
      rowsWritten,
    });
    return {
      exec(query: string, ...params: unknown[]) {
        const trimmed = query.trimStart().toUpperCase();
        const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
        if (isSelect) {
          const stmt = db.prepare(query);
          const rows = params.length === 0 ? stmt.all() : stmt.all(...(params as unknown[]));
          return makeResult(rows, 0);
        }
        // Write or DDL. Prefer prepare()/run() so we can report `changes` as
        // rowsWritten. Only prepare() failures fall back to exec() (multi-statement
        // DDL that prepare() rejects); run() errors (bad bindings, type mismatch)
        // must surface as real test failures rather than silently re-running the
        // query parameter-less via exec().
        const stmt = (() => {
          try {
            return db.prepare(query);
          } catch {
            return null;
          }
        })();
        if (stmt === null) {
          // Multi-statement DDL that prepare() rejects.
          db.exec(query);
          return makeResult([], 0);
        }
        const info = params.length === 0 ? stmt.run() : stmt.run(...(params as unknown[]));
        return makeResult([], info.changes);
      },
      get databaseSize() {
        return 0;
      },
    };
  })();
}

class FakeDurableState {
  readonly storage = new FakeStorage();
  readonly id = { toString: () => "fake-do-id" };
  blockConcurrencyWhile = async (fn: () => Promise<unknown>) => {
    await fn();
  };
  waitUntil(_promise: Promise<unknown>): void {}
}

class FakeD1Statement {
  constructor(
    private readonly db: FakeD1,
    private readonly query: string,
  ) {}

  private boundValues: unknown[] = [];

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    if (
      this.query.includes("CREATE TABLE IF NOT EXISTS") ||
      this.query.includes("CREATE INDEX IF NOT EXISTS") ||
      this.query.includes("INSERT INTO session_index") ||
      this.query.includes("INSERT INTO durable_event_replay_metadata") ||
      this.query.includes("INSERT INTO session_webhook_refs") ||
      this.query.includes("DELETE FROM auth_sessions") ||
      this.query.includes("DELETE FROM session_index") ||
      this.query.includes("UPDATE session_index")
    ) {
      return { success: true, meta: { last_row_id: 0 } };
    }
    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (
      this.query.includes("SELECT session_id, prompt_id, stage, attempt_count") &&
      this.query.includes("FROM slack_posts")
    ) {
      return { results: [] };
    }

    if (this.query.includes("FROM session_index")) {
      return { results: [...this.db.sessionIndex.values()] };
    }
    throw new Error(`Unhandled all query: ${this.query}`);
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("SELECT MIN(COALESCE(next_attempt_at, created_at)) AS next_attempt_at")) {
      return null;
    }

    if (this.query.includes("FROM github_installations")) {
      const [ownerLogin] = this.boundValues as [string];
      return this.db.githubInstallations.get(ownerLogin) ?? null;
    }
    if (this.query.includes("FROM auth_sessions")) return null;
    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return session ? { business_id: session.business_id ?? null } : null;
    }
    if (this.query.includes("FROM users WHERE id")) return { business_id: "biz-1" };
    if (this.query.includes("FROM user_settings WHERE user_id")) return null;
    if (this.query.includes("FROM durable_event_replay_metadata")) return null;
    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

class FakeD1 {
  readonly sessionIndex = new Map<string, Record<string, unknown>>();
  readonly githubInstallations = new Map<string, Record<string, unknown>>();

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
};

function createFakeEnv(): { env: Record<string, unknown> } {
  const db = new FakeD1();
  db.githubInstallations.set("test-owner", {
    installation_id: 1,
    owner_login: "test-owner",
    owner_id: 1,
    owner_type: "Organization",
    repository_selection: "all",
    created_at: Date.now(),
    suspended_at: null,
  });

  return {
    env: {
      DB: db,
      WORKER_ENV: "test",
      SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    },
  };
}

function createDO(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
): {
  doInstance: InstanceType<WorkerModule["SessionDO"]>;
  state: FakeDurableState;
} {
  const state = new FakeDurableState();
  const doInstance = new workerModule.SessionDO(state, env) as InstanceType<WorkerModule["SessionDO"]>;
  return { doInstance, state };
}

async function initSession(
  doInstance: InstanceType<WorkerModule["SessionDO"]>,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return doInstance.fetch(
    new Request("https://internal/session/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        ownerUserId: "user-1",
        repoOwner: "test-owner",
        repoName: "test-repo",
        ...overrides,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionDO storage write error handling (ARC-364)", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    sentrySpy.captureException.mockClear();
    mockPostStructuredEventToDd.mockClear();
  });

  describe("session initialization (session.init)", () => {
    it("returns 500 when storage.put fails during batch init write", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);

      // Fail when the batch init writes the ephemeral KV key (session data now goes to SQL)
      state.storage.putInterceptor = (key: string) => {
        if (key === "sandbox_connection_gen") {
          throw new Error("Simulated init storage failure");
        }
      };

      const res = await initSession(doInstance, "s-init-fail");

      expect(res.status).toBe(500);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("storage write error");

      expect(sentrySpy.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Simulated init storage failure" }),
        expect.objectContaining({
          tags: expect.objectContaining({ operation: "session.init" }),
        }),
      );
    });

    it("succeeds when storage.put works normally", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const res = await initSession(doInstance, "s-init-ok");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
      expect(sentrySpy.captureException).not.toHaveBeenCalled();
    });

    it("preserves scheduled provenance for legacy retry payloads without an entrypoint", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);

      const res = await initSession(doInstance, "s-init-legacy-scheduled", {
        initiationMode: "automation",
        scheduledRuleId: "rule-1",
      });

      expect(res.status).toBe(200);
      const [row] = state.storage.sql
        .exec("SELECT entrypoint FROM session WHERE session_id = ?", "s-init-legacy-scheduled")
        .toArray();
      expect(row.entrypoint).toBe("scheduled");
    });

    it("returns 400 (not 500) for an unknown agentRuntimeBackend", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const res = await initSession(doInstance, "s-init-bad-agent-backend", {
        agentRuntimeBackend: "not_a_real_backend",
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid agentRuntimeBackend");
      // Validation happens before the write try/catch, so nothing is reported to Sentry.
      expect(sentrySpy.captureException).not.toHaveBeenCalled();
    });

    it("accepts legacy helper names as metadata-only repo agent overrides", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const res = await initSession(doInstance, "s-init-legacy-agent-names", {
        agentOverrides: {
          compaction: { description: "Compaction metadata", mode: "primary" },
          title: { description: "Title metadata", mode: "primary" },
        },
      });

      expect(res.status).toBe(200);

      const agentsRes = await doInstance.fetch(new Request("https://internal/session/agents"));
      expect(agentsRes.status).toBe(200);
      const body = (await agentsRes.json()) as {
        agents: Record<string, { name: string; description: string; mode: string }>;
      };
      expect(body.agents.compaction).toStrictEqual({
        name: "compaction",
        description: "Compaction metadata",
        mode: "primary",
      });
      expect(body.agents.title).toStrictEqual({
        name: "title",
        description: "Title metadata",
        mode: "primary",
      });
    });

    it("ignores stale legacy KV session data and initializes fresh SQL state", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);

      await state.storage.put("session", {
        sessionId: "s-init-legacy",
        ownerUserId: "user-1",
        status: "active",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        closedAt: null,
        lastEventId: null,
        title: null,
      });

      const res = await initSession(doInstance, "s-init-legacy");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; session: { sessionId: string } };
      expect(body.ok).toBe(true);
      expect(body.session.sessionId).toBe("s-init-legacy");

      const rows = state.storage.sql.exec("SELECT * FROM session WHERE session_id = ?", "s-init-legacy").toArray();
      expect(rows).toHaveLength(1);
    });
  });

  describe("session close (SQL-based)", () => {
    it("succeeds when close writes go through SQL (no longer uses KV durableWrite)", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);

      // Create session successfully first
      const initRes = await initSession(doInstance, "s-close-ok");
      expect(initRes.status).toBe(200);

      // KV putInterceptor should NOT affect close path since session data is now in SQL
      state.storage.putInterceptor = (key: string) => {
        if (key === "session") {
          throw new Error("Simulated close storage failure");
        }
      };

      const closeRes = await doInstance.fetch(
        new Request("https://internal/session/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "user_archived" }),
        }),
      );
      expect(closeRes.status).toBe(200);
      const body = (await closeRes.json()) as { ok: boolean; session: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.session.status).toBe("archived");
    });

    it("emits a session.completed telemetry log when the session closes", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const initRes = await initSession(doInstance, "s-close-telemetry");
      expect(initRes.status).toBe(200);

      const infoSpy = vi.spyOn((doInstance as unknown as { log: { info: (...args: unknown[]) => void } }).log, "info");
      mockPostStructuredEventToDd.mockClear();

      const closeRes = await doInstance.fetch(
        new Request("https://internal/session/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "user_archived" }),
        }),
      );
      expect(closeRes.status).toBe(200);

      const completionCall = infoSpy.mock.calls.find((call) => {
        const first = (call as unknown[])[0] as Record<string, unknown> | undefined;
        return first?.event === "session.completed";
      });
      expect(completionCall).toBeDefined();
      const payload = (completionCall as unknown[])[0] as Record<string, unknown>;
      expect(payload.sessionId).toBe("s-close-telemetry");
      expect(payload.ownerUserId).toBe("user-1");
      expect(payload.status).toBe("archived");
      expect(payload.prCreated).toBe(false);
      expect(payload.repo).toBe("test-owner/test-repo");
      expect(payload.terminalStage).toBe("no_prompts");
      expect(payload.promptCount).toBe(0);
      expect(payload.completedPromptCount).toBe(0);
      expect(payload.failedPromptCount).toBe(0);
      expect(typeof payload.duration_ms === "number" || payload.duration_ms === null).toBe(true);
      expect(payload.activeDurationMs).toBe(0);

      // Must also direct-POST to Datadog; otherwise @event:session.completed is not
      // indexed on CF Worker console logs (see verification for #2166).
      const ddCall = mockPostStructuredEventToDd.mock.calls.find((call) => {
        const eventArg = (call as unknown[])[1] as Record<string, unknown> | undefined;
        return eventArg?.event === "session.completed";
      });
      expect(ddCall).toBeDefined();
      const ddPayload = (ddCall as unknown[])[1] as Record<string, unknown>;
      expect(ddPayload.sessionId).toBe("s-close-telemetry");
      expect(ddPayload.terminalStage).toBe("no_prompts");
      expect(ddPayload.repo).toBe("test-owner/test-repo");
    });

    it("emits activeDurationMs as prompt processing time instead of session lifetime", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const initRes = await initSession(doInstance, "s-close-active-duration");
      expect(initRes.status).toBe(200);

      const baseMs = Date.now() - 60_000;
      const sql = (doInstance as unknown as { sql: { exec: (query: string, ...params: unknown[]) => unknown } }).sql;
      sql.exec("UPDATE session SET created_at = ? WHERE session_id = ?", baseMs, "s-close-active-duration");
      sql.exec(
        `INSERT INTO prompts (
          prompt_id, session_id, prompt_text, actor_user_id, status,
          created_at, started_at, completed_at, updated_at, queue_position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "p-active-duration",
        "s-close-active-duration",
        "Run a focused test",
        "user-1",
        "completed",
        baseMs + 500,
        baseMs + 1_000,
        baseMs + 6_000,
        baseMs + 6_000,
        0,
      );

      mockPostStructuredEventToDd.mockClear();

      const closeRes = await doInstance.fetch(
        new Request("https://internal/session/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "user_archived" }),
        }),
      );
      expect(closeRes.status).toBe(200);

      const ddCall = mockPostStructuredEventToDd.mock.calls.find((call) => {
        const eventArg = (call as unknown[])[1] as Record<string, unknown> | undefined;
        return eventArg?.event === "session.completed";
      });
      expect(ddCall).toBeDefined();
      const ddPayload = (ddCall as unknown[])[1] as Record<string, unknown>;
      expect(ddPayload.activeDurationMs).toBe(5_000);
      expect(ddPayload.duration_ms).toEqual(expect.any(Number));
      expect(ddPayload.activeDurationMs as number).toBeLessThan(ddPayload.duration_ms as number);
    });

    it("emits session.stage_timing telemetry as wall-clock prompt processing plus unattributed time", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const initRes = await initSession(doInstance, "s-close-stage-timing");
      expect(initRes.status).toBe(200);

      const baseMs = Date.parse("2026-07-01T00:00:00.000Z");
      const sql = (doInstance as unknown as { sql: { exec: (query: string, ...params: unknown[]) => unknown } }).sql;
      sql.exec("UPDATE session SET created_at = ? WHERE session_id = ?", baseMs, "s-close-stage-timing");
      sql.exec(
        `INSERT INTO prompts (
          prompt_id, session_id, prompt_text, actor_user_id, status,
          created_at, started_at, completed_at, updated_at, queue_position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "p-stage-timing-1",
        "s-close-stage-timing",
        "First prompt",
        "user-1",
        "completed",
        baseMs + 500,
        baseMs + 1_000,
        baseMs + 7_000,
        baseMs + 7_000,
        0,
      );
      sql.exec(
        `INSERT INTO prompts (
          prompt_id, session_id, prompt_text, actor_user_id, status,
          created_at, started_at, completed_at, updated_at, queue_position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "p-stage-timing-2",
        "s-close-stage-timing",
        "Second prompt",
        "user-1",
        "completed",
        baseMs + 4_000,
        baseMs + 5_000,
        baseMs + 12_000,
        baseMs + 12_000,
        1,
      );

      mockPostStructuredEventToDd.mockClear();

      const closeRes = await doInstance.fetch(
        new Request("https://internal/session/close", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "test close" }),
        }),
      );
      expect(closeRes.status).toBe(200);

      const stagePayloads = mockPostStructuredEventToDd.mock.calls
        .map((call) => (call as unknown[])[1] as Record<string, unknown> | undefined)
        .filter((event): event is Record<string, unknown> => event?.event === "session.stage_timing");
      const completionPayload = mockPostStructuredEventToDd.mock.calls
        .map((call) => (call as unknown[])[1] as Record<string, unknown> | undefined)
        .find((event): event is Record<string, unknown> => event?.event === "session.completed");

      expect(stagePayloads).toHaveLength(2);
      expect(completionPayload).toBeDefined();

      const promptProcessingPayload = stagePayloads.find((payload) => payload.stage === "prompt_processing");
      const unattributedPayload = stagePayloads.find((payload) => payload.stage === "unattributed");
      expect(promptProcessingPayload).toBeDefined();
      expect(unattributedPayload).toBeDefined();

      const totalDurationMs = completionPayload?.duration_ms as number;
      expect(totalDurationMs).toEqual(expect.any(Number));
      expect(promptProcessingPayload).toMatchObject({
        sessionId: "s-close-stage-timing",
        stage: "prompt_processing",
        duration_ms: 11_000,
        total_duration_ms: totalDurationMs,
        repo: "test-owner/test-repo",
        terminalStage: "prompt_completed_no_pr",
      });
      expect(unattributedPayload).toMatchObject({
        sessionId: "s-close-stage-timing",
        stage: "unattributed",
        duration_ms: totalDurationMs - 11_000,
        total_duration_ms: totalDurationMs,
        repo: "test-owner/test-repo",
        terminalStage: "prompt_completed_no_pr",
      });
    });

    it("emits repo and owner tags on sandbox.ready telemetry", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);

      const initRes = await initSession(doInstance, "s-sandbox-ready-tags");
      expect(initRes.status).toBe(200);

      const now = Date.parse("2026-07-01T00:00:10.000Z");
      const sql = (doInstance as unknown as { sql: { exec: (query: string, ...params: unknown[]) => unknown } }).sql;
      sql.exec("UPDATE session SET created_at = ? WHERE session_id = ?", now - 20_000, "s-sandbox-ready-tags");
      sql.exec(
        "UPDATE sandbox_state SET sandbox_id = ?, spawn_started_at = ? WHERE session_id = ?",
        "sbx-ready-tags",
        now - 5_000,
        "s-sandbox-ready-tags",
      );

      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
      mockPostStructuredEventToDd.mockClear();

      try {
        await (
          doInstance as unknown as {
            putSandboxStatus(sessionId: string, status: string): Promise<void>;
          }
        ).putSandboxStatus("s-sandbox-ready-tags", "ready");
      } finally {
        dateNowSpy.mockRestore();
      }

      const ddCall = mockPostStructuredEventToDd.mock.calls.find((call) => {
        const eventArg = (call as unknown[])[1] as Record<string, unknown> | undefined;
        return eventArg?.event === "sandbox.ready";
      });
      expect(ddCall).toBeDefined();

      const ddPayload = (ddCall as unknown[])[1] as Record<string, unknown>;
      expect(ddPayload.repo).toBe("test-owner/test-repo");
      expect(ddPayload.ownerUserId).toBe("user-1");
      expect(ddPayload.owner_user_id).toBe("user-1");
      expect(ddPayload.sandbox_id).toBe("sbx-ready-tags");
      expect(ddPayload.session_creation_to_sandbox_ready_ms).toBe(20_000);
      expect(ddPayload.spawn_duration_ms).toBe(5_000);
    });

    it("direct-posts platform prompt status refusal telemetry", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);

      const initRes = await initSession(doInstance, "s-platform-refusal");
      expect(initRes.status).toBe(200);

      state.storage.sql.exec(
        `INSERT INTO platform_llm_prompt_status (prompt_id, session_id, status, updated_at, started_at)
         VALUES (?, ?, ?, ?, ?)`,
        "prompt-1",
        "s-platform-refusal",
        "terminal",
        1000,
        null,
      );
      const infoSpy = vi.spyOn((doInstance as unknown as { log: { info: (...args: unknown[]) => void } }).log, "info");

      const result = (
        doInstance as unknown as {
          markPlatformLlmPromptStatus(
            sessionId: string,
            promptId: string,
            status: "executing",
            now?: number,
          ): { accepted: boolean; reason?: string; observedStatus?: string | null };
        }
      ).markPlatformLlmPromptStatus("s-platform-refusal", "prompt-1", "executing", 2000);

      expect(result).toEqual({ accepted: false, reason: "stale_prior", observedStatus: "terminal" });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "platform_llm_prompt_status_refused",
          sessionId: "s-platform-refusal",
          promptId: "prompt-1",
          targetStatus: "executing",
          observedStatus: "terminal",
          reason: "stale_prior",
        }),
        expect.any(String),
      );
      expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          event: "platform_llm_prompt_status_refused",
          sessionId: "s-platform-refusal",
          promptId: "prompt-1",
          targetStatus: "executing",
          observedStatus: "terminal",
          reason: "stale_prior",
        }),
      );
    });
  });

  describe("auto-close alarm (SQL-based)", () => {
    it("logs and returns when alarm fires before a SQL-backed session exists", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);
      const warnSpy = vi.spyOn((doInstance as unknown as { log: { warn: (...args: unknown[]) => void } }).log, "warn");

      await expect(doInstance.alarm()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith({}, "alarm() fired with no session in SQL -- skipping");
    });

    it("auto-stops session via alarm when auto_close_scheduled_at is set", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);

      // Create session
      const initRes = await initSession(doInstance, "s-autoclose-ok");
      expect(initRes.status).toBe(200);

      // Set up auto-close state via SQL (no longer uses KV)
      state.storage.sql.exec(
        "UPDATE sandbox_state SET auto_close_scheduled_at = ? WHERE session_id = ?",
        Date.now() - 1000,
        "s-autoclose-ok",
      );
      // session.active_prompt_id was dropped in DO migration 70; the derived
      // active prompt id reads from prompts.status. No setup needed -- with
      // no processing prompt seeded, the derived helper returns null.

      // alarm() should auto-stop the session without error
      await doInstance.alarm();

      // Verify session remains active while sandbox state moves to stopped
      const sessionRow = state.storage.sql
        .exec("SELECT status FROM session WHERE session_id = ?", "s-autoclose-ok")
        .toArray()[0] as Record<string, unknown>;
      expect(sessionRow.status).toBe("active");
      const sandboxRow = state.storage.sql
        .exec("SELECT status, auto_close_scheduled_at FROM sandbox_state WHERE session_id = ?", "s-autoclose-ok")
        .toArray()[0] as Record<string, unknown>;
      expect(sandboxRow.status).toBe("stopped");
      expect(sandboxRow.auto_close_scheduled_at).toBeNull();
    });
  });

  // A transiently-missing local session row derives to rich_status "archived",
  // and buildSyncRichStatusStatement force-flips session_index.status='archived'
  // for that string. That coupling stranded a live Slack-initiated session as a
  // false archive (D1 archived / FSM still GENERATING / sandbox alive). The
  // projection write path must skip a missing row rather than project it.
  describe("rich_status projection guard (false-archive prevention)", () => {
    type ProjectionInternals = {
      // Signature mirrors the plan-gate seam: the projection write now also carries
      // the plan-approval pending flag + plan status (dormant sessions => false/"none").
      persistRichStatusToD1: (
        sessionId: string,
        richStatus: string,
        planApprovalPending: boolean,
        planStatus: string,
      ) => Promise<void>;
      runPersistCurrentRichStatus: (sessionId: string, cause: string) => Promise<string>;
    };

    it("writes the projection when the local session row is present", async () => {
      const { env } = createFakeEnv();
      const { doInstance } = createDO(workerModule, env);
      await initSession(doInstance, "s-present");

      const internals = doInstance as unknown as ProjectionInternals;
      const writeSpy = vi.spyOn(internals, "persistRichStatusToD1").mockResolvedValue(undefined);

      await internals.runPersistCurrentRichStatus("s-present", "test");

      // Plan-free session: dormant plan-approval flag (false) + plan status "none",
      // which keeps the D1 UPDATE byte-identical to the pre-gate statement.
      expect(writeSpy).toHaveBeenCalledWith("s-present", expect.any(String), false, "none");
    });

    it("skips the projection write when the local session row is missing (no false archive)", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);
      await initSession(doInstance, "s-missing");

      // Simulate the startup/hydration race: the local session row is transiently
      // absent when a projection runs (before the bridge connects).
      state.storage.sql.exec("DELETE FROM session WHERE session_id = ?", "s-missing");

      const internals = doInstance as unknown as ProjectionInternals;
      const writeSpy = vi.spyOn(internals, "persistRichStatusToD1").mockResolvedValue(undefined);

      await internals.runPersistCurrentRichStatus("s-missing", "test");

      expect(writeSpy).not.toHaveBeenCalled();
    });

    it("still projects the archived pill for a genuine archive (present, archived row)", async () => {
      const { env } = createFakeEnv();
      const { doInstance, state } = createDO(workerModule, env);
      await initSession(doInstance, "s-archived");

      // Genuine archive keeps the row present with status='archived' (mirrors
      // closeSessionAtDurabilityBoundary setting DO memory before it projects).
      state.storage.sql.exec("UPDATE session SET status = 'archived' WHERE session_id = ?", "s-archived");

      const internals = doInstance as unknown as ProjectionInternals;
      const writeSpy = vi.spyOn(internals, "persistRichStatusToD1").mockResolvedValue(undefined);

      await internals.runPersistCurrentRichStatus("s-archived", "test");

      // Archived pill still projected; plan-free session => dormant flag + "none".
      expect(writeSpy).toHaveBeenCalledWith("s-archived", "archived", false, "none");
    });
  });
});
