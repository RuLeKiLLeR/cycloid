/**
 * Tests for spawn health check: fail fast when sandbox never connects.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
  SANDBOX_HEARTBEAT_LIVENESS_MS,
} from "../../../apps/control-plane-worker/src/constants/sessions";
import { injectTraceparent, runInSpan, startSpan } from "../../../apps/control-plane-worker/src/observability/context";
import { E2BSandboxRuntimeError } from "../../../apps/control-plane-worker/src/sandbox/e2b-client";
import { SandboxCallbackPreflightError } from "../../../apps/control-plane-worker/src/services/control-plane-callback-preflight";
import { OpencodeAccessDeniedError } from "../../../apps/control-plane-worker/src/services/opencode-access-gate";
import { spawnInstrumentationKey } from "../../../apps/control-plane-worker/src/session/spawn-workflow";
import { parseTraceparent } from "../../../shared/observability/trace";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  queryPrompts,
  querySandboxState,
  querySession,
  querySessionEvents,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
};

interface DOTestHandle {
  generateSessionTitle(sessionId: string, promptText: string, promptId: string): Promise<void>;
  handleSpawnFailure(sessionId: string, operation: string, err: unknown): Promise<void>;
  sendPendingPromptToSandbox(sessionId: string): Promise<boolean>;
  startSpawnAttempt(sessionId: string, operation: string): Promise<string>;
  spawnSandbox(sessionId: string, spawnAttemptId?: string): Promise<void>;
  isCurrentSpawnAttempt(spawnAttemptId: string | undefined | null): Promise<boolean>;
  persistenceQueue: Promise<void>;
  sandboxWs: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number } | null;
  alarm(): Promise<void>;
}

const SPAWN_CONNECT_TIMEOUT_MS = 3 * 60 * 1000;
const STALE_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_ID = "test-session-1";
const originalFetch = globalThis.fetch;

interface PromptDesc {
  promptId: string;
  prompt: string;
  actorUserId: string;
  status: string;
  agent?: string;
  skills?: string[];
  files?: string[];
  uploadedFiles?: Array<{ name: string; content: string }>;
  uploadedImages?: Array<{ name: string; mediaType: string; data: string }>;
  startedAt?: number | null;
  completedAt?: number | null;
  error?: string | null;
  createdAt?: number;
}

function defaultPrompt(overrides: Partial<PromptDesc> = {}): PromptDesc {
  return {
    promptId: "p-1",
    prompt: "test prompt",
    actorUserId: "user-1",
    status: "processing",
    startedAt: Date.now(),
    ...overrides,
  };
}

function makePrompt(overrides: Partial<PromptDesc> = {}): PromptDesc {
  return defaultPrompt(overrides);
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    lastEventId: null,
    title: null,
    ...overrides,
  };
}

async function createSpawningDO(
  workerModule: WorkerModule,
  opts: {
    spawnStartedAt?: number;
    spawnRetryCount?: number;
    sessionKind?: "repo";
    promptOverrides?: Partial<PromptDesc>;
    extraPrompts?: Array<Partial<PromptDesc>>;
  } = {},
) {
  const env = createTestEnv();
  const fakeState = createFakeState();

  const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

  const prompt = defaultPrompt(opts.promptOverrides ?? {});
  const extras = (opts.extraPrompts ?? []).map((o) => defaultPrompt(o));
  const allPrompts = [prompt, ...extras];

  seedSession(fakeState.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    status: "active",
    sessionKind: opts.sessionKind ?? "repo",
    activePromptId: prompt.promptId,
    promptCounter: allPrompts.length,
  });
  seedSandboxState(fakeState.storage, {
    sessionId: SESSION_ID,
    status: "spawning",
    spawnStartedAt: opts.spawnStartedAt ?? Date.now() - SPAWN_CONNECT_TIMEOUT_MS - 1_000,
    lastSpawnAttemptId: "attempt-1",
    spawnRetryCount: opts.spawnRetryCount ?? 0,
  });
  // spawnAttemptId still in KV
  await fakeState.storage.put("spawnAttemptId", "attempt-1");

  for (const p of allPrompts) {
    seedPrompt(fakeState.storage, {
      promptId: p.promptId,
      sessionId: SESSION_ID,
      promptText: p.prompt,
      actorUserId: p.actorUserId,
      agent: p.agent ?? null,
      status: p.status,
      startedAt: p.startedAt ?? null,
      completedAt: p.completedAt ?? null,
      error: p.error ?? null,
      createdAt: p.createdAt ?? Date.now(),
      skillsJson: p.skills ? JSON.stringify(p.skills) : null,
      filesJson: p.files ? JSON.stringify(p.files) : null,
      uploadedFilesJson: p.uploadedFiles ? JSON.stringify(p.uploadedFiles) : null,
      uploadedImagesJson: p.uploadedImages ? JSON.stringify(p.uploadedImages) : null,
    });
  }

  // Events and replay still use KV
  await fakeState.storage.put("events", []);
  await fakeState.storage.put("replay", {
    sessionId: SESSION_ID,
    lastEventSequence: 0,
    lastEventTimestamp: null,
    updatedAt: null,
  });

  fakeState.acceptWebSocket({ send: vi.fn(), close: vi.fn(), readyState: 1 }, ["client", "wsid:test-client"]);

  const session = { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" };
  return { instance, fakeState, env, session, prompt, prompts: allPrompts };
}

function captureDatadogEvents(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const entries = JSON.parse(String(init?.body ?? "[]")) as Array<Record<string, unknown>>;
    events.push(...entries);
    return new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return events;
}

/**
 * Wrap the DO logger's `warn` so we can assert the structured
 * `sandbox.spawn_failed` telemetry (the only spawn-phase signal for a failed
 * spawn -- the success-side duration metric is bridge-emitted on "ready", which
 * a failed spawn never reaches). Calls through so other logging is unaffected.
 */
