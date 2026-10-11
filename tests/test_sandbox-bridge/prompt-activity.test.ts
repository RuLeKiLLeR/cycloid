// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROMPT_ACTIVITY_PULSE_INTERVAL_MS } from "../../apps/sandbox-bridge/src/constants/bridge.js";
import { DispatchLatencyTracker } from "../../apps/sandbox-bridge/src/services/dispatch-latency-tracker.js";
import {
  isVisiblePromptActivityEvent,
  PromptActivityReporter,
} from "../../apps/sandbox-bridge/src/services/prompt-activity.js";
import type { BridgeEvent as SandboxEvent } from "../../shared/events/bridge.js";

function makeReporter(
  overrides: { startupAttemptId?: string | null; repo?: string; completedPromptLimit?: number } = {},
) {
  const events: SandboxEvent[] = [];
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: unknown }> = [];
  const log = {
    info: (obj: Record<string, unknown>, msg: unknown) => logs.push({ level: "info", obj, msg }),
    warn: () => {},
    error: () => {},
    debug: (obj: Record<string, unknown>, msg: unknown) => logs.push({ level: "debug", obj, msg }),
    child: () => log,
  };
  let startupAttemptId: string | null = overrides.startupAttemptId ?? null;
  let pendingAck = new Map<string, SandboxEvent>();
  let buffer: SandboxEvent[] = [];
  let clock = 1000;
  const reporter = new PromptActivityReporter({
    sendEvent: (event) => events.push(event),
    sandboxId: "sbx-1",
    getCurrentPromptStartupAttemptId: () => startupAttemptId,
    getRepoSlug: () => overrides.repo,
    getPendingAckEvents: () => pendingAck,
    getEventBuffer: () => buffer,
    log,
    now: () => clock,
    ...(overrides.completedPromptLimit === undefined
      ? {}
      : { completedAgentProgressPromptIdLimit: overrides.completedPromptLimit }),
  });
  return {
    reporter,
    events,
    logs,
    setStartupAttemptId: (v: string | null) => (startupAttemptId = v),
    setPendingAck: (m: Map<string, SandboxEvent>) => (pendingAck = m),
    setBuffer: (b: SandboxEvent[]) => (buffer = b),
    setClock: (c: number) => (clock = c),
  };
}

describe("PromptActivityReporter.sendPromptActivity", () => {
  it("attaches startupAttemptId when set and omits when null", () => {
    const h = makeReporter();
    h.reporter.sendPromptActivity("p1", "session_creating");
    expect(h.events[0]).not.toHaveProperty("startupAttemptId");

    h.setStartupAttemptId("attempt-7");
    h.reporter.sendPromptActivity("p1", "session_creating", "detail-x");
    expect(h.events[1]).toMatchObject({
      type: "prompt_activity",
      promptId: "p1",
      phase: "session_creating",
      detail: "detail-x",
      startupAttemptId: "attempt-7",
      sandboxId: "sbx-1",
    });
  });
});

