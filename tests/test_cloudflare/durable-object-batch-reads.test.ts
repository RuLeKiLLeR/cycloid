/**
 * Unit tests for the batch-read refactor of SessionDO handlers (ARC-124).
 *
 * Each test pre-populates FakeStorage with known values, calls the handler,
 * and asserts that the response contains exactly the expected values —
 * verifying the batch read returns the same data that sequential reads did.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
  LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
} from "../../apps/control-plane-worker/src/constants/sessions";
import { projectCycloidEventToDurableEntry } from "../../apps/control-plane-worker/src/session/cycloid-event-store";
import * as doDb from "../../apps/control-plane-worker/src/session/do-db";
import { generateSandboxPromptCallbackToken } from "../../apps/control-plane-worker/src/utils";
import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate";
import { BaseFakeD1Statement, batchFakeD1Statements } from "./helpers/fake-d1";
import { createWorkerTestEnv, seedGithubInstallation } from "./helpers/worker-env";
import {
  type DurableNamespace,
  FakeDurableState,
  FakeSqlStorage as FakeStorage,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "./helpers/worker-harness";
import { setActivePromptIdViaPromptRow } from "./session/helpers";

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

vi.mock("../../apps/control-plane-worker/src/sandbox/e2b-client", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/sandbox/e2b-client")>(
    "../../apps/control-plane-worker/src/sandbox/e2b-client",
  );
  return {
    ...actual,
    E2BSandboxClient: class {
      async createSandbox(request: { sandboxId?: string; template?: string }) {
        return {
          runtimeProvider: "e2b",
          runtimeSandboxId: request.sandboxId ?? "sbx-test",
          runtimeTemplateId: request.template ?? "cycloid-sandbox-test",
          status: "running",
          createdAt: Date.now(),
        };
      }

      async startCommand() {
        return { pid: 123, startedAt: Date.now() };
      }

      async connectSandbox(runtimeSandboxId: string) {
        return { runtimeSandboxId };
      }

      async refreshSandbox() {
        return { status: "refreshed", refreshedUntil: Date.now() + 3_600_000 };
      }

      async pauseSandbox() {
        return { status: "paused" };
      }

      async terminateSandbox() {
        return { status: "killed" };
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Fake infrastructure (mirrors the pattern in control-plane-worker.test.ts)
// ---------------------------------------------------------------------------

class FakeD1Statement extends BaseFakeD1Statement<FakeD1> {
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    if (
      this.isSchemaQuery() ||
      this.query.includes("INSERT OR IGNORE INTO integration_lifecycle_events") ||
      this.query.includes("INSERT INTO prompt_runs") ||
      this.query.includes("DELETE FROM integration_lifecycle_events") ||
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

    if (this.query.includes("FROM business_integrations")) {
      return { results: [] };
    }
    if (this.query.includes("FROM business_integration_credentials")) {
      return { results: [] };
    }
    if (this.query.includes("FROM user_integrations")) {
      return {
        results: [
          {
            integration_id: "openai",
            oauth_access_token: null,
            oauth_refresh_token: null,
            oauth_expires_at: null,
            api_key: "sk-openai-test",
            service_url: null,
            encrypted: 0,
            last_validated_at: Date.now(),
            last_validation_status: "validated",
            last_validation_reason_code: null,
          },
        ],
      };
    }
    if (this.query.includes("FROM session_index")) {
      const rows = [...this.db.sessionIndex.values()];
      return { results: rows };
    }
    if (this.query.includes("codex_byos_enabled")) {
      // ARC-1517: Codex BYOS capability read during session-create; these tests
      // don't exercise BYOS, so report disabled. `WHERE 1 = 0` placeholder = no row.
      return { results: this.query.includes("WHERE 1 = 0") ? [] : [{ codex_byos_enabled: 0 }] };
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
    if (this.query.includes("FROM auth_sessions")) {
      const [token] = this.boundValues as [string];
      return this.db.authTokens.get(token) ?? null;
    }
    if (this.query.includes("SELECT business_id FROM session_index WHERE session_id = ?")) {
      const [sessionId] = this.boundValues as [string];
      const session = this.db.sessionIndex.get(sessionId);
      return session ? { business_id: session.business_id ?? null } : null;
    }
    if (this.query.includes("FROM users WHERE id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      return (
        this.db.users.get(userId) ?? {
          id: userId,
          login: `user-${userId}`,
          name: null,
          email: null,
          business_id: "biz-1",
        }
      );
    }
    if (this.query.includes("FROM user_settings WHERE user_id")) {
      const [userIdRaw] = this.boundValues as [number | string];
      const userId = Number(userIdRaw);
      const now = Date.now();
      return {
        user_id: userId,
        pr_review_auto_response_enabled: 1,
        default_model: null,
        default_repo: null,
        created_at: now,
        updated_at: now,
      };
    }
    if (this.query.includes("SELECT api_key FROM user_integrations")) {
      return { api_key: "sk-openai-test", encrypted: 0, last_validation_status: "validated" };
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
      const [_userIdRaw, integrationId] = this.boundValues as [number | string, string | undefined];
      if (integrationId === "openai") {
        return { api_key: "sk-openai-test", encrypted: 0, last_validation_status: "validated" };
      }
      return null;
    }
    if (this.query.includes("FROM env_blobs")) {
      return null;
    }
    if (this.query.includes("sandbox_layer_sources")) {
      return null;
    }
    if (this.query.includes("FROM durable_event_replay_metadata")) {
      return null;
    }
    if (this.query.includes("codex_byos_enabled")) {
      return { codex_byos_enabled: 0 };
    }
    throw new Error(`Unhandled first query: ${this.query}`);
  }
}

type AuthTokenUser = {
  user_id: number;
  expires_at: number;
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  business_id?: string;
};

class FakeD1 {
  readonly sessionIndex = new Map<string, Record<string, unknown>>();
  readonly authTokens = new Map<string, AuthTokenUser>();
  readonly githubInstallations = new Map<string, Record<string, unknown>>();
  readonly users = new Map<
    number,
    { id: number; login: string; name: string | null; email: string | null; business_id: string }
  >();

  setAuthToken(token: string, user: AuthTokenUser): void {
    this.authTokens.set(token, user);
    this.users.set(user.id, {
      id: user.id,
      login: user.login,
      name: user.name,
      email: user.email,
      business_id: user.business_id ?? "biz-1",
    });
  }

  prepare(query: string): FakeD1Statement {
    return new FakeD1Statement(this, query);
  }

  async batch(statements: FakeD1Statement[]) {
    return batchFakeD1Statements(statements);
  }
}

function createWorkerEnv(workerModule: WorkerModule): {
  env: Record<string, unknown>;
  db: FakeD1;
  sessionNs: DurableNamespace;
} {
  const db = new FakeD1();
  const { env, sessionNs } = createWorkerTestEnv(workerModule, {
    db,
    sqlStorage: true,
    envOverrides: {
      ARCANIST_OPENAI_API_KEY: "sk-openai-test",
      E2B_API_KEY: "test-e2b-key",
      E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    },
  });

  for (const owner of ["test-owner", "acme"]) {
    seedGithubInstallation(db, owner, 1);
  }

  return { env, db, sessionNs };
}

// ---------------------------------------------------------------------------
// SQL helpers for test setup/assertion (replaces KV map.get/put)
// ---------------------------------------------------------------------------

/**
 * Update session columns via SQL. `activePromptId` is intercepted because the
 * session.active_prompt_id column was dropped in DO migration 70 -- the value
 * is now derived from prompts.status, so we translate the legacy field into
 * an INSERT (or status flip) on the prompts table to match.
 */
