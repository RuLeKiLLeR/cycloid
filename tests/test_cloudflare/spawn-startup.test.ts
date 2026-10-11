/**
 * Tests for faster session startup changes:
 * - Spawn deduplication (prompt enqueue skips spawn when /warm already triggered one)
 * - Spawn failure cleanup (sandbox_status resets to "stopped" on failure)
 * - Batched DO storage puts during session initialization
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { BaseFakeD1Statement, batchFakeD1Statements } from "./helpers/fake-d1";
import { createWorkerTestEnv, seedGithubInstallation } from "./helpers/worker-env";
import { mockCloudflareWorkers, mockSentryCloudflare, workerFetch, type WorkerModule } from "./helpers/worker-harness";

const DEFAULT_REPO_URL = "https://github.com/test-owner/test-repo";

mockCloudflareWorkers();
mockSentryCloudflare();

class FakeSessionIndexRow {
  constructor(
    public session_id: string,
    public owner_user_id: string,
    public business_id: string | null,
    public status: string,
    public created_at: string,
    public updated_at: string,
    public closed_at: string | null,
    public last_event_id: string | null,
  ) {}
}

class FakeReplayRow {
  constructor(
    public session_id: string,
    public last_event_sequence: number,
    public last_event_timestamp: string | null,
    public updated_at: string | null,
  ) {}
}

class FakeD1Statement extends BaseFakeD1Statement<FakeD1> {
  async run(): Promise<{ success: true; meta?: { changes: number } }> {
    if (this.isSchemaQuery()) return { success: true };

    if (this.query.includes("INSERT INTO session_index")) {
      const [sessionId, ownerUserId, businessId, status, createdAt, updatedAt, closedAt, lastEventId] = this
        .boundValues as [string, string, string | null, string, string, string, string | null, string | null];
      const resolvedBusinessId = businessId ?? this.db.users.get(Number(ownerUserId))?.business_id ?? null;
      this.db.sessionIndex.set(
        sessionId,
        new FakeSessionIndexRow(
          sessionId,
          ownerUserId,
          resolvedBusinessId,
          status,
          createdAt,
          updatedAt,
          closedAt,
          lastEventId,
        ),
      );
      return { success: true };
    }

    if (this.query.includes("INSERT INTO durable_event_replay_metadata")) {
      const [sessionId, sequence, eventTimestamp, updatedAt] = this.boundValues as [
        string,
        number,
        string | null,
        string | null,
      ];
      this.db.replay.set(sessionId, new FakeReplayRow(sessionId, sequence, eventTimestamp, updatedAt));
      return { success: true };
    }

    if (this.query.includes("INSERT OR IGNORE INTO integration_lifecycle_events")) return { success: true };
    if (this.query.includes("INSERT INTO session_webhook_refs")) return { success: true };
    if (this.query.includes("INSERT INTO slack_thread_session_refs")) return { success: true, meta: { changes: 1 } };
    if (this.query.includes("INSERT INTO linear_issue_session_refs")) return { success: true };
    if (this.query.includes("INTO webhook_idempotency")) return { success: true, meta: { changes: 1 } };
    if (this.query.includes("INSERT INTO user_integrations")) return { success: true };
    if (this.query.includes("INSERT INTO prompt_runs")) return { success: true };
    if (this.query.includes("DELETE FROM")) return { success: true };
    if (this.query.includes("UPDATE")) return { success: true };

    throw new Error(`Unhandled run query: ${this.query}`);
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.query.includes("FROM user_integrations")) {
      const [userIdRaw, integrationId] = this.boundValues as [number | string, string | undefined];
      const userId = Number(userIdRaw);
      if (integrationId === "openai" || this.query.includes("integration_id IN (")) {
        return {
          results: [
            {
              integration_id: "openai",
              oauth_access_token: null,
              oauth_refresh_token: null,
              oauth_expires_at: null,
              api_key: `sk-openai-test-${userId}`,
              service_url: null,
              encrypted: 0,
              last_validation_status: "validated",
            },
          ],
        };
      }
      return { results: [] };
    }
    if (this.query.includes("FROM business_integrations")) return { results: [] };
    if (this.query.includes("FROM session_index")) {
      const rows = [...this.db.sessionIndex.values()];
      return { results: rows.map((r) => ({ ...r })) };
    }
    if (this.query.includes("FROM session_completions")) return { results: [] };
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
    if (this.query.includes("FROM durable_event_replay_metadata")) {
      const [sessionId] = this.boundValues as [string];
      return (this.db.replay.get(sessionId) as unknown as Record<string, unknown>) ?? null;
    }
    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      return this.db.authTokens.get(token) ?? null;
    }
    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return session ? { business_id: session.business_id } : null;
    }
    if (this.query.includes("FROM users WHERE id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      return {
        id: userId,
        login: `user-${userId}`,
        name: null,
        email: null,
        business_id: "biz-1",
      };
    }
    if (this.query.includes("FROM user_integrations") && this.query.includes("oauth_access_token")) {
      return {
        oauth_access_token: "ghp_test",
        oauth_refresh_token: null,
        oauth_expires_at: null,
        encrypted: 0,
      };
    }
    if (this.query.includes("FROM user_integrations")) {
      const [userIdRaw, integrationId] = this.boundValues as [number | string, string | undefined];
      if (integrationId === "openai") {
        return {
          api_key: `sk-openai-test-${Number(userIdRaw)}`,
          encrypted: 0,
          last_validation_status: "validated",
        };
      }
      return null;
    }
    if (this.query.includes("FROM user_settings")) {
      const [userId] = this.boundValues as [number];
      return {
        user_id: userId,
      };
    }
    if (this.query.includes("FROM business_members")) return null;
    if (this.query.includes("FROM business_integrations")) return null;
    if (this.query.includes("SELECT shared_sessions FROM businesses")) return { shared_sessions: 0 };
    if (this.query.includes("codex_byos_enabled")) {
      const [businessId] = this.boundValues as [string];
      return { codex_byos_enabled: businessId === SEEDED_BUSINESS_IDS.cycloid ? 1 : 0 };
    }
    return this.unhandled("first");
  }
}

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
};

class FakeD1 {
  readonly sessionIndex = new Map<string, FakeSessionIndexRow>();
  readonly replay = new Map<string, FakeReplayRow>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly githubInstallations = new Map<string, Record<string, unknown>>();
  readonly users = new Map<number, { business_id: string | null }>();

  setAuthToken(token: string, user: AuthTokenUser): void {
    this.authTokens.set(token, user);
    this.users.set(user.id, { business_id: "biz-1" });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return batchFakeD1Statements(statements);
  }
}

function createWorkerEnv(workerModule: WorkerModule) {
  const db = new FakeD1();
  const { env, sessionNs } = createWorkerTestEnv(workerModule, {
    db,
    sqlStorage: true,
  });
  expect(env.E2B_API_KEY).toBeUndefined();
  expect(env.E2B_SANDBOX_TEMPLATE).toBeUndefined();

  seedGithubInstallation(db, "test-owner", 1);

  return { env, db, ns: sessionNs };
}

let workerModule: WorkerModule;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  workerModule = (await import("../../apps/control-plane-worker/src/index.ts")) as unknown as WorkerModule;
});

beforeEach(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    if (url.includes("api.github.com/repos/")) {
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
    return originalFetch(input, init);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Batched DO storage puts during session initialization
// ---------------------------------------------------------------------------
describe("batched session initialization puts", () => {
  it("initializes all session state in a single batch put", async () => {
    const { env, ns } = createWorkerEnv(workerModule);

    // Create session
    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
      body: JSON.stringify({
        sessionId: "s-batch-1",
        ownerUserId: "1001",
        repoUrl: DEFAULT_REPO_URL,
        baseBranch: "main",
        installationId: 42,
      }),
    });
    expect(createRes.status).toBe(201);

    // Verify all expected state was stored (now in SQL tables, not KV)
    const state = ns._getState("s-batch-1")!;
    const sql = state.storage.sql;

    // Session row exists with correct fields
    const sessionRow = sql.exec("SELECT * FROM session WHERE session_id = ?", "s-batch-1").toArray()[0] as Record<
      string,
      unknown
    >;
    expect(sessionRow).toBeDefined();
    expect(sessionRow.owner_user_id).toBeDefined();
    expect(sessionRow.status).toBe("active");
    // active_prompt_id was dropped in DO migration 70; the derived active
    // prompt id is null for a freshly-created session (no prompts yet).
    expect(sessionRow.active_prompt_id).toBeUndefined();
    expect(sessionRow.prompt_counter).toBe(0);
    expect(sessionRow.resolved_agents_json).toBeDefined();
    expect(sessionRow.repo_owner).toBe("test-owner");
    expect(sessionRow.repo_name).toBe("test-repo");
    expect(sessionRow.base_branch).toBe("main");
    // installation_id is resolved from the GitHub installations table, not the request body
    expect(sessionRow.installation_id).toBe(1);

    // Prompts table should be empty
    const prompts = sql.exec("SELECT * FROM prompts WHERE session_id = ?", "s-batch-1").toArray();
    expect(prompts).toEqual([]);

    // Sandbox state row should exist
    const sandboxRow = sql.exec("SELECT * FROM sandbox_state WHERE session_id = ?", "s-batch-1").toArray()[0];
    expect(sandboxRow).toBeDefined();
  });

  it("omits optional fields when not provided", async () => {
    const { env, ns } = createWorkerEnv(workerModule);

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
      body: JSON.stringify({ sessionId: "s-batch-2", ownerUserId: "1001", repoUrl: DEFAULT_REPO_URL }),
    });
    expect(createRes.status).toBe(201);

    const state = ns._getState("s-batch-2")!;

    // Core fields present (now in SQL)
    const sql = state.storage.sql;
    const sessionRow = sql.exec("SELECT * FROM session WHERE session_id = ?", "s-batch-2").toArray()[0] as Record<
      string,
      unknown
    >;
    expect(sessionRow).toBeDefined();
    const prompts = sql.exec("SELECT * FROM prompts WHERE session_id = ?", "s-batch-2").toArray();
    expect(prompts).toEqual([]);

    // repo_owner and repo_name are derived from URL and stored
    expect(sessionRow.repo_owner).toBe("test-owner");
    expect(sessionRow.repo_name).toBe("test-repo");
  });

  it("accepts a legacy cold:true body field without persisting any warm-pool skip flag", async () => {
    // The warm sandbox pool was removed (all sessions cold-spawn), so `cold` is
    // accepted for backward compatibility but no longer has any effect.
    const { env, ns } = createWorkerEnv(workerModule);

    const createRes = await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
      body: JSON.stringify({
        sessionId: "s-cold-1",
        ownerUserId: "1001",
        repoUrl: DEFAULT_REPO_URL,
        cold: true,
      }),
    });
    expect(createRes.status).toBe(201);

    const state = ns._getState("s-cold-1")!;
    const skipFlag = await state.storage.get<boolean>("spawn_skip_warm_pool");
    expect(skipFlag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Spawn deduplication
// ---------------------------------------------------------------------------
describe("spawn deduplication", () => {
  it("skips spawn when sandbox_status is already 'spawning' from /warm", async () => {
    const { env, db, ns } = createWorkerEnv(workerModule);

    db.setAuthToken("sess-dedup", {
      user_id: 100,
      id: 100,
      expires_at: Date.now() + 60_000,
      login: "user100",
      name: null,
      email: null,
    });

    // Create session
    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-dedup" },
      body: JSON.stringify({ sessionId: "s-dedup-1", repoUrl: DEFAULT_REPO_URL }),
    });

    // Simulate an in-flight /warm spawn without actually starting a sandbox.
    const state = ns._getState("s-dedup-1")!;
    await state.storage.put("sandbox_status", "spawning");
    await state.storage.put("spawn_started_at", Date.now());

    // Now enqueue a prompt -- should set pendingPromptOnConnect but NOT trigger
    // a second spawn while the existing spawn is in progress.
    // The prompt should still be accepted.
    const promptRes = await workerFetch(workerModule, env, "/api/sessions/s-dedup-1/prompts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-dedup" },
      body: JSON.stringify({ prompt: "do work" }),
    });
    expect(promptRes.status).toBe(202);

    const promptBody = (await promptRes.json()) as { prompt: { promptId: string; status: string } };
    expect(promptBody.prompt.status).toBe("processing");
  });
});

// ---------------------------------------------------------------------------
// Spawn failure cleanup
// ---------------------------------------------------------------------------
describe("spawn failure cleanup", () => {
  it("resets sandbox_status to 'stopped' when /warm spawn fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    // No E2B runtime config -- spawnSandbox will throw.

    db.setAuthToken("sess-fail", {
      user_id: 200,
      id: 200,
      expires_at: Date.now() + 60_000,
      login: "user200",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-fail" },
      body: JSON.stringify({ sessionId: "s-fail-1", repoUrl: DEFAULT_REPO_URL }),
    });

    // Warm triggers spawn, which fails without E2B runtime config.
    const warmRes = await workerFetch(workerModule, env, "/api/sessions/s-fail-1/warm", {
      method: "POST",
      headers: { cookie: "session_token=sess-fail" },
    });
    expect(warmRes.status).toBe(202);

    // After failure, sandbox_status should be reset so a retry is possible.
    // Second /warm should NOT return "already_spawning" (it was stuck before this fix).
    const warmRes2 = await workerFetch(workerModule, env, "/api/sessions/s-fail-1/warm", {
      method: "POST",
      headers: { cookie: "session_token=sess-fail" },
    });
    expect(warmRes2.status).toBe(202);
    const body2 = (await warmRes2.json()) as { status: string };
    // Should be "spawning" (new attempt), not "already_spawning" (stuck)
    expect(body2.status).toBe("spawning");
  });

  it("does not leave the session stuck in sandbox_creating when prompt-path spawn fails", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    // No E2B runtime config -- spawnSandbox will throw.

    db.setAuthToken("sess-fail2", {
      user_id: 201,
      id: 201,
      expires_at: Date.now() + 60_000,
      login: "user201",
      name: null,
      email: null,
    });

    await workerFetch(workerModule, env, "/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-fail2" },
      body: JSON.stringify({ sessionId: "s-fail-2", repoUrl: DEFAULT_REPO_URL }),
    });

    // Enqueue prompt (no prior /warm) -- triggers spawn which fails
    await workerFetch(workerModule, env, "/api/sessions/s-fail-2/prompts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "session_token=sess-fail2" },
      body: JSON.stringify({ prompt: "do work" }),
    });

    // The fail-fast retry path runs off the request path. Regardless of exactly
    // which retry attempt has completed by the time we poll, the session should
    // no longer be stuck in sandbox_creating.
    await vi.waitFor(
      async () => {
        const stateRes = await workerFetch(workerModule, env, "/api/sessions/s-fail-2", {
          headers: { authorization: "Bearer admin-secret" },
        });
        const stateBody = (await stateRes.json()) as { session: { status: string } };
        expect(stateBody.session.status).not.toBe("sandbox_creating");
      },
      { timeout: 2000, interval: 10 },
    );
  });
});