describe("PromptActivityReporter.sendAgentProgress", () => {
  it("dedupes a repeated step across two call paths into one event", () => {
    const h = makeReporter();
    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");
    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");
    expect(h.events.filter((e) => e.type === "agent_progress")).toHaveLength(1);
  });

  it("re-emits the same step when repeat is set", () => {
    const h = makeReporter();
    h.reporter.sendAgentProgress("p1", "waiting_for_model", "Waiting for model");
    h.reporter.sendAgentProgress("p1", "waiting_for_model", "Waiting for model", { repeat: true });
    expect(h.events).toHaveLength(2);
  });

  it("tracks dedup per prompt id", () => {
    const h = makeReporter();
    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");
    h.reporter.sendAgentProgress("p2", "starting_agent", "Starting agent");
    expect(h.events).toHaveLength(2);
  });

  it("drops late progress for a recently completed prompt", () => {
    const h = makeReporter();
    h.reporter.markPromptComplete("p1");
    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");
    expect(h.events).toHaveLength(0);
  });

  it("bounds completed prompt ids by evicting the oldest completions first", () => {
    const h = makeReporter({ completedPromptLimit: 2 });

    h.reporter.markPromptComplete("p1");
    h.reporter.markPromptComplete("p2");
    h.reporter.markPromptComplete("p3");

    expect(h.reporter["completedAgentProgressPromptIds"].size).toBe(2);

    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");
    h.reporter.sendAgentProgress("p2", "starting_agent", "Starting agent");
    h.reporter.sendAgentProgress("p3", "starting_agent", "Starting agent");

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: "agent_progress",
      promptId: "p1",
      step: "starting_agent",
    });
  });

  it("refreshes eviction order when a prompt is completed again", () => {
    const h = makeReporter({ completedPromptLimit: 2 });

    h.reporter.markPromptComplete("p1");
    h.reporter.markPromptComplete("p2");
    h.reporter.markPromptComplete("p1");
    h.reporter.markPromptComplete("p3");

    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");
    h.reporter.sendAgentProgress("p2", "starting_agent", "Starting agent");
    h.reporter.sendAgentProgress("p3", "starting_agent", "Starting agent");

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: "agent_progress",
      promptId: "p2",
      step: "starting_agent",
    });
  });

  it("keeps late-progress suppression when the injected completed prompt limit is zero", () => {
    const h = makeReporter({ completedPromptLimit: 0 });

    h.reporter.markPromptComplete("p1");
    h.reporter.sendAgentProgress("p1", "starting_agent", "Starting agent");

    expect(h.events).toHaveLength(0);
  });

  it("emits backend thinking progress once and logs received-to-thinking timing", () => {
    const h = makeReporter({ repo: "trycycloid/cycloid" });
    h.reporter.recordFirstPromptActivityTracker("p1", {
      startedAt: 1000,
      sessionId: "sess-1",
      sandboxId: "sbx-1",
      startupAttemptId: "attempt-1",
      agent: "codex",
      model: "gpt-5",
      latencyTags: {
        agent_runtime_backend: "codex",
        model: "gpt-5",
        agent: "codex",
        reasoning_effort: "medium",
        is_followup: true,
        has_memories: false,
      },
    });
    h.setClock(1450);

    h.reporter.sendThinkingProgress("p1", "message.part.delta");
    h.reporter.sendThinkingProgress("p1", "message.part.updated");

    expect(h.events).toEqual([
      expect.objectContaining({
        type: "agent_progress",
        promptId: "p1",
        step: "thinking",
        label: "Thinking",
      }),
    ]);
    expect(h.logs.map((entry) => entry.obj)).toContainEqual({
      event: "prompt.received_to_thinking",
      session_id: "sess-1",
      prompt_id: "p1",
      sandbox_id: "sbx-1",
      startup_attempt_id: "attempt-1",
      received_to_thinking_ms: 450,
      signal: "message.part.delta",
      agent_runtime_backend: "codex",
      model: "gpt-5",
      agent: "codex",
      reasoning_effort: "medium",
      is_followup: true,
      has_memories: false,
      repo: "trycycloid/cycloid",
    });
  });

  it("logs when thinking progress has no timing tracker", () => {
    const h = makeReporter();

    h.reporter.sendThinkingProgress("p1", "message.part.delta");

    expect(h.events).toEqual([
      expect.objectContaining({
        type: "agent_progress",
        promptId: "p1",
        step: "thinking",
      }),
    ]);
    expect(h.logs).toContainEqual({
      level: "debug",
      obj: {
        event: "prompt.received_to_thinking_tracker_missing",
        prompt_id: "p1",
        signal: "message.part.delta",
      },
      msg: "Prompt thinking progress timing tracker missing",
    });
  });

  it("does not treat agent progress as a first-visible event", () => {
    expect(isVisiblePromptActivityEvent("agent_progress")).toBe(false);
  });
});

