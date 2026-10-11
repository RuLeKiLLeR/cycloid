import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
  querySession,
  querySessionEvents,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const sandboxMock = vi.hoisted(() => ({
  pause: vi.fn(),
  connect: vi.fn(),
  setTimeout: vi.fn(),
  create: vi.fn(),
  kill: vi.fn(),
}));

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("e2b", () => ({
  Sandbox: sandboxMock,
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

const SESSION_ID = "stop-boundary-session";

function createE2BEnv() {
  return {
    ...createTestEnv(),
    E2B_API_KEY: "test-e2b-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    E2B_SANDBOX_TIMEOUT_MS: "3600000",
    E2B_RUNTIME_RETENTION_HOURS: "24",
    E2B_RUNTIME_LIVE_LEASE_MS: "900000",
    E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS: "1800000",
    E2B_RUNTIME_PROVIDER_TTL_MS: "3600000",
    SANDBOX_RUNTIME_CLEANUP_SECRET: "test-cleanup-secret",
  };
}

function seedIdleE2BState(state: ReturnType<typeof createFakeState>) {
  const now = Date.now();
  seedSession(state.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
  });
  seedSandboxState(state.storage, {
    sessionId: SESSION_ID,
    status: "idle",
    autoCloseScheduledAt: now - 1_000,
  });
  state.storage.sql.exec(
    `UPDATE sandbox_state SET
      runtime_provider = ?,
      runtime_state = ?,
      runtime_sandbox_id = ?,
      runtime_template_id = ?,
      runtime_live_lease_expires_at = ?,
      runtime_created_at = ?,
      runtime_last_resumed_at = ?,
      runtime_last_provider_refreshed_at = ?,
      runtime_provider_ttl_expires_at = ?,
      last_snapshot_error = ?
     WHERE session_id = ?`,
    "e2b",
    "running",
    "e2b-stop-1",
    "cycloid-sandbox-test",
    now + 900_000,
    now - 60_000,
    now - 60_000,
    now - 30_000,
    now + 3_570_000,
    "old error",
    SESSION_ID,
  );
}

type CleanupCapableInstance = { fetch(request: Request): Promise<Response> };

async function cleanupRun(
  instance: CleanupCapableInstance,
  opts: { sandboxId?: string; backend?: string; nowMs?: number } = {},
): Promise<Response> {
  return instance.fetch(
    new Request("https://internal/internal/runtime/e2b/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-cleanup-secret" },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        projectedRuntimeSandboxId: opts.sandboxId ?? "e2b-stop-1",
        projectedRuntimeBackend: opts.backend ?? "e2b_cloud",
        reason: "live_lease_expired",
        nowMs: opts.nowMs ?? Date.now(),
      }),
    }),
  );
}

async function phaseReap(instance: CleanupCapableInstance, nowMs = Date.now()): Promise<Response> {
  return instance.fetch(
    new Request("https://internal/internal/session/phase-reap", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-cleanup-secret" },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        action: "archive",
        reason: "live_lease_expired",
        nowMs,
      }),
    }),
  );
}

/** Expire the live lease so the cleanup decision reaches the pause branch. */
function expireLiveLease(state: ReturnType<typeof createFakeState>, nowMs = Date.now()) {
  state.storage.sql.exec(
    "UPDATE sandbox_state SET runtime_live_lease_expires_at = ? WHERE session_id = ?",
    nowMs - 1,
    SESSION_ID,
  );
}

