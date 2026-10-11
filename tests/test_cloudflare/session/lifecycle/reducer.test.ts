import { describe, expect, it } from "vitest";

import { SANDBOX_HEARTBEAT_LIVENESS_MS } from "../../../../apps/control-plane-worker/src/constants/sessions";
import { defaultLifecycleConfig } from "../../../../apps/control-plane-worker/src/session/lifecycle/deadlines";
import { reduceLifecycle } from "../../../../apps/control-plane-worker/src/session/lifecycle/reducer";
import {
  createEmptyLifecycleState,
  type LifecycleState,
} from "../../../../apps/control-plane-worker/src/session/lifecycle/types";

function applyPatch(state: LifecycleState, decisions: ReturnType<typeof reduceLifecycle>): LifecycleState {
  const next = structuredClone(state) as LifecycleState;
  for (const decision of decisions) {
    if (decision.action !== "persist_state" && decision.action !== "finalize_sandbox_stopped") continue;
    if (decision.patch.sandbox) next.sandbox = { ...next.sandbox, ...decision.patch.sandbox };
    if (decision.patch.prompt) next.prompt = { ...next.prompt, ...decision.patch.prompt };
    if (decision.patch.reviewListening) {
      next.reviewListening = { ...next.reviewListening, ...decision.patch.reviewListening };
    }
    if (decision.patch.deadlines) next.deadlines = { ...next.deadlines, ...decision.patch.deadlines };
  }
  return next;
}

const config = defaultLifecycleConfig({
  startupTimeoutMs: 180_000,
  runningInactivityMs: 900_000,
  sandboxLivenessMs: 900_000,
  sandboxReconnectGraceMs: 90_000,
  spawnTimeoutMs: 180_000,
  spawnFailureCircuitLimit: 2,
});

