import { describe, expect, it } from "vitest";

import { defaultLifecycleConfig } from "../../../../apps/control-plane-worker/src/session/lifecycle/deadlines";
import { reduceLifecycle } from "../../../../apps/control-plane-worker/src/session/lifecycle/reducer";
import {
  createEmptyLifecycleState,
  type LifecycleState,
} from "../../../../apps/control-plane-worker/src/session/lifecycle/types";

function apply(state: LifecycleState, decisions: ReturnType<typeof reduceLifecycle>): LifecycleState {
  const next = structuredClone(state) as LifecycleState;
  for (const decision of decisions) {
    if (decision.action !== "persist_state") continue;
    if (decision.patch.sandbox) next.sandbox = { ...next.sandbox, ...decision.patch.sandbox };
    if (decision.patch.prompt) next.prompt = { ...next.prompt, ...decision.patch.prompt };
    if (decision.patch.deadlines) next.deadlines = { ...next.deadlines, ...decision.patch.deadlines };
  }
  return next;
}

const config = defaultLifecycleConfig({
  spawnFailureCircuitLimit: 2,
  spawnFailureResetMs: 600_000,
  spawnTimeoutMs: 180_000,
});

describe("lifecycle spawn resilience", () => {
  it("opens and resets the spawn failure circuit", () => {
    let state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "queued", promptId: "p-1" };

    state = apply(
      state,
      reduceLifecycle(state, { type: "sandbox.spawn_requested", startupAttemptId: "s-1" }, config, 0),
    );
    state = apply(
      state,
      reduceLifecycle(
        state,
        { type: "sandbox.spawn_failed", startupAttemptId: "s-1", errorCode: "spawn_timeout" },
        config,
        10,
      ),
    );
    expect(state.sandbox.spawnFailureCount).toBe(1);

    state = apply(
      state,
      reduceLifecycle(state, { type: "sandbox.spawn_requested", startupAttemptId: "s-2" }, config, 20),
    );
    state = apply(
      state,
      reduceLifecycle(
        state,
        { type: "sandbox.spawn_failed", startupAttemptId: "s-2", errorCode: "spawn_timeout" },
        config,
        30,
      ),
    );
    expect(state.sandbox.spawnFailureCount).toBe(2);

    const circuitOpen = reduceLifecycle(
      state,
      { type: "sandbox.spawn_requested", startupAttemptId: "s-3" },
      config,
      40,
    );
    expect(circuitOpen).toEqual([{ action: "noop", reason: "spawn circuit open" }]);

    const reset = reduceLifecycle(state, { type: "sandbox.spawn_requested", startupAttemptId: "s-4" }, config, 600_031);
    expect(reset.some((decision) => decision.action === "spawn_sandbox")).toBe(true);
    state = apply(state, reset);
    expect(state.sandbox.spawnFailureCount).toBe(0);
  });

  it("ignores stale startup attempt results", () => {
    const state = createEmptyLifecycleState();
    state.sandbox = { ...state.sandbox, state: "spawning", startupAttemptId: "current", spawnInProgress: true };

    expect(
      reduceLifecycle(
        state,
        { type: "sandbox.spawn_succeeded", startupAttemptId: "old", sandboxId: "sbx-old" },
        config,
        1,
      ),
    ).toEqual([{ action: "noop", reason: "stale spawn succeeded" }]);
    expect(
      reduceLifecycle(
        state,
        { type: "sandbox.spawn_failed", startupAttemptId: "old", errorCode: "spawn_timeout" },
        config,
        1,
      ),
    ).toEqual([{ action: "noop", reason: "stale spawn failed" }]);
  });
});
