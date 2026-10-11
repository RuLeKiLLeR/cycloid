import { describe, expect, it } from "vitest";

import { defaultLifecycleConfig } from "../../../../apps/control-plane-worker/src/session/lifecycle/deadlines";
import { reduceLifecycle } from "../../../../apps/control-plane-worker/src/session/lifecycle/reducer";
import {
  createEmptyLifecycleState,
  type LifecycleDecision,
  type LifecycleState,
} from "../../../../apps/control-plane-worker/src/session/lifecycle/types";

const config = defaultLifecycleConfig({
  startupTimeoutMs: 180_000,
  runningInactivityMs: 900_000,
  sandboxLivenessMs: 900_000,
  sandboxReconnectGraceMs: 90_000,
  spawnTimeoutMs: 180_000,
  spawnFailureCircuitLimit: 2,
});

function activeStateWithDeadlines(): LifecycleState {
  const state = createEmptyLifecycleState();
  state.sandbox.state = "ready";
  state.sandbox.sandboxId = "sbx-1";
  state.deadlines = {
    sandboxReconnectGrace: 1000,
    sandboxLiveness: 2000,
    promptStartup: 3000,
    promptDispatch: 4000,
    promptRunningInactivity: 5000,
    spawnTimeout: 6000,
  };
  return state;
}

function findFinalize(decisions: LifecycleDecision[]) {
  return decisions.find((d): d is Extract<LifecycleDecision, { action: "finalize_sandbox_stopped" }> => {
    return d.action === "finalize_sandbox_stopped";
  });
}

const expectedClearedDeadlines = {
  sandboxReconnectGrace: null,
  sandboxLiveness: null,
  spawnTimeout: null,
  promptStartup: null,
  promptDispatch: null,
  promptRunningInactivity: null,
};

