import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../../apps/control-plane-worker/src/types";

const mocks = vi.hoisted(() => ({
  clearRuntimeState: vi.fn(),
  syncRuntimeProjection: vi.fn(async (..._args: unknown[]) => undefined),
  syncRuntimeProjectionChecked: vi.fn(async (..._args: unknown[]) => "applied" as const),
  updateSandboxState: vi.fn(),
  postStructuredEventToDd: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock("../../../apps/control-plane-worker/src/session/do-db.ts", () => ({
  clearRuntimeState: (...args: unknown[]) => mocks.clearRuntimeState(...args),
  updateSandboxState: (...args: unknown[]) => mocks.updateSandboxState(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/services/session-projection.ts", () => ({
  syncRuntimeProjection: (...args: unknown[]) => mocks.syncRuntimeProjection(...args),
  syncRuntimeProjectionChecked: (...args: unknown[]) => mocks.syncRuntimeProjectionChecked(...args),
}));

vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter.ts", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mocks.postStructuredEventToDd(...args),
}));

import {
  abortIfStaleSpawnAttempt,
  buildBridgeStartupDiagnosticsEvent,
  buildResumeFailureClearDecisionEvent,
  buildSandboxResumeWallEvent,
  clearRuntimeAndSyncProjection,
  decideResumeFailureClear,
  emitRuntimeTerminateEvent,
  runtimeTerminateSource,
  terminateRuntimeWithLog,
  writeRunningRuntimeState,
} from "../../../apps/control-plane-worker/src/session/e2b-runtime-lifecycle.ts";

function createMockEnv(): Pick<Env, "DB"> {
  return { DB: {} as D1Database };
}

function createDdEnv(): Pick<Env, "DD_API_KEY" | "WORKER_ENV"> {
  return { DD_API_KEY: "dd-key", WORKER_ENV: "production" } as Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
}

describe("e2b runtime lifecycle helpers", () => {
  beforeEach(() => {
    mocks.clearRuntimeState.mockReset();
    mocks.syncRuntimeProjection.mockReset();
    mocks.syncRuntimeProjection.mockResolvedValue(undefined);
    mocks.syncRuntimeProjectionChecked.mockReset();
    mocks.syncRuntimeProjectionChecked.mockResolvedValue("applied");
    mocks.updateSandboxState.mockReset();
    mocks.postStructuredEventToDd.mockReset();
    mocks.postStructuredEventToDd.mockResolvedValue(true);
  });

  it("runs stale-attempt cleanup exactly once before logging", async () => {
    const events: string[] = [];
    const logger = {
      info: vi.fn(() => {
        events.push("log");
      }),
    };

    const stale = await abortIfStaleSpawnAttempt({
      sessionId: "sess-1",
      spawnAttemptId: "attempt-1",
      runtimeSandboxId: "sbx-1",
      logger,
      message: "stale attempt",
      isCurrentSpawnAttempt: vi.fn(async () => false),
      onStale: async () => {
        events.push("cleanup");
      },
    });

    expect(stale).toBe(true);
    expect(events).toEqual(["cleanup", "log"]);
    expect(logger.info).toHaveBeenCalledWith(
      { sessionId: "sess-1", spawnAttemptId: "attempt-1", runtimeSandboxId: "sbx-1" },
      "stale attempt",
    );
  });

  it("skips stale handling when the attempt is still current", async () => {
    const logger = { info: vi.fn() };
    const onStale = vi.fn();

    const stale = await abortIfStaleSpawnAttempt({
      sessionId: "sess-1",
      spawnAttemptId: "attempt-1",
      logger,
      message: "stale attempt",
      isCurrentSpawnAttempt: vi.fn(async () => true),
      onStale,
    });

    expect(stale).toBe(false);
    expect(onStale).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("logs terminate failures with the originating reason without throwing", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    await terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "bridge_start_failed",
      logger,
      message: "terminate failed",
      extraLogFields: { spawnAttemptId: "attempt-1" },
      terminate: async () => {
        throw new Error("boom");
      },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: "runtime.terminate_failed",
        sessionId: "sess-1",
        runtimeSandboxId: "sbx-1",
        reason: "bridge_start_failed",
        spawnAttemptId: "attempt-1",
        error: "Error: boom",
      },
      "terminate failed",
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("forwards the reason to terminate and logs a session-tagged success", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const terminate = vi.fn(async () => ({ status: "killed" as const }));

    await terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "orphan_reaper",
      logger,
      message: "terminate failed",
      terminate,
    });

    // The reason is forwarded so the chokepoint log is tagged consistently...
    expect(terminate).toHaveBeenCalledWith("orphan_reaper");
    // ...and a success is logged (the old behavior logged nothing on success, so
    // a healthy reaped VM left no session-queryable record).
    expect(logger.info).toHaveBeenCalledWith(
      {
        event: "runtime.terminate",
        sessionId: "sess-1",
        runtimeSandboxId: "sbx-1",
        reason: "orphan_reaper",
        terminateOutcome: "killed",
      },
      "Terminated sandbox runtime",
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("records terminateOutcome=missing when the sandbox was already gone", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    // terminateSandbox swallows a 404 as { status: "missing" } rather than
    // throwing; the success log must distinguish that from a real kill.
    const terminate = vi.fn(async () => ({ status: "missing" as const }));

    await terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "resume_failure_cleanup",
      logger,
      message: "terminate failed",
      terminate,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "runtime.terminate",
        reason: "resume_failure_cleanup",
        terminateOutcome: "missing",
      }),
      "Terminated sandbox runtime",
    );
  });

  it("clears runtime state and syncs the cleared projection", async () => {
    const env = createMockEnv();

    await clearRuntimeAndSyncProjection({
      sql: {} as SqlStorage,
      env: env as Env,
      sessionId: "sess-1",
      expectedProvider: "e2b",
    });

    expect(mocks.clearRuntimeState).toHaveBeenCalledWith({}, "sess-1", "e2b");
    expect(mocks.syncRuntimeProjection).toHaveBeenCalledWith(env, "sess-1", {
      runtimeProvider: null,
      runtimeBackend: null,
      runtimeState: null,
      runtimeSandboxId: null,
      runtimeTemplateId: null,
      runtimeStateExpiresAt: null,
      runtimeLiveLeaseExpiresAt: null,
      runtimePreviewUrl: null,
      runtimeCreatedAt: null,
      runtimeLastResumedAt: null,
      runtimeLastPausedAt: null,
      runtimeLastProviderRefreshedAt: null,
      runtimeProviderTtlExpiresAt: null,
    });
  });

  it("writes running runtime state without syncing projection when disabled", async () => {
    const env = createMockEnv();
    const sandboxState = { runtimeState: "running" as const, sandboxId: "sandbox-1" };
    const runtimeState = { runtimeProvider: "e2b" as const, runtimeState: "running" as const };

    await writeRunningRuntimeState({
      sql: {} as SqlStorage,
      env: env as Env,
      sessionId: "sess-1",
      sandboxState,
      runtimeState,
      syncProjection: false,
    });

    expect(mocks.updateSandboxState).toHaveBeenCalledWith({}, "sess-1", sandboxState);
    expect(mocks.syncRuntimeProjection).not.toHaveBeenCalled();
    expect(mocks.syncRuntimeProjectionChecked).not.toHaveBeenCalled();
  });

  it("uses the checked (non-throwing) projection on the attach path so a missing row never fails the spawn", async () => {
    const env = createMockEnv();
    const sandboxState = { runtimeState: "running" as const, sandboxId: "sandbox-1" };
    const runtimeState = { runtimeProvider: "e2b" as const, runtimeState: "running" as const };

    await writeRunningRuntimeState({
      sql: {} as SqlStorage,
      env: env as Env,
      sessionId: "sess-1",
      sandboxState,
      runtimeState,
    });

    expect(mocks.updateSandboxState).toHaveBeenCalledWith({}, "sess-1", sandboxState);
    // The attach path must NOT use the throwing syncRuntimeProjection (a throw is
    // caught by the cold-spawn/warm-pool catch and terminates the healthy VM).
    expect(mocks.syncRuntimeProjection).not.toHaveBeenCalled();
    expect(mocks.syncRuntimeProjectionChecked).toHaveBeenCalledWith(env, "sess-1", runtimeState, expect.any(Object));
  });
});

