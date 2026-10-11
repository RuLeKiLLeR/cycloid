import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
  querySessionEvents,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const sandboxMock = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  setTimeout: vi.fn(),
  pause: vi.fn(),
  kill: vi.fn(),
}));

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("e2b", () => ({
  Sandbox: sandboxMock,
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-resume-rate-limiter", () => ({
  checkSessionResumeRateLimit: vi.fn(async () => ({ limited: false })),
}));

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
  };
};

const SESSION_ID = "cold-resume-session";

function createColdResumeEnv() {
  return {
    ...createTestEnv(),
    E2B_API_KEY: "test-e2b-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    E2B_SANDBOX_TIMEOUT_MS: "3600000",
    E2B_RUNTIME_RETENTION_HOURS: "24",
    E2B_RUNTIME_LIVE_LEASE_MS: "900000",
    E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS: "1800000",
    E2B_RUNTIME_PROVIDER_TTL_MS: "3600000",
  };
}

describe("SessionDO cold resume from stopped", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    sandboxMock.create.mockReset();
    sandboxMock.connect.mockReset();
    sandboxMock.setTimeout.mockReset();
    sandboxMock.pause.mockReset();
    sandboxMock.kill.mockReset();
    sandboxMock.connect.mockResolvedValue({
      sandboxId: "e2b-paused-1",
      setTimeout: vi.fn().mockResolvedValue(undefined),
      commands: { run: vi.fn() },
    });
  });

  it("auto-resumes a reaped session on next prompt and emits session_resumed_cold", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      fetch(request: Request): Promise<Response>;
      spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
    };
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_sessionId: string, _spawnAttemptId: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET stop_reason = ?, snapshot_image_id = ? WHERE session_id = ?",
      "reaped",
      "img-stale-old",
      SESSION_ID,
    );

    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-auth-user-id": "user-1",
        },
        body: JSON.stringify({ prompt: "pick this back up", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(200);

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.pending_prompt_dispatch).toBe(1);
    expect(operations).toContain("spawnSandbox.resume.cold");

    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    const resumedCold = events.find((event) => event.type === "session_resumed_cold");
    expect(resumedCold).toBeDefined();
    expect(resumedCold?.data?.reason).toBe("prompt");
    expect(resumedCold?.data?.lostSnapshotImageId).toBe("img-stale-old");
  });

  it("uses the live E2B resume operation for an unexpired paused runtime", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      fetch(request: Request): Promise<Response>;
      spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
    };
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_sessionId: string, _spawnAttemptId: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        stop_reason = ?,
        runtime_provider = ?,
        runtime_state = ?,
        runtime_sandbox_id = ?,
        runtime_template_id = ?,
        runtime_state_expires_at = ?
       WHERE session_id = ?`,
      "user",
      "e2b",
      "paused",
      "e2b-paused-1",
      "cycloid-sandbox-test",
      Date.now() + 60_000,
      SESSION_ID,
    );

    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
        body: JSON.stringify({ prompt: "resume live", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(operations).toContain("spawnSandbox.resume.live");
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.some((event) => event.type === "session_resumed_cold")).toBe(false);
  });

  it("uses the expired E2B resume operation and emits cold-resume evidence when retention expired", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      fetch(request: Request): Promise<Response>;
      spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
    };
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_sessionId: string, _spawnAttemptId: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        runtime_provider = ?,
        runtime_state = ?,
        runtime_sandbox_id = ?,
        runtime_template_id = ?,
        runtime_state_expires_at = ?
       WHERE session_id = ?`,
      "e2b",
      "paused",
      "e2b-expired-1",
      "cycloid-sandbox-test",
      Date.now() - 1,
      SESSION_ID,
    );

    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
        body: JSON.stringify({ prompt: "resume expired", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(operations).toContain("spawnSandbox.resume.expired");
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.some((event) => event.type === "session_resumed_cold")).toBe(true);
  });

  // The two "clears a stale active prompt" tests that used to live here were
  // removed alongside session.active_prompt_id (DO schema migration 70). The
  // active prompt is now derived from prompts.status, so a "stale pointer
  // referencing a completed/missing prompt" state is structurally impossible
  // -- the derived helper returns null the moment prompts.status flips to
  // terminal. The defensive cleanup code those tests covered is gone.

  it("connects an unexpired paused E2B runtime without rotating the sandbox auth token", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      waitForE2BBridgeHealth?: (sessionId: string, runtimeSandboxId: string, sinceMs: number) => Promise<boolean>;
      spawnSandbox?: (sessionId: string) => Promise<void>;
    };
    instance.waitForE2BBridgeHealth = vi.fn(async () => true);
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "spawning",
      sandboxId: "bridge-sandbox-old",
      sandboxAuthTokenHash: "old-token-hash",
    });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        runtime_provider = ?,
        runtime_state = ?,
        runtime_sandbox_id = ?,
        runtime_template_id = ?,
        runtime_state_expires_at = ?,
        runtime_live_lease_expires_at = ?,
        runtime_created_at = ?,
        runtime_last_paused_at = ?,
        intentional_pause_reason = ?
       WHERE session_id = ?`,
      "e2b",
      "paused",
      "e2b-paused-1",
      "cycloid-sandbox-test",
      Date.now() + 60_000,
      null,
      Date.now() - 120_000,
      Date.now() - 30_000,
      "idle_auto_pause",
      SESSION_ID,
    );

    await instance.spawnSandbox?.(SESSION_ID);

    expect(sandboxMock.connect).toHaveBeenCalledWith("e2b-paused-1", {
      apiKey: "test-e2b-key",
      timeoutMs: 3_600_000,
    });
    expect(sandboxMock.create).not.toHaveBeenCalled();
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("running");
    expect(sandbox?.runtime_state_expires_at).toBeNull();
    expect(sandbox?.runtime_live_lease_expires_at).toEqual(expect.any(Number));
    expect(sandbox?.runtime_last_resumed_at).toEqual(expect.any(Number));
    expect(sandbox?.intentional_pause_reason).toBeNull();
    expect(sandbox?.sandbox_auth_token_hash).toBe("old-token-hash");
    expect(sandbox?.sandbox_id).toBe("bridge-sandbox-old");
  });

  // Removed: self-hosted capacity-refresh-on-resume test (self-hosted backend deleted).

  it("refreshes provider TTL on heartbeat without extending the idle live lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_762_245_000_000);
    sandboxMock.setTimeout.mockResolvedValue(undefined);
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?: (reason: "heartbeat") => Promise<void>;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        runtime_provider = ?,
        runtime_state = ?,
        runtime_sandbox_id = ?,
        runtime_template_id = ?,
        runtime_live_lease_expires_at = ?,
        runtime_last_provider_refreshed_at = ?,
        runtime_provider_ttl_expires_at = ?
       WHERE session_id = ?`,
      "e2b",
      "running",
      "e2b-running-1",
      "cycloid-sandbox-test",
      Date.now() + 1_000,
      Date.now() - 1_800_000,
      Date.now() + 1_000,
      SESSION_ID,
    );

    await instance.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?.("heartbeat");

    expect(sandboxMock.setTimeout).toHaveBeenCalledWith("e2b-running-1", 3_600_000, {
      apiKey: "test-e2b-key",
    });
    const first = querySandboxState(fakeState.storage, SESSION_ID);
    expect(first?.runtime_live_lease_expires_at).toBe(1_762_245_001_000);
    expect(first?.runtime_last_provider_refreshed_at).toBe(Date.now());
    expect(first?.runtime_provider_ttl_expires_at).toBe(Date.now() + 3_600_000);

    vi.setSystemTime(Date.now() + 1_000);
    await instance.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?.("heartbeat");

    expect(sandboxMock.setTimeout).toHaveBeenCalledTimes(1);
    const second = querySandboxState(fakeState.storage, SESSION_ID);
    expect(second?.runtime_live_lease_expires_at).toBe(1_762_245_001_000);
    expect(second?.runtime_last_provider_refreshed_at).toBe(1_762_245_000_000);
    vi.useRealTimers();
  });

  it("keeps runtime state for retry after transient provider TTL refresh failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_762_245_000_000);
    sandboxMock.setTimeout.mockRejectedValue(new TypeError("fetch failed"));
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?: (reason: "heartbeat") => Promise<void>;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        runtime_provider = ?,
        runtime_state = ?,
        runtime_sandbox_id = ?,
        runtime_template_id = ?,
        runtime_live_lease_expires_at = ?,
        runtime_last_provider_refreshed_at = ?\n       WHERE session_id = ?`,
      "e2b",
      "running",
      "e2b-running-1",
      "cycloid-sandbox-test",
      Date.now() + 1_000,
      Date.now() - 1_800_000,
      SESSION_ID,
    );

    await instance.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?.("heartbeat");

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("running");
    expect(sandbox?.runtime_sandbox_id).toBe("e2b-running-1");
    expect(sandbox?.runtime_live_lease_expires_at).toBe(1_762_245_001_000);
    expect(sandbox?.runtime_last_provider_refreshed_at).toBe(Date.now() - 1_800_000);
    vi.useRealTimers();
  });

  // Removed: three self-hosted heartbeat capacity-refresh tests (self-hosted backend deleted).

  it("marks runtime killed when provider TTL refresh reports the sandbox missing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_762_245_000_000);
    sandboxMock.setTimeout.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?: (reason: "heartbeat") => Promise<void>;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        runtime_provider = ?,
        runtime_state = ?,
        runtime_sandbox_id = ?,
        runtime_template_id = ?,
        runtime_live_lease_expires_at = ?,
        runtime_last_provider_refreshed_at = ?
       WHERE session_id = ?`,
      "e2b",
      "running",
      "e2b-running-1",
      "cycloid-sandbox-test",
      Date.now() + 1_000,
      Date.now() - 1_800_000,
      SESSION_ID,
    );

    await instance.maybeRefreshE2BRuntimeLiveLeaseAndProviderTtl?.("heartbeat");

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("killed");
    expect(sandbox?.runtime_state_expires_at).toBe(Date.now());
    expect(sandbox?.runtime_live_lease_expires_at).toBeNull();
    vi.useRealTimers();
  });

  it("blocks a user-stopped session with a 409 (no auto-resume)", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      fetch(request: Request): Promise<Response>;
      spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
    };
    instance.spawnSandbox = vi.fn(async () => undefined);
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    fakeState.storage.sql.exec("UPDATE sandbox_state SET stop_reason = ? WHERE session_id = ?", "user", SESSION_ID);

    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
        body: JSON.stringify({ prompt: "should fail", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(409);
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.status).toBe("stopped");
    expect(sandbox?.stop_reason).toBe("user");
  });

  it("treats a legacy stopped row (stop_reason = NULL) as auto-resumable", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createColdResumeEnv()) as {
      fetch(request: Request): Promise<Response>;
      spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
    };
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_sessionId: string, _spawnAttemptId: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    // Legacy rows: stop_reason stays NULL, treated as resumable.

    const response = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
        body: JSON.stringify({ prompt: "legacy resume", actorUserId: "user-1" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(operations).toContain("spawnSandbox.resume.cold");
  });
});
