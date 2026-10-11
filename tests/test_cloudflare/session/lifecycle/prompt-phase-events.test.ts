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
    if (decision.patch.prompt) next.prompt = { ...next.prompt, ...decision.patch.prompt };
    if (decision.patch.deadlines) next.deadlines = { ...next.deadlines, ...decision.patch.deadlines };
  }
  return next;
}

const config = defaultLifecycleConfig({ startupTimeoutMs: 180_000, runningInactivityMs: 900_000 });

describe("lifecycle prompt phase events", () => {
  it("tracks bridge acceptance, dispatch progress, and Codex prompt sent", () => {
    let state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "queued", promptId: "p-1" };
    state.sandbox = { ...state.sandbox, sandboxId: "sbx-1" };

    state = apply(
      state,
      reduceLifecycle(state, { type: "prompt.sent_to_bridge", promptId: "p-1", sandboxId: "sbx-1" }, config, 0),
    );
    state = apply(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.bridge_accepted", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-1" },
        config,
        10,
      ),
    );
    expect(state.prompt.phase).toBe("dispatching");
    expect(state.prompt.startupAttemptId).toBe("start-1");
    expect(state.prompt.bridgeAcceptedAt).toBe(10);
    expect(state.deadlines.promptStartup).toBe(180_000);

    state = apply(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.dispatching_progress", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-1" },
        config,
        20,
      ),
    );
    expect(state.prompt.phase).toBe("dispatching");
    expect(state.deadlines.promptStartup).toBe(180_000);

    state = apply(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.agent_prompt_sent", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-1" },
        config,
        30,
      ),
    );
    expect(state.prompt.phase).toBe("dispatching");
    expect(state.prompt.codexPromptSentAt).toBe(30);
    expect(state.deadlines.promptStartup).toBeNull();
    expect(state.deadlines.promptDispatch).toBe(180_030);
    expect(state.deadlines.promptRunningInactivity).toBeNull();

    state = apply(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.running_activity", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-1" },
        config,
        40,
      ),
    );
    expect(state.prompt.phase).toBe("running");
    expect(state.deadlines.promptDispatch).toBeNull();
    expect(state.deadlines.promptRunningInactivity).toBe(900_040);
  });

  it("rejects stale startup attempt progress", () => {
    const state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "dispatching",
      promptId: "p-1",
      sandboxId: "sbx-1",
      startupAttemptId: "start-1",
    };
    state.sandbox = { ...state.sandbox, sandboxId: "sbx-1" };

    expect(
      reduceLifecycle(
        state,
        { type: "prompt.dispatching_progress", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-2" },
        config,
        20,
      ),
    ).toEqual([{ action: "noop", reason: "stale startup attempt" }]);
  });
});

describe("ARC-1196 liveness watchdog survives prompt terminal", () => {
  function runningState(sandboxState: LifecycleState["sandbox"]["state"]): LifecycleState {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "running", promptId: "p-1" };
    state.sandbox = { ...state.sandbox, state: sandboxState, sandboxId: "sbx-1" };
    state.deadlines = { ...state.deadlines, sandboxLiveness: 500, promptRunningInactivity: 900 };
    return state;
  }

  it("re-arms sandbox liveness on successful prompt terminal while the sandbox is ready", () => {
    const decisions = reduceLifecycle(
      runningState("ready"),
      { type: "prompt.terminal_received", promptId: "p-1", sandboxId: "sbx-1" },
      config,
      1_000,
    );
    const state = apply(runningState("ready"), decisions);
    expect(state.prompt.phase).toBe("terminal");
    expect(state.deadlines.sandboxLiveness).toBe(1_000 + config.sandboxLivenessMs);
    expect(state.deadlines.promptRunningInactivity).toBeNull();
    expect(decisions.some((decision) => decision.action === "arm_alarm")).toBe(true);
  });

  it("re-arms sandbox liveness on errored prompt terminal while the sandbox is reconnecting", () => {
    const decisions = reduceLifecycle(
      runningState("reconnecting"),
      { type: "prompt.terminal_received", promptId: "p-1", sandboxId: "sbx-1", errorCode: "stale_prompt" },
      config,
      1_000,
    );
    const state = apply(runningState("reconnecting"), decisions);
    expect(state.prompt.phase).toBe("terminal");
    expect(state.deadlines.sandboxLiveness).toBe(1_000 + config.sandboxLivenessMs);
    expect(decisions.some((decision) => decision.action === "arm_alarm")).toBe(true);
    expect(decisions.some((decision) => decision.action === "emit_terminal")).toBe(true);
  });

  it("still clears sandbox liveness on prompt terminal when the sandbox is not alive", () => {
    const decisions = reduceLifecycle(
      runningState("stopped"),
      { type: "prompt.terminal_received", promptId: "p-1", sandboxId: "sbx-1" },
      config,
      1_000,
    );
    const state = apply(runningState("stopped"), decisions);
    expect(state.prompt.phase).toBe("terminal");
    expect(state.deadlines.sandboxLiveness).toBeNull();
  });

  it("keeps clearing liveness for watchdog-driven terminals (liveness expiry path)", () => {
    const state = runningState("ready");
    const decisions = reduceLifecycle(state, { type: "sandbox.liveness_expired", sandboxId: "sbx-1" }, config, 1_000);
    const next = apply(state, decisions);
    expect(next.deadlines.sandboxLiveness).toBeNull();
  });
});