describe("runtime kill-path read channel (arm 3)", () => {
  beforeEach(() => {
    mocks.postStructuredEventToDd.mockReset();
    mocks.postStructuredEventToDd.mockResolvedValue(true);
  });

  it("direct-posts a readable runtime.terminate event with reason+source+outcome on success", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "orphan_reaper",
      logger,
      message: "terminate failed",
      terminate: async () => ({ status: "killed" as const }),
    });

    // The wrapper now returns the outcome so status-consuming callers (idle
    // cleanup, reaper) can migrate onto it.
    expect(result).toEqual({ status: "killed" });
    // The kill is queryable in Datadog (plain logger.* is not exported).
    expect(mocks.postStructuredEventToDd).toHaveBeenCalledTimes(1);
    expect(mocks.postStructuredEventToDd).toHaveBeenCalledWith(expect.anything(), {
      event: "runtime.terminate",
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "orphan_reaper",
      source: "reaper",
      terminateOutcome: "killed",
    });
  });

  it("posts terminateOutcome=error and returns {status:error} when terminate throws", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    const result = await terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: null,
      runtimeSandboxId: "sbx-1",
      reason: "orphan_reaper",
      logger,
      message: "terminate failed",
      terminate: async () => {
        throw new Error("boom");
      },
    });

    expect(result).toEqual({ status: "error" });
    expect(mocks.postStructuredEventToDd).toHaveBeenCalledWith(expect.anything(), {
      event: "runtime.terminate",
      sessionId: null,
      runtimeSandboxId: "sbx-1",
      reason: "orphan_reaper",
      source: "reaper",
      terminateOutcome: "error",
    });
  });

  it("hands the post to waitUntil (off the kill path) instead of awaiting inline when provided", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const waitUntil = vi.fn();
    // A post that never settles would hang the terminate if awaited inline.
    mocks.postStructuredEventToDd.mockReturnValue(new Promise(() => {}));

    const result = await terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "runtime_cleanup",
      logger,
      message: "terminate failed",
      terminate: async () => ({ status: "killed" as const }),
      waitUntil,
    });

    expect(result).toEqual({ status: "killed" });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it("awaits the readable post inline when no waitUntil is provided (no fire-and-forget drop)", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    // Without a waitUntil, a cron/queue caller must not return before the post
    // is delivered, or the Workers handler can drop it and lose the event.
    let resolvePost: (value: boolean) => void = () => {};
    mocks.postStructuredEventToDd.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePost = resolve;
      }),
    );

    let settled = false;
    const call = terminateRuntimeWithLog({
      env: createDdEnv(),
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      reason: "orphan_reaper",
      logger,
      message: "terminate failed",
      terminate: async () => ({ status: "killed" as const }),
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePost(true);
    await expect(call).resolves.toEqual({ status: "killed" });
    expect(settled).toBe(true);
  });

  it("emitRuntimeTerminateEvent never rejects even if the post fails", async () => {
    mocks.postStructuredEventToDd.mockRejectedValue(new Error("dd down"));

    await expect(
      emitRuntimeTerminateEvent({
        env: createDdEnv(),
        sessionId: "sess-1",
        runtimeSandboxId: "sbx-1",
        reason: "runtime_cleanup",
        terminateOutcome: "killed",
      }),
    ).resolves.toBeUndefined();
  });

  it("maps every terminate reason to a coarse source facet", () => {
    expect(runtimeTerminateSource("orphan_reaper")).toBe("reaper");
    expect(runtimeTerminateSource("runtime_cleanup")).toBe("cleanup");
    expect(runtimeTerminateSource("duplicate_spawn_retry")).toBe("spawn");
    expect(runtimeTerminateSource("cold_create_unusable")).toBe("spawn");
    expect(runtimeTerminateSource("bridge_start_failed")).toBe("spawn");
    expect(runtimeTerminateSource("stale_spawn_after_bridge")).toBe("spawn");
    expect(runtimeTerminateSource("resume_failure_cleanup")).toBe("resume");
    expect(runtimeTerminateSource("resume_stale_cleanup")).toBe("resume");
    expect(runtimeTerminateSource("sandbox_layer_smoke")).toBe("layer");
  });
});