describe("SessionDO E2B stop-boundary pause", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useRealTimers();
    sandboxMock.pause.mockReset();
    sandboxMock.pause.mockResolvedValue(undefined);
    sandboxMock.connect.mockReset();
    sandboxMock.connect.mockResolvedValue({
      setTimeout: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("pauses E2B and stores a 24h retention expiry before auto-stopping an idle session", async () => {
    const before = Date.now();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      alarm(): Promise<void>;
      sandboxWs: unknown | null;
    };
    seedIdleE2BState(fakeState);
    instance.sandboxWs = null;

    await instance.alarm();

    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });

    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.status).toBe("active");
    expect(session?.closed_at).toBeNull();

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.status).toBe("stopped");
    expect(sandbox?.runtime_provider).toBe("e2b");
    expect(sandbox?.runtime_state).toBe("paused");
    expect(sandbox?.runtime_sandbox_id).toBe("e2b-stop-1");
    expect(sandbox?.runtime_live_lease_expires_at).toBeNull();
    expect(sandbox?.runtime_last_paused_at).toEqual(expect.any(Number));
    expect(Number(sandbox?.runtime_state_expires_at)).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1_000);
    expect(sandbox?.last_snapshot_error).toBeNull();

    const stopEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "session_stopped",
    );
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.data?.reason).toBe("sandbox_disconnected");
    expect(stopEvent?.data?.snapshotSaved).toBe(false);
    expect(stopEvent?.data?.snapshotImageId).toBeUndefined();
  });

  it("pauses a stale running runtime via cleanup-run when only heartbeat is fresh", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance;
    seedIdleE2BState(fakeState);
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        last_heartbeat_at = ?,
        last_activity_at = ?,
        prompt_last_activity_at = NULL,
        pending_prompt_dispatch = 0,
        runtime_live_lease_expires_at = ?
       WHERE session_id = ?`,
      Date.now(),
      Date.now() - 901_000,
      Date.now() - 1,
      SESSION_ID,
    );

    const response = await cleanupRun(instance);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "paused", reasonCode: "paused" });
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("paused");
  });

  it("refuses to auto-archive a session before it is three days old", async () => {
    const nowMs = Date.now();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance;
    seedIdleE2BState(fakeState);
    expireLiveLease(fakeState, nowMs);

    const response = await phaseReap(instance, nowMs);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      terminalized: false,
      action: "archive",
      reason: "session_too_young",
    });
    expect(querySession(fakeState.storage, SESSION_ID)?.status).toBe("active");
    expect(sandboxMock.pause).not.toHaveBeenCalled();
  });

  it("pauses via cleanup-run when lastActivityAt is null and the live lease expired", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance;
    seedIdleE2BState(fakeState);
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        last_activity_at = NULL,
        prompt_last_activity_at = NULL,
        pending_prompt_dispatch = 0,
        runtime_live_lease_expires_at = ?
       WHERE session_id = ?`,
      Date.now() - 1,
      SESSION_ID,
    );

    const response = await cleanupRun(instance);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "paused", reasonCode: "paused" });
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("paused");
  });

  it("pauses an idle E2B runtime through the cleanup-run route", async () => {
    const before = Date.now();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance;
    seedIdleE2BState(fakeState);
    expireLiveLease(fakeState, before);

    const response = await cleanupRun(instance, { nowMs: before });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "paused" });
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.status).toBe("stopped");
    expect(sandbox?.stop_reason).toBeNull();
    expect(sandbox?.runtime_state).toBe("paused");
    expect(sandbox?.runtime_live_lease_expires_at).toBeNull();
    expect(sandbox?.intentional_pause_reason).toBe("idle_auto_pause");
    expect(Number(sandbox?.runtime_state_expires_at)).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1_000);
  });

  // Removed: self-hosted client-config and capacity-admission cleanup-run pause tests
  // (self-hosted backend + runtime_capacity_admissions code deleted).

  it("skips cleanup-run when newer activity already happened (no pause)", async () => {
    const before = Date.now();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance;
    seedIdleE2BState(fakeState);
    expireLiveLease(fakeState, before);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET last_activity_at = ? WHERE session_id = ?",
      before + 1,
      SESSION_ID,
    );

    const response = await cleanupRun(instance, { nowMs: before });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: "skipped",
      reasonCode: "skipped_live_activity",
    });
    expect(sandboxMock.pause).not.toHaveBeenCalled();

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("running");
    expect(sandbox?.status).toBe("idle");
  });

  it("resumes immediately when work appears while the provider pause call is in flight", async () => {
    const before = Date.now();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance & {
      waitForE2BBridgeHealth?: (sessionId: string, runtimeSandboxId: string, startedAt: number) => Promise<boolean>;
    };
    seedIdleE2BState(fakeState);
    expireLiveLease(fakeState, before);
    instance.waitForE2BBridgeHealth = vi.fn().mockResolvedValue(true);
    sandboxMock.pause.mockImplementationOnce(async () => {
      seedPrompt(fakeState.storage, {
        promptId: "p-race",
        sessionId: SESSION_ID,
        promptText: "race",
        status: "processing",
        startedAt: Date.now(),
      });
      fakeState.storage.sql.exec(
        "UPDATE sandbox_state SET pending_prompt_dispatch = 1, last_activity_at = ? WHERE session_id = ?",
        before + 1,
        SESSION_ID,
      );
    });

    const response = await cleanupRun(instance, { nowMs: before });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "skipped" });
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });
    expect(sandboxMock.connect).toHaveBeenCalledWith("e2b-stop-1", {
      apiKey: "test-e2b-key",
      timeoutMs: 3_600_000,
    });

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("running");
    expect(sandbox?.runtime_sandbox_id).toBe("e2b-stop-1");
    expect(sandbox?.intentional_pause_reason).toBeNull();
  });

  it("marks the sandbox stopped when the provider reports the runtime missing during cleanup-run pause", async () => {
    const before = Date.now();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as CleanupCapableInstance;
    seedIdleE2BState(fakeState);
    expireLiveLease(fakeState, before);
    sandboxMock.pause.mockRejectedValueOnce(Object.assign(new Error("sandbox not found"), { status: 404 }));

    const response = await cleanupRun(instance, { nowMs: before });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "skipped" });

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.status).toBe("stopped");
    expect(sandbox?.runtime_state).toBe("killed");
    expect(sandbox?.runtime_live_lease_expires_at).toBeNull();
    expect(sandbox?.intentional_pause_reason).toBeNull();
  });

  // Removed: self-hosted capacity-release-on-missing-runtime cleanup-run test
  // (self-hosted backend + runtime_capacity_admissions code deleted).

  it("rejects internal close requests without an explicit reason", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
    };
    seedIdleE2BState(fakeState);

    const response = await instance.fetch(new Request("https://internal/session/close", { method: "POST" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Missing close reason" });
  });

  it("pauses E2B on the explicit close path without taking a Modal snapshot", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
    };
    seedIdleE2BState(fakeState);

    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_archived" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("paused");
    expect(sandbox?.runtime_state_expires_at).toEqual(expect.any(Number));

    const closeEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "session_closed",
    );
    expect(closeEvent?.data?.reason).toBe("user_archived");
    expect(closeEvent?.data?.snapshotSaved).toBe(false);
  });

  it("finalizes the active prompt then pauses on close (was: 'does not pause while a prompt is active')", async () => {
    // Pre-PR1 (archive-active-prompt-leak fix), closeSessionAtDurabilityBoundary
    // bailed out of snapshot capture with a "prompt is active" precondition
    // error and left the runtime running. The PR1 fix finalizes the in-flight
    // prompt via failActivePromptForArchive BEFORE capturing the snapshot, so
    // the pause now proceeds normally and the prompt lands as
    // status="failed" with errorCode="session_archived".
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
    };
    seedIdleE2BState(fakeState);
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "test",
      status: "processing",
      startedAt: Date.now(),
    });

    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_archived" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-stop-1", { apiKey: "test-e2b-key" });
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("paused");
  });
});