function captureSpawnFailureLogs(instance: unknown): Array<Record<string, unknown>> {
  const logged: Array<Record<string, unknown>> = [];
  const handle = instance as { log: { warn: (fields: unknown, msg?: unknown) => void } };
  const original = handle.log.warn.bind(handle.log);
  handle.log.warn = (fields: unknown, msg?: unknown) => {
    if (msg === "Sandbox spawn failed" && fields && typeof fields === "object") {
      logged.push(fields as Record<string, unknown>);
    }
    return original(fields, msg);
  };
  return logged;
}

function seedTitleReadySession(fakeState: ReturnType<typeof createFakeState>): void {
  seedSession(fakeState.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
    model: "gpt-5.4-mini",
    activePromptId: "p-1",
    promptCounter: 1,
    repoOwner: "acme",
    repoName: "widgets",
  });
  seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
  seedPrompt(fakeState.storage, {
    promptId: "p-1",
    sessionId: SESSION_ID,
    promptText: "Fix the OAuth redirect",
    actorUserId: "user-1",
    status: "processing",
    startedAt: Date.now(),
  });
}

describe("SessionDO spawn timeout", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/session/durable-object.ts")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("persists and broadcasts generated title metadata for the first active prompt", async () => {
    const feedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const env = {
      ...createTestEnv(),
      ARCANIST_OPENAI_API_KEY: "sk-oai-test",
      SESSION_FEED: {
        idFromName: vi.fn().mockImplementation((name: string) => `id:${name}`),
        get: vi.fn().mockReturnValue({ fetch: feedFetch }),
      },
    };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    const clientSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    fakeState.acceptWebSocket(clientSocket, ["client", "wsid:test-client"]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Fix OAuth redirect" }),
                },
              ],
            },
          ],
        }),
      ),
    );

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      model: "gpt-5.4-mini",
      activePromptId: "p-1",
      promptCounter: 1,
      repoOwner: "acme",
      repoName: "widgets",
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "Fix the OAuth redirect",
      actorUserId: "user-1",
      status: "processing",
      startedAt: Date.now(),
    });

    await instance.generateSessionTitle(SESSION_ID, "Fix the OAuth redirect", "p-1");
    await fakeState.flushWaitUntil();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.title).toBe("Fix OAuth redirect");
    const statusBroadcast = clientSocket.send.mock.calls
      .map(([payload]) => JSON.parse(payload as string) as { type: string; title?: string })
      .find((msg) => msg.type === "session_status");
    expect(statusBroadcast).toMatchObject({
      title: "Fix OAuth redirect",
    });
    expect(feedFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(feedFetch.mock.calls[0][1].body as string)).toMatchObject({
      type: "session_status",
      sessionId: SESSION_ID,
      source: "session.title_generation",
      phase: "running",
      title: "Fix OAuth redirect",
    });
  });

  it("consumes a prepared title record without calling the title model", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    const clientSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    fakeState.acceptWebSocket(clientSocket, ["client", "wsid:test-client"]);
    globalThis.fetch = vi.fn();
    seedTitleReadySession(fakeState);
    await fakeState.storage.put("prepared_title:p-1", { title: "Reuse prepared title", ticketKey: "ARC-123" });
    const originalDelete = fakeState.storage.delete.bind(fakeState.storage);
    fakeState.storage.delete = vi.fn((keyOrKeys: string | string[]) =>
      originalDelete(keyOrKeys),
    ) as typeof fakeState.storage.delete;

    await instance.generateSessionTitle(SESSION_ID, "Fix the OAuth redirect", "p-1");
    await fakeState.flushWaitUntil();

    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.title).toBe("Reuse prepared title");
    expect(session?.ticket_key).toBe("ARC-123");
    expect(await fakeState.storage.get("prepared_title:p-1")).toBeUndefined();
    expect(fakeState.storage.delete).toHaveBeenCalledOnce();
    expect(fakeState.storage.delete).toHaveBeenCalledWith("prepared_title:p-1");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(clientSocket.send).toHaveBeenCalledWith(expect.stringContaining("Reuse prepared title"));
  });

  it("deletes malformed prepared title records and falls back to the title model", async () => {
    const env = { ...createTestEnv(), ARCANIST_OPENAI_API_KEY: "sk-oai-test" };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Fallback generated title" }),
                },
              ],
            },
          ],
        }),
      ),
    );
    seedTitleReadySession(fakeState);
    await fakeState.storage.put("prepared_title:p-1", { title: "Bad prepared title" });

    await instance.generateSessionTitle(SESSION_ID, "Fix the OAuth redirect", "p-1");
    await fakeState.flushWaitUntil();

    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.title).toBe("Fallback generated title");
    expect(await fakeState.storage.get("prepared_title:p-1")).toBeUndefined();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the title model when prepared title storage read fails", async () => {
    const env = { ...createTestEnv(), ARCANIST_OPENAI_API_KEY: "sk-oai-test" };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Storage fallback title" }),
                },
              ],
            },
          ],
        }),
      ),
    );
    seedTitleReadySession(fakeState);
    const originalGet = fakeState.storage.get.bind(fakeState.storage);
    fakeState.storage.get = vi.fn(async (keyOrKeys: string | string[]) => {
      if (keyOrKeys === "prepared_title:p-1") throw new Error("storage unavailable");
      return originalGet(keyOrKeys as string);
    }) as typeof fakeState.storage.get;

    await instance.generateSessionTitle(SESSION_ID, "Fix the OAuth redirect", "p-1");
    await fakeState.flushWaitUntil();

    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.title).toBe("Storage fallback title");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("deletes a prepared title record when the first prompt is missing", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    globalThis.fetch = vi.fn();
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      model: "gpt-5.4-mini",
      activePromptId: "p-1",
      promptCounter: 1,
    });
    await fakeState.storage.put("prepared_title:p-1", { title: "Orphan prepared title", ticketKey: null });

    await instance.generateSessionTitle(SESSION_ID, "Fix the OAuth redirect", "p-1");

    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.title).toBeNull();
    expect(await fakeState.storage.get("prepared_title:p-1")).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("skips generated title metadata for archived sessions", async () => {
    const env = { ...createTestEnv(), ARCANIST_OPENAI_API_KEY: "sk-oai-test" };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    const clientSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    fakeState.acceptWebSocket(clientSocket, ["client", "wsid:test-client"]);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ title: "Ignored archived title" }),
                },
              ],
            },
          ],
        }),
      ),
    );

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "archived",
      closedAt: Date.now(),
      model: "gpt-5.4-mini",
      activePromptId: "p-1",
      promptCounter: 1,
    });
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "Fix the OAuth redirect",
      actorUserId: "user-1",
      status: "processing",
      startedAt: Date.now(),
    });
    await fakeState.storage.put("prepared_title:p-1", { title: "Ignored archived title", ticketKey: null });

    await instance.generateSessionTitle(SESSION_ID, "Fix the OAuth redirect", "p-1");
    await fakeState.flushWaitUntil();

    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.title).toBeNull();
    expect(session?.title_tags).toBeNull();
    expect(await fakeState.storage.get("prepared_title:p-1")).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(clientSocket.send).not.toHaveBeenCalled();
  });

  it("retries with a fresh prompt when spawn times out", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    await fakeState.storage.put({ has_pending_question: true, last_push_succeeded: true });
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.alarm();

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const original = prompts?.find((prompt) => prompt.promptId === "p-1");
    const retry = prompts?.find((prompt) => prompt.promptId === "p-2");

    expect(original?.status).toBe("failed");
    expect(original?.error).toContain("retrying");
    expect(retry?.status).toBe("processing");
    expect(await fakeState.storage.get("activePromptId")).toBe("p-2");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(1);
    expect(await fakeState.storage.get("sandbox_auth_token_hash")).toBeUndefined();
    expect(await fakeState.storage.get("has_pending_question")).toBe(false);
    // ARC-876: lastPushSucceeded reset on spawn timeout was removed with the
    // wider deprecation of that flag. Push outcome now lives on the prompt row.
    expect(startSpawnAttempt).toHaveBeenCalledWith("test-session-1", "spawnSandbox.spawnTimeout");
  });

  it("carries the disconnect-retry budget across a spawn-timeout retry instead of resetting it", async () => {
    // A prompt that already exhausted DISCONNECT_RETRY_CAP via mid-turn drops
    // (disconnect_retry_count=2) must not get a fresh budget when the recovery
    // spawn then times out. Resetting to 0 here let a prompt re-run unboundedly by
    // alternating spawn-timeout and disconnect, burning a VM each time.
    const { instance, fakeState } = await createSpawningDO(workerModule);
    fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "p-1");
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.alarm();

    const clone = queryPrompts(fakeState.storage, SESSION_ID).find((prompt) => prompt.prompt_id === "p-2");
    expect(clone?.status).toBe("processing");
    // Budget carried forward (not reset to 0), so the cap still bounds the prompt.
    expect(clone?.disconnect_retry_count).toBe(2);
  });

  it("keeps prompt-queue retry and diagnostics when the lifecycle spawn deadline is also due", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
      state: "spawning",
      startupAttemptId: "attempt-1",
      spawnInProgress: true,
    });
    await fakeState.storage.put(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, Date.now() - 1_000);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    const collectDiagnostics = vi.fn().mockResolvedValue(undefined);
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;
    (
      instance as unknown as {
        collectE2BBridgeStartupDiagnostics: typeof collectDiagnostics;
      }
    ).collectE2BBridgeStartupDiagnostics = collectDiagnostics;

    await instance.alarm();

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    expect(prompts?.find((prompt) => prompt.promptId === "p-1")?.error).toContain("retrying");
    expect(prompts?.find((prompt) => prompt.promptId === "p-2")?.status).toBe("processing");
    expect(startSpawnAttempt).toHaveBeenCalledWith("test-session-1", "spawnSandbox.spawnTimeout");
    expect(collectDiagnostics).toHaveBeenCalledWith(
      "test-session-1",
      expect.objectContaining({ status: "spawning" }),
      "spawn_connect_timeout",
    );
  });

  it("redacts E2B bridge startup diagnostics before logging and direct-posting", async () => {
    const { instance, fakeState, env } = await createSpawningDO(workerModule);
    env.DD_API_KEY = "dd-test-key";
    const ddEvents = captureDatadogEvents();
    const warn = vi.fn();
    const runCommand = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "bridge output sk-test-secret-value-1234567890",
      stderr: "OPENAI_API_KEY=sk-test-secret-value-1234567890",
    });
    const diagnosticsHandle = instance as unknown as {
      log: { warn: typeof warn };
      buildRuntimeClientConfig: ReturnType<typeof vi.fn>;
      collectE2BBridgeStartupDiagnostics: (
        sessionId: string,
        sandboxState: Record<string, unknown>,
        reason: string,
      ) => Promise<void>;
    };
    diagnosticsHandle.log = { warn };
    diagnosticsHandle.buildRuntimeClientConfig = vi.fn(() => ({
      client: { runCommand },
    }));

    await diagnosticsHandle.collectE2BBridgeStartupDiagnostics(
      SESSION_ID,
      {
        runtimeProvider: "e2b",
        runtimeBackend: "e2b_cloud",
        runtimeSandboxId: "runtime-1",
      },
      "spawn_connect_timeout",
    );

    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 20_000 }));
    const payload = warn.mock.calls.find(
      (call) => call[1] === "Collected E2B bridge startup diagnostics after missing bridge connection",
    )?.[0] as { stdout?: string; stderr?: string };
    expect(payload.stdout).toContain("[REDACTED]");
    expect(payload.stderr).toContain("[REDACTED]");
    expect(`${payload.stdout ?? ""}\n${payload.stderr ?? ""}`).not.toContain("sk-test-secret-value");

    await fakeState.flushWaitUntil();
    const event = ddEvents.find((entry) => entry.event === "sandbox.bridge_startup_diagnostics");
    expect(event).toEqual(
      expect.objectContaining({
        outcome: "collected",
        sessionId: SESSION_ID,
        runtimeSandboxId: "runtime-1",
        reason: "spawn_connect_timeout",
        exitCode: 0,
        stdout: payload.stdout,
        stderr: payload.stderr,
      }),
    );
    expect(`${event?.stdout ?? ""}\n${event?.stderr ?? ""}`).not.toContain("sk-test-secret-value");
  });

  it("direct-posts bounded redacted stderr when E2B bridge startup diagnostics fail", async () => {
    const { instance, fakeState, env } = await createSpawningDO(workerModule);
    env.DD_API_KEY = "dd-test-key";
    const ddEvents = captureDatadogEvents();
    const warn = vi.fn();
    const runCommand = vi
      .fn()
      .mockRejectedValue(new Error(`boom token: abcdefghijklmnopqrstuvwx ${"y".repeat(20_000)}`));
    const diagnosticsHandle = instance as unknown as {
      log: { warn: typeof warn };
      buildRuntimeClientConfig: ReturnType<typeof vi.fn>;
      collectE2BBridgeStartupDiagnostics: (
        sessionId: string,
        sandboxState: Record<string, unknown>,
        reason: string,
      ) => Promise<void>;
    };
    diagnosticsHandle.log = { warn };
    diagnosticsHandle.buildRuntimeClientConfig = vi.fn(() => ({
      client: { runCommand },
    }));

    await diagnosticsHandle.collectE2BBridgeStartupDiagnostics(
      SESSION_ID,
      {
        runtimeProvider: "e2b",
        runtimeBackend: "e2b_cloud",
        runtimeSandboxId: "runtime-1",
      },
      "spawn_connect_timeout",
    );
    await fakeState.flushWaitUntil();

    const payload = warn.mock.calls.find(
      (call) => call[1] === "Failed to collect E2B bridge startup diagnostics after missing bridge connection",
    )?.[0] as { error?: { name?: string; message?: string } };
    expect(payload.error).toMatchObject({ name: "Error" });
    expect(String(payload.error?.message)).toContain("[REDACTED]");
    const event = ddEvents.find((entry) => entry.event === "sandbox.bridge_startup_diagnostics");
    expect(event).toEqual(
      expect.objectContaining({
        outcome: "failed",
        sessionId: SESSION_ID,
        runtimeSandboxId: "runtime-1",
        reason: "spawn_connect_timeout",
        exitCode: null,
      }),
    );
    expect(event).not.toHaveProperty("stdout");
    expect(String(event?.stderr)).toContain("[REDACTED]");
    expect(String(event?.stderr)).toContain("[truncated]");
    expect(String(event?.stderr)).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(String(event?.stderr).length).toBeLessThanOrEqual(12_020);
  });

  it("reschedules the alarm when spawn is still within the connect budget", async () => {
    const elapsed = 60_000;
    const { instance, fakeState } = await createSpawningDO(workerModule, {
      spawnStartedAt: Date.now() - elapsed,
    });

    await instance.alarm();

    const alarm = await fakeState.storage.getAlarm();
    const remaining = SPAWN_CONNECT_TIMEOUT_MS - elapsed;
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + remaining - 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + remaining + 1_000);
  });

  it("fails permanently after three total spawn attempts", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule, {
      spawnRetryCount: 2,
    });

    await instance.alarm();

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const original = prompts?.find((prompt) => prompt.promptId === "p-1");

    expect(original?.status).toBe("failed");
    expect(original?.error).toContain("after 3 attempts");
    expect(await fakeState.storage.get("activePromptId")).toBeNull();
    expect(await fakeState.storage.get("sandbox_status")).toBe("stopped");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(0);
  });

  it("drains queued prompts after the active prompt exhausts its spawn retries", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule, {
      spawnRetryCount: 2,
      extraPrompts: [makePrompt({ promptId: "p-2", status: "queued", startedAt: null })],
    });
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.alarm();

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const exhausted = prompts?.find((prompt) => prompt.promptId === "p-1");
    const promoted = prompts?.find((prompt) => prompt.promptId === "p-2");

    expect(exhausted?.status).toBe("failed");
    expect(exhausted?.error).toContain("after 3 attempts");
    expect(promoted?.status).toBe("processing");
    expect(await fakeState.storage.get("activePromptId")).toBe("p-2");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(0);
    expect(startSpawnAttempt).toHaveBeenCalledWith("test-session-1", "spawnSandbox.spawnTimeout");
  });

  it("upgrades the alarm when a sandbox connects and dispatch succeeds", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    const prompt = makePrompt();
    await fakeState.storage.put("session", session);
    await fakeState.storage.put("activePromptId", prompt.promptId);
    await fakeState.storage.put("prompts", [prompt]);
    await fakeState.storage.put("sandbox_status", "spawning");
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    instance.sandboxWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    const dispatched = await instance.sendPendingPromptToSandbox(session.sessionId);
    expect(dispatched).toBe(true);

    if (dispatched && instance.sandboxWs) {
      await fakeState.storage.put("prompt_last_activity_at", Date.now());
      await fakeState.storage.setAlarm(Date.now() + STALE_PROMPT_TIMEOUT_MS);
    }

    const alarm = await fakeState.storage.getAlarm();
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + STALE_PROMPT_TIMEOUT_MS - 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + STALE_PROMPT_TIMEOUT_MS + 1_000);
  });

  it("dispatches the active prompt on first sandbox connect after DO recreation", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const session = makeSession();
    const prompt = makePrompt();
    const sandboxToken = "sandbox-token";

    await fakeState.storage.put("session", session);
    await fakeState.storage.put("activePromptId", prompt.promptId);
    await fakeState.storage.put("prompts", [prompt]);
    await fakeState.storage.put("sandbox_status", "spawning");
    await fakeState.storage.put("sandbox_id", "sandbox-1");
    await fakeState.storage.put("sandbox_auth_token_hash", createHash("sha256").update(sandboxToken).digest("hex"));
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, env);
    const sendToSandboxSpy = vi.spyOn(
      instance as unknown as { sendToSandbox(command: unknown): Promise<void> },
      "sendToSandbox",
    );
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      await expect(
        instance.fetch(
          new Request(`https://internal/session/ws?type=sandbox&sessionId=${session.sessionId}&sandboxId=sandbox-1`, {
            headers: {
              upgrade: "websocket",
              authorization: `Bearer ${sandboxToken}`,
              "x-sandbox-id": "sandbox-1",
            },
          }),
        ),
      ).rejects.toThrow(RangeError);
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const sandboxSocket = fakeState.getWebSockets("sandbox")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    expect(sendToSandboxSpy.mock.calls.length).toBeGreaterThan(0);
    await Promise.all(sendToSandboxSpy.mock.results.map((result) => result.value));
    const sentCommandTypes = sandboxSocket.send.mock.calls.map(
      ([payload]) => JSON.parse(payload as string).type as string,
    );
    expect(sentCommandTypes).toContain("prompt");
    expect(querySandboxState(fakeState.storage, session.sessionId)?.modal_object_id).toBeNull();
    expect(await fakeState.storage.get("sandbox_status")).toBe("ready");

    const alarm = await fakeState.storage.getAlarm();
    // ws_connected now arms the phase-independent sandbox-liveness deadline
    // (~90s), which is nearer than the 15-min running-inactivity window and so
    // becomes the next alarm. Heartbeats re-arm it; it only fires on silence.
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + SANDBOX_HEARTBEAT_LIVENESS_MS - 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + SANDBOX_HEARTBEAT_LIVENESS_MS + 1_000);
  });

  it("dispatches a queued prompt during reconnect when durable dispatch is pending", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    const prompt = makePrompt();
    await fakeState.storage.put("session", session);
    await fakeState.storage.put("activePromptId", prompt.promptId);
    await fakeState.storage.put("prompts", [prompt]);
    await fakeState.storage.put("sandbox_status", "reconnecting");
    await fakeState.storage.put("pending_prompt_dispatch", true);
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    instance.sandboxWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    expect(await instance.sendPendingPromptToSandbox(session.sessionId)).toBe(true);
    expect(await fakeState.storage.get("pending_prompt_dispatch")).toBe(false);
  });

  it("cleans up a stalled spawn when no active prompt exists", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    await fakeState.storage.put("session", session);
    await fakeState.storage.put("activePromptId", null);
    await fakeState.storage.put("prompts", []);
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });
    await fakeState.storage.put("sandbox_status", "spawning");
    await fakeState.storage.put("spawn_started_at", Date.now() - SPAWN_CONNECT_TIMEOUT_MS - 1_000);
    await fakeState.storage.put("spawnAttemptId", "attempt-1");

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    await instance.alarm();

    expect(await fakeState.storage.get("sandbox_status")).toBe("stopped");
    expect(await fakeState.storage.get("spawnAttemptId")).toBeUndefined();
  });

  it("ignores stale spawn failures once sandbox state has moved on", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    const prompt = makePrompt();
    await fakeState.storage.put("session", session);
    await fakeState.storage.put("activePromptId", prompt.promptId);
    await fakeState.storage.put("prompts", [prompt]);
    await fakeState.storage.put("sandbox_status", "ready");
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    await instance.handleSpawnFailure(session.sessionId, "spawnSandbox.test", new Error("stale"));

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    expect(prompts?.[0]?.status).toBe("processing");
    expect(await fakeState.storage.get("sandbox_status")).toBe("ready");
  });

  it("inserts the automatic retry before queued prompts", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule, {
      extraPrompts: [makePrompt({ promptId: "p-2", status: "queued", startedAt: null })],
    });
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;
    await fakeState.storage.put("promptCounter", 2);

    await instance.alarm();

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const retryIndex = prompts?.findIndex((prompt) => prompt.promptId === "p-3");
    const queuedIndex = prompts?.findIndex((prompt) => prompt.promptId === "p-2");

    expect(retryIndex).toBeGreaterThan(-1);
    expect(queuedIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeLessThan(queuedIndex);
  });

  it("reuses the remaining spawn budget when a prompt arrives during an in-progress spawn", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    await fakeState.storage.put("session", session);
    await fakeState.storage.put("prompts", []);
    await fakeState.storage.put("promptCounter", 0);
    await fakeState.storage.put("activePromptId", null);
    await fakeState.storage.put("sandbox_status", "spawning");
    await fakeState.storage.put("spawn_started_at", Date.now() - 150_000);
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as {
      fetch(request: Request): Promise<Response>;
    };
    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "do work", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(200);
    const alarm = await fakeState.storage.getAlarm();
    const remaining = SPAWN_CONNECT_TIMEOUT_MS - 150_000;
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + remaining - 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + remaining + 1_000);
  });

  it("uses the same retry path for direct provider spawn failures", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.handleSpawnFailure("test-session-1", "spawnSandbox.test", new Error("Sandbox provider error"));

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const original = prompts?.find((prompt) => prompt.promptId === "p-1");
    const retry = prompts?.find((prompt) => prompt.promptId === "p-2");

    expect(original?.status).toBe("failed");
    expect(retry?.status).toBe("processing");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(1);
  });

  it("fails unrecoverable image build errors without masking the provider error behind retries", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.handleSpawnFailure(
      "test-session-1",
      "spawnSandbox.test",
      new Error("Sandbox provider error: Image build for im-test failed. See build logs for more details."),
    );

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const original = prompts?.find((prompt) => prompt.promptId === "p-1");

    expect(original?.status).toBe("failed");
    expect(original?.error).toContain("Image build for im-test failed");
    expect(original?.error).not.toContain("after 3 attempts");
    expect(await fakeState.storage.get("activePromptId")).toBeNull();
    expect(await fakeState.storage.get("sandbox_status")).toBe("stopped");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(0);
    expect(startSpawnAttempt).not.toHaveBeenCalled();
  });

  it("fails typed non-retryable provider errors without retrying", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.handleSpawnFailure(
      "test-session-1",
      "spawnSandbox.test",
      new E2BSandboxRuntimeError("E2B sandbox authentication failed", {
        code: "auth",
        status: 401,
        requestSent: true,
      }),
    );

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const original = prompts?.find((prompt) => prompt.promptId === "p-1");

    expect(original?.status).toBe("failed");
    expect(original?.error).toContain("E2B sandbox authentication failed");
    expect(original?.error).not.toContain("after 3 attempts");
    expect(await fakeState.storage.get("activePromptId")).toBeNull();
    expect(await fakeState.storage.get("sandbox_status")).toBe("stopped");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(0);
    expect(startSpawnAttempt).not.toHaveBeenCalled();
  });

  // Removed: self-hosted capacity/config error and provider-detail-stripping tests
  // (SelfHostedE2BSpawnError, RuntimeBackendConfigError, wrapSelfHostedSpawnError deleted).

  it("fails local callback preflight errors without retrying", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.handleSpawnFailure(
      "test-session-1",
      "spawnSandbox.test",
      new SandboxCallbackPreflightError(
        "Local control-plane callback preflight failed: GET https://stale-tunnel.ngrok-free.dev/api/sessions/test-session-1/ws?type=sandbox returned HTTP 404, expected HTTP 426.",
        {
          check: "websocket",
          status: 404,
          url: "https://stale-tunnel.ngrok-free.dev/api/sessions/test-session-1/ws?type=sandbox",
        },
      ),
    );

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const original = prompts?.find((prompt) => prompt.promptId === "p-1");
    const retry = prompts?.find((prompt) => prompt.promptId === "p-2");

    expect(original?.status).toBe("failed");
    expect(original?.error).toContain("Local control-plane callback preflight failed");
    expect(retry).toBeUndefined();
    expect(await fakeState.storage.get("activePromptId")).toBeNull();
    expect(await fakeState.storage.get("sandbox_status")).toBe("stopped");
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(0);
    expect(startSpawnAttempt).not.toHaveBeenCalled();

    const events = querySessionEvents(fakeState.storage, "test-session-1");
    expect(events.find((event) => event.type === "session_error")?.data).toMatchObject({
      code: "sandbox_callback",
      promptId: "p-1",
    });
    expect(events.find((event) => event.type === "prompt_failed")?.data).toMatchObject({
      errorCode: "sandbox_callback",
      promptId: "p-1",
    });
  });

  it("pins last-writer-wins behavior for overlapping spawn attempts", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const resolvers: Array<() => void> = [];
    const startedAttempts: string[] = [];
    const spawnSandbox = vi.fn((_sessionId: string, spawnAttemptId?: string) => {
      if (!spawnAttemptId) throw new Error("expected spawn attempt id");
      startedAttempts.push(spawnAttemptId);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    });
    instance.spawnSandbox = spawnSandbox;

    const firstAttemptId = await instance.startSpawnAttempt(SESSION_ID, "spawnSandbox.overlap.first");
    const secondAttemptId = await instance.startSpawnAttempt(SESSION_ID, "spawnSandbox.overlap.second");

    expect(spawnSandbox).toHaveBeenCalledTimes(2);
    expect(startedAttempts).toEqual([firstAttemptId, secondAttemptId]);
    expect(await fakeState.storage.get("spawnAttemptId")).toBe(secondAttemptId);
    expect(await instance.isCurrentSpawnAttempt(firstAttemptId)).toBe(false);
    expect(await instance.isCurrentSpawnAttempt(secondAttemptId)).toBe(true);
    expect(await fakeState.storage.get("sandbox_status")).toBe("spawning");

    for (const resolve of resolvers) resolve();
    await Promise.all(spawnSandbox.mock.results.map((result) => result.value));
  });

  it("runs request-driven spawn attempts in a child trace context", async () => {
    const traceQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = { ...createTestEnv(), TRACE_QUEUE: { send: traceQueueSend }, WORKER_ENV: "test" };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
    });
    seedPrompt(fakeState.storage, {
      sessionId: SESSION_ID,
      promptId: "prompt-traced",
      promptText: "test prompt",
      actorUserId: "user-1",
      status: "processing",
      startedAt: Date.now(),
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    let spawnTraceparent: string | null = null;
    instance.spawnSandbox = vi.fn(async () => {
      spawnTraceparent = injectTraceparent();
    });

    const rootSpan = startSpan("do./session/prompt");
    await runInSpan(rootSpan, () => instance.startSpawnAttempt(SESSION_ID, "spawnSandbox.prompt"));
    await fakeState.flushWaitUntil();

    expect(spawnTraceparent).not.toBeNull();
    expect(parseTraceparent(spawnTraceparent)).toMatchObject({ traceId: rootSpan.traceId });
    expect(traceQueueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "cycloid-session-do",
        spans: expect.arrayContaining([
          expect.objectContaining({
            name: "do.spawn_sandbox",
            parentSpanId: rootSpan.spanId,
            attributes: expect.objectContaining({
              "session.id": SESSION_ID,
              "prompt.id": "prompt-traced",
              operation: "spawnSandbox.prompt",
            }),
          }),
        ]),
      }),
    );
  });

  it("runs alarm-origin spawn attempts in a root trace context with session metadata", async () => {
    const traceQueueSend = vi.fn().mockResolvedValue(undefined);
    const env = { ...createTestEnv(), TRACE_QUEUE: { send: traceQueueSend }, WORKER_ENV: "test" };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
    });
    seedPrompt(fakeState.storage, {
      sessionId: SESSION_ID,
      promptId: "prompt-alarm",
      promptText: "test prompt",
      actorUserId: "user-1",
      status: "processing",
      startedAt: Date.now(),
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    let spawnTraceparent: string | null = null;
    instance.spawnSandbox = vi.fn(async () => {
      spawnTraceparent = injectTraceparent();
    });

    await instance.startSpawnAttempt(SESSION_ID, "spawnSandbox.alarm");
    await fakeState.flushWaitUntil();

    expect(spawnTraceparent).not.toBeNull();
    expect(parseTraceparent(spawnTraceparent)?.traceId).toBeTruthy();
    expect(traceQueueSend).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "cycloid-session-do",
        spans: expect.arrayContaining([
          expect.objectContaining({
            name: "do.spawn_sandbox",
            parentSpanId: null,
            attributes: expect.objectContaining({
              "session.id": SESSION_ID,
              "prompt.id": "prompt-alarm",
              operation: "spawnSandbox.alarm",
            }),
          }),
        ]),
      }),
    );
  });

  it("clones agent, skills, files, uploadedFiles, and uploadedImages onto the retry prompt", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule, {
      promptOverrides: {
        agent: "review",
        skills: ["review-spec"],
        files: ["src/index.ts"],
        uploadedFiles: [{ name: "notes.md", content: "hello" }],
        uploadedImages: [{ name: "image.png", mediaType: "image/png", data: "AAAA" }],
      },
    });
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.alarm();

    const prompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
    const retry = prompts?.find((prompt) => prompt.promptId === "p-2");

    expect(retry?.agent).toBe("review");
    expect(retry?.skills).toEqual(["review-spec"]);
    expect(retry?.files).toEqual(["src/index.ts"]);
    expect(retry?.uploadedFiles).toEqual([{ name: "notes.md", content: "hello" }]);
    expect(retry?.uploadedImages).toEqual([{ name: "image.png", mediaType: "image/png", data: "AAAA" }]);
  });

  it("resets spawnRetryCount on user-initiated /session/retry", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    const failedPrompt = makePrompt({
      status: "failed",
      startedAt: null,
      completedAt: new Date().toISOString(),
      error: "timeout",
    });
    await fakeState.storage.put("session", session);
    await fakeState.storage.put("prompts", [failedPrompt]);
    await fakeState.storage.put("promptCounter", 1);
    await fakeState.storage.put("activePromptId", null);
    await fakeState.storage.put("sandbox_status", "ready");
    await fakeState.storage.put("spawnRetryCount", 2);
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle & {
      fetch(request: Request): Promise<Response>;
    };
    instance.sandboxWs = { send: vi.fn(), close: vi.fn(), readyState: 1 };

    const response = await instance.fetch(
      new Request("https://internal/session/retry", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(202);
    expect(await fakeState.storage.get("spawnRetryCount")).toBe(0);
  });

  it("emits sandbox.spawn_failed telemetry with phase and retry context on spawn timeout", async () => {
    const { instance } = await createSpawningDO(workerModule);
    const spawnFailures = captureSpawnFailureLogs(instance);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.alarm();

    expect(spawnFailures).toHaveLength(1);
    expect(spawnFailures[0]).toMatchObject({
      event: "sandbox.spawn_failed",
      sessionId: SESSION_ID,
      promptId: "p-1",
      // No provider object id was recorded, so the deadline fired before a VM existed.
      phase: "spawn_deadline_no_object",
      spawn_origin: "deadline",
      spawn_retry_count: 0,
      spawn_retry_cap_reached: false,
      // No runtime attached, so no breadcrumb exists.
      spawn_path: null,
      e2b_create_ms: null,
      bridge_launch_ms: null,
    });
    expect(typeof spawnFailures[0].spawn_alarm_overshoot_ms).toBe("number");
  });

  it("marks sandbox.spawn_failed as retry-exhausted on the final attempt", async () => {
    const { instance } = await createSpawningDO(workerModule, { spawnRetryCount: 2 });
    const spawnFailures = captureSpawnFailureLogs(instance);

    await instance.alarm();

    expect(spawnFailures).toHaveLength(1);
    expect(spawnFailures[0]).toMatchObject({
      event: "sandbox.spawn_failed",
      phase: "spawn_deadline_no_object",
      spawn_retry_count: 2,
      spawn_retry_cap_reached: true,
    });
  });

  it("attributes sandbox.spawn_failed to no_bridge with breadcrumb timings when a runtime attached", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    // A provider object id present at the deadline means the VM spawned but the
    // bridge never connected -> spawn_deadline_no_bridge.
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_sandbox_id = ?, runtime_backend = ? WHERE session_id = ?",
      "runtime-1",
      "e2b_cloud",
      SESSION_ID,
    );
    await fakeState.storage.put(spawnInstrumentationKey(SESSION_ID), {
      spawnPath: "cold",
      e2bCreateMs: 1234,
      runtimeBackend: "e2b_cloud",
      attachedAtMs: Date.now() - 5_000,
    });
    const spawnFailures = captureSpawnFailureLogs(instance);
    const startSpawnAttempt = vi.fn().mockResolvedValue("attempt-2");
    (instance as unknown as { startSpawnAttempt: typeof startSpawnAttempt }).startSpawnAttempt = startSpawnAttempt;

    await instance.alarm();

    expect(spawnFailures).toHaveLength(1);
    expect(spawnFailures[0]).toMatchObject({
      event: "sandbox.spawn_failed",
      phase: "spawn_deadline_no_bridge",
      spawn_path: "cold",
      e2b_create_ms: 1234,
      runtime_backend: "e2b_cloud",
    });
    expect(spawnFailures[0].bridge_launch_ms).toBeGreaterThanOrEqual(5_000);
  });

  it("emits sandbox.spawn_failed on an unrecoverable provider failure", async () => {
    const { instance } = await createSpawningDO(workerModule);
    const spawnFailures = captureSpawnFailureLogs(instance);

    await instance.handleSpawnFailure(
      SESSION_ID,
      "spawnSandbox.test",
      new E2BSandboxRuntimeError("E2B sandbox authentication failed", {
        code: "auth",
        status: 401,
        requestSent: true,
      }),
    );

    expect(spawnFailures).toHaveLength(1);
    expect(spawnFailures[0]).toMatchObject({
      event: "sandbox.spawn_failed",
      promptId: "p-1",
      spawn_origin: "provider_error",
      spawn_retry_cap_reached: false,
    });
    // A typed non-retryable error fails as spawn_preconnect, not a spawn phase code.
    expect(spawnFailures[0].phase).toBe("spawn_preconnect");
  });

  it("fails active prompts immediately when spawn is denied by opencode entitlement", async () => {
    const { instance, fakeState } = await createSpawningDO(workerModule);
    const spawnFailures = captureSpawnFailureLogs(instance);

    await instance.handleSpawnFailure(
      SESSION_ID,
      "spawnSandbox.test",
      new OpencodeAccessDeniedError({ businessId: "biz-1", sessionId: SESSION_ID }),
    );

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("opencode is only available to Cycloid team members"),
    });
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.status).toBe("stopped");
    expect(spawnFailures).toHaveLength(1);
    expect(spawnFailures[0]).toMatchObject({
      event: "sandbox.spawn_failed",
      promptId: "p-1",
      spawn_origin: "provider_error",
      spawn_retry_cap_reached: false,
      phase: "auth",
    });
  });
});