describe("decideResumeFailureClear", () => {
  it("skips clear when a newer attempt superseded the runtime row", () => {
    expect(decideResumeFailureClear({ stillOurs: false, liveness: "dead" })).toBe("skip_superseded");
    expect(decideResumeFailureClear({ stillOurs: false, liveness: "unknown" })).toBe("skip_superseded");
  });

  it("skips clear when the probe affirms the VM is still alive", () => {
    expect(decideResumeFailureClear({ stillOurs: true, liveness: "alive" })).toBe("skip_live");
  });

  it("clears when the runtime is still ours and confirmed dead or unknown", () => {
    expect(decideResumeFailureClear({ stillOurs: true, liveness: "dead" })).toBe("clear");
    expect(decideResumeFailureClear({ stillOurs: true, liveness: "unknown" })).toBe("clear");
  });
});

describe("buildResumeFailureClearDecisionEvent (E1 read channel)", () => {
  it("carries the decision, liveness, ownership, and ids under the queryable event name", () => {
    expect(
      buildResumeFailureClearDecisionEvent({
        sessionId: "sess-1",
        runtimeSandboxId: "sbx-1",
        decision: "skip_live",
        liveness: "alive",
        stillOurs: true,
      }),
    ).toEqual({
      event: "resume_failure_clear_decision",
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      decision: "skip_live",
      liveness: "alive",
      stillOurs: true,
    });
  });
});