function sqlUpdateSession(storage: FakeStorage, sessionId: string, fields: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(fields, "activePromptId")) {
    setActivePromptIdViaPromptRow(
      storage.sql as unknown as SqlStorage,
      sessionId,
      fields.activePromptId as string | null,
    );
    const { activePromptId: _drop, ...rest } = fields;
    void _drop;
    fields = rest;
  }
  const mapping: Record<string, string> = {
    status: "status",
    promptCounter: "prompt_counter",
    last_branch: "last_branch",
    pr_url: "pr_url",
    pr_number: "pr_number",
    pr_creating: "pr_creating",
    pr_draft: "pr_draft",
    pr_manual_review_reason: "pr_manual_review_reason",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(fields)) {
    const col = mapping[key] ?? key;
    sets.push(`${col} = ?`);
    if (typeof val === "boolean") {
      values.push(val ? 1 : 0);
    } else {
      values.push(val);
    }
  }
  if (sets.length === 0) return;
  values.push(sessionId);
  storage.sql.exec(`UPDATE session SET ${sets.join(", ")} WHERE session_id = ?`, ...values);
}

/** Update sandbox_state columns via SQL. */
function sqlUpdateSandbox(storage: FakeStorage, sessionId: string, fields: Record<string, unknown>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(val);
  }
  if (sets.length === 0) return;
  values.push(sessionId);
  storage.sql.exec(`UPDATE sandbox_state SET ${sets.join(", ")} WHERE session_id = ?`, ...values);
}

/** Insert a prompt row via SQL. */
function sqlInsertPrompt(
  storage: FakeStorage,
  sessionId: string,
  prompt: {
    promptId: string;
    prompt: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    result: unknown;
    error: string | null;
    actorUserId: string | null;
  },
): void {
  const toMs = (iso: string | null) => (iso ? Date.parse(iso) : null);
  storage.sql.exec(
    `INSERT INTO prompts (prompt_id, session_id, prompt_text, actor_user_id, agent, status,
      created_at, started_at, completed_at, updated_at, error, result_json,
      queue_position, has_pending_question, files_json, uploaded_files_json, uploaded_images_json)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL)`,
    prompt.promptId,
    sessionId,
    prompt.prompt,
    prompt.actorUserId,
    prompt.status,
    toMs(prompt.createdAt) ?? Date.now(),
    toMs(prompt.startedAt),
    toMs(prompt.completedAt),
    toMs(prompt.updatedAt) ?? Date.now(),
    prompt.error,
    prompt.result ? JSON.stringify(prompt.result) : null,
  );
}

function sqlInsertPlatformLlmPromptStatus(
  storage: FakeStorage,
  sessionId: string,
  promptId: string,
  status: string,
  updatedAtMs: number,
): void {
  storage.sql.exec(
    `INSERT INTO platform_llm_prompt_status (prompt_id, session_id, status, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(prompt_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    promptId,
    sessionId,
    status,
    updatedAtMs,
  );
}

/** Insert prompt_usage row via SQL. */
function sqlInsertPromptUsage(
  storage: FakeStorage,
  promptId: string,
  usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCostUsd: number;
  },
): void {
  storage.sql.exec(
    `INSERT INTO prompt_usage (prompt_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_cost_usd_micros)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    promptId,
    usage.model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    Math.round(usage.totalCostUsd * 1_000_000),
  );
}

/** Read session row from SQL. */
function sqlGetSession(storage: FakeStorage, sessionId: string): Record<string, unknown> | undefined {
  const rows = storage.sql.exec("SELECT * FROM session WHERE session_id = ?", sessionId).toArray();
  return rows[0] as Record<string, unknown> | undefined;
}

/** Read prompts from SQL. */
function sqlGetPrompts(storage: FakeStorage, sessionId: string): Array<Record<string, unknown>> {
  return storage.sql
    .exec("SELECT * FROM prompts WHERE session_id = ? ORDER BY created_at ASC", sessionId)
    .toArray() as Array<Record<string, unknown>>;
}