describe("reduceLifecycle", () => {
  it("tracks normal prompt flow from dispatching to running to terminal", () => {
    let state = createEmptyLifecycleState();
    state = applyPatch(state, reduceLifecycle(state, { type: "prompt.enqueued", promptId: "p-1" }, config, 0));
    expect(state.prompt.phase).toBe("queued");

    state = applyPatch(state, reduceLifecycle(state, { type: "sandbox.ws_connected", sandboxId: "sbx-1" }, config, 1));
    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "prompt.sent_to_bridge", promptId: "p-1", sandboxId: "sbx-1" }, config, 2),
    );
    expect(state.prompt.phase).toBe("dispatching");
    expect(state.deadlines.promptStartup).toBe(180_002);

    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "prompt.agent_prompt_sent", promptId: "p-1", sandboxId: "sbx-1" }, config, 3),
    );
    expect(state.prompt.phase).toBe("dispatching");
    expect(state.deadlines.promptStartup).toBeNull();
    expect(state.deadlines.promptDispatch).toBe(180_003);
    expect(state.deadlines.promptRunningInactivity).toBeNull();

    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "prompt.running_activity", promptId: "p-1", sandboxId: "sbx-1" }, config, 4),
    );
    expect(state.prompt.phase).toBe("running");
    expect(state.deadlines.promptDispatch).toBeNull();
    expect(state.deadlines.promptRunningInactivity).toBe(900_004);

    const terminal = reduceLifecycle(
      state,
      { type: "prompt.terminal_received", promptId: "p-1", sandboxId: "sbx-1" },
      config,
      4,
    );
    state = applyPatch(state, terminal);
    expect(state.prompt.phase).toBe("terminal");
    // ARC-1196: prompt terminal over a live (ready) sandbox re-arms the
    // phase-independent liveness watchdog instead of clearing it.
    expect(state.deadlines.sandboxLiveness).toBe(4 + config.sandboxLivenessMs);
    expect(terminal.some((decision) => decision.action === "emit_terminal")).toBe(false);
  });

  it("defaults the sandbox liveness window to the heartbeat-liveness constant", () => {
    expect(defaultLifecycleConfig().sandboxLivenessMs).toBe(SANDBOX_HEARTBEAT_LIVENESS_MS);
  });

  it("arms sandbox liveness on ws_connected even without a running prompt", () => {
    let state = createEmptyLifecycleState();
    state = applyPatch(state, reduceLifecycle(state, { type: "sandbox.ws_connected", sandboxId: "sbx-1" }, config, 5));
    expect(state.sandbox.state).toBe("ready");
    expect(state.deadlines.sandboxLiveness).toBe(5 + config.sandboxLivenessMs);
  });

  it("re-arms sandbox liveness on heartbeat even without a running prompt", () => {
    let state = createEmptyLifecycleState();
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.sandboxLiveness = 100;
    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "sandbox.heartbeat_received", sandboxId: "sbx-1" }, config, 50),
    );
    expect(state.deadlines.sandboxLiveness).toBe(50 + config.sandboxLivenessMs);
  });

  it("does not let sandbox heartbeat prove prompt progress", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      sandboxId: "sbx-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.promptRunningInactivity = 100;

    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "sandbox.heartbeat_received", sandboxId: "sbx-1" }, config, 20),
    );

    expect(state.prompt.lastRunningActivityAt).toBe(10);
    expect(state.deadlines.promptRunningInactivity).toBe(100);
  });

  it("running keepalive extends the inactivity deadline while a tool is active", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      sandboxId: "sbx-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.promptRunningInactivity = 100;

    state = applyPatch(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.running_keepalive", promptId: "p-1", sandboxId: "sbx-1", activeToolCall: true },
        config,
        50,
      ),
    );

    expect(state.deadlines.promptRunningInactivity).toBe(50 + 900_000);
    // does not update lastRunningActivityAt (keepalive is not an activity signal)
    expect(state.prompt.lastRunningActivityAt).toBe(10);
  });

  it("running keepalive does not extend inactivity for plain model wait", () => {
    const state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      sandboxId: "sbx-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.promptRunningInactivity = 100;

    const decisions = reduceLifecycle(
      state,
      { type: "prompt.running_keepalive", promptId: "p-1", sandboxId: "sbx-1", activeToolCall: false },
      config,
      50,
    );

    expect(decisions).toEqual([{ action: "noop", reason: "model wait keepalive without active tool" }]);
  });

  it("running keepalive extends startup when prompt is still dispatching", () => {
    let state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "dispatching", promptId: "p-1", sandboxId: "sbx-1" };
    state.deadlines.promptStartup = 180_000;
    state.deadlines.promptRunningInactivity = null;

    state = applyPatch(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.running_keepalive", promptId: "p-1", sandboxId: "sbx-1", activeToolCall: false },
        config,
        50,
      ),
    );

    expect(state.prompt.bridgeAcceptedAt).toBe(50);
    expect(state.deadlines.promptStartup).toBe(180_000);
    expect(state.deadlines.promptRunningInactivity).toBeNull();
  });

  it("running keepalive is a no-op for a stale prompt id", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "running", promptId: "p-1", sandboxId: "sbx-1" };
    state.deadlines.promptRunningInactivity = 100;

    const decisions = reduceLifecycle(
      state,
      { type: "prompt.running_keepalive", promptId: "p-other", sandboxId: "sbx-1", activeToolCall: true },
      config,
      50,
    );

    expect(decisions).toEqual([{ action: "noop", reason: "stale running keepalive" }]);
  });

  it("running keepalive is a no-op for a mismatched sandbox", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "running", promptId: "p-1", sandboxId: "sbx-1" };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.promptRunningInactivity = 100;

    const decisions = reduceLifecycle(
      state,
      { type: "prompt.running_keepalive", promptId: "p-1", sandboxId: "sbx-other", activeToolCall: true },
      config,
      50,
    );

    expect(decisions).toEqual([{ action: "noop", reason: "mismatched sandbox for keepalive" }]);
  });

  it("clears spawn timeout when the sandbox websocket connects", () => {
    let state = createEmptyLifecycleState();
    state.sandbox = { ...state.sandbox, state: "spawning", startupAttemptId: "start-1", spawnInProgress: true };
    state.deadlines.spawnTimeout = 180_000;

    state = applyPatch(state, reduceLifecycle(state, { type: "sandbox.ws_connected", sandboxId: "sbx-1" }, config, 1));

    expect(state.sandbox).toMatchObject({
      state: "ready",
      sandboxId: "sbx-1",
      spawnInProgress: false,
    });
    expect(state.deadlines.spawnTimeout).toBeNull();
  });

  it("turns sandbox liveness expiry into a typed sandbox failure", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      sandboxId: "sbx-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.sandboxLiveness = 100;

    const decisions = reduceLifecycle(state, { type: "sandbox.liveness_expired", sandboxId: "sbx-1" }, config, 101);
    state = applyPatch(state, decisions);

    expect(state.sandbox.state).toBe("stopped");
    expect(state.deadlines.sandboxLiveness).toBeNull();
    expect(decisions).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "sandbox_disconnected",
      reason: "sandbox liveness expired",
    });
  });

  it("force-fails a pre-publish stall even when no sandbox identity exists", () => {
    const state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "reconnecting", sandboxId: null };
    state.deadlines = {
      sandboxReconnectGrace: 20,
      sandboxLiveness: null,
      promptStartup: 30,
      promptDispatch: 40,
      promptRunningInactivity: 50,
      spawnTimeout: 60,
    };

    const decisions = reduceLifecycle(state, { type: "boundary.pre_publish_stall_expired" }, config, 100);
    const next = applyPatch(state, decisions);

    expect(next.sandbox).toMatchObject({ state: "failed", spawnInProgress: false });
    expect(next.prompt).toMatchObject({ phase: "terminal", terminalErrorCode: "sandbox_disconnected" });
    expect(next.deadlines).toEqual({
      sandboxReconnectGrace: null,
      sandboxLiveness: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: null,
      spawnTimeout: null,
    });
    expect(decisions).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "sandbox_disconnected",
      reason: "pre-publish stall backstop expired",
    });
  });

  it("moves an active prompt sandbox into reconnecting without terminalizing the prompt on websocket disconnect", () => {
    const state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      sandboxId: "sbx-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1", lastHeartbeatAt: 15 };
    state.deadlines = {
      ...state.deadlines,
      sandboxLiveness: 900_015,
      promptRunningInactivity: 900_010,
    };

    const decisions = reduceLifecycle(state, { type: "sandbox.ws_disconnected", sandboxId: "sbx-1" }, config, 20);
    const next = applyPatch(state, decisions);

    expect(next.sandbox).toMatchObject({ state: "reconnecting", disconnectStartedAt: 20 });
    expect(next.prompt.phase).toBe("running");
    expect(next.deadlines).toEqual({
      sandboxReconnectGrace: 20 + config.sandboxReconnectGraceMs,
      sandboxLiveness: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: 900_010,
      spawnTimeout: null,
    });
    expect(decisions).toContainEqual({
      action: "arm_alarm",
      deadlineAt: 20 + config.sandboxReconnectGraceMs,
      reason: "next lifecycle deadline",
    });
    expect(decisions.some((decision) => decision.action === "emit_terminal")).toBe(false);
  });

  it("arms reconnect grace without terminal output when a sandbox disconnects with no active prompt", () => {
    const state = createEmptyLifecycleState();
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1", lastHeartbeatAt: 15 };
    state.deadlines.sandboxLiveness = 900_015;

    const decisions = reduceLifecycle(state, { type: "sandbox.ws_disconnected", sandboxId: "sbx-1" }, config, 20);
    const next = applyPatch(state, decisions);

    expect(next.sandbox).toMatchObject({ state: "reconnecting", disconnectStartedAt: 20 });
    expect(next.prompt.phase).toBe("none");
    expect(next.deadlines).toEqual({
      sandboxReconnectGrace: 20 + config.sandboxReconnectGraceMs,
      sandboxLiveness: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: null,
      spawnTimeout: null,
    });
    expect(decisions).toContainEqual({
      action: "arm_alarm",
      deadlineAt: 20 + config.sandboxReconnectGraceMs,
      reason: "next lifecycle deadline",
    });
    expect(decisions.some((decision) => decision.action === "emit_terminal")).toBe(false);
  });

  it("anchors reconnect recovery to the last proven bridge heartbeat", () => {
    const state = createEmptyLifecycleState();
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1", lastHeartbeatAt: 10_000 };
    const boundedConfig = defaultLifecycleConfig({
      sandboxLivenessMs: 60_000,
      sandboxReconnectGraceMs: 90_000,
    });

    const decisions = reduceLifecycle(
      state,
      { type: "sandbox.ws_disconnected", sandboxId: "sbx-1" },
      boundedConfig,
      40_000,
    );
    const next = applyPatch(state, decisions);

    // Recovery is due 60s after the last heartbeat, not 90s after the close.
    expect(next.deadlines.sandboxReconnectGrace).toBe(70_000);
    expect(decisions).toContainEqual({
      action: "arm_alarm",
      deadlineAt: 70_000,
      reason: "next lifecycle deadline",
    });
  });

  it("stops a reconnecting sandbox without terminal output when reconnect grace expires with no active prompt", () => {
    const state = createEmptyLifecycleState();
    state.sandbox = { ...state.sandbox, state: "reconnecting", sandboxId: "sbx-1" };
    state.deadlines = {
      ...state.deadlines,
      sandboxReconnectGrace: 90_020,
      sandboxLiveness: 900_020,
    };

    const decisions = reduceLifecycle(
      state,
      { type: "sandbox.reconnect_grace_expired", sandboxId: "sbx-1" },
      config,
      90_021,
    );
    const next = applyPatch(state, decisions);

    expect(next.sandbox.state).toBe("stopped");
    expect(next.prompt.phase).toBe("none");
    expect(next.deadlines).toEqual({
      sandboxReconnectGrace: null,
      sandboxLiveness: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: null,
      spawnTimeout: null,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: "persist_state", reason: "sandbox reconnect grace expired" });
    expect(decisions.some((decision) => decision.action === "emit_terminal")).toBe(false);
  });

  it("terminalizes an active prompt when reconnect grace expires", () => {
    const state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "running",
      promptId: "p-1",
      sandboxId: "sbx-1",
      lastRunningActivityAt: 10,
    };
    state.sandbox = { ...state.sandbox, state: "reconnecting", sandboxId: "sbx-1" };
    state.deadlines = {
      ...state.deadlines,
      sandboxReconnectGrace: 90_020,
      sandboxLiveness: 900_020,
      promptRunningInactivity: 900_010,
    };

    const decisions = reduceLifecycle(
      state,
      { type: "sandbox.reconnect_grace_expired", sandboxId: "sbx-1" },
      config,
      90_021,
    );
    const next = applyPatch(state, decisions);

    expect(next.sandbox.state).toBe("stopped");
    expect(next.prompt).toMatchObject({ phase: "terminal", terminalErrorCode: "sandbox_disconnected" });
    expect(next.deadlines).toEqual({
      sandboxReconnectGrace: null,
      sandboxLiveness: null,
      promptStartup: null,
      promptDispatch: null,
      promptRunningInactivity: null,
      spawnTimeout: null,
    });
    expect(decisions).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "sandbox_disconnected",
      reason: "sandbox reconnect grace expired",
    });
  });

  it("ignores stale sandbox death events", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "running", promptId: "p-1", sandboxId: "sbx-1" };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };

    expect(reduceLifecycle(state, { type: "sandbox.ws_disconnected", sandboxId: "sbx-old" }, config, 20)).toEqual([
      { action: "noop", reason: "stale sandbox disconnect" },
    ]);
    expect(reduceLifecycle(state, { type: "sandbox.liveness_expired", sandboxId: "sbx-old" }, config, 20)).toEqual([
      { action: "noop", reason: "stale sandbox liveness deadline" },
    ]);
    expect(
      reduceLifecycle(state, { type: "sandbox.reconnect_grace_expired", sandboxId: "sbx-old" }, config, 20),
    ).toEqual([{ action: "noop", reason: "stale reconnect grace deadline" }]);
  });

  it("clears stale prompt identity fields when a new prompt is enqueued", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "terminal",
      promptId: "p-old",
      startupAttemptId: "start-old",
      sandboxId: "sbx-old",
      queuedAt: 1,
      sentToBridgeAt: 2,
      bridgeAcceptedAt: 3,
      codexPromptSentAt: 4,
      lastRunningActivityAt: 5,
      terminalErrorCode: "sandbox_disconnected",
    };

    state = applyPatch(state, reduceLifecycle(state, { type: "prompt.enqueued", promptId: "p-new" }, config, 10));

    expect(state.prompt).toMatchObject({
      phase: "queued",
      promptId: "p-new",
      startupAttemptId: null,
      sandboxId: null,
      sentToBridgeAt: null,
      bridgeAcceptedAt: null,
      codexPromptSentAt: null,
      lastRunningActivityAt: null,
      terminalErrorCode: null,
    });
  });

  it("keeps startup and running inactivity deadlines separate", () => {
    let state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "dispatching", promptId: "p-1", sandboxId: "sbx-1", bridgeAcceptedAt: 5 };

    const dispatchTimeout = reduceLifecycle(
      state,
      { type: "prompt.startup_deadline_elapsed", promptId: "p-1" },
      config,
      180_005,
    );
    expect(dispatchTimeout).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "codex_prompt_dispatch_timeout",
      reason: "prompt startup deadline elapsed",
    });

    state.prompt.phase = "running";
    const ignoredStartup = reduceLifecycle(
      state,
      { type: "prompt.startup_deadline_elapsed", promptId: "p-1" },
      config,
      180_006,
    );
    expect(ignoredStartup).toEqual([{ action: "noop", reason: "running prompt ignores startup deadline" }]);

    const runningTimeout = reduceLifecycle(
      state,
      { type: "prompt.running_inactivity_elapsed", promptId: "p-1" },
      config,
      900_006,
    );
    expect(runningTimeout).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "stale_prompt",
      reason: "prompt running inactivity elapsed",
    });
  });

  it("fails a prompt that is dispatched to Codex but never produces a first execution event", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "dispatching",
      promptId: "p-1",
      sandboxId: "sbx-1",
      bridgeAcceptedAt: 5,
      codexPromptSentAt: 10,
    };
    state.deadlines.promptDispatch = 180_010;

    const decisions = reduceLifecycle(
      state,
      { type: "prompt.dispatch_deadline_elapsed", promptId: "p-1" },
      config,
      180_011,
    );
    state = applyPatch(state, decisions);

    expect(state.prompt.phase).toBe("terminal");
    expect(state.deadlines.promptDispatch).toBeNull();
    expect(decisions).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "codex_prompt_dispatch_timeout",
      reason: "prompt dispatch deadline elapsed",
    });
  });

  it("clears the dispatch watchdog on the first execution event", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "dispatching",
      promptId: "p-1",
      sandboxId: "sbx-1",
      codexPromptSentAt: 10,
    };
    state.deadlines.promptDispatch = 180_010;

    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "prompt.running_activity", promptId: "p-1", sandboxId: "sbx-1" }, config, 20),
    );

    expect(state.prompt.phase).toBe("running");
    expect(state.deadlines.promptDispatch).toBeNull();
    expect(state.deadlines.promptRunningInactivity).toBe(900_020);

    const decisions = reduceLifecycle(
      state,
      { type: "prompt.dispatch_deadline_elapsed", promptId: "p-1" },
      config,
      180_011,
    );
    expect(decisions).toEqual([{ action: "noop", reason: "running prompt ignores dispatch deadline" }]);
  });

  it("does not regress a running prompt when the prompt-sent event arrives late", () => {
    let state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "dispatching",
      promptId: "p-1",
      sandboxId: "sbx-1",
      startupAttemptId: "start-1",
    };
    state.sandbox = { ...state.sandbox, sandboxId: "sbx-1" };

    state = applyPatch(
      state,
      reduceLifecycle(
        state,
        { type: "prompt.running_activity", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-1" },
        config,
        5,
      ),
    );

    const latePromptSent = reduceLifecycle(
      state,
      { type: "prompt.agent_prompt_sent", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-1" },
      config,
      6,
    );
    state = applyPatch(state, latePromptSent);

    expect(latePromptSent).toEqual([{ action: "noop", reason: "running prompt already observed execution" }]);
    expect(state.prompt.phase).toBe("running");
    expect(state.prompt.codexPromptSentAt).toBeNull();
    expect(state.deadlines.promptDispatch).toBeNull();
    expect(state.deadlines.promptRunningInactivity).toBe(900_005);

    const dispatchTimeout = reduceLifecycle(
      state,
      { type: "prompt.dispatch_deadline_elapsed", promptId: "p-1" },
      config,
      180_006,
    );
    expect(dispatchTimeout).toEqual([{ action: "noop", reason: "running prompt ignores dispatch deadline" }]);
  });

  it("arms the earliest deadline after merging current state with the patch", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "running", promptId: "p-1", sandboxId: "sbx-1" };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.promptRunningInactivity = 100;

    const decisions = reduceLifecycle(state, { type: "sandbox.heartbeat_received", sandboxId: "sbx-1" }, config, 20);

    expect(decisions).toContainEqual({ action: "arm_alarm", deadlineAt: 100, reason: "next lifecycle deadline" });
  });

  it("ignores stale past deadlines when arming the next lifecycle alarm", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "running", promptId: "p-1", sandboxId: "sbx-1" };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };
    state.deadlines.promptStartup = 10;
    state.deadlines.promptRunningInactivity = 100;

    const decisions = reduceLifecycle(state, { type: "sandbox.heartbeat_received", sandboxId: "sbx-1" }, config, 20);

    expect(decisions).toContainEqual({ action: "arm_alarm", deadlineAt: 100, reason: "next lifecycle deadline" });
    expect(decisions).not.toContainEqual({ action: "arm_alarm", deadlineAt: 20, reason: "next lifecycle deadline" });
  });

  it("does not dispatch a queued prompt with a mismatched prompt id", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "queued", promptId: "p-1" };
    state.sandbox = { ...state.sandbox, state: "ready", sandboxId: "sbx-1" };

    expect(
      reduceLifecycle(state, { type: "prompt.sent_to_bridge", promptId: "p-2", sandboxId: "sbx-1" }, config, 1),
    ).toEqual([{ action: "noop", reason: "stale prompt sent to bridge" }]);
  });

  it("fences mismatched prompt, sandbox, and startup attempt events", () => {
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
      reduceLifecycle(state, { type: "prompt.agent_prompt_sent", promptId: "p-2", sandboxId: "sbx-1" }, config, 1),
    ).toEqual([{ action: "noop", reason: "stale running prompt event" }]);
    expect(
      reduceLifecycle(state, { type: "prompt.agent_prompt_sent", promptId: "p-1", sandboxId: "sbx-2" }, config, 1),
    ).toEqual([{ action: "noop", reason: "mismatched sandbox for running event" }]);
    expect(
      reduceLifecycle(
        state,
        { type: "prompt.agent_prompt_sent", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-2" },
        config,
        1,
      ),
    ).toEqual([{ action: "noop", reason: "stale startup attempt" }]);
    expect(
      reduceLifecycle(
        state,
        { type: "prompt.running_activity", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-2" },
        config,
        1,
      ),
    ).toEqual([{ action: "noop", reason: "stale startup attempt" }]);
  });

  it("falls back to the sandbox startup attempt when prompt attempt is not set yet", () => {
    const state = createEmptyLifecycleState();
    state.prompt = {
      ...state.prompt,
      phase: "dispatching",
      promptId: "p-1",
      sandboxId: "sbx-1",
      startupAttemptId: null,
    };
    state.sandbox = { ...state.sandbox, sandboxId: "sbx-1", startupAttemptId: "start-current" };

    expect(
      reduceLifecycle(
        state,
        { type: "prompt.bridge_accepted", promptId: "p-1", sandboxId: "sbx-1", startupAttemptId: "start-old" },
        config,
        1,
      ),
    ).toEqual([{ action: "noop", reason: "stale startup attempt" }]);
  });

  it("clears the reconnect-grace deadline and disconnect marker when a spawn is requested from reconnecting", () => {
    // Sandbox-death wedge: spawning fresh abandons the prior transport, so a
    // stale reconnect-grace alarm must not survive to fire mid-spawn and
    // terminalize the prompt this spawn serves.
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "queued", promptId: "p-1" };
    state.sandbox = { ...state.sandbox, state: "reconnecting", sandboxId: "sbx-1" };
    state.deadlines = { ...state.deadlines, sandboxReconnectGrace: 95 };

    const decisions = reduceLifecycle(state, { type: "sandbox.spawn_requested", startupAttemptId: "s-1" }, config, 10);
    expect(decisions).toContainEqual({ action: "spawn_sandbox", reason: "sandbox spawn requested" });

    const persist = decisions.find((decision) => decision.action === "persist_state");
    expect(persist?.action).toBe("persist_state");
    if (persist?.action !== "persist_state") throw new Error("expected persist_state decision");
    expect(persist.patch.sandbox?.state).toBe("spawning");
    expect(persist.patch.sandbox?.disconnectStartedAt).toBeNull();
    expect(persist.patch.deadlines?.sandboxReconnectGrace).toBeNull();
    expect(persist.patch.deadlines?.spawnTimeout).toBe(10 + 180_000);
  });

  it("terminalizes an active prompt when the spawn circuit is open", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "queued", promptId: "p-1" };
    state.sandbox = { ...state.sandbox, state: "failed", spawnFailureCount: 2, lastSpawnFailureAt: 0 };

    const decisions = reduceLifecycle(state, { type: "sandbox.spawn_requested", startupAttemptId: "s-1" }, config, 1);

    expect(decisions).toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "spawn_preconnect",
      reason: "spawn circuit open",
    });
  });

  it("ignores late spawn failures and aborts after the prompt is terminal", () => {
    const state = createEmptyLifecycleState();
    state.prompt = { ...state.prompt, phase: "terminal", promptId: "p-1", terminalErrorCode: "sandbox_disconnected" };
    state.sandbox = { ...state.sandbox, state: "spawning", startupAttemptId: "start-1", spawnFailureCount: 1 };

    expect(
      reduceLifecycle(
        state,
        { type: "sandbox.spawn_failed", startupAttemptId: "start-1", errorCode: "spawn_timeout" },
        config,
        1,
      ),
    ).not.toContainEqual({
      action: "emit_terminal",
      promptId: "p-1",
      errorCode: "spawn_timeout",
      reason: "sandbox spawn failed",
    });
    expect(reduceLifecycle(state, { type: "prompt.abort_requested", promptId: "p-1" }, config, 1)).toEqual([
      { action: "noop", reason: "stale prompt abort" },
    ]);
  });

  it("aborts queued, dispatching, and running prompts with terminal precedence", () => {
    for (const phase of ["queued", "dispatching", "running"] as const) {
      const state = createEmptyLifecycleState();
      state.prompt = { ...state.prompt, phase, promptId: "p-1" };
      const decisions = reduceLifecycle(state, { type: "prompt.abort_requested", promptId: "p-1" }, config, 1);
      expect(decisions).toContainEqual({
        action: "emit_terminal",
        promptId: "p-1",
        errorCode: "aborted",
        reason: "prompt abort requested",
      });
    }
  });

  it("ignores lifecycle events for archived sessions", () => {
    const archived = createEmptyLifecycleState();
    archived.sessionStatus = "archived";
    expect(reduceLifecycle(archived, { type: "sandbox.spawn_requested", startupAttemptId: "s-1" }, config, 1)).toEqual([
      { action: "noop", reason: "session archived" },
    ]);
  });

  it("tracks review listening entry, epoch enqueue, and explicit exit", () => {
    let state = createEmptyLifecycleState();

    state = applyPatch(
      state,
      reduceLifecycle(
        state,
        {
          type: "review_listening.entered",
          prUrl: "https://github.com/acme/repo/pull/42",
          currentHeadSha: "sha-1",
        },
        config,
        100,
      ),
    );

    expect(state.reviewListening).toEqual({
      active: true,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "sha-1",
      enteredAt: 100,
    });

    state = applyPatch(
      state,
      reduceLifecycle(
        state,
        {
          type: "review_listening.epoch_enqueued",
          prUrl: "https://github.com/acme/repo/pull/42",
          currentHeadSha: "sha-2",
        },
        config,
        200,
      ),
    );

    // A head change restarts the no-show window: the wait for the NEW head begins now, so enteredAt
    // resets to the event time (200), not the original arm time (100). Otherwise a long-armed listen
    // plus a fresh push would settle the bot no-show immediately on a commit reviewers have not seen.
    expect(state.reviewListening).toMatchObject({
      active: true,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "sha-2",
      enteredAt: 200,
    });

    state = applyPatch(
      state,
      reduceLifecycle(state, { type: "review_listening.exited", reason: "merged" }, config, 300),
    );

    expect(state.reviewListening).toEqual({
      active: false,
      prUrl: null,
      currentHeadSha: null,
      enteredAt: null,
    });
  });

  it("stops review listening when the user stops or archives the session", () => {
    const listening = createEmptyLifecycleState();
    listening.reviewListening = {
      active: true,
      prUrl: "https://github.com/acme/repo/pull/42",
      currentHeadSha: "sha-1",
      enteredAt: 100,
    };

    const stoppedByUser = applyPatch(
      listening,
      reduceLifecycle(
        listening,
        { type: "boundary.stop_finalize", stopReason: "user", reason: "user stop" },
        config,
        200,
      ),
    );
    expect(stoppedByUser.reviewListening.active).toBe(false);

    const listeningAgain = structuredClone(listening) as LifecycleState;
    const autoStopped = applyPatch(
      listeningAgain,
      reduceLifecycle(
        listeningAgain,
        { type: "boundary.transport_stop_finalize", stopReason: "reaped", reason: "idle pause" },
        config,
        250,
      ),
    );
    expect(autoStopped.reviewListening.active).toBe(true);

    const archived = applyPatch(
      listening,
      reduceLifecycle(listening, { type: "boundary.close_finalize", reason: "archive" }, config, 300),
    );
    expect(archived.reviewListening.active).toBe(false);
  });
});
