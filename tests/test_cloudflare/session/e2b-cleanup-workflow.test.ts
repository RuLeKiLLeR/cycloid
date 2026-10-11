import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

const sandboxMock = vi.hoisted(() => ({
  kill: vi.fn(),
  pause: vi.fn(),
  connect: vi.fn(),
  create: vi.fn(),
  setTimeout: vi.fn(),
}));

// Freestyle SDK mock so the cleanup workflow can drive a freestyle-backed row end to
// end (proving the provider-agnostic cleanup decision does NOT skip a "freestyle" row).
const freestyleMock = vi.hoisted(() => {
  const vmsDelete = vi.fn();
  const vmsList = vi.fn();
  // ARC-1481: pauseSandbox now parks the VM via vms.ref(...).suspend(), so ref must
  // return a handle carrying a real suspend() (the old mock's ref returned undefined,
  // which was fine only while pause was a no-op).
  const vmSuspend = vi.fn();
  const vm = { suspend: vmSuspend };
  const vmsRef = vi.fn(() => vm);
  const FreestyleCtor = vi.fn(function (this: { vms: unknown }) {
    this.vms = { delete: vmsDelete, list: vmsList, create: vi.fn(), ref: vmsRef };
  });
  return { vmsDelete, vmsList, vmSuspend, vmsRef, FreestyleCtor };
});

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("e2b", () => ({
  Sandbox: sandboxMock,
}));

vi.mock("freestyle", () => ({
  Freestyle: freestyleMock.FreestyleCtor,
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

const SESSION_ID = "e2b-cleanup-session";
const CLEANUP_SECRET = "test-cleanup-secret";
const CLOUD = "e2b_cloud";
const FREESTYLE = "freestyle";

function createCleanupEnv(overrides: Record<string, unknown> = {}) {
  // createTestEnv() supplies a FakeD1 that backs session_index projection
  // writes (the same DB the stop-boundary pause path exercises).
  return {
    ...createTestEnv(),
    E2B_API_KEY: "test-e2b-key",
    E2B_SANDBOX_TEMPLATE: "cycloid-sandbox-test",
    SANDBOX_RUNTIME_CLEANUP_SECRET: CLEANUP_SECRET,
    ...overrides,
  };
}

type Instance = {
  alarm(): Promise<void>;
  fetch(request: Request): Promise<Response>;
};

function newInstance(env: Record<string, unknown>, workerModule: WorkerModule) {
  const state = createFakeState();
  const instance = new workerModule.SessionDO(state, env) as Instance & { sandboxWs: unknown | null };
  instance.sandboxWs = null;
  return { state, instance };
}

interface SeedRuntimeOpts {
  runtimeState: "paused" | "running" | "killed";
  sandboxId?: string;
  provider?: string;
  backend?: string;
  stateExpiresAt?: number | null;
  liveLeaseExpiresAt?: number | null;
  sessionStatus?: string;
  lastActivityAt?: number | null;
}

function seedRuntime(state: ReturnType<typeof createFakeState>, opts: SeedRuntimeOpts) {
  const sandboxId = opts.sandboxId ?? "e2b-1";
  seedSession(state.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: opts.sessionStatus ?? "active",
  });
  seedSandboxState(state.storage, { sessionId: SESSION_ID, status: "stopped" });
  state.storage.sql.exec(
    `UPDATE sandbox_state SET
       runtime_provider = ?,
       runtime_state = ?,
       runtime_sandbox_id = ?,
       runtime_backend = ?,
       runtime_state_expires_at = ?,
       runtime_live_lease_expires_at = ?,
       last_activity_at = ?
     WHERE session_id = ?`,
    opts.provider ?? "e2b",
    opts.runtimeState,
    sandboxId,
    opts.backend ?? CLOUD,
    opts.stateExpiresAt ?? null,
    opts.liveLeaseExpiresAt ?? null,
    opts.lastActivityAt ?? null,
    SESSION_ID,
  );
}

async function runCleanup(
  instance: Instance,
  body: { projectedRuntimeSandboxId: string; projectedRuntimeBackend?: string; reason?: string; nowMs?: number },
): Promise<{ status: number; outcome: string; reasonCode: string }> {
  const res = await instance.fetch(
    new Request("https://session.internal/internal/runtime/e2b/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CLEANUP_SECRET}` },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        projectedRuntimeSandboxId: body.projectedRuntimeSandboxId,
        projectedRuntimeBackend: body.projectedRuntimeBackend ?? CLOUD,
        reason: body.reason ?? "paused_expired",
        nowMs: body.nowMs ?? Date.now(),
      }),
    }),
  );
  const json = (await res.json()) as { outcome: string; reasonCode: string };
  return { status: res.status, outcome: json.outcome, reasonCode: json.reasonCode };
}