describe("PromptActivityReporter.withPromptActivityPulse", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits the initial activity and clears the interval after work resolves", async () => {
    const h = makeReporter();
    await h.reporter.withPromptActivityPulse("p1", "session_creating", async () => "ok");
    const before = h.events.length;
    expect(before).toBeGreaterThanOrEqual(1);
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS * 3);
    expect(h.events.length).toBe(before);
  });

  it("clears the interval when the work fn rejects (no leaked pulses)", async () => {
    const h = makeReporter();
    await expect(
      h.reporter.withPromptActivityPulse("p1", "session_creating", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const before = h.events.length;
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS * 5);
    expect(h.events.length).toBe(before);
  });

  it("clears the interval when the work fn throws synchronously", () => {
    const h = makeReporter();
    expect(() =>
      h.reporter.withPromptActivityPulse("p1", "session_creating", () => {
        throw new Error("sync boom");
      }),
    ).toThrow("sync boom");
    const before = h.events.length;
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS * 5);
    expect(h.events.length).toBe(before);
  });

  it("logs a prompt.activity_phase duration metric when work completes", async () => {
    const h = makeReporter({ repo: "owner/repo" });
    await h.reporter.withPromptActivityPulse("p1", "session_creating", async () => "ok", "detail-x");
    const metrics = h.logs.filter((l) => l.obj.event === "prompt.activity_phase");
    expect(metrics).toHaveLength(1);
    expect(metrics[0].obj).toMatchObject({
      prompt_id: "p1",
      phase: "session_creating",
      outcome: "completed",
      detail: "detail-x",
      repo: "owner/repo",
    });
    expect(typeof metrics[0].obj.duration_ms).toBe("number");
  });

  it("logs latency tags on prompt.activity_phase duration metrics", async () => {
    const h = makeReporter({ repo: "owner/repo" });
    await h.reporter.withPromptActivityPulse("p1", "agent_runtime_initializing", async () => "ok", undefined, {
      agent_runtime_backend: "codex",
      model: "gpt-5.4",
      agent: "codex",
      reasoning_effort: "provider_default",
      is_followup: true,
      has_memories: false,
    });

    const [metric] = h.logs.filter((l) => l.obj.event === "prompt.activity_phase");
    expect(metric.obj).toMatchObject({
      phase: "agent_runtime_initializing",
      outcome: "completed",
      agent_runtime_backend: "codex",
      model: "gpt-5.4",
      agent: "codex",
      reasoning_effort: "provider_default",
      is_followup: true,
      has_memories: false,
      repo: "owner/repo",
    });
  });

  it("logs a failed outcome when work rejects", async () => {
    const h = makeReporter();
    await expect(
      h.reporter.withPromptActivityPulse("p1", "session_creating", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const metrics = h.logs.filter((l) => l.obj.event === "prompt.activity_phase");
    expect(metrics).toHaveLength(1);
    expect(metrics[0].obj.outcome).toBe("failed");
  });

  it("logs a failed outcome when work throws synchronously", () => {
    const h = makeReporter();
    expect(() =>
      h.reporter.withPromptActivityPulse("p1", "session_creating", () => {
        throw new Error("sync boom");
      }),
    ).toThrow("sync boom");
    const metrics = h.logs.filter((l) => l.obj.event === "prompt.activity_phase");
    expect(metrics).toHaveLength(1);
    expect(metrics[0].obj.outcome).toBe("failed");
  });
});

describe("PromptActivityReporter waiting telemetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("distinguishes useful-activity age from passive waiting pulses", () => {
    const h = makeReporter();
    h.setClock(1_000);
    const stop = h.reporter.startPromptActivityPulse("p1", "waiting_for_agent_event");

    h.setClock(31_000);
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS);
    h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });

    h.setClock(61_000);
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS);
    stop();

    const pulses = h.logs.filter((entry) => entry.obj.event === "prompt.wait_pulse");
    expect(pulses).toHaveLength(3);
    expect(pulses[0].obj).toMatchObject({
      waiting_pulse_count: 1,
      waiting_elapsed_ms: 0,
      useful_activity_observed: false,
      useful_activity_age_ms: 0,
      active_tool_call: false,
    });
    expect(pulses[1].obj.useful_activity_age_ms).toBe(30_000);
    expect(pulses[2].obj).toMatchObject({
      waiting_pulse_count: 3,
      waiting_elapsed_ms: 60_000,
      useful_activity_observed: true,
      useful_activity_age_ms: 30_000,
      last_useful_event_type: "token",
    });
  });

  it("marks a long-running tool active until its terminal update is delivered", () => {
    const h = makeReporter();
    h.setClock(1_000);
    const stop = h.reporter.startPromptActivityPulse("p1", "waiting_for_agent_event");
    h.reporter.recordFirstPromptActivitySent({
      type: "tool_call",
      messageId: "p1",
      callId: "call-1",
    });

    h.setClock(31_000);
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS);
    expect(h.logs.at(-1)?.obj).toMatchObject({ active_tool_call: true, active_tool_count: 1 });

    h.reporter.recordFirstPromptActivitySent({
      type: "tool_update",
      messageId: "p1",
      callId: "call-1",
      tool: "bash",
      status: "completed",
    });
    h.setClock(61_000);
    vi.advanceTimersByTime(PROMPT_ACTIVITY_PULSE_INTERVAL_MS);
    stop();
    expect(h.logs.at(-1)?.obj).toMatchObject({
      active_tool_call: false,
      active_tool_count: 0,
      last_useful_event_type: "tool_update",
      useful_activity_age_ms: 30_000,
    });
  });

  it("summarizes tool-active time separately from tool-free no-output gaps", () => {
    const h = makeReporter({ repo: "owner/repo" });
    h.setClock(1_000);
    const stop = h.reporter.startPromptActivityPulse("p1", "waiting_for_agent_event");

    h.setClock(3_000);
    h.reporter.recordFirstPromptActivitySent({
      type: "tool_call",
      messageId: "p1",
      callId: "call-1",
      tool: "bash",
      args: {},
    });
    h.setClock(8_000);
    h.reporter.recordFirstPromptActivitySent({
      type: "tool_update",
      messageId: "p1",
      callId: "call-1",
      tool: "bash",
      status: "completed",
    });
    h.setClock(11_000);
    stop();
    h.reporter.markPromptComplete("p1");

    const summary = h.logs.find((entry) => entry.obj.event === "prompt.wait_summary")?.obj;
    expect(summary).toMatchObject({
      prompt_id: "p1",
      waiting_elapsed_ms: 10_000,
      tool_active_ms: 5_000,
      no_tool_no_output_ms: 5_000,
      max_no_tool_no_output_gap_ms: 3_000,
      final_no_output_gap_ms: 3_000,
      useful_event_count: 2,
      first_useful_event_ms: 2_000,
      active_tool_count_at_completion: 0,
      repo: "owner/repo",
    });
  });
});

