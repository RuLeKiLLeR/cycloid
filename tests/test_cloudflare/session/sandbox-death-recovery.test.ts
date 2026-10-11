/**
 * Sandbox-death recovery: the review-listening wedge.
 *
 * When an E2B VM dies while a review-listening session has no active prompt, the
 * row reaches `status=reconnecting`, `runtime_state=killed`, no socket. The old
 * admit path suppressed the fresh spawn for any `reconnecting` status, so the
 * next review-loop prompt was promoted to `processing` with no work scheduled,
 * hung to the 30-min ceiling, failed `max_duration_exceeded`, and the review-loop
 * cron re-enqueued it forever.
 *
 * These tests pin the fix:
 *  - admit/retry/promotion spawn fresh against a dead `reconnecting` runtime;
 *  - a genuine in-flight reconnect (unexpired grace) still waits;
 *  - a late ws-close on an already-killed runtime does NOT resurrect `reconnecting`;
 *  - a zero-prompt-activity max-duration trip routes through the bounded
 *    disconnect-retry flow (sandbox_never_started), while a quiet-but-active
 *    prompt still fails with max_duration_exceeded.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
  LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  PROMPT_MAX_DURATION_MS,
  SANDBOX_LOSS_RECOVERY_BUDGET_MS,
  SANDBOX_RECONNECT_GRACE_MS,
} from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  queryPrompts,
  querySandboxState,
  querySessionEvents,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

// The termination chokepoint probes E2B via `Sandbox.getInfo`. Mock it so the
// disconnect-lane gate sees a deterministic alive/dead/unknown reading instead
// of a real network call. Default (no impl) -> getInfo returns undefined ->
// getSandboxInfo classifies `unknown` -> the gate terminates (today's behavior).
const sandboxMock = vi.hoisted(() => ({
  kill: vi.fn(),
  pause: vi.fn(),
  connect: vi.fn(),
  create: vi.fn(),
  setTimeout: vi.fn(),
  getInfo: vi.fn(),
  // `list` backs listCycloidSandboxes (returns an E2B paginator). Used by the
  // observational disconnect cross-check fired via waitUntil on terminalize.
  list: vi.fn(),
}));

// Freestyle disconnect cross-check (ARC-1484) reads the session's OWN VM via the
// per-VM `getInfo` (GET /v1/vms/{vm_id}), NOT an account-wide list. Mock the SDK
// so a freestyle-backed session's probe + cross-check hit `vmGetInfo` and never the
// E2B `list`.
const freestyleMock = vi.hoisted(() => {
  const vmGetInfo = vi.fn();
  const vm = { getInfo: vmGetInfo };
  const vmsRef = vi.fn(() => vm);
  const FreestyleCtor = vi.fn(function (this: { vms: unknown }) {
    this.vms = { ref: vmsRef, list: vi.fn(), create: vi.fn(), delete: vi.fn() };
  });
  return { vmGetInfo, vmsRef, FreestyleCtor };
});

// The A4a SLO counter is fired (via waitUntil) from the chokepoint on every
// decision. Mock the emitter so the tests can assert the lane/decision/liveness
// tags without standing up a Datadog POST.
const survivalMetricsMock = vi.hoisted(() => ({
  emitSandboxDisconnectTerminalizeMetric: vi.fn(async () => undefined),
}));

// The disconnect diagnostic events (probe, cross-check, terminalize) direct-post
// to Datadog so they stay queryable (plain `this.log` never reaches Datadog).
// Mock the exporter so tests can assert the posted payloads without a real POST.
const eventsExporterMock = vi.hoisted(() => ({
  postStructuredEventToDd: vi.fn(async (_env: unknown, _event: Record<string, unknown>) => true),
}));

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("e2b", () => ({ Sandbox: sandboxMock }));
vi.mock("freestyle", () => ({ Freestyle: freestyleMock.FreestyleCtor }));
vi.mock("../../../apps/control-plane-worker/src/observability/sandbox-survival-metrics.ts", () => survivalMetricsMock);
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

interface DOTestHandle {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  persistenceQueue: Promise<void>;
  spawnSandbox?: (sessionId: string, spawnAttemptId: string, operation: string) => Promise<void>;
  cachedSandboxConnectionGen: number | null;
  sandboxWs: unknown | null;
  promptQueue: {
    failActivePromptOnDisconnect: (session: unknown, activePromptId: string, origin?: string) => Promise<void>;
  };
  probeE2BRuntimeLiveness(
    client: { getSandboxInfo: (id: string, opts?: { requestTimeoutMs?: number }) => Promise<unknown> },
    runtimeSandboxId: string,
    logContext?: Record<string, unknown>,
  ): Promise<"alive" | "dead" | "unknown">;
}

function attachSandboxSocket(
  fakeState: ReturnType<typeof createFakeState>,
  instance: DOTestHandle,
  sandboxId = "sbx-1",
  generation = 1,
): WebSocket {
  const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
  fakeState.acceptWebSocket(sandboxSocket, ["sandbox", `sid:${sandboxId}`, `gen:${generation}`]);
  instance.cachedSandboxConnectionGen = generation;
  instance.sandboxWs = sandboxSocket;
  return sandboxSocket;
}

const SESSION_ID = "sandbox-death-session";

function createEnv() {
  return {
    ...createTestEnv(),
    E2B_API_KEY: "test-e2b-key",
    FREESTYLE_API_KEY: "test-freestyle-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    E2B_SANDBOX_TIMEOUT_MS: "3600000",
    E2B_RUNTIME_RETENTION_HOURS: "24",
    E2B_RUNTIME_LIVE_LEASE_MS: "900000",
    E2B_RUNTIME_PROVIDER_REFRESH_INTERVAL_MS: "1800000",
    E2B_RUNTIME_PROVIDER_TTL_MS: "3600000",
  };
}

/** Stand up an active session whose sandbox row is review-listening (no active prompt). */
function createReviewListeningDO(workerModule: WorkerModule): {
  instance: DOTestHandle;
  fakeState: ReturnType<typeof createFakeState>;
  operations: string[];
} {
  const fakeState = createFakeState();
  const instance = new workerModule.SessionDO(fakeState, createEnv()) as unknown as DOTestHandle;
  const operations: string[] = [];
  instance.spawnSandbox = vi.fn(async (_sessionId: string, _spawnAttemptId: string, operation: string) => {
    operations.push(operation);
  });
  seedSession(fakeState.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
  });
  seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "reconnecting" });
  return { instance, fakeState, operations };
}

