import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LIFECYCLE_SANDBOX_STATE_STORAGE_KEY } from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const sandboxMock = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  setTimeout: vi.fn(),
  pause: vi.fn(),
  kill: vi.fn(),
  getInfo: vi.fn(),
  list: vi.fn(),
}));

// Spread-mock the exporter so every other export stays real and only the DD
// poster is captured (same pattern as sandbox-death-recovery.test.ts).
const eventsExporterMock = vi.hoisted(() => ({
  postStructuredEventToDd: vi.fn(async (_env: unknown, _event: Record<string, unknown>) => true),
}));

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("e2b", () => ({ Sandbox: sandboxMock }));
vi.mock("../../../apps/control-plane-worker/src/services/session-resume-rate-limiter", () => ({
  checkSessionResumeRateLimit: vi.fn(async () => ({ limited: false })),
}));
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async (importActual) => {
  const actual =
    await importActual<typeof import("../../../apps/control-plane-worker/src/observability/events-exporter")>();
  return { ...actual, postStructuredEventToDd: eventsExporterMock.postStructuredEventToDd };
});

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
};

const SESSION_ID = "resume-telemetry-session";

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

function enqueue(instance: { fetch(request: Request): Promise<Response> }, prompt: string): Promise<Response> {
  return enqueueBody(instance, { prompt });
}

function enqueueBody(
  instance: { fetch(request: Request): Promise<Response> },
  body: Record<string, unknown>,
): Promise<Response> {
  return instance.fetch(
    new Request("https://internal/session/prompts/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
      body: JSON.stringify({ actorUserId: "user-1", ...body }),
    }),
  );
}

