import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../apps/control-plane-worker/src/constants/businesses";
import { SessionEntrypoint } from "../../apps/control-plane-worker/src/enums/session-entrypoint";
import { OpencodeAccessDeniedError } from "../../apps/control-plane-worker/src/services/opencode-access-gate";
import { ProviderCredentialNotValidatedError } from "../../apps/control-plane-worker/src/services/provider-credential-gate";
import { USER_SETTINGS_SELECT_BY_USER_ID_SQL } from "../../apps/control-plane-worker/src/settings/db";
import { ENVIRONMENT } from "../../shared/constants/environment";
import { SqliteD1 } from "./sqlite-d1-helper";

const MIGRATIONS_DIR = resolve(__dirname, "../../apps/control-plane-worker/migrations");

function createMigratedSqlite(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function slackThreadSessionId(
  sqlite: Database.Database,
  ref: { businessId: string; teamId: string; channelId: string; threadTs: string },
): string | null {
  const row = sqlite
    .prepare(
      `SELECT session_id FROM slack_thread_session_refs
       WHERE business_id = ? AND team_id = ? AND channel_id = ? AND thread_ts = ?`,
    )
    .get(ref.businessId, ref.teamId, ref.channelId, ref.threadTs) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

function slackThreadWebhookSessionId(
  sqlite: Database.Database,
  ref: { channelId: string; threadTs: string },
): string | null {
  const row = sqlite
    .prepare(
      `SELECT session_id FROM session_webhook_refs
       WHERE source = 'slack_thread' AND external_ref = ?`,
    )
    .get(`${ref.channelId}:${ref.threadTs}`) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

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
  captureException: () => {},
}));

interface PromptState {
  promptId: string;
  prompt: string;
  actorUserId: string | null;
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  result: unknown;
  error: string | null;
}

type SessionStateModule = {
  assertDatabase: (env: Record<string, unknown>) => unknown;
  createSessionState: (
    env: Record<string, unknown>,
    sessionId: string,
    ownerUserId: string,
    options?: {
      requestId?: string | null;
      businessId?: string | null;
      autoVerify?: boolean;
      planMode?: "off" | "on" | "auto";
      entrypoint?: (typeof SessionEntrypoint)[keyof typeof SessionEntrypoint];
      adoptedExternalPr?: boolean;
      model?: string | null;
      agentRuntimeBackend?: string;
      agentRole?: string;
      agentProfile?: string;
      harnessKind?: string;
      runtimeStartupProfile?: string;
      targetPrUrl?: string | null;
      initiationMode?: string;
      credentialGate?: { mode: "enforce" } | { mode: "skip"; reason: string };
      waitUntil?: (promise: Promise<unknown>) => void;
      callbackContext?: {
        source: "slack";
        channel: string;
        threadTs: string;
        slackTeamId: string;
      };
      auth?: {
        userId: string;
        canAccessAllSessions: boolean;
        businessId?: string | null;
        sharedSessions?: boolean;
        businessMemberIds?: string[];
        email?: string | null;
        username?: string | null;
      };
    },
  ) => Promise<unknown>;
  listSessionPrompts: (
    env: Record<string, unknown>,
    sessionId: string,
    options?: {
      requestId?: string | null;
      auth?: {
        userId: string;
        canAccessAllSessions: boolean;
        businessId?: string | null;
        sharedSessions?: boolean;
        businessMemberIds?: string[];
        email?: string | null;
        username?: string | null;
      };
    },
  ) => Promise<{ status: number; ok: boolean; payload: { ok: boolean; prompts: unknown[] } | null }>;
  getSessionPlan: (
    env: Record<string, unknown>,
    sessionId: string,
    requestId: string | null,
    auth: {
      userId: string;
      canAccessAllSessions: boolean;
      businessId?: string | null;
      sharedSessions?: boolean;
      businessMemberIds?: string[];
      email?: string | null;
      username?: string | null;
    },
  ) => Promise<{
    status: number;
    ok: boolean;
    payload: {
      status: "none" | "pending" | "approved" | "superseded";
      revision: number;
      markdown: string | null;
      userEdited: boolean;
      updatedAt: string;
      planPromptId: string;
    } | null;
  }>;
  enqueueSessionPrompt: (
    env: Record<string, unknown>,
    sessionId: string,
    prompt: string,
    actorUserId: string,
    options?: {
      requestId?: string | null;
      auth?: {
        userId: string;
        canAccessAllSessions: boolean;
        businessId?: string | null;
        sharedSessions?: boolean;
        businessMemberIds?: string[];
        email?: string | null;
        username?: string | null;
      };
    },
  ) => Promise<{
    status: number;
    ok: boolean;
    payload: unknown | null;
    error: string | null;
    reason?: string | null;
  }>;
  notifySessionPrMerged: (
    env: Record<string, unknown>,
    sessionId: string,
    prUrl: string,
    requestId?: string | null,
  ) => Promise<{ status: number; ok: boolean; payload: { ok: boolean; notified?: boolean } | null }>;
  openSessionWebSocket: (
    env: Record<string, unknown>,
    sessionId: string,
    request: Request,
    afterSequence: number,
    auth: {
      userId: string;
      canAccessAllSessions: boolean;
      businessId?: string | null;
      sharedSessions?: boolean;
      businessMemberIds?: string[];
      email?: string | null;
      username?: string | null;
      impersonationId?: string;
      readOnly?: true;
    },
  ) => Promise<Response>;
  runTerminalBenchTests: (
    env: Record<string, unknown>,
    sessionId: string,
    payload: { taskId: string },
    auth: { userId: string; canAccessAllSessions: boolean },
    requestId?: string | null,
  ) => Promise<{ status: number; ok: boolean; payload: unknown | null; error: string | null }>;
  updateSessionCallbackContext: (
    env: Record<string, unknown>,
    sessionId: string,
    callbackContext: Record<string, unknown>,
    requestId?: string | null,
  ) => Promise<{ status: number; ok: boolean; payload: { ok: true } | null }>;
  getPublicSessionArtifact: (
    env: Record<string, unknown>,
    sessionId: string,
    artifactId: string,
    filename: string,
    request: Request,
  ) => Promise<Response>;
  revokeSessionArtifact: (
    env: Record<string, unknown>,
    sessionId: string,
    artifactId: string,
    requestId?: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  getSessionEventHistory: (
    env: Record<string, unknown>,
    sessionId: string,
    promptId?: string,
    afterSequence?: number,
    requestId?: string | null,
  ) => Promise<{
    ok: boolean;
    events: Array<{ sequence: number; id: string; type: string; timestamp: string; data: Record<string, unknown> }>;
  }>;
  getSessionReplayPageAuthed: (
    env: Record<string, unknown>,
    sessionId: string,
    auth: {
      userId: string;
      canAccessAllSessions: boolean;
      businessId?: string | null;
      sharedSessions?: boolean;
      businessMemberIds?: string[];
      email?: string | null;
      username?: string | null;
      mode?: string;
    },
    query: {
      promptId?: string;
      afterSequence?: number;
      beforeSequence?: number;
      limit?: number;
      hasExplicitAfterSequence?: boolean;
    },
    requestId?: string | null,
  ) => Promise<{
    status: number;
    ok: boolean;
    payload: {
      ok: boolean;
      afterSequence: number;
      beforeSequence?: number | null;
      hasMore: boolean;
      droppedCount: number;
      firstSequence: number | null;
      lastSequence: number | null;
      events: unknown[];
    } | null;
  }>;
};

type PromptQueueModule = {
  getQueueState: (
    prompts: PromptState[],
    activePromptId: string | null,
  ) => { queuedCount: number; processingPromptId: string | null };
  buildSandboxCallbackContract: (
    sessionId: string,
    prompt: PromptState,
    callbackAuth: string,
    sessionModel?: string | null,
  ) => {
    sessionId: string;
    promptId: string;
    prompt: string;
    callback: { method: string; path: string; auth: string };
  };
};

let stateMod: SessionStateModule;
let queueMod: PromptQueueModule;

function expectHeaders(init: RequestInit, expected: Record<string, string>): void {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(expected)) {
    expect(headers.get(key)).toBe(value);
  }
}