function setDeadRuntime(fakeState: ReturnType<typeof createFakeState>): void {
  fakeState.storage.sql.exec(
    `UPDATE sandbox_state SET runtime_provider = ?, runtime_state = ?, runtime_sandbox_id = ?, runtime_template_id = ?
     WHERE session_id = ?`,
    "e2b",
    "killed",
    "e2b-dead",
    "cycloid-sandbox-test",
    SESSION_ID,
  );
}

async function enqueue(instance: DOTestHandle, prompt: string): Promise<Response> {
  return instance.fetch(
    new Request("https://internal/session/prompts/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
      body: JSON.stringify({ prompt, actorUserId: "user-1" }),
    }),
  );
}

describe("SessionDO sandbox-death recovery", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    sandboxMock.getInfo.mockReset();
    sandboxMock.list.mockReset();
    sandboxMock.list.mockReturnValue({ hasNext: false, nextItems: async () => [] });
    freestyleMock.vmGetInfo.mockReset();
    freestyleMock.vmsRef.mockClear();
    survivalMetricsMock.emitSandboxDisconnectTerminalizeMetric.mockClear();
    eventsExporterMock.postStructuredEventToDd.mockReset();
    eventsExporterMock.postStructuredEventToDd.mockResolvedValue(true);
  });

  it("waits 60s before provider loss can be confirmed", () => {
    expect(SANDBOX_LOSS_RECOVERY_BUDGET_MS).toBe(60_000);
  });

  it("spawns fresh when a prompt is enqueued against a dead reconnecting runtime", async () => {
    const { instance, fakeState, operations } = createReviewListeningDO(workerModule);
    setDeadRuntime(fakeState);

    const response = await enqueue(instance, "respond to review");
    expect(response.status).toBe(200);

    // The dead reconnecting runtime spawns fresh rather than wedging on a
    // reconnect that will never arrive.
    expect(operations).toContain("spawnSandbox.prompt");
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.pending_prompt_dispatch).toBe(1);

    // The admit decision must NOT be wait_for_inflight_spawn against a killed runtime.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.some((event) => event.type === "prompt_processing")).toBe(true);
  });

  it("still waits for a genuine in-flight reconnect (unexpired grace) instead of spawning", async () => {
    const { instance, fakeState, operations } = createReviewListeningDO(workerModule);
    // Runtime not killed; a valid unexpired reconnect-grace deadline is armed.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, Date.now() + 60_000);

    const response = await enqueue(instance, "respond to review");
    expect(response.status).toBe(200);

    // Genuine reconnect in flight -> wait, do not spawn.
    expect(operations).toEqual([]);
  });

  it("spawns fresh when reconnect-grace already lapsed on a dead runtime", async () => {
    const { instance, fakeState, operations } = createReviewListeningDO(workerModule);
    setDeadRuntime(fakeState);
    // An expired grace deadline must not suppress the needed spawn.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, Date.now() - 1_000);

    const response = await enqueue(instance, "respond to review");
    expect(response.status).toBe(200);
    expect(operations).toContain("spawnSandbox.prompt");
  });

  it("ignores a late ws-close on an already-killed runtime instead of resurrecting reconnecting", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createEnv()) as unknown as DOTestHandle;
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
    });
    // Liveness expiry already routed the dead VM to stopped + killed.
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    setDeadRuntime(fakeState);

    // A late close frame for the killed VM's socket arrives.
    const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "sid:e2b-dead", "gen:1"]);
    instance.cachedSandboxConnectionGen = 1;
    instance.sandboxWs = sandboxSocket;

    await instance.webSocketClose(sandboxSocket, 1006, "abnormal", false);
    await instance.persistenceQueue;

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    // The dead runtime stays stopped -- it is NOT resurrected to reconnecting.
    expect(sandbox?.status).toBe("stopped");
    expect(sandbox?.disconnect_started_at).toBeNull();
  });

  it("routes a zero-activity max-duration trip through the bounded disconnect-retry flow", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createEnv()) as unknown as DOTestHandle;
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_s: string, _a: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      promptCounter: 1,
    });
    // Dead sandbox (no socket) and the prompt never produced any activity: a
    // phantom timeout, not a genuine long turn.
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "reconnecting",
      sandboxId: "sbx-1",
      promptLastActivityAt: null,
    });
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "respond",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt: Date.now() - (PROMPT_MAX_DURATION_MS + 60_000),
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    await instance.alarm();
    await instance.persistenceQueue;

    // Bounded disconnect-retry: a fresh prompt clone spawns on a new sandbox.
    expect(operations).toContain("spawnSandbox.sandboxDisconnect");
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    const original = prompts.find((p) => p.prompt_id === "p-1");
    expect(original?.status).toBe("failed");
    // The phantom timeout is NOT surfaced as max_duration_exceeded.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.some((event) => event.type === "prompt_retrying")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "prompt_failed" &&
          (event.data as { errorCode?: string })?.errorCode === "max_duration_exceeded",
      ),
    ).toBe(false);
  });

  it("still fails a quiet-but-active prompt with max_duration_exceeded", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createEnv()) as unknown as DOTestHandle;
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_s: string, _a: string, operation: string) => {
      operations.push(operation);
    });
    const startedAt = Date.now() - (PROMPT_MAX_DURATION_MS + 60_000);
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      promptCounter: 1,
    });
    // The prompt DID start: prompt_last_activity_at advanced past startedAt (a long,
    // quiet tool call). This must stay a genuine max_duration_exceeded.
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
      sandboxId: "sbx-1",
      promptLastActivityAt: startedAt + 5_000,
    });
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "long task",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt,
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    await instance.alarm();
    await instance.persistenceQueue;

    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(
      events.some(
        (event) =>
          event.type === "prompt_failed" &&
          (event.data as { errorCode?: string })?.errorCode === "max_duration_exceeded",
      ),
    ).toBe(true);
  });

  it("fails a long live-socket prompt with no activity marker as max_duration_exceeded, not a phantom retry", async () => {
    // prompt_last_activity_at is only written on the connect-dispatch path, so a
    // long prompt dispatched over an already-live socket can have it null even
    // though it is genuinely running. The live socket must keep this a real
    // max-duration failure, not a sandbox_never_started re-run.
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createEnv()) as unknown as DOTestHandle;
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_s: string, _a: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      promptCounter: 1,
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
      sandboxId: "sbx-1",
      promptLastActivityAt: null,
    });
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "long task",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt: Date.now() - (PROMPT_MAX_DURATION_MS + 60_000),
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });
    // A live sandbox socket proves the prompt is running, not a dead-VM phantom.
    attachSandboxSocket(fakeState, instance);

    await instance.alarm();
    await instance.persistenceQueue;

    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(
      events.some(
        (event) =>
          event.type === "prompt_failed" &&
          (event.data as { errorCode?: string })?.errorCode === "max_duration_exceeded",
      ),
    ).toBe(true);
  });

  it("threads reconnect_grace_expiry origin into the disconnect-retry call", async () => {
    sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createEnv()) as unknown as DOTestHandle;
    instance.spawnSandbox = vi.fn(async () => undefined);
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      promptCounter: 1,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready", sandboxId: "sbx-1" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET runtime_provider = ?, runtime_backend = ?, runtime_state = ?, runtime_sandbox_id = ?,
        runtime_template_id = ?, runtime_live_lease_expires_at = ? WHERE session_id = ?`,
      "e2b",
      "e2b_cloud",
      "running",
      "e2b-running-1",
      "cycloid-sandbox-test",
      Date.now() + 60_000,
      SESSION_ID,
    );
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "respond",
      actorUserId: "user-1",
      agent: "code",
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

    const origins: Array<string | undefined> = [];
    instance.promptQueue.failActivePromptOnDisconnect = vi.fn(
      async (_session: unknown, _promptId: string, origin?: string) => {
        origins.push(origin);
      },
    );

    const sandboxSocket = attachSandboxSocket(fakeState, instance, "e2b-running-1");
    await instance.webSocketClose(sandboxSocket, 1006, "abnormal", false);
    await instance.persistenceQueue;
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
      state: "reconnecting",
      sandboxId: "e2b-running-1",
      lastHeartbeatAt: Date.now() - SANDBOX_LOSS_RECOVERY_BUDGET_MS - 1_000,
    });

    // Force the reconnect-grace deadline (and disconnect marker) into the past so
    // the next alarm expires it and routes through the disconnect-retry flow.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, Date.now() - 1);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ? WHERE session_id = ?",
      Date.now() - (SANDBOX_RECONNECT_GRACE_MS + 1_000),
      SESSION_ID,
    );

    await instance.alarm();

    expect(origins).toContain("reconnect_grace_expiry");
  });

  /**
   * Termination chokepoint (Plan A): stand up an in-flight processing prompt on a
   * live E2B runtime, then route an alarm through a disconnect-terminal lane.
   *
   * The bounded resume hold is anchored on the lifecycle heartbeat (NOT
   * sandbox_state.last_heartbeat_at, which heartbeats never write), so the helper
   * seeds the lifecycle sandbox record's `lastHeartbeatAt` directly. `lane`
   * selects reconnect-grace (clean close + past grace deadline) vs liveness
   * (open socket gone silent + past liveness deadline, no disconnect marker).
   */
  async function driveDisconnectedActivePrompt(
    options: {
      lane?: "reconnect_grace" | "liveness";
      heartbeatAgeMs?: number;
      env?: Record<string, unknown>;
      runtimeProvider?: "e2b" | "freestyle";
      runtimeBackend?: "e2b_cloud" | "freestyle";
      runtimeSandboxId?: string;
    } = {},
  ): Promise<{ instance: DOTestHandle; fakeState: ReturnType<typeof createFakeState>; operations: string[] }> {
    const lane = options.lane ?? "reconnect_grace";
    const heartbeatAgeMs = options.heartbeatAgeMs ?? SANDBOX_LOSS_RECOVERY_BUDGET_MS + 1_000;
    const runtimeProvider = options.runtimeProvider ?? "e2b";
    const runtimeBackend = options.runtimeBackend ?? "e2b_cloud";
    const runtimeSandboxId = options.runtimeSandboxId ?? "e2b-running-1";
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, {
      ...createEnv(),
      ...(options.env ?? {}),
    }) as unknown as DOTestHandle;
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_s: string, _a: string, operation: string) => {
      operations.push(operation);
    });
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      promptCounter: 1,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready", sandboxId: runtimeSandboxId });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state SET runtime_provider = ?, runtime_backend = ?, runtime_state = ?, runtime_sandbox_id = ?,
        runtime_template_id = ?, runtime_live_lease_expires_at = ? WHERE session_id = ?`,
      runtimeProvider,
      runtimeBackend,
      "running",
      runtimeSandboxId,
      "cycloid-sandbox-test",
      Date.now() + 60_000,
      SESSION_ID,
    );
    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "respond",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt: Date.now() - 30_000,
    });
    await fakeState.storage.put("events", []);
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });
    // Seed the lifecycle heartbeat (the hold anchor) + sandbox identity.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
      state: "reconnecting",
      sandboxId: runtimeSandboxId,
      lastHeartbeatAt: Date.now() - heartbeatAgeMs,
    });

    if (lane === "reconnect_grace") {
      const sandboxSocket = attachSandboxSocket(fakeState, instance, runtimeSandboxId);
      await instance.webSocketClose(sandboxSocket, 1006, "abnormal", false);
      await instance.persistenceQueue;
      // Force the reconnect-grace deadline + disconnect marker past so the alarm
      // routes through the disconnect-terminal chokepoint.
      await fakeState.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, Date.now() - 1);
      fakeState.storage.sql.exec(
        "UPDATE sandbox_state SET disconnect_started_at = ? WHERE session_id = ?",
        Date.now() - (SANDBOX_RECONNECT_GRACE_MS + 1_000),
        SESSION_ID,
      );
    } else {
      // Silent-liveness lane: open socket, no disconnect marker, past liveness
      // deadline. Keep the lifecycle sandbox state `ready` so the reducer fires
      // sandbox.liveness_expired.
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: runtimeSandboxId,
        lastHeartbeatAt: Date.now() - heartbeatAgeMs,
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, Date.now() - 1);
    }

    return { instance, fakeState, operations };
  }

  it("defers terminalizing an in-flight prompt when the E2B VM probes alive (grace lane)", async () => {
    sandboxMock.getInfo.mockResolvedValue({ state: "running" });
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt();

    await instance.alarm();
    await instance.persistenceQueue;

    // The live VM is NOT killed and the prompt is NOT re-cloned.
    expect(sandboxMock.getInfo).toHaveBeenCalledWith("e2b-running-1", expect.anything());
    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((p) => p.prompt_id === "p-1")?.status).toBe("processing");

    // Held in reconnecting with a freshly re-armed grace window for the same VM.
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.status).toBe("reconnecting");
    expect(sandbox?.runtime_state).not.toBe("killed");
    const rearmed = await fakeState.storage.get<number>(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY);
    expect(typeof rearmed).toBe("number");
    expect(rearmed as number).toBeGreaterThan(Date.now());
    expect(rearmed as number).toBeGreaterThanOrEqual(Date.now() + SANDBOX_LOSS_RECOVERY_BUDGET_MS - 1_000);

    // Finding 1: the prompt lifecycle phase must be restored (not left terminal),
    // or a reconnecting bridge's events would be rejected and the prompt wedges.
    const promptLifecycle = await fakeState.storage.get<{ phase?: string }>(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY);
    expect(promptLifecycle?.phase).not.toBe("terminal");

    // Finding 4: disconnect marker is reset to ~now (not the stale past value), so
    // rescheduleSessionAlarm's disconnectStartedAt+grace candidate is in the future.
    expect(sandbox?.disconnect_started_at as number).toBeGreaterThan(Date.now() - SANDBOX_RECONNECT_GRACE_MS);
  });

  it("retries a dead sandbox within the liveness budget even while a tool call is active", async () => {
    // Silent liveness expiry means the first-party bridge/harness heartbeat is
    // missing. Provider/desktop/VNC liveness must not keep the prompt alive.
    sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt({ lane: "liveness" });
    // Tool activity may extend the prompt inactivity deadline, but it must not
    // alter the independent sandbox-liveness deadline.
    await fakeState.storage.put("prompt_active_tool_calls:p-1", ["tool-1"]);
    await fakeState.storage.put(
      LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
      Date.now() + PROMPT_MAX_DURATION_MS,
    );

    await instance.alarm();
    await instance.persistenceQueue;

    expect(sandboxMock.getInfo).toHaveBeenCalled();
    expect(operations).toContain("spawnSandbox.sandboxDisconnect");
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("killed");
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((p) => p.prompt_id === "p-1")?.status).toBe("failed");
    expect(prompts.find((p) => p.prompt_id === "p-2")).toMatchObject({
      status: "processing",
      disconnect_retry_count: 1,
    });
    await expect(fakeState.storage.get("prompt_active_tool_calls:p-1")).resolves.toBeUndefined();
  });

  it("never terminalizes a provider-alive runtime after the observation window", async () => {
    sandboxMock.getInfo.mockResolvedValue({ state: "running" });
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt({
      heartbeatAgeMs: SANDBOX_LOSS_RECOVERY_BUDGET_MS + 1,
    });
    await instance.alarm();
    await instance.persistenceQueue;

    expect(sandboxMock.getInfo).toHaveBeenCalled();
    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).not.toBe("killed");
  });

  it("does not block disconnect retry on runtime projection cleanup", async () => {
    sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt({ lane: "liveness" });
    let projectionStarted = false;
    (
      instance as unknown as {
        projectRuntimeKilledAfterUnexpectedDisconnect: (sessionId: string) => Promise<void>;
      }
    ).projectRuntimeKilledAfterUnexpectedDisconnect = vi.fn(async () => {
      projectionStarted = true;
      await new Promise<void>(() => undefined);
    });

    await expect(instance.alarm()).resolves.toBeUndefined();
    await instance.persistenceQueue;

    expect(projectionStarted).toBe(true);
    expect(operations).toContain("spawnSandbox.sandboxDisconnect");
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((p) => p.prompt_id === "p-1")?.status).toBe("failed");
    expect(prompts.find((p) => p.prompt_id === "p-2")?.status).toBe("processing");
  });

  it("keeps observing when the provider probe is unknown", async () => {
    // No getInfo impl -> returns undefined -> getSandboxInfo classifies unknown.
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt();

    await instance.alarm();
    await instance.persistenceQueue;

    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).not.toBe("killed");
  });

  it("keeps observing an alive VM regardless of heartbeat age", async () => {
    sandboxMock.getInfo.mockResolvedValue({ state: "running" });
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt({
      heartbeatAgeMs: SANDBOX_LOSS_RECOVERY_BUDGET_MS + 60_000,
    });

    await instance.alarm();
    await instance.persistenceQueue;

    expect(sandboxMock.getInfo).toHaveBeenCalled();
    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).not.toBe("killed");
  });

  // Removed: probe-error fail-closed test relied on self-hosted-disabled forcing
  // buildCleanupClient to throw; self-hosted backend deleted, no cloud trigger.

  it("does not terminalize when provider probing is disabled", async () => {
    sandboxMock.getInfo.mockResolvedValue({ state: "running" });
    const { instance, fakeState, operations } = await driveDisconnectedActivePrompt({
      env: { E2B_ORPHAN_REAPER_LIVENESS_GUARD: "0" },
    });

    await instance.alarm();
    await instance.persistenceQueue;

    expect(sandboxMock.getInfo).not.toHaveBeenCalled();
    expect(operations).not.toContain("spawnSandbox.sandboxDisconnect");
    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.runtime_state).not.toBe("killed");
  });

  // Observational disconnect cross-check (sandbox-loss-diagnosis.md): on terminate
  // the chokepoint lists Cycloid sandboxes per backend via waitUntil to record
  // whether E2B still sees the VM. It must never alter the decision nor throw.
  describe("observational disconnect cross-check", () => {
    it("cross-checks E2B on terminalize without changing the kill decision", async () => {
      sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
      const { instance, fakeState, operations } = await driveDisconnectedActivePrompt();

      await instance.alarm();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      // The observational list ran...
      expect(sandboxMock.list).toHaveBeenCalled();
      // ...but the terminate decision is unchanged (still kills + re-clones).
      expect(operations).toContain("spawnSandbox.sandboxDisconnect");
      expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("killed");
    });

    it("swallows a throwing cross-check and still terminalizes", async () => {
      sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
      sandboxMock.list.mockImplementation(() => {
        throw new Error("e2b list unavailable");
      });
      const { instance, fakeState, operations } = await driveDisconnectedActivePrompt();

      // The alarm must resolve and the swallowed cross-check must not surface a
      // rejection through waitUntil.
      await expect(instance.alarm()).resolves.toBeUndefined();
      await instance.persistenceQueue;
      await expect(fakeState.flushWaitUntil()).resolves.toBeUndefined();

      expect(operations).toContain("spawnSandbox.sandboxDisconnect");
      expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("killed");
    });
  });

  // ARC-1484: a Freestyle session must NOT be cross-checked against the E2B account
  // list (it never contains the Freestyle vm-id, so every live Freestyle VM was
  // logged as genuinely-gone). The cross-check reads the session's OWN VM via the
  // per-VM getInfo and dispatches on the persisted runtime backend.
  describe("Freestyle disconnect cross-check (ARC-1484)", () => {
    const postMock = eventsExporterMock.postStructuredEventToDd;

    function postedEvents(event: string): Array<Record<string, unknown>> {
      return postMock.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .filter((payload) => payload?.event === event);
    }

    function driveFreestyle(options: { heartbeatAgeMs?: number } = {}) {
      return driveDisconnectedActivePrompt({
        runtimeProvider: "freestyle",
        runtimeBackend: "freestyle",
        runtimeSandboxId: "vm-abc",
        heartbeatAgeMs: options.heartbeatAgeMs,
      });
    }

    it("cross-checks the Freestyle VM per-id and NEVER the E2B account list", async () => {
      // Probe reads the VM as deleted -> dead -> terminate; the cross-check then
      // re-reads the SAME VM and finds it running (a suspend/transient window):
      // pre-fix this hit the empty E2B list and logged absent_from_all_backends
      // (false genuine-loss) for a live VM. Now it reads vm-abc directly -> listed.
      freestyleMock.vmGetInfo
        .mockResolvedValueOnce({ deleted: true }) // liveness probe -> missing -> dead
        .mockResolvedValueOnce({ state: "running" }); // cross-check -> running -> listed
      const { instance, fakeState, operations } = await driveFreestyle();

      await instance.alarm();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      // The E2B account list is never consulted for a Freestyle session.
      expect(sandboxMock.list).not.toHaveBeenCalled();
      // The per-VM read targets the session's OWN vm-id.
      expect(freestyleMock.vmsRef).toHaveBeenCalledWith({ vmId: "vm-abc" });

      const crossChecks = postedEvents("sandbox_disconnect_crosscheck");
      expect(crossChecks).toHaveLength(1);
      expect(crossChecks[0]).toMatchObject({ runtimeSandboxId: "vm-abc", listed: true, listedState: "running" });

      const summaries = postedEvents("sandbox_disconnect_crosscheck_summary");
      expect(summaries).toHaveLength(1);
      // Listed + a dead probe = the H2 false-negative signal, NOT a genuine loss.
      expect(summaries[0]).toMatchObject({ listed: true, signal: "probe_false_negative_suspected" });

      // Decision parity: the observational cross-check never changed the kill.
      expect(operations).toContain("spawnSandbox.sandboxDisconnect");
      expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("killed");
    });

    it("reports genuine loss (absent) only when the per-VM read is decisively missing", async () => {
      // Every read says deleted -> the VM is genuinely gone on its own backend.
      freestyleMock.vmGetInfo.mockResolvedValue({ deleted: true });
      const { instance, fakeState } = await driveFreestyle();

      await instance.alarm();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      expect(sandboxMock.list).not.toHaveBeenCalled();
      const summaries = postedEvents("sandbox_disconnect_crosscheck_summary");
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ listed: false, signal: "absent_from_all_backends" });
    });
  });

  // A4a SLO: every chokepoint decision emits one count tagged lane/decision/liveness.
  // The `{decision:terminate,liveness:alive}` slice is the invariant violation and must
  // stay ~0 (eligible reconnect-grace alive probes defer); the `{decision:defer}` slice
  // is A1's positive signal.
  describe("emits the disconnect_terminalize SLO metric", () => {
    const emitMock = survivalMetricsMock.emitSandboxDisconnectTerminalizeMetric;

    it("tags a defer as decision:defer / liveness:alive on the grace lane", async () => {
      sandboxMock.getInfo.mockResolvedValue({ state: "running" });
      const { instance } = await driveDisconnectedActivePrompt();

      await instance.alarm();
      await instance.persistenceQueue;

      expect(emitMock).toHaveBeenCalledWith(expect.anything(), {
        lane: "reconnect_grace_expiry",
        decision: "defer",
        liveness: "alive",
      });
    });

    it("tags an unknown probe as decision:defer / liveness:unknown", async () => {
      const { instance } = await driveDisconnectedActivePrompt();

      await instance.alarm();
      await instance.persistenceQueue;

      expect(emitMock).toHaveBeenCalledWith(expect.anything(), {
        lane: "reconnect_grace_expiry",
        decision: "defer",
        liveness: "unknown",
      });
    });

    it("tags an old provider-alive observation as deferred", async () => {
      sandboxMock.getInfo.mockResolvedValue({ state: "running" });
      const { instance } = await driveDisconnectedActivePrompt({
        heartbeatAgeMs: SANDBOX_LOSS_RECOVERY_BUDGET_MS + 60_000,
      });

      await instance.alarm();
      await instance.persistenceQueue;

      expect(sandboxMock.getInfo).toHaveBeenCalled();
      expect(emitMock).toHaveBeenCalledWith(expect.anything(), {
        lane: "reconnect_grace_expiry",
        decision: "defer",
        liveness: "alive",
      });
    });

    it("independently probes silent liveness expiry and defers an alive provider", async () => {
      sandboxMock.getInfo.mockResolvedValue({ state: "running" });
      const { instance } = await driveDisconnectedActivePrompt({ lane: "liveness" });

      await instance.alarm();
      await instance.persistenceQueue;

      expect(sandboxMock.getInfo).toHaveBeenCalled();
      expect(emitMock).toHaveBeenCalledWith(expect.anything(), {
        lane: "liveness_expiry",
        decision: "defer",
        liveness: "alive",
      });
    });
  });

  // Read-channel fix (sandbox-loss-diag-fix-read-channel.md): the diagnostic
  // events must direct-post to Datadog (plain `this.log` is invisible there).
  // These assert the post fires with a hygienic payload, fires off the decision
  // path, and never alters the terminate/defer decision or rejects the alarm.
  describe("direct-posts disconnect diagnostics to Datadog", () => {
    const postMock = eventsExporterMock.postStructuredEventToDd;

    /** Payloads direct-posted for a given event name, in call order. */
    function postedEvents(event: string): Array<Record<string, unknown>> {
      return postMock.mock.calls
        .map((call) => call[1] as Record<string, unknown>)
        .filter((payload) => payload?.event === event);
    }

    it("posts probe + cross-check + terminalize_confirmed on provider-confirmed loss", async () => {
      sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
      const { instance, fakeState, operations } = await driveDisconnectedActivePrompt();

      await instance.alarm();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      // Probe (sync path, waitUntil) carries the normalized liveness, no raw read.
      expect(postedEvents("sandbox_liveness_probe")).toHaveLength(1);
      // Cross-check posts one detail event plus one summary.
      expect(postedEvents("sandbox_disconnect_crosscheck")).toHaveLength(1);
      expect(postedEvents("sandbox_disconnect_crosscheck_summary")).toHaveLength(1);
      // The terminate decision's confirmation record is posted exactly once.
      const confirmed = postedEvents("sandbox_disconnect_terminalize_confirmed");
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({
        lane: "reconnect_grace_expiry",
        liveness: "dead",
        observationState: "provider_dead_confirmed",
        terminalizationReason: "provider_missing_after_sustained_transport_loss",
        connectionGeneration: 1,
      });
      // Decision parity: posting did not change the kill outcome.
      expect(operations).toContain("spawnSandbox.sandboxDisconnect");
      expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("killed");
    });

    it("posts terminalize_deferred (and no cross-check) when the VM probes alive", async () => {
      sandboxMock.getInfo.mockResolvedValue({ state: "running" });
      const { instance, fakeState } = await driveDisconnectedActivePrompt();

      await instance.alarm();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      const deferred = postedEvents("sandbox_disconnect_terminalize_deferred");
      expect(deferred).toHaveLength(1);
      expect(postedEvents("sandbox_disconnect_detected")).toContainEqual(
        expect.objectContaining({
          connectionGeneration: 1,
          observationState: "transport_loss_observing",
          activePromptId: "p-1",
        }),
      );
      expect(deferred[0]).toMatchObject({
        lane: "reconnect_grace_expiry",
        liveness: "alive",
        observationState: "provider_alive",
        connectionGeneration: 1,
      });
      expect(typeof deferred[0].providerProbeDurationMs).toBe("number");
      expect(postedEvents("sandbox_liveness_probe")).toHaveLength(1);
      expect(postedEvents("sandbox_liveness_probe")[0]).toMatchObject({
        connectionGeneration: 1,
        liveness: "alive",
      });
      expect(typeof postedEvents("sandbox_liveness_probe")[0].probeDurationMs).toBe("number");
      // The cross-check only runs on the terminate branch, never on defer.
      expect(postedEvents("sandbox_disconnect_crosscheck_summary")).toHaveLength(0);
      expect(postedEvents("sandbox_disconnect_terminalize_confirmed")).toHaveLength(0);
    });

    it("carries the raw provider state in the probe payload on an unmapped state", async () => {
      // An unmapped SDK state collapses to `unknown` (E2B) or a live-biased `paused`
      // (Freestyle, ARC-1478); either way the probe payload must preserve rawState —
      // it is the only surviving record of what the provider actually reported.
      sandboxMock.getInfo.mockResolvedValue({ state: "converting" });
      const { instance, fakeState } = await driveDisconnectedActivePrompt();

      await instance.alarm();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      const probes = postedEvents("sandbox_liveness_probe");
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({ normalizedStatus: "unknown", rawState: "converting", liveness: "unknown" });
    });

    it("preserves rawState in the probe payload on a live-biased paused reading", async () => {
      // Freestyle maps an unrecognized state on an existing VM to `paused`+rawState
      // (ARC-1478). The payload guard must read rawState on non-unknown statuses too
      // — a regression back to `status === "unknown" ? rawState : undefined` would
      // silently drop the only record of what the provider reported. The E2B mock
      // can never emit paused+rawState, so drive the probe directly with a stubbed
      // provider client (the method takes the client as a parameter).
      const { instance, fakeState } = await driveDisconnectedActivePrompt();
      postMock.mockClear();

      const liveness = await instance.probeE2BRuntimeLiveness(
        { getSandboxInfo: async () => ({ status: "paused", rawState: "hibernating" }) },
        "vm-freestyle-1",
        { sessionId: SESSION_ID, lane: "reconnect_grace_expiry" },
      );
      await fakeState.flushWaitUntil();

      expect(liveness).toBe("alive");
      const probes = postedEvents("sandbox_liveness_probe");
      expect(probes).toHaveLength(1);
      expect(probes[0]).toMatchObject({ normalizedStatus: "paused", rawState: "hibernating", liveness: "alive" });
    });

    it("posts a sanitized errorCode (never a raw error string) on a probe error", async () => {
      // A corrupt/legacy persisted backend value (self-hosted was dropped) makes
      // parsePersistedRuntimeBackend throw. The chokepoint must fail CLOSED through
      // the wrapped probe -> probe_error, never reject the alarm and strand the prompt.
      sandboxMock.getInfo.mockResolvedValue({ state: "running" });
      const { instance, fakeState } = await driveDisconnectedActivePrompt();
      fakeState.storage.sql.exec(
        "UPDATE sandbox_state SET runtime_backend = ? WHERE session_id = ?",
        "cycloid_self_hosted_e2b",
        SESSION_ID,
      );

      await expect(instance.alarm()).resolves.toBeUndefined();
      await instance.persistenceQueue;
      await fakeState.flushWaitUntil();

      const probeErrors = postedEvents("sandbox_disconnect_probe_error");
      expect(probeErrors).toHaveLength(1);
      // Hygiene: bounded errorCode only, never the raw `error: String(error)`.
      expect(typeof probeErrors[0].errorCode).toBe("string");
      expect(probeErrors[0]).not.toHaveProperty("error");
      // The corrupt backend is healed to cloud so the terminate branch's spawn
      // re-clone (resolveRuntimeBackendAffinity re-reads runtime_backend) recovers
      // instead of re-throwing the same parse error and looping spawn retries.
      expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_backend).toBe("e2b_cloud");
    });

    it("does not change the decision or reject the alarm when the post fails", async () => {
      // A throwing Datadog post must be isolated on both the waitUntil sync path
      // and the awaited cross-check path. Reject only
      // the 7 diagnostic events (not the unrelated raw-waitUntil lifecycle_event
      // post), and defer the rejection to a macrotask so each post is still pending
      // when flushWaitUntil drives it -- that forces the tracker to observe the
      // rejection. A raw `waitUntil(postStructuredEventToDd(...))` on the sync path
      // (no swallow) would surface as a rejected tracked promise and make flush
      // re-throw, so this fails closed if the sync-path swallow regresses.
      const diagnosticEvents = new Set([
        "sandbox_liveness_probe",
        "sandbox_disconnect_crosscheck",
        "sandbox_disconnect_crosscheck_summary",
        "sandbox_disconnect_crosscheck_error",
        "sandbox_disconnect_probe_error",
        "sandbox_disconnect_terminalize_confirmed",
        "sandbox_disconnect_terminalize_deferred",
      ]);
      postMock.mockImplementation((_env, event) =>
        diagnosticEvents.has(event?.event as string)
          ? new Promise((_resolve, reject) => setTimeout(() => reject(new Error("datadog unavailable")), 0))
          : Promise.resolve(true),
      );
      sandboxMock.getInfo.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));
      const { instance, fakeState, operations } = await driveDisconnectedActivePrompt();

      await expect(instance.alarm()).resolves.toBeUndefined();
      await instance.persistenceQueue;
      await expect(fakeState.flushWaitUntil()).resolves.toBeUndefined();

      // Parity preserved despite every post rejecting.
      expect(operations).toContain("spawnSandbox.sandboxDisconnect");
      expect(querySandboxState(fakeState.storage, SESSION_ID)?.runtime_state).toBe("killed");
    });
  });
});