describe("boundary lifecycle events", () => {
  it("stop_finalize emits a single finalize decision carrying the patch", () => {
    const state = activeStateWithDeadlines();
    const decisions = reduceLifecycle(
      state,
      { type: "boundary.stop_finalize", stopReason: "user", reason: "user_stop" },
      config,
      100,
    );

    // Single decision so the applier can perform the DO-storage patch and the
    // D1 sandbox_state write atomically — emitting a separate persist_state
    // would broadcast a transient "stopped_resumable" before stopReason lands.
    expect(decisions).toHaveLength(1);
    const finalize = findFinalize(decisions);
    expect(finalize?.stopReason).toBe("user");
    expect(finalize?.reason).toBe("user_stop");
    expect(finalize?.preserveExistingStopReason).toBe(false);
    expect(finalize?.patch.sandbox?.state).toBe("stopped");
    expect(finalize?.patch.sandbox?.spawnInProgress).toBe(false);
    expect(finalize?.patch.deadlines).toEqual(expectedClearedDeadlines);
  });

  it("stop_finalize preserves resumable stopReason variants", () => {
    const state = activeStateWithDeadlines();

    const reaped = reduceLifecycle(
      state,
      { type: "boundary.stop_finalize", stopReason: "reaped", reason: "sandbox_disconnected" },
      config,
      100,
    );
    expect(findFinalize(reaped)?.stopReason).toBe("reaped");

    const pushFailed = reduceLifecycle(
      state,
      { type: "boundary.stop_finalize", stopReason: null, reason: "publish_push_failed" },
      config,
      100,
    );
    expect(findFinalize(pushFailed)?.stopReason).toBeNull();
  });

  it("transport_stop_finalize sets preserveExistingStopReason so the applier keeps a prior 'user' stopReason", () => {
    const state = activeStateWithDeadlines();
    const decisions = reduceLifecycle(
      state,
      { type: "boundary.transport_stop_finalize", stopReason: "reaped", reason: "sandbox_ws_closed" },
      config,
      100,
    );

    expect(decisions).toHaveLength(1);
    const finalize = findFinalize(decisions);
    expect(finalize?.stopReason).toBe("reaped");
    expect(finalize?.preserveExistingStopReason).toBe(true);
    expect(finalize?.patch.sandbox?.state).toBe("stopped");
    expect(finalize?.patch.deadlines).toEqual(expectedClearedDeadlines);
  });

  it("transport_stop_finalize bypasses the archived no-op", () => {
    const state = activeStateWithDeadlines();
    state.sessionStatus = "archived";
    const decisions = reduceLifecycle(
      state,
      { type: "boundary.transport_stop_finalize", stopReason: "reaped", reason: "sandbox_ws_closed" },
      config,
      100,
    );

    expect(decisions).toHaveLength(1);
    const finalize = findFinalize(decisions);
    expect(finalize?.stopReason).toBe("reaped");
    expect(finalize?.preserveExistingStopReason).toBe(true);
    expect(finalize?.patch.sandbox?.state).toBe("stopped");
    expect(finalize?.patch.deadlines).toEqual(expectedClearedDeadlines);
  });

  it("close_finalize emits a single finalize decision with stopReason=null", () => {
    const state = activeStateWithDeadlines();
    const decisions = reduceLifecycle(state, { type: "boundary.close_finalize", reason: "user_closed" }, config, 100);

    expect(decisions).toHaveLength(1);
    const finalize = findFinalize(decisions);
    expect(finalize?.stopReason).toBeNull();
    expect(finalize?.reason).toBe("user_closed");
    expect(finalize?.patch.sandbox?.state).toBe("stopped");
  });

  it("archived session no-ops events other than close_finalize", () => {
    const state = activeStateWithDeadlines();
    state.sessionStatus = "archived";

    const userStop = reduceLifecycle(
      state,
      { type: "boundary.stop_finalize", stopReason: "user", reason: "user_stop" },
      config,
      100,
    );
    expect(userStop).toEqual([{ action: "noop", reason: "session archived" }]);

    // close_finalize bypasses the archived no-op on purpose.
    const close = reduceLifecycle(state, { type: "boundary.close_finalize", reason: "user_closed" }, config, 100);
    expect(findFinalize(close)?.stopReason).toBeNull();
  });

  it("auto_close_scheduled emits a persist patch setting autoCloseScheduledAt to `now`", () => {
    const state = activeStateWithDeadlines();
    const decisions = reduceLifecycle(state, { type: "boundary.auto_close_scheduled" }, config, 1234);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: "persist_state",
      patch: { sandbox: { autoCloseScheduledAt: 1234 } },
    });
  });

  it("intentional_pause_close clears disconnectStartedAt + autoCloseScheduledAt without finalizing", () => {
    const state = activeStateWithDeadlines();
    const decisions = reduceLifecycle(state, { type: "boundary.intentional_pause_close" }, config, 100);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: "persist_state",
      patch: { sandbox: { disconnectStartedAt: null, autoCloseScheduledAt: null } },
    });
    // No finalize decision — intentional pause leaves sandbox.state alone.
    expect(findFinalize(decisions)).toBeUndefined();
  });

  it("intentional_pause_close bypasses the archived no-op", () => {
    const state = activeStateWithDeadlines();
    state.sessionStatus = "archived";
    const decisions = reduceLifecycle(state, { type: "boundary.intentional_pause_close" }, config, 100);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      action: "persist_state",
      patch: { sandbox: { disconnectStartedAt: null, autoCloseScheduledAt: null } },
    });
  });

  it("ws_disconnected patch includes disconnectStartedAt = now so the reducer owns the D1 marker", () => {
    const state = activeStateWithDeadlines();
    const decisions = reduceLifecycle(state, { type: "sandbox.ws_disconnected", sandboxId: "sbx-1" }, config, 5000);

    const persist = decisions.find((d) => d.action === "persist_state");
    expect(persist).toMatchObject({
      patch: { sandbox: { state: "reconnecting", disconnectStartedAt: 5000 } },
    });
  });

  it("ws_connected patch clears disconnectStartedAt + autoCloseScheduledAt", () => {
    const state = activeStateWithDeadlines();
    state.sandbox.state = "reconnecting";
    const decisions = reduceLifecycle(state, { type: "sandbox.ws_connected", sandboxId: "sbx-1" }, config, 6000);

    const persist = decisions.find((d) => d.action === "persist_state");
    expect(persist).toMatchObject({
      patch: { sandbox: { state: "ready", disconnectStartedAt: null, autoCloseScheduledAt: null } },
    });
  });
});