const jobKey = (sb: string) => `e2b_cleanup_job:${sb}`;
const stepKey = (sb: string, phase: string) => `step:e2b_cleanup_${sb}_${phase}`;
const RETRY_POINTER_KEY = "lifecycle:deadline:e2b_cleanup_retry";

describe("SessionDO E2B cleanup workflow", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useRealTimers();
    sandboxMock.kill.mockReset();
    sandboxMock.pause.mockReset();
    sandboxMock.connect.mockReset();
    freestyleMock.vmsDelete.mockReset();
    freestyleMock.vmsDelete.mockResolvedValue(undefined);
    freestyleMock.vmsList.mockReset();
    freestyleMock.vmsList.mockResolvedValue({ vms: [] });
    freestyleMock.vmSuspend.mockReset();
    freestyleMock.vmSuspend.mockResolvedValue({ id: "fs", vmInstanceId: "fs-inst", snapshotLayerId: "df-layer" });
    freestyleMock.vmsRef.mockClear();
    freestyleMock.FreestyleCtor.mockClear();
  });

  it("lifecycle fires for a freestyle-provider row: cleanup decision is NOT skipped as not_e2b", async () => {
    // Regression for the provider-derive refactor: an honest runtime_provider="freestyle"
    // row must be admitted by the (now provider-agnostic) computeE2BCleanupDecision guard
    // and terminated via the Freestyle client — not silently skipped, which would leak the
    // VM. Byte-identical E2B behavior is proven by the sibling e2b tests above.
    const env = createCleanupEnv({ FREESTYLE_API_KEY: "test-freestyle-key" });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "paused",
      provider: "freestyle",
      backend: FREESTYLE,
      stateExpiresAt: Date.now() - 1_000,
      sandboxId: "fs-1",
    });

    const result = await runCleanup(instance, {
      projectedRuntimeSandboxId: "fs-1",
      projectedRuntimeBackend: FREESTYLE,
    });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(freestyleMock.vmsDelete).toHaveBeenCalledWith({ vmId: "fs-1" });
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_provider).toBeNull();
    expect(sandbox?.runtime_sandbox_id).toBeNull();
  });

  it("clears a LEGACY freestyle row that still stores runtime_provider='e2b' (pre-derive skew)", async () => {
    // Rows written before the derivation sweep carry provider "e2b" with backend
    // "freestyle". The clear CAS must match what the row actually stores (observed-first,
    // derived fallback) or the D1 projection clears while the DO row survives, stranding
    // a pointer to a dead VM.
    const env = createCleanupEnv({ FREESTYLE_API_KEY: "test-freestyle-key" });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "paused",
      provider: "e2b",
      backend: FREESTYLE,
      stateExpiresAt: Date.now() - 1_000,
      sandboxId: "fs-legacy-1",
    });

    const result = await runCleanup(instance, {
      projectedRuntimeSandboxId: "fs-legacy-1",
      projectedRuntimeBackend: FREESTYLE,
    });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(freestyleMock.vmsDelete).toHaveBeenCalledWith({ vmId: "fs-legacy-1" });
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_provider).toBeNull();
    expect(sandbox?.runtime_sandbox_id).toBeNull();
  });

  it("terminates a paused-expired runtime and clears it (killed -> cleared)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-1" });
    sandboxMock.kill.mockResolvedValue(true);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-1" });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_provider).toBeNull();
    expect(sandbox?.runtime_sandbox_id).toBeNull();
    // Job + step records cleaned up on success.
    expect(await state.storage.get(jobKey("e2b-1"))).toBeUndefined();
    expect(await state.storage.get(stepKey("e2b-1", "terminate"))).toBeUndefined();
  });

  it("treats a missing provider sandbox as success (missing -> cleared)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-2" });
    sandboxMock.kill.mockResolvedValue(false); // not found -> missing

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-2" });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "missing_sandbox" });
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBeNull();
  });

  it("replays a memoized terminate without re-killing on restart-after-terminate", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-3" });
    // Pre-seed a successful terminate step memo (DO crashed after terminate).
    await state.storage.put(stepKey("e2b-3", "terminate"), { ok: true, result: "killed" });

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-3" });

    expect(result.outcome).toBe("cleared");
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBeNull();
  });

  it("retries on terminate failure then converges on the second entry", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-4" });

    sandboxMock.kill.mockRejectedValueOnce(new Error("provider 500"));
    const first = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-4" });

    expect(first).toMatchObject({ outcome: "retry_scheduled", reasonCode: "terminate_failed_retry" });
    const job = (await state.storage.get(jobKey("e2b-4"))) as { attempts: number; status: string } | undefined;
    expect(job).toMatchObject({ attempts: 1, status: "active" });
    expect(await state.storage.get(RETRY_POINTER_KEY)).toMatchObject({ runtimeSandboxId: "e2b-4" });
    expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
    // Runtime state preserved for retry.
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBe("e2b");

    sandboxMock.kill.mockResolvedValue(true);
    const second = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-4" });

    expect(second.outcome).toBe("cleared");
    expect(sandboxMock.kill).toHaveBeenCalledTimes(2);
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBeNull();
    expect(await state.storage.get(jobKey("e2b-4"))).toBeUndefined();
    expect(await state.storage.get(RETRY_POINTER_KEY)).toBeUndefined();
  });

  it("skips and does not clear when the sandbox id changed (CAS guard at decide)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-new" });

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-old" });

    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_sandbox_changed" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    // The newer runtime is untouched.
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_sandbox_id).toBe("e2b-new");
  });

  // Removed: "skips when the backend changed" CAS guard test relied on a second
  // (self-hosted) backend value; only e2b_cloud remains, so the divergence is
  // structurally impossible.

  it("pauses a stale running runtime instead of clearing it", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: Date.now() - 1_000,
      sandboxId: "e2b-6",
      lastActivityAt: null,
    });
    sandboxMock.pause.mockResolvedValue(undefined);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-6", reason: "live_lease_expired" });

    expect(result).toMatchObject({ outcome: "paused", reasonCode: "paused" });
    expect(sandboxMock.pause).toHaveBeenCalledTimes(1);
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("paused");
    expect(sandbox?.runtime_provider).toBe("e2b");
  });

  it("lifecycle fires for a freestyle-provider row: idle-pause precondition is NOT skipped", async () => {
    // Regression: a running freestyle row with an expired live lease must reach the
    // (provider-agnostic) idle-pause path and persist runtime_state="paused" with the
    // honest runtime_provider="freestyle" — not be skipped, which would leave the VM
    // billing without a lifecycle owner. Freestyle pauseSandbox parks the VM via
    // vms.ref(...).suspend() (ARC-1481), asserted below.
    // Unlike the terminate tests above (buildCleanupClient, snapshot-independent), the
    // pause path builds the full runtime config, which since ARC-1480 fails closed
    // without a snapshot id — so this env needs one, mirroring E2B_SANDBOX_TEMPLATE.
    const env = createCleanupEnv({
      FREESTYLE_API_KEY: "test-freestyle-key",
      FREESTYLE_DEFAULT_SNAPSHOT_ID: "snap-test",
    });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "running",
      provider: "freestyle",
      backend: FREESTYLE,
      liveLeaseExpiresAt: Date.now() - 1_000,
      sandboxId: "fs-2",
      lastActivityAt: null,
    });

    const result = await runCleanup(instance, {
      projectedRuntimeSandboxId: "fs-2",
      projectedRuntimeBackend: FREESTYLE,
      reason: "live_lease_expired",
    });

    expect(result).toMatchObject({ outcome: "paused", reasonCode: "paused" });
    expect(sandboxMock.pause).not.toHaveBeenCalled();
    // The VM was actually parked via the Freestyle memory-preserving suspend, not the
    // E2B pause path and not a no-op.
    expect(freestyleMock.vmsRef).toHaveBeenCalledWith({ vmId: "fs-2" });
    expect(freestyleMock.vmSuspend).toHaveBeenCalledTimes(1);
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("paused");
    expect(sandbox?.runtime_provider).toBe("freestyle");
  });

  it("retries a failed pause as pause_failed_retry", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: Date.now() - 1_000,
      sandboxId: "e2b-7",
      lastActivityAt: null,
    });
    sandboxMock.pause.mockRejectedValue(new Error("pause boom"));

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-7", reason: "live_lease_expired" });

    expect(result).toMatchObject({ outcome: "retry_scheduled", reasonCode: "pause_failed_retry" });
    // Still running, preserved for retry.
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_state).toBe("running");
  });

  // Removed: self-hosted "terminal_disabled when backend disabled" test
  // (resolveSelfHostedE2BClientConfig + self-hosted backend deleted).

  it("marks the job terminal_failed after exhausting attempts and stops re-arming", async () => {
    const env = createCleanupEnv({ E2B_CLEANUP_MAX_ATTEMPTS: "2" });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-9" });
    sandboxMock.kill.mockRejectedValue(new Error("always fails"));

    const first = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-9" });
    expect(first.outcome).toBe("retry_scheduled");

    const second = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-9" });
    expect(second).toMatchObject({ outcome: "terminal_failed", reasonCode: "terminal_failed_max_attempts" });

    const job = (await state.storage.get(jobKey("e2b-9"))) as { status: string } | undefined;
    expect(job?.status).toBe("terminal_failed");
    // Retry pointer cleared; runtime left uncleared as the worker-sweep backstop.
    expect(await state.storage.get(RETRY_POINTER_KEY)).toBeUndefined();
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBe("e2b");
  });

  it("returns terminal_failed within the cooldown window without reopening", async () => {
    const env = createCleanupEnv({ E2B_CLEANUP_MAX_ATTEMPTS: "1" });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-10" });
    sandboxMock.kill.mockRejectedValue(new Error("fail"));

    const first = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-10" });
    expect(first.outcome).toBe("terminal_failed");

    // Worker sweep re-discovers the still-uncleared row within cooldown.
    sandboxMock.kill.mockReset();
    sandboxMock.kill.mockResolvedValue(true);
    const second = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-10" });

    expect(second.outcome).toBe("terminal_failed");
    expect(sandboxMock.kill).not.toHaveBeenCalled(); // not reopened
  });

  it("runs the cleanup retry from alarm() even on an archived session (before the archived guard)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "paused",
      stateExpiresAt: Date.now() - 1_000,
      sandboxId: "e2b-11",
      sessionStatus: "archived",
    });
    // Seed an active job + a past-due retry pointer (as a prior failure would).
    await state.storage.put(jobKey("e2b-11"), {
      sessionId: SESSION_ID,
      runtimeSandboxId: "e2b-11",
      runtimeBackend: CLOUD,
      reason: "paused_expired",
      attempts: 1,
      firstAttemptAt: Date.now() - 60_000,
      lastError: "prior failure",
      status: "active",
    });
    await state.storage.put(RETRY_POINTER_KEY, { runtimeSandboxId: "e2b-11", deadlineAt: Date.now() - 1_000 });
    sandboxMock.kill.mockResolvedValue(true);

    await instance.alarm();

    // The workflow ran despite the archived status: terminate happened and the
    // runtime cleared.
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBeNull();
    expect(await state.storage.get(jobKey("e2b-11"))).toBeUndefined();
    expect(await state.storage.get(RETRY_POINTER_KEY)).toBeUndefined();
  });

  it("recovers a partial clear: re-sync on a stored-job skip clears the projection and job", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    // Simulate a prior partial clear: DO runtime state already cleared, but a
    // job record remains (projection sync had thrown before memoizing).
    seedSession(state.storage, { sessionId: SESSION_ID, ownerUserId: "u", businessId: "b", status: "active" });
    seedSandboxState(state.storage, { sessionId: SESSION_ID, status: "stopped" });
    await state.storage.put(jobKey("e2b-12"), {
      sessionId: SESSION_ID,
      runtimeSandboxId: "e2b-12",
      runtimeBackend: CLOUD,
      reason: "paused_expired",
      attempts: 1,
      firstAttemptAt: Date.now() - 10_000,
      lastError: "sync failed",
      status: "active",
    });
    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-12" });

    // decide returns not_e2b (already cleared); stored job triggers a projection
    // re-sync, then the job is finalized.
    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_not_e2b" });
    expect(await state.storage.get(jobKey("e2b-12"))).toBeUndefined();
  });

  it("emits skipped_missing_during_pause when the provider reports the runtime missing during pause", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: Date.now() - 1_000,
      sandboxId: "e2b-13",
      lastActivityAt: null,
    });
    sandboxMock.pause.mockRejectedValue(Object.assign(new Error("sandbox not found"), { status: 404 }));

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-13", reason: "live_lease_expired" });

    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_missing_during_pause" });
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_state).toBe("killed");
  });

  it("re-arms other lifecycle deadlines when terminal_failed is reached via an alarm-triggered retry", async () => {
    const env = createCleanupEnv({ E2B_CLEANUP_MAX_ATTEMPTS: "1" });
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "paused", stateExpiresAt: Date.now() - 1_000, sandboxId: "e2b-14" });
    // Another live lifecycle deadline that must survive the terminal_failed retry.
    const autoCloseAt = Date.now() + 60_000;
    state.storage.sql.exec(
      "UPDATE sandbox_state SET auto_close_scheduled_at = ? WHERE session_id = ?",
      autoCloseAt,
      SESSION_ID,
    );
    await state.storage.put(jobKey("e2b-14"), {
      sessionId: SESSION_ID,
      runtimeSandboxId: "e2b-14",
      runtimeBackend: CLOUD,
      reason: "paused_expired",
      attempts: 0,
      firstAttemptAt: Date.now() - 60_000,
      lastError: "prior failure",
      status: "active",
    });
    await state.storage.put(RETRY_POINTER_KEY, { runtimeSandboxId: "e2b-14", deadlineAt: Date.now() - 1_000 });
    sandboxMock.kill.mockRejectedValue(new Error("always fails"));

    await instance.alarm();

    const job = (await state.storage.get(jobKey("e2b-14"))) as { status: string } | undefined;
    expect(job?.status).toBe("terminal_failed");
    expect(await state.storage.get(RETRY_POINTER_KEY)).toBeUndefined();
    // The DO alarm was re-armed for the still-pending auto-close deadline rather
    // than left cleared (which would strand every other lifecycle deadline).
    expect(await state.storage.getAlarm()).toEqual(expect.any(Number));
  });

  it("terminates a killed-state row via the malformed/unknown-state fallthrough (killed_stale -> terminated)", async () => {
    // R2 pin: the DO ignores the worker-passed reason and re-decides live. A
    // runtime_state='killed' row (never matched by the running/paused arms) with a
    // sandbox id falls through to the "terminate if we have a sandbox ID" arm. No
    // DO decision change was made for this — it must already hold.
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "killed",
      stateExpiresAt: Date.now() - 60 * 60 * 1000,
      sandboxId: "e2b-killed",
    });
    sandboxMock.kill.mockResolvedValue(true);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-killed", reason: "killed_stale" });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_provider).toBeNull();
    expect(sandbox?.runtime_sandbox_id).toBeNull();
  });

  it("threads the worker cleanup_reason into the sandbox.runtime.cleanup outcome log", async () => {
    // The candidate reason (why the sweep selected the row) is logged as
    // `cleanup_reason`, distinct from `reason_code` (the workflow outcome), so DD
    // can split killed_stale sweeps from ordinary cleanups.
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const env = createCleanupEnv({ LOG_LEVEL: "info" });
      const { state, instance } = newInstance(env, workerModule);
      seedRuntime(state, {
        runtimeState: "killed",
        stateExpiresAt: Date.now() - 60 * 60 * 1000,
        sandboxId: "e2b-killed-log",
      });
      sandboxMock.kill.mockResolvedValue(true);

      const result = await runCleanup(instance, {
        projectedRuntimeSandboxId: "e2b-killed-log",
        reason: "killed_stale",
      });
      expect(result.outcome).toBe("cleared");

      const cleanupLog = consoleSpy.mock.calls
        .map(([payload]) => {
          try {
            return JSON.parse(String(payload)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.event === "sandbox.runtime.cleanup");
      expect(cleanupLog).toMatchObject({
        outcome: "cleared",
        reason_code: "terminated",
        cleanup_reason: "killed_stale",
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // ── R4: session_terminal FINAL-terminal reclaim (the reason-aware decision arms) ──
  // The DO re-decides live; `session_terminal` is the ONLY reason that overrides the running/paused arms.
  // Every OTHER reason keeps byte-identical behavior (proven by the untouched sibling tests above).

  it("session_terminal terminates a PAUSED VM even INSIDE the 72h retention window (paused_expired would skip)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    // Retention window is still open — the ordinary paused_expired sweep would `skipped_not_expired`.
    seedRuntime(state, {
      runtimeState: "paused",
      stateExpiresAt: Date.now() + 60 * 60 * 1000,
      sandboxId: "e2b-term-1",
    });
    sandboxMock.kill.mockResolvedValue(true);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-term-1", reason: "session_terminal" });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_provider).toBeNull();
    expect(sandbox?.runtime_sandbox_id).toBeNull();
  });

  it("byte-identical guard: the SAME unexpired paused row under paused_expired still skips (reason-scoped override)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "paused",
      stateExpiresAt: Date.now() + 60 * 60 * 1000,
      sandboxId: "e2b-term-2",
    });

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-term-2", reason: "paused_expired" });

    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_not_expired" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  it("session_terminal terminates an IDLE running VM (no active prompt, no pending dispatch)", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    // Fresh live lease + recent activity — the ordinary sweep would pause/skip, never terminate.
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: Date.now() + 60 * 60 * 1000,
      lastActivityAt: Date.now(),
      sandboxId: "e2b-term-3",
    });
    sandboxMock.kill.mockResolvedValue(true);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-term-3", reason: "session_terminal" });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
    expect(sandboxMock.pause).not.toHaveBeenCalled();
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_provider).toBeNull();
  });

  it("session_terminal NEVER yanks a live turn: a running VM with an active prompt skips WITHOUT a lease refresh", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    const lease = Date.now() - 60 * 60 * 1000; // EXPIRED — the normal running arm would pause; R4 must NOT refresh it
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: lease,
      lastActivityAt: null,
      sandboxId: "e2b-term-4",
    });
    // An in-flight SUPERSEDED follow-up turn is processing — do not yank it.
    seedPrompt(state.storage, {
      sessionId: SESSION_ID,
      promptId: "prompt-live",
      promptText: "follow-up",
      status: "processing",
    });

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-term-4", reason: "session_terminal" });

    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_live_activity" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    const sandbox = querySandboxState(state.storage, SESSION_ID);
    expect(sandbox?.runtime_state).toBe("running");
    // The R4 contract: this skip must NOT extend retention — the (expired) lease is left untouched.
    expect(sandbox?.runtime_live_lease_expires_at).toBe(lease);
  });

  it("session_terminal NEVER yanks a queued turn: a running VM with pendingPromptDispatch skips", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: Date.now() - 60 * 60 * 1000,
      lastActivityAt: null,
      sandboxId: "e2b-term-5",
    });
    state.storage.sql.exec("UPDATE sandbox_state SET pending_prompt_dispatch = 1 WHERE session_id = ?", SESSION_ID);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-term-5", reason: "session_terminal" });

    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_live_activity" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
  });

  it("session_terminal terminates a killed-state row via the existing malformed/unknown fallthrough", async () => {
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, { runtimeState: "killed", stateExpiresAt: Date.now(), sandboxId: "e2b-term-6" });
    sandboxMock.kill.mockResolvedValue(true);

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-term-6", reason: "session_terminal" });

    expect(result).toMatchObject({ outcome: "cleared", reasonCode: "terminated" });
    expect(sandboxMock.kill).toHaveBeenCalledTimes(1);
  });

  it("SUPERSEDED follow-up convergence: a session_terminal run against a sandbox-changed row skips (ownership CAS fences it)", async () => {
    // A newer runtime attached between the FSM decide and this run — the ownership guard must fence the
    // terminate so it never reclaims the live successor VM.
    const env = createCleanupEnv();
    const { state, instance } = newInstance(env, workerModule);
    seedRuntime(state, {
      runtimeState: "running",
      liveLeaseExpiresAt: Date.now() - 1_000,
      sandboxId: "e2b-new-vm",
    });

    const result = await runCleanup(instance, { projectedRuntimeSandboxId: "e2b-old-vm", reason: "session_terminal" });

    expect(result).toMatchObject({ outcome: "skipped", reasonCode: "skipped_sandbox_changed" });
    expect(sandboxMock.kill).not.toHaveBeenCalled();
    expect(querySandboxState(state.storage, SESSION_ID)?.runtime_sandbox_id).toBe("e2b-new-vm");
  });

  it("threads cleanup_reason=session_terminal into the sandbox.runtime.cleanup outcome log (terminate attribution)", async () => {
    // The request reason threads end to end; the DD `runtime.terminate` event's reason facet is derived
    // from the same value (enforced by the exhaustive runtimeTerminateSource switch + the executor test).
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const env = createCleanupEnv({ LOG_LEVEL: "info" });
      const { state, instance } = newInstance(env, workerModule);
      seedRuntime(state, {
        runtimeState: "paused",
        stateExpiresAt: Date.now() + 60 * 60 * 1000,
        sandboxId: "e2b-term-log",
      });
      sandboxMock.kill.mockResolvedValue(true);

      const result = await runCleanup(instance, {
        projectedRuntimeSandboxId: "e2b-term-log",
        reason: "session_terminal",
      });
      expect(result.outcome).toBe("cleared");

      const cleanupLog = consoleSpy.mock.calls
        .map(([payload]) => {
          try {
            return JSON.parse(String(payload)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.event === "sandbox.runtime.cleanup");
      expect(cleanupLog).toMatchObject({
        outcome: "cleared",
        reason_code: "terminated",
        cleanup_reason: "session_terminal",
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("rejects an unauthenticated cleanup-run call", async () => {
    const env = createCleanupEnv();
    const { instance } = newInstance(env, workerModule);
    const res = await instance.fetch(
      new Request("https://session.internal/internal/runtime/e2b/cleanup-run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          projectedRuntimeSandboxId: "e2b-1",
          projectedRuntimeBackend: CLOUD,
          reason: "paused_expired",
          nowMs: Date.now(),
        }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