describe("session/state - pure functions", () => {
  beforeEach(async () => {
    const stateModulePath: string = "../../apps/control-plane-worker/src/session/state";
    const queueModulePath: string = "../../apps/control-plane-worker/src/session/prompt-queue";
    stateMod = (await import(stateModulePath)) as unknown as SessionStateModule;
    queueMod = (await import(queueModulePath)) as unknown as PromptQueueModule;
  });

  describe("getQueueState", () => {
    const makePrompt = (overrides: Partial<PromptState> = {}): PromptState => ({
      promptId: "p-1",
      prompt: "hello",
      actorUserId: "user-1",
      status: "queued",
      createdAt: "2025-01-01T00:00:00Z",
      startedAt: null,
      completedAt: null,
      updatedAt: "2025-01-01T00:00:00Z",
      result: null,
      error: null,
      ...overrides,
    });

    it("returns zero counts for empty prompts", () => {
      const result = queueMod.getQueueState([], null);
      expect(result).toEqual({ queuedCount: 0, processingPromptId: null });
    });

    it("counts only queued prompts", () => {
      const prompts: PromptState[] = [
        makePrompt({ promptId: "p-1", status: "queued" }),
        makePrompt({ promptId: "p-2", status: "processing" }),
        makePrompt({ promptId: "p-3", status: "queued" }),
        makePrompt({ promptId: "p-4", status: "completed" }),
      ];
      const result = queueMod.getQueueState(prompts, "p-2");
      expect(result.queuedCount).toBe(2);
      expect(result.processingPromptId).toBe("p-2");
    });

    it("passes through the active prompt id", () => {
      const result = queueMod.getQueueState([], "active-prompt-123");
      expect(result.processingPromptId).toBe("active-prompt-123");
    });

    it("handles all prompts completed", () => {
      const prompts: PromptState[] = [makePrompt({ status: "completed" }), makePrompt({ status: "failed" })];
      const result = queueMod.getQueueState(prompts, null);
      expect(result.queuedCount).toBe(0);
      expect(result.processingPromptId).toBeNull();
    });
  });

  describe("buildSandboxCallbackContract", () => {
    it("builds a dispatch contract with encoded session and prompt ids", () => {
      const prompt: PromptState = {
        promptId: "prompt-abc",
        prompt: "do something",
        actorUserId: "user-1",
        status: "processing",
        createdAt: "2025-01-01T00:00:00Z",
        startedAt: "2025-01-01T00:00:01Z",
        completedAt: null,
        updatedAt: "2025-01-01T00:00:01Z",
        result: null,
        error: null,
      };

      const contract = queueMod.buildSandboxCallbackContract("session-xyz", prompt, "Bearer test-token");
      expect(contract.sessionId).toBe("session-xyz");
      expect(contract.promptId).toBe("prompt-abc");
      expect(contract.prompt).toBe("do something");
      expect(contract.callback.method).toBe("POST");
      expect(contract.callback.path).toContain("session-xyz");
      expect(contract.callback.path).toContain("prompt-abc");
      expect(contract.callback.auth).toBe("Bearer test-token");
    });

    it("URL-encodes special characters in session and prompt ids", () => {
      const prompt: PromptState = {
        promptId: "prompt with spaces",
        prompt: "test",
        actorUserId: null,
        status: "queued",
        createdAt: "2025-01-01T00:00:00Z",
        startedAt: null,
        completedAt: null,
        updatedAt: "2025-01-01T00:00:00Z",
        result: null,
        error: null,
      };

      const contract = queueMod.buildSandboxCallbackContract("session/special", prompt, "Bearer test-token");
      expect(contract.callback.path).toContain(encodeURIComponent("session/special"));
      expect(contract.callback.path).toContain(encodeURIComponent("prompt with spaces"));
    });
  });

  describe("assertDatabase", () => {
    it("returns DB when present", () => {
      const env = { DB: { prepare: () => {} } };
      expect(stateMod.assertDatabase(env)).toBe(env.DB);
    });

    it("throws when DB is missing", () => {
      const env = {};
      expect(() => stateMod.assertDatabase(env)).toThrow("D1 binding DB is not configured");
    });
  });

  describe("createSessionState", () => {
    it("rejects malformed session ids before any business lookup or DO fetch", async () => {
      const fetchMock = vi.fn();
      const prepare = vi.fn();
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: { prepare },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      for (const sessionId of ["bad/slash", "bad\nnewline", "x".repeat(129), 123 as unknown as string]) {
        await expect(stateMod.createSessionState(env, sessionId, "123")).rejects.toMatchObject({
          name: "InvalidSessionIdError",
          message: "sessionId must be 1-128 characters of letters, numbers, underscores, or hyphens",
        });
      }

      expect(prepare).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts bounded non-UUID session ids at the chokepoint", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: { sessionId: "Session_ABC-123", ownerUserId: "123", businessId: "biz-1", status: "active" },
              replay: { sessionId: "Session_ABC-123", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "Session_ABC-123", "123", {
        businessId: "biz-1",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("accepts the internally-generated Slack automation session id at the chokepoint", async () => {
      // Slack channel automation builds `automation-slack-alert-<32hex>-<ts>` (~73 chars) and
      // routes it through createSessionState. The bound must not reject these legit internal ids.
      const automationSessionId = `automation-slack-alert-${"a".repeat(32)}-1720000000-123456`;
      expect(automationSessionId.length).toBeGreaterThan(64);

      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: { sessionId: automationSessionId, ownerUserId: "123", businessId: "biz-1", status: "active" },
              replay: { sessionId: automationSessionId, lastEventSequence: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, automationSessionId, "123", {
        businessId: "biz-1",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("forwards auth context on initialization headers", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-123",
                ownerUserId: "user-123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-123", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-123", "user-123", {
        requestId: "req-123",
        businessId: "biz-1",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
        auth: {
          userId: "user-123",
          canAccessAllSessions: false,
          businessId: "biz-1",
          sharedSessions: true,
          businessMemberIds: ["user-123", "user-456"],
          email: "user@example.com",
          username: "user-login",
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expectHeaders(init, {
        "content-type": "application/json",
        "x-request-id": "req-123",
        "x-session-id": "session-123",
        "x-auth-user-id": "user-123",
        "x-auth-can-access-all": "false",
        "x-auth-business-id": "biz-1",
        "x-auth-shared-sessions": "true",
        "x-auth-business-member-ids": '["user-123","user-456"]',
        "x-auth-user-email": "user@example.com",
        "x-auth-user-username": "user-login",
      });
    });

    it("schedules session.requested startup telemetry through waitUntil", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-telemetry",
                ownerUserId: "user-123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-telemetry", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const waitUntil = vi.fn();
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-telemetry", "user-123", {
        businessId: "biz-1",
        model: "gpt-5.5",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
        waitUntil,
      });

      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    });

    it("derives the agent runtime backend from the model when none is given", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: { sessionId: "session-claude", ownerUserId: "user-123", businessId: "biz-1", status: "active" },
              replay: { sessionId: "session-claude", lastEventSequence: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-claude", "user-123", {
        businessId: "biz-1",
        model: "claude-opus-4-8",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("claude-opus-4-8");
      expect(body.agentRuntimeBackend).toBe("claude_code");
    });

    it("keeps the codex backend for OpenAI models when none is given", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: { sessionId: "session-codex", ownerUserId: "user-123", businessId: "biz-1", status: "active" },
              replay: { sessionId: "session-codex", lastEventSequence: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-codex", "user-123", {
        businessId: "biz-1",
        model: "gpt-5.5",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("gpt-5.5");
      expect(body.agentRuntimeBackend).toBe("codex");
    });

    it("fails closed for a model that is invalid on an explicitly requested backend", async () => {
      const fetchMock = vi.fn();
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await expect(
        stateMod.createSessionState(env, "session-bad", "user-123", {
          businessId: "biz-1",
          model: "claude-opus-4-8",
          agentRuntimeBackend: "codex",
        }),
      ).rejects.toThrow("Invalid session start model for codex: claude-opus-4-8");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("blocks opencode centrally for non-Cycloid businesses", async () => {
      const fetchMock = vi.fn();
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await expect(
        stateMod.createSessionState(env, "session-opencode-denied", "user-123", {
          businessId: "biz-1",
          model: "kimi-k2.7-code",
          agentRuntimeBackend: "opencode",
          credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
        }),
      ).rejects.toBeInstanceOf(OpencodeAccessDeniedError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("allows opencode centrally for Cycloid businesses when provider credentials pass", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-opencode",
                ownerUserId: "user-123",
                businessId: SEEDED_BUSINESS_IDS.cycloidQa,
                status: "active",
              },
              replay: { sessionId: "session-opencode", lastEventSequence: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-opencode", "user-123", {
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        model: "kimi-k2.7-code",
        agentRuntimeBackend: "opencode",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("kimi-k2.7-code");
      expect(body.agentRuntimeBackend).toBe("opencode");
    });

    it("keeps missing and unattended entrypoints out of plan mode after approval activation", async () => {
      const cases = [
        {
          sessionId: "session-plan-default",
          businessId: SEEDED_BUSINESS_IDS.cycloidQa,
          options: {},
          expectedPlanMode: false,
        },
        {
          sessionId: "session-plan-disabled",
          businessId: SEEDED_BUSINESS_IDS.cycloidQa,
          options: { planMode: "off" },
          expectedPlanMode: false,
        },
        {
          // A missing entrypoint fails closed for every business after activation.
          sessionId: "session-plan-non-cycloid",
          businessId: "biz-1",
          options: {},
          expectedPlanMode: false,
        },
        {
          // Explicit off remains off for every business.
          sessionId: "session-plan-non-cycloid-disabled",
          businessId: "biz-1",
          options: { planMode: "off" },
          expectedPlanMode: false,
        },
        {
          sessionId: "session-plan-verifier",
          businessId: SEEDED_BUSINESS_IDS.cycloidQa,
          options: {
            agentRole: "verification",
            agentProfile: "verify",
            harnessKind: "codex-session",
            runtimeStartupProfile: "verification_ready_runtime",
            targetPrUrl: "https://github.com/org/repo/pull/123",
          },
          expectedPlanMode: false,
        },
        {
          sessionId: "session-plan-child",
          businessId: SEEDED_BUSINESS_IDS.cycloidQa,
          options: { initiationMode: "child" },
          expectedPlanMode: false,
        },
        ...[
          SessionEntrypoint.CHILD_SESSION,
          SessionEntrypoint.SLACK_AUTOMATION,
          SessionEntrypoint.JIRA,
          SessionEntrypoint.LINEAR,
          SessionEntrypoint.PAGERDUTY,
          SessionEntrypoint.GITHUB,
          SessionEntrypoint.SCHEDULED,
          SessionEntrypoint.AUTO_QA,
        ].map((entrypoint) => ({
          sessionId: `session-plan-legacy-${entrypoint}`,
          businessId: SEEDED_BUSINESS_IDS.cycloidQa,
          options: { entrypoint },
          expectedPlanMode: false,
        })),
      ];

      for (const testCase of cases) {
        const fetchMock = vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                session: {
                  sessionId: testCase.sessionId,
                  ownerUserId: "user-123",
                  businessId: testCase.businessId,
                  status: "active",
                },
                replay: { sessionId: testCase.sessionId, lastEventSequence: 0 },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        );
        const env = {
          WORKER_ENV: ENVIRONMENT.Test,
          SESSION: {
            idFromName: (name: string) => name,
            get: () => ({ fetch: fetchMock }),
          },
        };

        await stateMod.createSessionState(env, testCase.sessionId, "user-123", {
          businessId: testCase.businessId,
          credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
          ...testCase.options,
        });

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(init.body as string)).toMatchObject({
          planMode: testCase.expectedPlanMode,
          planApprovalRequired: false,
        });
      }
    });

    it.each([
      { sessionId: "session-external-pr-default", option: undefined, expected: false },
      { sessionId: "session-external-pr-adopted", option: true, expected: true },
    ])("threads adoptedExternalPr=$expected into SessionDO initialization", async ({ sessionId, option, expected }) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: { sessionId, ownerUserId: "user-123", businessId: SEEDED_BUSINESS_IDS.cycloidQa },
              replay: { sessionId, lastEventSequence: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, sessionId, "user-123", {
        businessId: SEEDED_BUSINESS_IDS.cycloidQa,
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
        ...(option === true ? { adoptedExternalPr: true } : {}),
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ adoptedExternalPr: expected });
    });

    it("runs the provider credential gate before initializing the Session DO", async () => {
      const fetchMock = vi.fn();
      const bind = vi.fn(() => ({}));
      const prepare = vi.fn(() => ({ bind }));
      const batch = vi.fn().mockResolvedValue([{ results: [] }, { results: [] }]);
      const env = {
        WORKER_ENV: "test",
        DB: { prepare, batch },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await expect(
        stateMod.createSessionState(env, "session-missing-key", "123", {
          businessId: "biz-1",
          model: "gpt-5.5",
        }),
      ).rejects.toBeInstanceOf(ProviderCredentialNotValidatedError);

      expect(batch).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects GPT-5.3 Codex Spark session creation without Codex subscription auth", async () => {
      const fetchMock = vi.fn();
      const bind = vi.fn(() => ({}));
      const prepare = vi.fn(() => ({ bind }));
      const batch = vi.fn().mockResolvedValue([
        { results: [{ use_codex_subscription: 0 }] },
        {
          results: [
            {
              api_key: "encrypted-auth-json",
              external_user_id: "auth_json:123",
              encrypted: 1,
              last_validation_status: "validated",
            },
          ],
        },
      ]);
      const env = {
        WORKER_ENV: "test",
        DB: { prepare, batch },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await expect(
        stateMod.createSessionState(env, "session-spark-byok", "123", {
          businessId: "295d2abc-d10b-4662-b84d-7bfa66242882",
          model: "gpt-5.3-codex-spark",
        }),
      ).rejects.toBeInstanceOf(ProviderCredentialNotValidatedError);

      expect(batch).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects session creation when the owner has no business snapshot", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-123",
                ownerUserId: "123",
                businessId: null,
                status: "active",
              },
              replay: { sessionId: "session-123", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const first = vi.fn(async () => ({ business_id: null }));
      const bind = vi.fn(() => ({ first }));
      const prepare = vi.fn(() => ({ bind }));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: { prepare },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await expect(
        stateMod.createSessionState(env, "session-123", "123", { entrypoint: SessionEntrypoint.API }),
      ).rejects.toThrow("User 123 is missing business ownership");

      expect(prepare).toHaveBeenCalledWith("SELECT business_id FROM users WHERE id = ? LIMIT 1");
      expect(bind).toHaveBeenCalledWith(123);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolves an explicit null business id from the owner snapshot", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-123",
                ownerUserId: "123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-123", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const first = vi.fn(async () => ({ business_id: "biz-1" }));
      const bind = vi.fn(() => ({ first }));
      const prepare = vi.fn(() => ({ bind }));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: { prepare },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-123", "123", {
        businessId: null,
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      expect(prepare).toHaveBeenCalledWith("SELECT business_id FROM users WHERE id = ? LIMIT 1");
      expect(bind).toHaveBeenCalledWith(123);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ businessId: "biz-1" });
    });

    it("forwards verification role metadata during session creation", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-verify",
                ownerUserId: "123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-verify", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-verify", "123", {
        businessId: "biz-1",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
        agentRole: "verification",
        agentProfile: "verify",
        harnessKind: "codex-session",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/org/repo/pull/123",
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({
        agentRole: "verification",
        agentProfile: "verify",
        harnessKind: "codex-session",
        runtimeStartupProfile: "verification_ready_runtime",
        targetPrUrl: "https://github.com/org/repo/pull/123",
      });
    });

    it("uses the saved auto verification default when autoVerify is omitted", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-auto-verify-default",
                ownerUserId: "123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-auto-verify-default", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const first = vi.fn(async () => ({ auto_verify_enabled: 0 }));
      const bind = vi.fn(() => ({ first }));
      const prepare = vi.fn(() => ({ bind }));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: { prepare },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-auto-verify-default", "123", {
        businessId: "biz-1",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      expect(prepare).toHaveBeenCalledWith(USER_SETTINGS_SELECT_BY_USER_ID_SQL);
      expect(bind).toHaveBeenCalledWith(123);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ autoVerify: false });
    });

    it("honors explicit autoVerify over the saved default", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-auto-verify-explicit",
                ownerUserId: "123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-auto-verify-explicit", lastEventSequence: 0 },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const first = vi.fn(async () => null);
      const bind = vi.fn(() => ({ first }));
      const prepare = vi.fn(() => ({ bind }));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: { prepare },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-auto-verify-explicit", "123", {
        businessId: "biz-1",
        autoVerify: true,
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      expect(prepare).not.toHaveBeenCalledWith(USER_SETTINGS_SELECT_BY_USER_ID_SQL);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).not.toHaveProperty("autoVerify");
    });

    it("defaults verification OFF when the saved setting cannot be loaded", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                sessionId: "session-auto-verify-fallback",
                ownerUserId: "123",
                businessId: "biz-1",
                status: "active",
              },
              replay: { sessionId: "session-auto-verify-fallback", lastEventSequence: 0 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      // getUserSettings throws → resolveAutoVerifyEnabled's catch must now fail to OFF.
      const first = vi.fn(async () => {
        throw new Error("settings load failed");
      });
      const bind = vi.fn(() => ({ first }));
      const prepare = vi.fn(() => ({ bind }));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: { prepare },
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.createSessionState(env, "session-auto-verify-fallback", "123", {
        businessId: "biz-1",
        credentialGate: { mode: "skip", reason: "unit test does not exercise provider credentials" },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string)).toMatchObject({ autoVerify: false });
    });
  });

  describe("createSessionState - Slack thread claim invariant", () => {
    const REF = { businessId: "biz-1", teamId: "T1", channelId: "C1", threadTs: "1700000000.0001" };
    const slackCallbackContext = {
      source: "slack" as const,
      channel: REF.channelId,
      threadTs: REF.threadTs,
      slackTeamId: REF.teamId,
    };
    const credentialGate = { mode: "skip" as const, reason: "unit test does not exercise provider credentials" };

    function buildSlackEnv(sqlite: Database.Database, fetchImpl: () => Promise<Response>): Record<string, unknown> {
      return {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: new SqliteD1(sqlite) as unknown as D1Database,
        SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: vi.fn(fetchImpl) }) },
      };
    }

    function okInitializeResponse(sessionId: string): Response {
      return new Response(
        JSON.stringify({
          session: { sessionId, ownerUserId: "user-1", businessId: REF.businessId, status: "active" },
          replay: { sessionId, lastEventSequence: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    it("claims the Slack thread for the created session, binding the thread 1:1", async () => {
      const sqlite = createMigratedSqlite();
      const env = buildSlackEnv(sqlite, async () => okInitializeResponse("session-a"));

      await stateMod.createSessionState(env, "session-a", "user-1", {
        businessId: REF.businessId,
        credentialGate,
        callbackContext: slackCallbackContext,
      });

      expect(slackThreadSessionId(sqlite, REF)).toBe("session-a");
    });

    it("writes the Slack thread webhook ref when the callback context is Slack", async () => {
      const sqlite = createMigratedSqlite();
      const env = buildSlackEnv(sqlite, async () => okInitializeResponse("session-a"));

      await stateMod.createSessionState(env, "session-a", "user-1", {
        businessId: REF.businessId,
        credentialGate,
        callbackContext: slackCallbackContext,
      });

      expect(slackThreadWebhookSessionId(sqlite, REF)).toBe("session-a");
    });

    it("does not fail session creation when the Slack webhook ref write fails", async () => {
      const sqlite = createMigratedSqlite();
      const realDb = new SqliteD1(sqlite);
      const db = {
        prepare(query: string) {
          if (query.includes("INSERT INTO session_webhook_refs")) {
            return { bind: () => ({ run: async () => Promise.reject(new Error("d1 unavailable")) }) };
          }
          return realDb.prepare(query);
        },
      };
      const env = {
        ...buildSlackEnv(sqlite, async () => okInitializeResponse("session-a")),
        DB: db as unknown as D1Database,
      };

      await expect(
        stateMod.createSessionState(env, "session-a", "user-1", {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        }),
      ).resolves.toBeDefined();
      expect(slackThreadSessionId(sqlite, REF)).toBe("session-a");
      expect(slackThreadWebhookSessionId(sqlite, REF)).toBeNull();
    });

    it("does not expose the Slack thread webhook ref before initialize succeeds", async () => {
      const sqlite = createMigratedSqlite();
      const initialize = deferred<Response>();
      const fetchMock = vi.fn(() => initialize.promise);
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: new SqliteD1(sqlite) as unknown as D1Database,
        SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: fetchMock }) },
      };

      const createPromise = stateMod.createSessionState(env, "session-a", "user-1", {
        businessId: REF.businessId,
        credentialGate,
        callbackContext: slackCallbackContext,
      });

      for (let attempt = 0; attempt < 20 && fetchMock.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(slackThreadSessionId(sqlite, REF)).toBe("session-a");
      expect(slackThreadWebhookSessionId(sqlite, REF)).toBeNull();

      initialize.resolve(okInitializeResponse("session-a"));
      await expect(createPromise).resolves.toBeDefined();
      expect(slackThreadWebhookSessionId(sqlite, REF)).toBe("session-a");
    });

    it("fails closed when another session already owns the thread", async () => {
      const sqlite = createMigratedSqlite();
      // First session claims the thread.
      await stateMod.createSessionState(
        buildSlackEnv(sqlite, async () => okInitializeResponse("session-a")),
        "session-a",
        "user-1",
        {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        },
      );

      const secondFetch = vi.fn(async () => okInitializeResponse("session-b"));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: new SqliteD1(sqlite) as unknown as D1Database,
        SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: secondFetch }) },
      };

      let caught: unknown;
      await stateMod
        .createSessionState(env, "session-b", "user-1", {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        })
        .catch((err) => {
          caught = err;
        });

      expect((caught as { name?: string })?.name).toBe("SlackThreadAlreadyClaimedError");
      expect((caught as { existingSessionId?: string })?.existingSessionId).toBe("session-a");
      // The second session never initialized, and the thread stays bound to session-a.
      expect(secondFetch).not.toHaveBeenCalled();
      expect(slackThreadSessionId(sqlite, REF)).toBe("session-a");
    });

    it("is idempotent when the same session re-claims its own thread", async () => {
      const sqlite = createMigratedSqlite();
      sqlite
        .prepare(
          `INSERT INTO slack_thread_session_refs (business_id, team_id, channel_id, thread_ts, session_id, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(REF.businessId, REF.teamId, REF.channelId, REF.threadTs, "session-a", 1000);
      const fetchMock = vi.fn(async () => okInitializeResponse("session-a"));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: new SqliteD1(sqlite) as unknown as D1Database,
        SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: fetchMock }) },
      };

      await expect(
        stateMod.createSessionState(env, "session-a", "user-1", {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        }),
      ).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("releases the thread claim when DO initialize fails so the thread is not orphaned", async () => {
      const sqlite = createMigratedSqlite();
      const env = buildSlackEnv(sqlite, async () => new Response("boom", { status: 500 }));

      await expect(
        stateMod.createSessionState(env, "session-a", "user-1", {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        }),
      ).rejects.toThrow(/initialize failed/);

      expect(slackThreadSessionId(sqlite, REF)).toBeNull();
      expect(slackThreadWebhookSessionId(sqlite, REF)).toBeNull();
    });

    it("surfaces the DO initialize error even when releasing the claim throws", async () => {
      const sqlite = createMigratedSqlite();
      const real = new SqliteD1(sqlite);
      // Simulate D1 being transiently unavailable for the release DELETE at the
      // same moment the DO call fails. The release must not mask the primary error.
      const dbFailingDelete = {
        prepare(query: string) {
          if (query.includes("DELETE FROM slack_thread_session_refs")) {
            return { bind: () => ({ run: async () => Promise.reject(new Error("d1 delete unavailable")) }) };
          }
          return (real as unknown as { prepare: (q: string) => unknown }).prepare(query);
        },
      };
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: dbFailingDelete as unknown as D1Database,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: vi.fn(async () => new Response("boom", { status: 500 })) }),
        },
      };

      // The caller sees the DO failure, not the swallowed delete error.
      await expect(
        stateMod.createSessionState(env, "session-a", "user-1", {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        }),
      ).rejects.toThrow(/initialize failed/);
    });

    it("re-claims the thread when a concurrent release frees it between claim and lookup", async () => {
      let insertCount = 0;
      // Scripted D1: the first claim INSERT conflicts (a prior claimant's row
      // exists), the owner lookup then returns null (that claimant released the
      // row), and the second claim INSERT succeeds. createSessionState must
      // re-attempt the claim rather than proceed unclaimed.
      const scriptedDb = {
        prepare(query: string) {
          const isInsert = query.includes("INSERT INTO slack_thread_session_refs");
          return {
            bind: () => ({
              run: async () => {
                if (isInsert) {
                  insertCount += 1;
                  return { success: true, meta: { changes: insertCount === 1 ? 0 : 1 } };
                }
                return { success: true, meta: { changes: 0 } };
              },
              first: async () => null,
            }),
          };
        },
      };
      const fetchMock = vi.fn(async () => okInitializeResponse("session-a"));
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        DB: scriptedDb as unknown as D1Database,
        SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: fetchMock }) },
      };

      await expect(
        stateMod.createSessionState(env, "session-a", "user-1", {
          businessId: REF.businessId,
          credentialGate,
          callbackContext: slackCallbackContext,
        }),
      ).resolves.toBeDefined();
      expect(insertCount).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("listSessionPrompts", () => {
    it("forwards auth context on internal DO headers", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              prompts: [],
              queue: { queuedCount: 0, processingPromptId: null },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.listSessionPrompts(env, "session-123", {
        auth: {
          userId: "user-123",
          canAccessAllSessions: false,
          businessMemberIds: ["user-123", "user-456"],
          email: "user@example.com",
          username: "user-login",
        },
        requestId: "req-123",
      });

      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expectHeaders(init, {
        "x-request-id": "req-123",
        "x-session-id": "session-123",
        "x-auth-user-id": "user-123",
        "x-auth-can-access-all": "false",
        "x-auth-business-member-ids": '["user-123","user-456"]',
        "x-auth-user-email": "user@example.com",
        "x-auth-user-username": "user-login",
      });
    });

    it("omits business member header when no shared members are present", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              prompts: [],
              queue: { queuedCount: 0, processingPromptId: null },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.listSessionPrompts(env, "session-456", {
        auth: {
          userId: "admin-1",
          canAccessAllSessions: true,
        },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("x-auth-business-member-ids")).toBeNull();
      expect(headers.get("x-auth-can-access-all")).toBe("true");
    });
  });

  describe("getSessionPlan", () => {
    it("uses the typed plan route and forwards authorization context", async () => {
      const plan = {
        status: "pending" as const,
        revision: 3,
        markdown: "# Plan\n\nShip it",
        userEdited: true,
        updatedAt: "2026-07-09T16:00:00.000Z",
        planPromptId: "p-plan-3",
      };
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify(plan), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionPlan(env, "session-123", "req-plan", {
        userId: "user-123",
        canAccessAllSessions: false,
        businessId: "biz-1",
        sharedSessions: true,
        businessMemberIds: ["user-123", "user-456"],
      });

      expect(result).toEqual({ status: 200, ok: true, payload: plan });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/plan");
      expect(init.method).toBe("GET");
      expectHeaders(init, {
        "x-request-id": "req-plan",
        "x-session-id": "session-123",
        "x-auth-user-id": "user-123",
        "x-auth-business-id": "biz-1",
        "x-auth-shared-sessions": "true",
        "x-auth-business-member-ids": '["user-123","user-456"]',
      });
    });

    it("preserves a missing-plan 404 without inventing a payload", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Plan not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await expect(
        stateMod.getSessionPlan(env, "session-without-plan", null, {
          userId: "user-123",
          canAccessAllSessions: false,
        }),
      ).resolves.toEqual({ status: 404, ok: false, payload: null });
    });
  });

  describe("typed SessionDO route helpers", () => {
    it("forwards read-only impersonation auth to websocket DO requests", async () => {
      let forwardedRequest: Request | null = null;
      const fetchMock = vi.fn(async (request: Request) => {
        forwardedRequest = request;
        return new Response(null, { status: 200 });
      });
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.openSessionWebSocket(
        env,
        "session-123",
        new Request("https://app.trycycloid.com/api/sessions/session-123/ws", {
          headers: {
            upgrade: "websocket",
            "x-auth-user-id": "spoofed-user",
            "x-auth-impersonation-id": "spoofed-impersonation",
          },
        }),
        0,
        {
          userId: "user-123",
          canAccessAllSessions: false,
          businessId: null,
          sharedSessions: false,
          impersonationId: "imp-123",
        },
      );

      expect(forwardedRequest).toBeInstanceOf(Request);
      expect(forwardedRequest?.url).toBe("https://internal/session/ws?afterSequence=0");
      expect(forwardedRequest?.headers.get("upgrade")).toBe("websocket");
      expect(forwardedRequest?.headers.get("x-auth-user-id")).toBe("user-123");
      expect(forwardedRequest?.headers.get("x-auth-can-access-all")).toBe("false");
      expect(forwardedRequest?.headers.get("x-auth-impersonation-id")).toBe("imp-123");
      expect(forwardedRequest?.headers.get("x-auth-read-only")).toBe("true");
    });

    it("reuses the prompt enqueue helper for authed requests", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              session: { sessionId: "session-123", status: "active" },
              replay: { sessionId: "session-123", lastEventSequence: 1 },
              prompt: { promptId: "prompt-1" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.enqueueSessionPrompt(env, "session-123", "Ship it", "user-123", {
        source: "web",
        auth: {
          userId: "user-123",
          canAccessAllSessions: false,
          businessMemberIds: ["user-123"],
        },
        requestId: "req-123",
      });

      expect(result.ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/prompts/enqueue");
      expect(init.method).toBe("POST");
      expectHeaders(init, {
        "content-type": "application/json",
        "x-request-id": "req-123",
        "x-session-id": "session-123",
        "x-auth-user-id": "user-123",
        "x-auth-can-access-all": "false",
        "x-auth-business-member-ids": '["user-123"]',
      });
      expect(JSON.parse(init.body as string)).toMatchObject({
        prompt: "Ship it",
        source: "web",
        replyToText: "Ship it",
        actorUserId: "user-123",
      });
    });

    it("lifts the structured session_not_sendable envelope so reason survives", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "session_not_sendable", reason: "blocked" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.enqueueSessionPrompt(env, "session-123", "Ship it", "user-123", {
        requestId: "req-1",
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(409);
      expect(result.error).toBe("session_not_sendable");
      expect((result as unknown as { reason: string | null }).reason).toBe("blocked");
    });

    it("derives event history timestamps from canonical replay timestampMs", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 0,
              beforeSequence: null,
              hasMore: true,
              droppedCount: 0,
              firstSequence: 1,
              lastSequence: 2,
              events: [
                {
                  sequence: 1,
                  phase: "tool.call",
                  timestampMs: 1_713_456_789_000,
                  sessionId: "session-123",
                  promptId: "prompt-1",
                  payload: { callId: "call-1", tool: "exec_command", args: { cmd: "date" } },
                },
                {
                  sequence: 2,
                  type: "question",
                  data: { timestamp: "2024-04-18T12:00:00.000Z", question: "Continue?" },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 2,
              beforeSequence: null,
              hasMore: false,
              droppedCount: 0,
              firstSequence: 3,
              lastSequence: 3,
              events: [
                {
                  sequence: 3,
                  phase: "prompt.complete",
                  timestampMs: 1_713_456_789_500,
                  sessionId: "session-123",
                  promptId: "prompt-1",
                  payload: { success: true },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionEventHistory(env, "session-123", "prompt-1", undefined, "req-123");

      expect(result).toEqual({
        ok: true,
        events: [
          {
            sequence: 1,
            id: "replay-1",
            type: "tool_call",
            timestamp: "2024-04-18T16:13:09.000Z",
            data: {
              promptId: "prompt-1",
              id: "call-1",
              tool: "exec_command",
              summary: "",
              input: { cmd: "date" },
            },
          },
          {
            sequence: 2,
            id: "replay-2",
            type: "question",
            timestamp: "2024-04-18T12:00:00.000Z",
            data: { timestamp: "2024-04-18T12:00:00.000Z", question: "Continue?" },
          },
          {
            sequence: 3,
            id: "replay-3",
            type: "prompt_completed",
            timestamp: "2024-04-18T16:13:09.500Z",
            data: { promptId: "prompt-1", success: true },
          },
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(firstUrl).toBe("https://internal/session/events/history?prompt_id=prompt-1&after_sequence=0&limit=1000");
      expect(secondUrl).toBe("https://internal/session/events/history?prompt_id=prompt-1&after_sequence=2&limit=1000");
      expectHeaders(firstInit, {
        "x-request-id": "req-123",
        "x-session-id": "session-123",
      });
    });

    it("derives ISO timestamps from canonical replay events", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 0,
              beforeSequence: null,
              hasMore: false,
              droppedCount: 0,
              firstSequence: 7,
              lastSequence: 7,
              events: [
                {
                  sequence: 7,
                  phase: "prompt.dispatch",
                  promptId: "prompt-1",
                  timestampMs: 1_713_456_789_000,
                  sessionId: "session-123",
                  payload: {
                    source: "user",
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionEventHistory(env, "session-123", "prompt-1", 0, "req-123");

      expect(result).toEqual({
        ok: true,
        events: [
          {
            sequence: 7,
            id: "replay-7",
            type: "prompt_processing",
            timestamp: "2024-04-18T16:13:09.000Z",
            data: {
              promptId: "prompt-1",
            },
          },
        ],
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/events/history?prompt_id=prompt-1&after_sequence=0&limit=1000");
      expect(init.method).toBe("GET");
      expectHeaders(init, {
        "x-request-id": "req-123",
        "x-session-id": "session-123",
      });
    });

    it("falls back to embedded legacy event timestamps when replay events are not canonical", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 0,
              beforeSequence: null,
              hasMore: false,
              droppedCount: 0,
              firstSequence: 3,
              lastSequence: 3,
              events: [
                {
                  sequence: 3,
                  type: "tool_call",
                  data: {
                    id: "call-1",
                    tool: "Read",
                    timestamp: 1_713_456_789_100,
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionEventHistory(env, "session-legacy");

      expect(result).toEqual({
        ok: true,
        events: [
          {
            sequence: 3,
            id: "replay-3",
            type: "tool_call",
            timestamp: "2024-04-18T16:13:09.100Z",
            data: {
              id: "call-1",
              tool: "Read",
              timestamp: 1_713_456_789_100,
            },
          },
        ],
      });
    });

    it("returns an empty timestamp for malformed canonical and legacy replay timestamps", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 0,
              beforeSequence: null,
              hasMore: false,
              droppedCount: 0,
              firstSequence: 11,
              lastSequence: 11,
              events: [
                {
                  sequence: 11,
                  phase: "prompt.dispatch",
                  promptId: "prompt-bad",
                  timestampMs: 9_999_999_999_999_999,
                  sessionId: "session-123",
                  payload: {},
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 0,
              beforeSequence: null,
              hasMore: false,
              droppedCount: 0,
              firstSequence: 12,
              lastSequence: 12,
              events: [
                {
                  sequence: 12,
                  type: "tool_call",
                  data: {
                    id: "call-bad",
                    tool: "Read",
                    timestamp: "not-a-date",
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const canonicalResult = await stateMod.getSessionEventHistory(env, "session-bad-canonical");
      const legacyResult = await stateMod.getSessionEventHistory(env, "session-bad-legacy");

      expect(canonicalResult).toEqual({
        ok: true,
        events: [
          {
            sequence: 11,
            id: "replay-11",
            type: "prompt_processing",
            timestamp: "",
            data: {
              promptId: "prompt-bad",
            },
          },
        ],
      });
      expect(legacyResult).toEqual({
        ok: true,
        events: [
          {
            sequence: 12,
            id: "replay-12",
            type: "tool_call",
            timestamp: "",
            data: {
              id: "call-bad",
              tool: "Read",
              timestamp: "not-a-date",
            },
          },
        ],
      });
    });

    it("preserves both replay cursors so the DO can reject invalid mixed pagination", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "after_sequence cannot be combined with before_sequence" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionReplayPageAuthed(
        env,
        "session-123",
        { userId: "user-1", canAccessAllSessions: false, mode: "user_session" },
        { afterSequence: 5, beforeSequence: 10, limit: 25 },
        "req-123",
      );

      expect(result).toEqual({ status: 400, ok: false, payload: null });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/events/history?after_sequence=5&before_sequence=10&limit=25");
      expect(init.method).toBe("GET");
      expectHeaders(init, {
        "x-request-id": "req-123",
        "x-session-id": "session-123",
      });
    });

    it("omits the default after_sequence when replaying before a cursor", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              afterSequence: 0,
              beforeSequence: 10,
              hasMore: false,
              droppedCount: 0,
              firstSequence: null,
              lastSequence: null,
              events: [],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionReplayPageAuthed(
        env,
        "session-123",
        { userId: "user-1", canAccessAllSessions: false, mode: "user_session" },
        { afterSequence: 0, beforeSequence: 10, limit: 25 },
        "req-123",
      );

      expect(result).toMatchObject({ status: 200, ok: true });
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/events/history?before_sequence=10&limit=25");
    });

    it("keeps explicit after_sequence=0 when mixed with before_sequence so the DO can reject it", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "after_sequence cannot be combined with before_sequence" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.getSessionReplayPageAuthed(
        env,
        "session-123",
        { userId: "user-1", canAccessAllSessions: false, mode: "user_session" },
        { afterSequence: 0, beforeSequence: 10, limit: 25, hasExplicitAfterSequence: true },
        "req-123",
      );

      expect(result).toEqual({ status: 400, ok: false, payload: null });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/events/history?after_sequence=0&before_sequence=10&limit=25");
      expect(init.method).toBe("GET");
      expectHeaders(init, {
        "x-request-id": "req-123",
        "x-session-id": "session-123",
      });
    });

    it("sends PR merged notifications through the shared route contract", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, notified: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      const result = await stateMod.notifySessionPrMerged(
        env,
        "session-123",
        "https://github.com/org/repo/pull/42",
        "req-123",
      );

      expect(result.ok).toBe(true);
      expect(result.payload?.notified).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/notify-pr-merged");
      expect(init.method).toBe("POST");
      expectHeaders(init, {
        "content-type": "application/json",
        "x-request-id": "req-123",
        "x-session-id": "session-123",
      });
      expect(JSON.parse(init.body as string)).toEqual({ prUrl: "https://github.com/org/repo/pull/42" });
    });

    it("updates callback context through the shared route contract", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.updateSessionCallbackContext(
        env,
        "session-456",
        {
          source: "slack",
          channel: "C123",
          threadTs: "1710000000.000001",
          slackTeamId: "T123",
          reactionMessageTimestamps: ["1710000000.000002"],
        },
        "req-456",
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://internal/session/callback-context");
      expect(init.method).toBe("PUT");
      expectHeaders(init, {
        "content-type": "application/json",
        "x-request-id": "req-456",
        "x-session-id": "session-456",
      });
      expect(JSON.parse(init.body as string)).toMatchObject({
        source: "slack",
        channel: "C123",
        threadTs: "1710000000.000001",
        slackTeamId: "T123",
        reactionMessageTimestamps: ["1710000000.000002"],
      });
    });

    it("uses explicit artifact read and delete route helpers", async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const env = {
        WORKER_ENV: ENVIRONMENT.Test,
        SESSION: {
          idFromName: (name: string) => name,
          get: () => ({ fetch: fetchMock }),
        },
      };

      await stateMod.getPublicSessionArtifact(
        env,
        "session-123",
        "artifact-1",
        "preview.png",
        new Request(
          "https://app.trycycloid.com/api/sessions/session-123/artifacts/artifact-1/preview.png?artifactToken=t",
        ),
      );
      await stateMod.revokeSessionArtifact(env, "session-123", "artifact-1", "req-123");

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://internal/session/artifacts/artifact-1/preview.png?artifactToken=t",
        expect.objectContaining({ method: "GET" }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://internal/session/artifacts/artifact-1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