/** Create a session and return its state from DO storage. */
async function createSessionAndGetState(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
  sessionNs: DurableNamespace,
  sessionId: string,
  opts?: {
    repoUrl?: string;
    baseBranch?: string;
    ownerUserId?: string;
  },
): Promise<FakeDurableState> {
  const res = await workerFetch(workerModule, env, "/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer admin-secret",
    },
    body: JSON.stringify({
      sessionId,
      ownerUserId: opts?.ownerUserId ?? "1001",
      repoUrl: opts?.repoUrl ?? "https://github.com/test-owner/test-repo",
      // These tests assert base queue/batch-read mechanics; opt out of plan mode
      // (default-on since ungating) so no plan->implement handoff shifts the queue.
      planMode: "off",
      ...(opts?.baseBranch ? { baseBranch: opts.baseBranch } : {}),
    }),
  });
  expect(res.status).toBe(201);
  const state = sessionNs._states.get(sessionId);
  expect(state).toBeDefined();
  return state!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionDO batch storage reads (ARC-124)", () => {
  let workerModule: WorkerModule;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
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

  // -------------------------------------------------------------------------
  // GET /session/state — 11-key batch
  // Note: GET /api/sessions/:id returns { session } (no top-level ok field)
  // -------------------------------------------------------------------------

  describe("GET /session/state batch reads", () => {
    it("returns all storage fields from a single batch read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-1", {
        repoUrl: "https://github.com/acme/widget",
        baseBranch: "main",
      });

      // Pre-populate session fields and sandbox state via SQL
      sqlUpdateSession(state.storage, "s-state-1", {
        last_branch: "feature/abc",
        pr_url: "https://github.com/acme/widget/pull/7",
        pr_creating: false,
        activePromptId: null,
        plan_auto_reason: "The task needs sequencing across files.",
      });
      sqlUpdateSandbox(state.storage, "s-state-1", { status: "ready" });
      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      // GET /api/sessions/:id returns { session } — no top-level ok
      const body = await res.json();
      expect(body.session).toBeDefined();
      expect(body.session.repoOwner).toBe("acme");
      expect(body.session.repoName).toBe("widget");
      expect(body.session.baseBranch).toBe("main");
      expect(body.session.lastBranch).toBe("feature/abc");
      expect(body.session.prUrl).toBe("https://github.com/acme/widget/pull/7");
      expect(body.session).not.toHaveProperty("planAutoReason");
      // sandbox_status=ready + no activePromptId → phase=idle. The phase model
      // keeps `idle` as the residual repo-session state so canSendPrompt is preserved.
      expect(body.session.phase).toBe("idle");
      expect(body.session.phase).toBe("idle");
    });

    it("includes review-listening fields in session state", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-review-listening", {
        repoUrl: "https://github.com/acme/widget",
        baseBranch: "main",
      });

      sqlUpdateSession(state.storage, "s-state-review-listening", {
        review_listening_active: true,
        review_listening_pr_url: "https://github.com/acme/widget/pull/7",
        review_listening_head_sha: "abc123",
        review_listening_entered_at: 1_768_952_400_000,
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-review-listening", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("review_listening");
      expect(body.session.reviewListeningActive).toBe(true);
      expect(body.session.reviewListeningPrUrl).toBe("https://github.com/acme/widget/pull/7");
      expect(body.session.reviewListeningHeadSha).toBe("abc123");
      expect(body.session.reviewListeningEnteredAt).toBe(1_768_952_400_000);
    });

    it("normalizes stale disabled runtime profile provenance in session state", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-runtime-provenance");
      await state.storage.put("runtime_provenance", {
        dockerEnabled: false,
        appRuntimeProfileSource: "disabled",
        appRuntimeProfileDiagnostics: [
          {
            code: "docker_disabled",
            severity: "warning",
            message: "stale",
          },
        ],
        updatedAt: Date.now(),
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-runtime-provenance", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.runtimeProvenance.appRuntimeProfileSource).toBe("none");
      expect(body.session.runtimeProvenance.appRuntimeProfileDiagnostics).toEqual([]);
    });

    it("includes the latest close reason for archived sessions", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-archived");

      sqlUpdateSession(state.storage, "s-state-archived", { status: "archived" });
      state.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        1,
        "event-1",
        "s-state-archived",
        null,
        "session_closed",
        Date.now(),
        JSON.stringify({ reason: "pr_merged" }),
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-archived", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("archived");
      expect(body.session.closeReason).toBe("pr_merged");
    });

    it("does not include prompts or queue in the session state response", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-no-prompts");

      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, "s-state-no-prompts", {
        promptId: "p-1",
        prompt: "test",
        status: "completed",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: ts,
        result: { ok: true },
        error: null,
        actorUserId: null,
      });

      const stateDoState = sessionNs._states.get("s-state-no-prompts");
      expect(stateDoState).toBeDefined();
      const doInstance = new workerModule.SessionDO(stateDoState!, env);
      const stateRes = await doInstance.fetch(new Request("https://internal/session/state", { method: "GET" }));
      expect(stateRes.status).toBe(200);
      const stateBody = await stateRes.json();
      expect(stateBody.session).toBeDefined();
      expect(stateBody.prompts).toBeUndefined();
      expect(stateBody.queue).toBeUndefined();
    });

    it("returns 404 when session key missing", async () => {
      const { env } = createWorkerEnv(workerModule);
      const res = await workerFetch(workerModule, env, "/api/sessions/does-not-exist", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(404);
    });

    it("computes rich status from batched sandbox_status + activePromptId", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-2");

      // activePromptId set with no sandbox → "running"
      sqlUpdateSandbox(state.storage, "s-state-2", { status: "ready" });
      sqlUpdateSession(state.storage, "s-state-2", { activePromptId: "p-1" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-2", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // activePromptId set → "running"
      expect(body.session.phase).toBe("running");
    });

    it("projects publishing state as finalizing from batch read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-3");
      sqlUpdateSession(state.storage, "s-state-3", {
        publish_status: "publishing",
        publish_stage: "creating_pr",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-3", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.publishStatus).toBe("publishing");
      expect(body.session.phase).toBe("finalizing");
    });

    it("keeps queued prompts from masking no-change completion projection", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-queued-nochanges");
      const completedAt = "2026-01-01T00:00:00.000Z";
      const queuedAt = "2026-01-01T00:01:00.000Z";
      sqlInsertPrompt(state.storage, "s-state-queued-nochanges", {
        promptId: "p-completed",
        prompt: "Do the work",
        status: "completed",
        createdAt: completedAt,
        updatedAt: completedAt,
        startedAt: completedAt,
        completedAt,
        result: { noChanges: true, noChangeReason: "No diff produced" },
        error: null,
        actorUserId: "1001",
      });
      sqlInsertPrompt(state.storage, "s-state-queued-nochanges", {
        promptId: "p-queued",
        prompt: "Follow-up",
        status: "queued",
        createdAt: queuedAt,
        updatedAt: queuedAt,
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        actorUserId: "1001",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-queued-nochanges", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("completed");
    });

    it("keeps queued prompts from masking post-execution-pending projection", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-queued-postexec");
      const completedAt = Date.parse("2026-01-01T00:00:00.000Z");
      const queuedAt = "2026-01-01T00:01:00.000Z";
      sqlInsertPrompt(state.storage, "s-state-queued-postexec", {
        promptId: "p-completed",
        prompt: "Do the work",
        status: "completed",
        createdAt: new Date(completedAt).toISOString(),
        updatedAt: new Date(completedAt).toISOString(),
        startedAt: new Date(completedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        result: { diffSummary: "Changed files" },
        error: null,
        actorUserId: "1001",
      });
      sqlInsertPlatformLlmPromptStatus(
        state.storage,
        "s-state-queued-postexec",
        "p-completed",
        "post_execution_pending",
        completedAt,
      );
      sqlInsertPrompt(state.storage, "s-state-queued-postexec", {
        promptId: "p-queued",
        prompt: "Follow-up",
        status: "queued",
        createdAt: queuedAt,
        updatedAt: queuedAt,
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
        actorUserId: "1001",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-queued-postexec", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("finalizing");
    });

    it("projects no-change repo export status as completed", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-export-nochanges");
      const completedAt = "2026-01-01T00:00:00.000Z";
      sqlInsertPrompt(state.storage, "s-export-nochanges", {
        promptId: "p-completed",
        prompt: "Inspect the repo",
        status: "completed",
        createdAt: completedAt,
        updatedAt: completedAt,
        startedAt: completedAt,
        completedAt,
        result: { noChanges: true, noChangeReason: "no_diff" },
        error: null,
        actorUserId: "1001",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-export-nochanges/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("completed");
    });

    it("projects post-execution-pending repo export status as finalizing", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-export-postexec");
      const completedAt = Date.parse("2026-01-01T00:00:00.000Z");
      sqlInsertPrompt(state.storage, "s-export-postexec", {
        promptId: "p-completed",
        prompt: "Make changes",
        status: "completed",
        createdAt: new Date(completedAt).toISOString(),
        updatedAt: new Date(completedAt).toISOString(),
        startedAt: new Date(completedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        result: { diffSummary: "Changed files" },
        error: null,
        actorUserId: "1001",
      });
      sqlInsertPlatformLlmPromptStatus(
        state.storage,
        "s-export-postexec",
        "p-completed",
        "post_execution_pending",
        completedAt,
      );

      const res = await workerFetch(workerModule, env, "/api/sessions/s-export-postexec/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.phase).toBe("finalizing");
    });

    it("preserves persisted draft PR metadata when latest verification is normal", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-state-draft-pr");
      sqlUpdateSession(state.storage, "s-state-draft-pr", {
        pr_url: "https://github.com/acme/widget/pull/7",
        pr_draft: true,
        pr_manual_review_reason: "Broad typecheck was resource-killed.",
      });
      await state.storage.put("verification", {
        verified: true,
        status: "passed",
        publishMode: "normal",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-state-draft-pr", {
        headers: { authorization: "Bearer admin-secret" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.session.prUrl).toBe("https://github.com/acme/widget/pull/7");
      expect(body.session.prDraft).toBe(true);
      expect(body.session.prManualReviewReason).toBe("Broad typecheck was resource-killed.");
    });
  });

  // -------------------------------------------------------------------------
  // GET /session/events — 5-key batch
  // Note: /api/sessions/:id/events returns SSE; use /events/history for JSON.
  // -------------------------------------------------------------------------

  describe("GET /session/events batch reads", () => {
    it("returns events and replay from batch read via events/history", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-1");

      // events/history returns JSON (not SSE)
      const res = await workerFetch(workerModule, env, "/api/sessions/s-events-1/events/history", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.afterSequence).toBe(0);
      expect(body.beforeSequence).toBe(null);
      expect(typeof body.hasMore).toBe("boolean");
      expect(typeof body.droppedCount).toBe("number");
      expect("firstSequence" in body).toBe(true);
      expect("lastSequence" in body).toBe(true);
    });

    it("projects stored transport rows on before_sequence history reads", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-events-transport-1");
      const transportEvent = translateBridgeEventToCycloidEvent("s-events-transport-1", {
        type: "token",
        content: "hello",
        partId: "part-1",
        messageId: "prompt-1",
        sandboxId: "sbx-1",
        timestamp: 100,
      });
      const projected = projectCycloidEventToDurableEntry(transportEvent);

      expect(projected).not.toBeNull();
      const [persistedEvent] = doDb.appendEventsWithReplay(
        state.storage.sql,
        "s-events-transport-1",
        [projected!],
        "prompt-1",
      ).newEvents;

      const res = await workerFetch(
        workerModule,
        env,
        `/api/sessions/s-events-transport-1/events/history?before_sequence=${persistedEvent!.sequence + 1}&limit=1`,
        { headers: { authorization: "Bearer admin-secret" } },
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        beforeSequence: persistedEvent!.sequence + 1,
        events: [
          {
            sequence: persistedEvent!.sequence,
            phase: "text.delta",
            sessionId: "s-events-transport-1",
            promptId: "prompt-1",
            sandboxId: "sbx-1",
            timestampMs: 100,
            payload: {
              channel: "output",
              text: "hello",
              partId: "part-1",
              bridgeEventType: "token",
              bridgeData: {
                content: "hello",
                partId: "part-1",
                messageId: "prompt-1",
              },
            },
          },
        ],
      });
    });

    it("filters events by after_sequence using batched events array (events/history)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-2");

      // Enqueue a prompt to generate events
      await workerFetch(workerModule, env, "/api/sessions/s-events-2/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "hello" }),
      });

      const resAll = await workerFetch(workerModule, env, "/api/sessions/s-events-2/events/history", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const bodyAll = await resAll.json();
      const totalCount = bodyAll.events.length;
      expect(totalCount).toBeGreaterThan(0);

      // after_sequence=999 should return nothing
      const resFiltered = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-events-2/events/history?after_sequence=999",
        { headers: { authorization: "Bearer admin-secret" } },
      );
      const bodyFiltered = await resFiltered.json();
      expect(bodyFiltered.events.length).toBe(0);
    });

    it("returns 400 for malformed replay parameters", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-4");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-events-4/events/history?after_sequence=-1&limit=oops",
        { headers: { authorization: "Bearer admin-secret" } },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.any(String) });
    });

    it("returns 400 when before_sequence is combined with prompt_id", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-5");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-events-5/events/history?before_sequence=10&prompt_id=p-1",
        { headers: { authorization: "Bearer admin-secret" } },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: "prompt_id cannot be combined with before_sequence",
      });
    });

    it("returns 400 when before_sequence is combined with after_sequence", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-6");

      const res = await workerFetch(
        workerModule,
        env,
        "/api/sessions/s-events-6/events/history?after_sequence=5&before_sequence=10",
        { headers: { authorization: "Bearer admin-secret" } },
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: "after_sequence cannot be combined with before_sequence",
      });
    });

    it("rejects WebSocket upgrade with malformed afterSequence query param", async () => {
      // ARC-453: handshake-time strict validation. Malformed `afterSequence`
      // must fail before the upgrade so the client gets a clean HTTP 400
      // instead of a silently-normalized stale replay window.
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-ws-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-events-ws-1/ws?afterSequence=oops", {
        headers: {
          authorization: "Bearer admin-secret",
          upgrade: "websocket",
        },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("afterSequence"),
      });
    });

    it("rejects WebSocket upgrade with empty afterSequence query param", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-events-ws-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-events-ws-1/ws?afterSequence=", {
        headers: {
          authorization: "Bearer admin-secret",
          upgrade: "websocket",
        },
      });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("afterSequence"),
      });
    });

    // -------------------------------------------------------------------------
    // POST /session/review-listening/enter — activates review-listening on a
    // session that is NOT currently in review-listening mode (the reengage fix).
    // -------------------------------------------------------------------------

    it("review-listening/enter activates review-listening on a non-listening active session", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-rl-enter-1", {
        repoUrl: "https://github.com/acme/widget",
        baseBranch: "main",
      });

      // Confirm the session is NOT currently review-listening.
      const beforeRes = await workerFetch(workerModule, env, "/api/sessions/s-rl-enter-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(beforeRes.status).toBe(200);
      const beforeBody = await beforeRes.json();
      expect(beforeBody.session.reviewListeningActive).toBeFalsy();

      // Call the enter route directly on the DO (mirrors how state.enterSessionReviewListening
      // calls it — via stub.fetch on "https://internal/session/review-listening/enter").
      const enterRes = await sessionNs.get("s-rl-enter-1").fetch(
        new Request("https://internal/session/review-listening/enter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prUrl: "https://github.com/acme/widget/pull/7",
            currentHeadSha: "abc123",
          }),
        }),
      );
      expect(enterRes.status).toBe(200);
      const enterBody = await enterRes.json();
      expect(enterBody.ok).toBe(true);
      expect(enterBody.updated).toBe(true);
      expect(enterBody.reason).toBeUndefined();

      // Confirm the session is now in review-listening mode with the correct head SHA.
      const afterRes = await workerFetch(workerModule, env, "/api/sessions/s-rl-enter-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(afterRes.status).toBe(200);
      const afterBody = await afterRes.json();
      expect(afterBody.session.reviewListeningActive).toBe(true);
      expect(afterBody.session.reviewListeningPrUrl).toBe("https://github.com/acme/widget/pull/7");
      expect(afterBody.session.reviewListeningHeadSha).toBe("abc123");
    });

    it("review-listening/enter returns archived guard for an archived session without activating", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-rl-enter-archived", {
        repoUrl: "https://github.com/acme/widget",
        baseBranch: "main",
      });

      // Force session to archived status.
      sqlUpdateSession(state.storage, "s-rl-enter-archived", { status: "archived" });

      const enterRes = await sessionNs.get("s-rl-enter-archived").fetch(
        new Request("https://internal/session/review-listening/enter", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prUrl: "https://github.com/acme/widget/pull/7",
            currentHeadSha: "abc123",
          }),
        }),
      );
      expect(enterRes.status).toBe(200);
      const enterBody = await enterRes.json();
      expect(enterBody.ok).toBe(true);
      expect(enterBody.updated).toBe(false);
      expect(enterBody.reason).toBe("archived");
    });

    it("batch reads return correct sessionStatus via DO fetch (internal path)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-events-3");
      // Set activePromptId and a ready sandbox_status — reading via GET state
      sqlUpdateSession(state.storage, "s-events-3", { activePromptId: "p-1" });
      sqlUpdateSandbox(state.storage, "s-events-3", { status: "ready" });

      // Verify via the state endpoint (which also uses the batch read for session/events)
      const res = await workerFetch(workerModule, env, "/api/sessions/s-events-3", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const body = await res.json();
      // activePromptId set + sandbox_status=ready → "running"
      expect(body.session.phase).toBe("running");
    });
  });

  // -------------------------------------------------------------------------
  // GET /session/prompts — 3-key batch
  // -------------------------------------------------------------------------

  describe("GET /session/prompts batch reads", () => {
    it("returns prompts from batch read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-prompts-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-prompts-1/prompts", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      // External prompts route returns { prompts } (no ok, no queue)
      const body = await res.json();
      expect(Array.isArray(body.prompts)).toBe(true);
      expect(body.prompts).toHaveLength(0);
    });

    it("reflects stored prompts from batch read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-prompts-2");

      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, "s-prompts-2", {
        promptId: "p-1",
        prompt: "test",
        status: "processing",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: null,
        result: null,
        error: null,
        actorUserId: null,
      });
      sqlUpdateSession(state.storage, "s-prompts-2", { activePromptId: "p-1" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-prompts-2/prompts", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const body = await res.json();
      // External prompts route returns { prompts } (no queue)
      expect(body.prompts).toHaveLength(1);
      expect(body.prompts[0].promptId).toBe("p-1");
      expect(body.prompts[0].status).toBe("processing");
    });
  });

  describe("GET /session/view", () => {
    it("returns session state, prompts, and queue together", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-view-1");

      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, "s-view-1", {
        promptId: "p-1",
        prompt: "test",
        status: "processing",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: null,
        result: null,
        error: null,
        actorUserId: null,
      });
      sqlUpdateSession(state.storage, "s-view-1", { activePromptId: "p-1" });
      sqlUpdateSandbox(state.storage, "s-view-1", { status: "ready" });

      const viewDoState = sessionNs._states.get("s-view-1");
      expect(viewDoState).toBeDefined();
      const doInstance = new workerModule.SessionDO(viewDoState!, env);
      const viewRes = await doInstance.fetch(new Request("https://internal/session/view", { method: "GET" }));
      expect(viewRes.status).toBe(200);
      const viewBody = await viewRes.json();
      expect(viewBody.session.sessionId).toBe("s-view-1");
      expect(viewBody.session.phase).toBe("running");
      expect(viewBody.prompts).toHaveLength(1);
      expect(viewBody.prompts[0].promptId).toBe("p-1");
      expect(viewBody.queue).toEqual({ queuedCount: 0, processingPromptId: "p-1" });
    });
  });

  // -------------------------------------------------------------------------
  // POST /session/prompts/enqueue — 4-key batch
  // -------------------------------------------------------------------------

  describe("POST /session/prompts/enqueue batch reads", () => {
    it("reads session + prompts + promptCounter + activePromptId in one batch", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-enqueue-1");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-enqueue-1/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "implement feature X" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.prompt.promptId).toBe("p-1");
      expect(body.prompt.status).toBe("processing");
      expect(body.queue.processingPromptId).toBe("p-1");
    });

    it("assigns sequential promptIds using batched promptCounter", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-enqueue-2");
      // Pre-set counter to 5 to simulate existing prompts
      sqlUpdateSession(state.storage, "s-enqueue-2", { promptCounter: 5 });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-enqueue-2/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "build the thing" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      // Counter was 5, so next promptId should be p-6
      expect(body.prompt.promptId).toBe("p-6");
    });

    it("queues second prompt when activePromptId is already set", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-enqueue-3");

      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, "s-enqueue-3", {
        promptId: "p-1",
        prompt: "first",
        status: "processing",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: null,
        result: null,
        error: null,
        actorUserId: null,
      });
      sqlUpdateSession(state.storage, "s-enqueue-3", { activePromptId: "p-1", promptCounter: 1 });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-enqueue-3/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "second prompt" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.prompt.status).toBe("queued");
      expect(body.queue.queuedCount).toBe(1);
      expect(body.queue.processingPromptId).toBe("p-1");
    });

    it("rejects closed session using batched session read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-enqueue-4");

      // Close the session
      sqlUpdateSession(state.storage, "s-enqueue-4", { status: "archived" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-enqueue-4/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "should fail" }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: "session_not_sendable", reason: "archived" });
    });
  });

  // -------------------------------------------------------------------------
  // POST /session/prompts/callback — 3-key batch
  // -------------------------------------------------------------------------

  describe("POST /session/prompts/callback batch reads", () => {
    it("completes prompt and returns correct queue state from batch", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-callback-1");

      // Enqueue a prompt first
      await workerFetch(workerModule, env, "/api/sessions/s-callback-1/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "do work" }),
      });
      // ARC-1024: callback auth is no longer in the enqueue response; mint it as the DO does.
      const callbackAuth = `Bearer ${await generateSandboxPromptCallbackToken("s-callback-1", "p-1", "sandbox-callback-secret")}`;

      // Simulate callback
      const cbRes = await workerFetch(
        workerModule,
        env,
        "/internal/sandbox/sessions/s-callback-1/prompts/p-1/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: callbackAuth },
          body: JSON.stringify({ promptId: "p-1", success: true }),
        },
      );
      expect(cbRes.status).toBe(200);
      const cbBody = await cbRes.json();
      expect(cbBody.ok).toBe(true);
      expect(cbBody.completedPrompt.status).toBe("completed");
      expect(cbBody.nextDispatch).toBeNull();
      expect(cbBody.queue.processingPromptId).toBeNull();
    });

    it("advances queue to next prompt from batch reads", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-callback-2");

      // Enqueue two prompts
      await workerFetch(workerModule, env, "/api/sessions/s-callback-2/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "first" }),
      });
      const firstCallbackAuth = `Bearer ${await generateSandboxPromptCallbackToken("s-callback-2", "p-1", "sandbox-callback-secret")}`;

      await workerFetch(workerModule, env, "/api/sessions/s-callback-2/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "second" }),
      });

      // Complete first — the external callback route returns { ok, completedPrompt, nextDispatch, queue }
      // (nextPrompt is not passed through by handleSandboxCallback, but queue reflects the advance)
      const cbRes = await workerFetch(
        workerModule,
        env,
        "/internal/sandbox/sessions/s-callback-2/prompts/p-1/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: firstCallbackAuth },
          body: JSON.stringify({ promptId: "p-1", success: true }),
        },
      );
      const cbBody = await cbRes.json();
      expect(cbBody.ok).toBe(true);
      expect(cbBody.completedPrompt.status).toBe("completed");
      // queue.processingPromptId should now be p-2
      expect(cbBody.queue.processingPromptId).toBe("p-2");
      // nextDispatch reflects that p-2 has been dispatched (no sandbox → sandbox callback)
      expect(cbBody.nextDispatch).toBeDefined();
      expect(cbBody.nextDispatch?.promptId).toBe("p-2");
    });

    it("marks prompt failed when success=false", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-callback-3");

      await workerFetch(workerModule, env, "/api/sessions/s-callback-3/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "risky operation" }),
      });
      const callbackAuth = `Bearer ${await generateSandboxPromptCallbackToken("s-callback-3", "p-1", "sandbox-callback-secret")}`;

      const cbRes = await workerFetch(
        workerModule,
        env,
        "/internal/sandbox/sessions/s-callback-3/prompts/p-1/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: callbackAuth },
          body: JSON.stringify({ promptId: "p-1", success: false, error: "execution failed" }),
        },
      );
      const cbBody = await cbRes.json();
      expect(cbBody.completedPrompt.status).toBe("failed");
      expect(cbBody.completedPrompt.error).toBe("execution failed");
    });
  });

  // -------------------------------------------------------------------------
  // POST /session/warm — 2-key batch
  // Note: external route returns 202 on ok=true
  // -------------------------------------------------------------------------

  describe("POST /session/warm batch reads", () => {
    it("rejects warm with 409 session_not_warmable when sandbox is already spawning", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-warm-1");
      sqlUpdateSandbox(state.storage, "s-warm-1", { status: "spawning" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-warm-1/warm", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      // sandboxStatus=spawning collapses into phase=running + creating, which
      // `isWarmAvailable` rejects: there's nothing left for warm to do.
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("session_not_warmable");
    });

    it("rejects warm for closed session using batched session read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-warm-2");
      sqlUpdateSession(state.storage, "s-warm-2", { status: "archived" });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-warm-2/warm", {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(409);
    });
  });

  // -------------------------------------------------------------------------
  // POST /session/retry — 4-key batch
  // -------------------------------------------------------------------------

  describe("POST /session/retry batch reads", () => {
    it("rejects archived sessions with the structured retry-blocked envelope", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-retry-archived");
      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, "s-retry-archived", {
        promptId: "p-1",
        prompt: "retry me",
        status: "failed",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: ts,
        result: null,
        error: "failed",
        actorUserId: null,
      });
      sqlUpdateSession(state.storage, "s-retry-archived", { status: "archived", promptCounter: 1 });

      const res = await sessionNs.get("s-retry-archived").fetch(
        new Request("https://internal/session/retry", {
          method: "POST",
        }),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: "session_not_retryable",
        reason: "archived",
      });
    });

    it("rejects finalizing sessions with the structured retry-blocked envelope", async () => {
      const sessionId = "s-retry-finalizing";
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, sessionId);
      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, sessionId, {
        promptId: "p-1",
        prompt: "retry me",
        status: "completed",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: ts,
        result: { ok: true },
        error: null,
        actorUserId: null,
      });
      sqlUpdateSession(state.storage, sessionId, { publish_status: "publishing", promptCounter: 1 });

      const res = await sessionNs.get(sessionId).fetch(
        new Request("https://internal/session/retry", {
          method: "POST",
        }),
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({
        ok: false,
        error: "session_not_retryable",
        reason: "finalizing",
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /session/context — 6-key batch
  // -------------------------------------------------------------------------

  describe("GET /session/context batch reads", () => {
    it("returns all context fields from a single batch read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-ctx-1", {
        repoUrl: "https://github.com/acme/widget",
        baseBranch: "develop",
      });

      sqlUpdateSession(state.storage, "s-ctx-1", {
        last_branch: "feat/my-branch",
        pr_url: "https://github.com/acme/widget/pull/3",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-ctx-1/context", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.context.sessionId).toBe("s-ctx-1");
      expect(body.context.repoOwner).toBe("acme");
      expect(body.context.repoName).toBe("widget");
      expect(body.context.baseBranch).toBe("develop");
      expect(body.context.lastBranch).toBe("feat/my-branch");
      expect(body.context.prUrl).toBe("https://github.com/acme/widget/pull/3");
      expect(body.context.repoUrl).toBe("https://github.com/acme/widget");
    });

    it("returns null for missing optional fields", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-ctx-2");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-ctx-2/context", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const body = await res.json();
      expect(body.context.lastBranch).toBeNull();
      expect(body.context.prUrl).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // GET /session/export — 8-key batch
  // -------------------------------------------------------------------------

  describe("GET /session/export batch reads", () => {
    it("returns all export fields from batch read", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-export-1", {
        repoUrl: "https://github.com/acme/widget",
      });

      sqlUpdateSession(state.storage, "s-export-1", {
        pr_url: "https://github.com/acme/widget/pull/42",
        pr_number: 42,
        last_branch: "feat/export-test",
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-export-1/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.session.id).toBe("s-export-1");
      expect(body.session.repoUrl).toBe("https://github.com/acme/widget");
      expect(body.pr).toBeDefined();
      expect(body.pr.url).toBe("https://github.com/acme/widget/pull/42");
      expect(body.pr.number).toBe(42);
      expect(body.pr.branch).toBe("feat/export-test");
    });

    it("returns null pr when no pr_url in storage", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      await createSessionAndGetState(workerModule, env, sessionNs, "s-export-2");

      const res = await workerFetch(workerModule, env, "/api/sessions/s-export-2/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const body = await res.json();
      expect(body.pr).toBeNull();
    });

    it("aggregates token counts from prompt_usage storage", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-export-3");

      // Insert prompt rows so the usage join works
      const ts = new Date().toISOString();
      sqlInsertPrompt(state.storage, "s-export-3", {
        promptId: "p-1",
        prompt: "a",
        status: "completed",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: ts,
        result: null,
        error: null,
        actorUserId: null,
      });
      sqlInsertPrompt(state.storage, "s-export-3", {
        promptId: "p-2",
        prompt: "b",
        status: "completed",
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        completedAt: ts,
        result: null,
        error: null,
        actorUserId: null,
      });
      sqlInsertPromptUsage(state.storage, "p-1", {
        model: "gpt-5.4-mini",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        totalCostUsd: 0.001,
      });
      sqlInsertPromptUsage(state.storage, "p-2", {
        model: "gpt-5.4-mini",
        inputTokens: 100,
        outputTokens: 80,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        totalCostUsd: 0.001,
      });

      const res = await workerFetch(workerModule, env, "/api/sessions/s-export-3/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const body = await res.json();
      expect(body.tokens.inputTokens).toBe(200);
      expect(body.tokens.outputTokens).toBe(130);
      expect(body.tokens.cacheReadTokens).toBe(100);
      expect(body.tokens.cacheWriteTokens).toBe(0);
      expect(body.tokens.totalTokens).toBe(330);
      expect(body.tokens.totalBilledTokens).toBe(430);
    });
  });

  // -------------------------------------------------------------------------
  // POST /session/notify-pr-merged — 2-key batch
  // This endpoint is internal (not in public API), test via DO fetch directly.
  // -------------------------------------------------------------------------

  describe("POST /session/notify-pr-merged batch reads", () => {
    it("returns not-notified when pr_url missing from batch (no Slack token)", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-merged-1");

      // Call the DO directly at the internal path
      const doInstance = new workerModule.SessionDO(
        {
          storage: state.storage,
          id: { toString: () => "s-merged-1" },
          blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
            await fn();
          },
          waitUntil: (_p: Promise<unknown>) => {},
        },
        env,
      );
      const res = await doInstance.fetch(new Request("https://internal/session/notify-pr-merged", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.notified).toBe(false);
      expect(body.reason).toBe("no pr_url");
    });

    it("uses pr_url from batch read when payload lacks it", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-merged-2");
      sqlUpdateSession(state.storage, "s-merged-2", { pr_url: "https://github.com/acme/repo/pull/99" });

      const doInstance = new workerModule.SessionDO(
        {
          storage: state.storage,
          id: { toString: () => "s-merged-2" },
          blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
            await fn();
          },
          waitUntil: (_p: Promise<unknown>) => {},
        },
        env,
      );
      const res = await doInstance.fetch(new Request("https://internal/session/notify-pr-merged", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      // No SLACK_BOT_TOKEN in env → notified=false but the pr_url was read from batch
      expect(body.ok).toBe(true);
      expect(body.notified).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // syncCurrentRichStatus (tested indirectly via putActivePromptId calls)
  // -------------------------------------------------------------------------

  describe("syncCurrentRichStatus batch reads (via enqueue → putActivePromptId)", () => {
    it("computes and exposes rich status from batch of session + sandbox_status + activePromptId", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-rich-1");

      // No active prompt → phase=idle (the residual repo-session state).
      let stateRes = await workerFetch(workerModule, env, "/api/sessions/s-rich-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      let stateBody = await stateRes.json();
      expect(stateBody.session.phase).toBe("idle");

      // Enqueue a prompt — sets activePromptId via putActivePromptId which calls syncCurrentRichStatus
      await workerFetch(workerModule, env, "/api/sessions/s-rich-1/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "do work" }),
      });

      stateRes = await workerFetch(workerModule, env, "/api/sessions/s-rich-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      stateBody = await stateRes.json();
      // After enqueue, the prompt is active and the sandbox spawn is still in-flight.
      // computeRichStatus should surface sandbox creation rather than idle/running.
      expect(stateBody.session.phase).toBe("running");
      expect(stateBody.session.sandboxSubstate).toBe("creating");

      // Verify activePromptId was stored
      const sess = sqlGetSession(state.storage, "s-rich-1");
      expect(
        state.storage.sql
          .exec("SELECT prompt_id FROM prompts WHERE session_id = ? AND status = 'processing'", sess?.session_id ?? "")
          .toArray()[0]?.prompt_id,
      ).toBe("p-1");
    });
  });

  // -------------------------------------------------------------------------
  // Alarm handler — 3-key batch (activePromptId + prompts + session)
  // -------------------------------------------------------------------------

  describe("alarm batch reads", () => {
    it("returns early when no activePromptId in batch", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-alarm-1");
      sqlUpdateSession(state.storage, "s-alarm-1", { activePromptId: null });

      // Instantiate DO and call alarm directly
      const instance = new workerModule.SessionDO(
        {
          storage: state.storage,
          id: { toString: () => "fake-do-id" },
          blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
            await fn();
          },
          waitUntil: () => {},
        },
        { DB: null },
      );
      // Should not throw
      await expect(instance.alarm()).resolves.toBeUndefined();
    });

    it("marks prompt as failed after lifecycle running inactivity deadline using batch reads", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-alarm-2");

      // Set up a processing prompt with an expired lifecycle running deadline.
      const now = Date.now();
      const staleTs = new Date(now - 20 * 60 * 1000).toISOString();
      sqlInsertPrompt(state.storage, "s-alarm-2", {
        promptId: "p-stale",
        prompt: "stale work",
        status: "processing",
        createdAt: staleTs,
        updatedAt: staleTs,
        startedAt: staleTs,
        completedAt: null,
        result: null,
        error: null,
        actorUserId: null,
      });
      sqlUpdateSession(state.storage, "s-alarm-2", { activePromptId: "p-stale", status: "active" });
      await state.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "p-stale",
      });
      await state.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, now - 1);

      const instance = new workerModule.SessionDO(
        {
          storage: state.storage,
          id: { toString: () => "fake-do-id" },
          blockConcurrencyWhile: async (fn: () => Promise<unknown>) => {
            await fn();
          },
          waitUntil: (_p: Promise<unknown>) => {},
        },
        { DB: null },
      );
      await instance.alarm();

      // After alarm, prompt should be marked failed
      const prompts = sqlGetPrompts(state.storage, "s-alarm-2");
      const stalePrompt = prompts.find((p) => p.prompt_id === "p-stale");
      expect(stalePrompt?.status).toBe("failed");
      expect(stalePrompt?.error).toContain("inactive");
    });
  });

  // -------------------------------------------------------------------------
  // sendPendingPromptToSandbox — 2-key batch (activePromptId + prompts)
  // -------------------------------------------------------------------------

  describe("sendPendingPromptToSandbox batch reads (via sandbox WebSocket connect)", () => {
    it("reads activePromptId + prompts in one batch on sandbox connect", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);
      const state = await createSessionAndGetState(workerModule, env, sessionNs, "s-sandbox-1");

      // Enqueue a prompt so activePromptId is set
      await workerFetch(workerModule, env, "/api/sessions/s-sandbox-1/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "pending work" }),
      });

      const sess = sqlGetSession(state.storage, "s-sandbox-1");
      expect(
        state.storage.sql
          .exec("SELECT prompt_id FROM prompts WHERE session_id = ? AND status = 'processing'", sess?.session_id ?? "")
          .toArray()[0]?.prompt_id,
      ).toBe("p-1");

      const prompts = sqlGetPrompts(state.storage, "s-sandbox-1");
      expect(prompts.find((p) => p.prompt_id === "p-1")?.status).toBe("processing");
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle integration (session creation → prompt → callback → state)
  // -------------------------------------------------------------------------

  describe("full lifecycle integration with batch reads", () => {
    it("session creation → prompt enqueue → callback → state all use batch reads correctly", async () => {
      const { env, sessionNs } = createWorkerEnv(workerModule);

      // Create session
      const createRes = await workerFetch(workerModule, env, "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({
          sessionId: "s-lifecycle-1",
          ownerUserId: "1001",
          repoUrl: "https://github.com/test-owner/test-repo",
          // planMode:"off" — assert base single-prompt lifecycle without plan mode's
          // plan->implement handoff (default-on since ungating).
          planMode: "off",
        }),
      });
      expect(createRes.status).toBe(201);

      // Enqueue prompt — batch reads: session + prompts + promptCounter + activePromptId
      const enqueueRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle-1/prompts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-secret" },
        body: JSON.stringify({ prompt: "implement feature" }),
      });
      expect(enqueueRes.status).toBe(202);
      const enqueueBody = await enqueueRes.json();
      expect(enqueueBody.prompt.promptId).toBe("p-1");
      expect(enqueueBody.prompt.status).toBe("processing");
      const callbackAuth = `Bearer ${await generateSandboxPromptCallbackToken("s-lifecycle-1", "p-1", "sandbox-callback-secret")}`;

      // Check state — batch reads: all 9 state keys
      // With a successful mock spawn, the session remains in sandbox creation until
      // a sandbox actually connects and drains the prompt.
      const stateRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const stateBody = await stateRes.json();
      expect(stateBody.session.phase).toBe("running");
      expect(stateBody.session.sandboxSubstate).toBe("creating");

      // Complete via callback — batch reads: session + prompts + activePromptId
      const cbRes = await workerFetch(
        workerModule,
        env,
        "/internal/sandbox/sessions/s-lifecycle-1/prompts/p-1/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: callbackAuth },
          body: JSON.stringify({ promptId: "p-1", success: true, result: { summary: "done" } }),
        },
      );
      expect(cbRes.status).toBe(200);
      const cbBody = await cbRes.json();
      expect(cbBody.completedPrompt.status).toBe("completed");

      // Final state check: the prompt is completed, but the mocked spawn still
      // has not connected a sandbox WebSocket, so the session remains in
      // sandbox_creating until that connection would arrive.
      const finalStateRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle-1", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const finalBody = await finalStateRes.json();
      expect(finalBody.session.phase).toBe("running");
      expect(finalBody.session.sandboxSubstate).toBe("creating");

      // Verify prompts listing — batch reads: session + prompts + activePromptId
      const promptsRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle-1/prompts", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const promptsBody = await promptsRes.json();
      expect(promptsBody.prompts).toHaveLength(1);
      expect(promptsBody.prompts[0].status).toBe("completed");
      // External prompts route returns { prompts } only (no queue field)

      // Verify export — batch reads: 8 keys
      const exportRes = await workerFetch(workerModule, env, "/api/sessions/s-lifecycle-1/export", {
        headers: { authorization: "Bearer admin-secret" },
      });
      const exportBody = await exportRes.json();
      expect(exportBody.stats.totalPrompts).toBe(1);
      expect(exportBody.stats.successCount).toBe(1);
    });
  });
});