describe("PromptActivityReporter first-message tracking", () => {
  it("logs prompt.first_message once on the first delivered visible-work event and clears the tracker", () => {
    const h = makeReporter({ repo: "owner/repo" });
    h.setClock(1000);
    h.reporter.recordFirstPromptActivityTracker("p1", {
      startedAt: 600,
      sessionId: "session-1",
      sandboxId: "sbx-1",
      startupAttemptId: "attempt-1",
      agent: "codex",
      model: "gpt",
    });

    h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
    const visibleLogs = h.logs.filter((l) => l.obj.event === "prompt.first_visible_event");
    expect(visibleLogs).toHaveLength(1);
    expect(visibleLogs[0].obj).toMatchObject({
      session_id: "session-1",
      prompt_id: "p1",
      sandbox_id: "sbx-1",
      startup_attempt_id: "attempt-1",
      first_event_type: "token",
      prompt_received_to_first_visible_event_ms: 400,
      agent: "codex",
      model: "gpt",
      repo: "owner/repo",
    });
    const firstLogs = h.logs.filter((l) => l.obj.event === "prompt.first_message");
    expect(firstLogs).toHaveLength(1);
    expect(firstLogs[0].obj).toMatchObject({
      prompt_id: "p1",
      first_event_type: "token",
      time_to_first_message_ms: 400,
      agent: "codex",
      model: "gpt",
      repo: "owner/repo",
    });

    // Tracker cleared: a second delivered event does not log again.
    h.reporter.recordFirstPromptActivitySent({ type: "tool_call", messageId: "p1" });
    expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(1);
  });

  it("ignores events that are not visible-work types or have no tracker", () => {
    const h = makeReporter();
    h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "codex", model: "gpt" });
    h.reporter.recordFirstPromptActivitySent({ type: "prompt_activity", messageId: "p1" });
    h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "other" });
    expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(0);
  });

  it("clamps a negative elapsed time to zero", () => {
    const h = makeReporter();
    h.setClock(500);
    h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "codex", model: "gpt" });
    h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
    expect(h.logs.find((l) => l.obj.event === "prompt.first_message")?.obj.time_to_first_message_ms).toBe(0);
  });

  describe("dispatch_to_first_event (bucket B)", () => {
    const latencyTags = {
      agent_runtime_backend: "codex",
      model: "gpt",
      agent: "build",
      reasoning_effort: "medium",
      is_followup: true,
      has_memories: false,
    };

    it("emits dispatch_to_first_event anchored on the first visible event once dispatch is recorded", () => {
      const h = makeReporter({ repo: "owner/repo" });
      h.setClock(2000);
      h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "build", model: "gpt" });
      h.reporter.recordPromptDispatched("p1", 1000, latencyTags);
      h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });

      const bucketB = h.logs.filter((l) => l.obj.event === "prompt.dispatch_to_first_event");
      expect(bucketB).toHaveLength(1);
      expect(bucketB[0].obj).toMatchObject({
        prompt_id: "p1",
        dispatch_to_first_event_ms: 1000, // 2000 - dispatchStartedAt 1000
        first_event_type: "token",
        model: "gpt",
        agent: "build",
        agent_runtime_backend: "codex",
        is_followup: true,
        has_memories: false,
      });
    });

    it("does not emit dispatch_to_first_event when the dispatch boundary was never recorded", () => {
      const h = makeReporter();
      h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "build", model: "gpt" });
      h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
      expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(1);
      expect(h.logs.filter((l) => l.obj.event === "prompt.dispatch_to_first_event")).toHaveLength(0);
    });

    it("ignores recordPromptDispatched for an unknown prompt", () => {
      const h = makeReporter();
      h.reporter.recordPromptDispatched("p1", 1000, latencyTags); // no tracker seeded -> no-op
      h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
      expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(0);
      expect(h.logs.filter((l) => l.obj.event === "prompt.dispatch_to_first_event")).toHaveLength(0);
    });
  });

  describe("deleteFirstPromptActivityTrackerIfNoPendingDelivery", () => {
    it("keeps the tracker while a visible-work event is still pending ack", () => {
      const h = makeReporter();
      h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "codex", model: "gpt" });
      h.setPendingAck(new Map([["e1", { type: "token", messageId: "p1" }]]));
      h.reporter.deleteFirstPromptActivityTrackerIfNoPendingDelivery("p1");
      // Tracker survives: a later delivery still logs first_message.
      h.setPendingAck(new Map());
      h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
      expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(1);
    });

    it("keeps the tracker while a visible-work event is still buffered", () => {
      const h = makeReporter();
      h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "codex", model: "gpt" });
      h.setBuffer([{ type: "tool_call", messageId: "p1" }]);
      h.reporter.deleteFirstPromptActivityTrackerIfNoPendingDelivery("p1");
      h.setBuffer([]);
      h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
      expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(1);
    });

    it("deletes the tracker when nothing is pending or buffered", () => {
      const h = makeReporter();
      h.reporter.recordFirstPromptActivityTracker("p1", { startedAt: 600, agent: "codex", model: "gpt" });
      h.reporter.deleteFirstPromptActivityTrackerIfNoPendingDelivery("p1");
      // Tracker gone: a later delivery does not log.
      h.reporter.recordFirstPromptActivitySent({ type: "token", messageId: "p1" });
      expect(h.logs.filter((l) => l.obj.event === "prompt.first_message")).toHaveLength(0);
    });
  });

  describe("dispatch latency tracker delivery", () => {
    function makeDispatchTracker() {
      const logs: Record<string, unknown>[] = [];
      const promptLog = {
        info: (obj: Record<string, unknown>) => logs.push(obj),
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => promptLog,
      };
      const tracker = new DispatchLatencyTracker({
        promptId: "p1",
        promptLog,
        now: () => 2000,
      });
      tracker.setAnchor(1000);
      return { tracker, logs };
    }

    it("records bridge_first_visible_event when a buffered event is delivered later", () => {
      const h = makeReporter();
      const { tracker, logs } = makeDispatchTracker();
      h.reporter.recordDispatchLatencyTracker("p1", tracker);
      h.reporter.recordDispatchLatencyVisibleEventQueued({ type: "token", messageId: "p1" });
      h.reporter.recordDispatchLatencyVisibleEventBuffered({ type: "token", messageId: "p1" });
      h.setBuffer([{ type: "token", messageId: "p1" }]);
      h.reporter.deleteDispatchLatencyTrackerIfNoPendingDelivery("p1");
      h.setBuffer([]);
      h.reporter.recordDispatchLatencyVisibleEvent({ type: "token", messageId: "p1" });
      expect(
        logs.some((l) => l.event === "prompt.dispatch_subspan" && l.span === "bridge_first_visible_event_queued"),
      ).toBe(true);
      expect(
        logs.some((l) => l.event === "prompt.dispatch_subspan" && l.span === "bridge_first_visible_event_buffered"),
      ).toBe(true);
      expect(logs.some((l) => l.event === "prompt.dispatch_subspans_completed")).toBe(true);
    });

    it("deleteDispatchLatencyTrackerIfNoPendingDelivery drops the tracker when delivery is done", () => {
      const h = makeReporter();
      const { tracker, logs } = makeDispatchTracker();
      h.reporter.recordDispatchLatencyTracker("p1", tracker);
      h.reporter.deleteDispatchLatencyTrackerIfNoPendingDelivery("p1");
      h.reporter.recordDispatchLatencyVisibleEvent({ type: "token", messageId: "p1" });
      expect(logs.filter((l) => l.event === "prompt.dispatch_subspans_completed")).toHaveLength(0);
    });
  });
});