describe("buildSandboxResumeWallEvent", () => {
  it("carries resume wall time with low-cardinality outcome and error fields", () => {
    expect(
      buildSandboxResumeWallEvent({
        sessionId: "sess-1",
        runtimeSandboxId: "sbx-1",
        runtimeBackend: "e2b_cloud",
        operation: "spawnSandbox.resume.live",
        resumeWallMs: 123.4,
        outcome: "failed",
        errorClass: "missing_sandbox",
      }),
    ).toEqual({
      event: "sandbox.resume_wall",
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      runtime_backend: "e2b_cloud",
      operation: "spawnSandbox.resume.live",
      resume_wall_ms: 123,
      outcome: "failed",
      error_class: "missing_sandbox",
    });
  });

  it("omits error_class on successful resumes", () => {
    expect(
      buildSandboxResumeWallEvent({
        sessionId: "sess-1",
        runtimeSandboxId: "sbx-1",
        runtimeBackend: "e2b_cloud",
        operation: "spawnSandbox.resume.live",
        resumeWallMs: -1,
        outcome: "resumed",
        errorClass: null,
      }),
    ).toEqual({
      event: "sandbox.resume_wall",
      sessionId: "sess-1",
      runtimeSandboxId: "sbx-1",
      runtime_backend: "e2b_cloud",
      operation: "spawnSandbox.resume.live",
      resume_wall_ms: 0,
      outcome: "resumed",
    });
  });
});

describe("buildBridgeStartupDiagnosticsEvent (E2 read channel)", () => {
  it("reuses the existing event name and adds outcome/status plus camelCase facets", () => {
    expect(
      buildBridgeStartupDiagnosticsEvent({
        outcome: "collected",
        sessionId: "sess-2",
        runtimeSandboxId: "sbx-2",
        reason: "bridge_connect_deadline",
        exitCode: 0,
        stdout: "diag stdout",
        stderr: "diag stderr",
      }),
    ).toEqual({
      event: "sandbox.bridge_startup_diagnostics",
      outcome: "collected",
      status: "collected",
      sessionId: "sess-2",
      runtimeSandboxId: "sbx-2",
      reason: "bridge_connect_deadline",
      exitCode: 0,
      stdout: "diag stdout",
      stderr: "diag stderr",
    });
  });

  it("allows a null sandbox id and null exit code on the skipped/failed paths without diagnostic keys", () => {
    const event = buildBridgeStartupDiagnosticsEvent({
      outcome: "skipped",
      sessionId: "sess-3",
      runtimeSandboxId: null,
      reason: "not_e2b",
      exitCode: null,
    });

    expect(event).toEqual({
      event: "sandbox.bridge_startup_diagnostics",
      outcome: "skipped",
      status: "skipped",
      sessionId: "sess-3",
      runtimeSandboxId: null,
      reason: "not_e2b",
      exitCode: null,
    });
    expect(event).not.toHaveProperty("stdout");
    expect(event).not.toHaveProperty("stderr");
  });

  it("carries stderr without stdout on the failed path", () => {
    expect(
      buildBridgeStartupDiagnosticsEvent({
        outcome: "failed",
        sessionId: "sess-3",
        runtimeSandboxId: "sbx-3",
        reason: "run_failed",
        exitCode: null,
        stderr: "Error: denied",
      }),
    ).toEqual({
      event: "sandbox.bridge_startup_diagnostics",
      outcome: "failed",
      status: "failed",
      sessionId: "sess-3",
      runtimeSandboxId: "sbx-3",
      reason: "run_failed",
      exitCode: null,
      stderr: "Error: denied",
    });
  });
});