function findEvent(name: string): Record<string, unknown> | undefined {
  const call = eventsExporterMock.postStructuredEventToDd.mock.calls.find(
    ([, event]) => (event as { event?: string })?.event === name,
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("resume/stop dispatch telemetry", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useRealTimers();
    sandboxMock.create.mockReset();
    sandboxMock.connect.mockReset();
    sandboxMock.pause.mockReset().mockResolvedValue(undefined);
    sandboxMock.kill.mockReset();
    sandboxMock.getInfo.mockReset();
    sandboxMock.list.mockReset().mockReturnValue({ hasNext: false, nextItems: async () => [] });
    eventsExporterMock.postStructuredEventToDd.mockReset().mockResolvedValue(true);
  });

  it("emits dispatch_path:live with a numeric resume_latency_ms on a live-socket dispatch", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
      cachedSandboxConnectionGen: number | null;
      sandboxWs: unknown | null;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready", sandboxId: "sbx-live" });
    // Fresh lifecycle heartbeat -> socketFresh -> admit dispatches to the live agent.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, { lastHeartbeatAt: Date.now() });
    const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(socket, ["sandbox", "sid:sbx-live", "gen:1"]);
    instance.cachedSandboxConnectionGen = 1;
    instance.sandboxWs = socket;

    const response = await enqueue(instance, "add the missing test");
    expect(response.status).toBe(200);
    expect((socket as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled();

    const admit = findEvent("prompt_admit_decision");
    expect(admit).toBeDefined();
    expect(admit?.decision).toBe("send_now");
    expect(admit?.dispatch_path).toBe("live");
    expect(admit?.review_loop_turn).toBe(false);
    expect(admit?.review_loop_epoch_id).toBeNull();
    expect(admit?.review_loop_source_kind).toBeNull();
    expect(typeof admit?.resume_latency_ms).toBe("number");
    expect(admit?.resume_latency_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("tags review-loop admit telemetry with the epoch id and source kind", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
      cachedSandboxConnectionGen: number | null;
      sandboxWs: unknown | null;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready", sandboxId: "sbx-live" });
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, { lastHeartbeatAt: Date.now() });
    const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(socket, ["sandbox", "sid:sbx-live", "gen:1"]);
    instance.cachedSandboxConnectionGen = 1;
    instance.sandboxWs = socket;

    const response = await enqueueBody(instance, {
      prompt: "address the review feedback",
      reviewLoopEpochId: "epoch-1",
      reviewLoopSourceKind: "human",
    });
    expect(response.status).toBe(200);

    const admit = findEvent("prompt_admit_decision");
    expect(admit).toBeDefined();
    expect(admit?.review_loop_turn).toBe(true);
    expect(admit?.review_loop_epoch_id).toBe("epoch-1");
    expect(admit?.review_loop_source_kind).toBe("human");
  });

  it("emits dispatch_path:cold when the prompt cold-resumes a stopped sandbox", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
      spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
    };
    instance.spawnSandbox = vi.fn(async () => undefined);
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    // Legacy stopped row (stop_reason NULL) -> auto-resumable cold spawn, no live socket.
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });

    const response = await enqueue(instance, "pick this back up");
    expect(response.status).toBe(200);

    const admit = findEvent("prompt_admit_decision");
    expect(admit).toBeDefined();
    expect(admit?.decision).toBe("start_spawn");
    expect(admit?.dispatch_path).toBe("cold");
    expect(typeof admit?.resume_latency_ms).toBe("number");
  });

  it("emits live_idle_ms tagged resumed:false when a kept-alive session idle-pauses", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
    };
    const now = Date.now();
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "idle" });
    // Stale-but-running E2B row past its live lease, no activity -> cleanup decides "pause".
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET
        runtime_provider = ?, runtime_state = ?, runtime_backend = ?, runtime_sandbox_id = ?,
        runtime_template_id = ?, last_heartbeat_at = ?, last_activity_at = ?,
        prompt_last_activity_at = NULL, pending_prompt_dispatch = 0, runtime_live_lease_expires_at = ?
       WHERE session_id = ?`,
      "e2b",
      "running",
      "e2b_cloud",
      "e2b-idle-1",
      "cycloid-sandbox-test",
      now,
      now - 901_000,
      now - 1,
      SESSION_ID,
    );
    // PR-2 stamps this at the user soft-stop divergence point.
    await fakeState.storage.put("stopped_kept_alive_at", now - 120_000);

    const response = await instance.fetch(
      new Request("https://internal/internal/runtime/e2b/cleanup-run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-cleanup-secret" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          projectedRuntimeSandboxId: "e2b-idle-1",
          projectedRuntimeBackend: "e2b_cloud",
          reason: "live_lease_expired",
          nowMs: Date.now(),
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(sandboxMock.pause).toHaveBeenCalledWith("e2b-idle-1", { apiKey: "test-e2b-key" });
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("paused");

    const liveIdle = findEvent("sandbox.live_idle");
    expect(liveIdle).toBeDefined();
    expect(liveIdle?.resumed).toBe(false);
    expect(typeof liveIdle?.live_idle_ms).toBe("number");
    expect(liveIdle?.live_idle_ms as number).toBeGreaterThanOrEqual(120_000);
    expect(typeof liveIdle?.runtime_backend).toBe("string");
    // Window terminus clears the marker so a later idle cycle can't double-count.
    expect(await fakeState.storage.get("stopped_kept_alive_at")).toBeUndefined();
  });

  it("emits resumed_after_stop:true with a string runtime_backend on a live dispatch after a user soft-stop", async () => {
    const fakeState = createFakeState();
    // Pre-seed the soft-stop marker BEFORE the DO instantiates so the
    // blockConcurrencyWhile init rehydrates this.userStopped=true; the enqueue
    // then reads host.isUserStopped()===true at entry and attributes the dispatch.
    await fakeState.storage.put("stopped_kept_alive_at", Date.now() - 60_000);
    const instance = new workerModule.SessionDO(fakeState, createE2BEnv()) as {
      fetch(request: Request): Promise<Response>;
      cachedSandboxConnectionGen: number | null;
      sandboxWs: unknown | null;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready", sandboxId: "sbx-live" });
    // Concrete provider/backend so the admit event carries the provider tag plus
    // the backend split used by the existing dashboard widgets.
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider = ?, runtime_backend = ? WHERE session_id = ?",
      "e2b",
      "e2b_cloud",
      SESSION_ID,
    );
    // Fresh lifecycle heartbeat -> socketFresh -> admit dispatches to the live agent.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, { lastHeartbeatAt: Date.now() });
    const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(socket, ["sandbox", "sid:sbx-live", "gen:1"]);
    instance.cachedSandboxConnectionGen = 1;
    instance.sandboxWs = socket;

    const response = await enqueue(instance, "context kept, pick this back up");
    expect(response.status).toBe(200);
    expect((socket as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled();

    const admit = findEvent("prompt_admit_decision");
    expect(admit).toBeDefined();
    expect(admit?.decision).toBe("send_now");
    expect(admit?.dispatch_path).toBe("live");
    // Captured at enqueue entry from the rehydrated flag, before the admit clears it.
    expect(admit?.resumed_after_stop).toBe(true);
    expect(admit?.provider).toBe("e2b");
    expect(typeof admit?.runtime_backend).toBe("string");
  });
});
