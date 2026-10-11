// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { DispatchLatencyTracker } from "../../apps/sandbox-bridge/src/services/dispatch-latency-tracker.js";

function makeTracker(clock = { now: 0 }) {
  const logs: Record<string, unknown>[] = [];
  const promptLog = {
    info: (obj: Record<string, unknown>) => logs.push(obj),
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => promptLog,
  };
  const tracker = new DispatchLatencyTracker({
    promptId: "msg-1",
    promptLog,
    now: () => clock.now,
  });
  return { tracker, logs, clock };
}

describe("DispatchLatencyTracker", () => {
  it("records pre-dispatch milestones with negative offset_ms from the dispatch anchor", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 1000;
    tracker.recordRuntimeClientReady();
    clock.now = 1300;
    tracker.recordSessionCreated();
    clock.now = 2000;
    tracker.setAnchor(2000);
    tracker.setLatencyTags({
      agent_runtime_backend: "codex",
      model: "gpt",
      agent: "build",
      is_followup: false,
      has_memories: false,
    });

    const subspans = logs.filter((l) => l.event === "prompt.dispatch_subspan");
    expect(subspans).toHaveLength(2);
    expect(subspans[0]).toMatchObject({ span: "runtime_client_ready", offset_ms: -1000 });
    expect(subspans[1]).toMatchObject({ span: "session_created", offset_ms: -700 });
  });

  it("records post-dispatch milestones and emits a completed waterfall summary", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 5000;
    tracker.setAnchor(5000);
    tracker.setLatencyTags({
      agent_runtime_backend: "codex",
      model: "gpt",
      agent: "build",
      is_followup: true,
      has_memories: false,
    });

    clock.now = 5005;
    tracker.markPromptSendStarted();
    clock.now = 5040;
    tracker.recordPromptSentToBackend();
    clock.now = 9800;
    tracker.recordBackendFirstToken("session.status");
    clock.now = 10100;
    tracker.recordBridgeFirstVisibleEvent("token");

    const subspans = logs.filter((l) => l.event === "prompt.dispatch_subspan");
    expect(subspans).toHaveLength(3);
    expect(subspans[0]).toMatchObject({
      span: "prompt_sent_to_backend",
      offset_ms: 40,
      duration_ms: 35,
    });
    expect(subspans[1]).toMatchObject({
      span: "backend_first_token",
      offset_ms: 4800,
      signal: "session.status",
    });
    expect(subspans[2]).toMatchObject({
      span: "bridge_first_visible_event",
      offset_ms: 5100,
      first_event_type: "token",
    });

    const summary = logs.filter((l) => l.event === "prompt.dispatch_subspans_completed");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      prompt_id: "msg-1",
      dispatch_to_first_visible_event_ms: 5100,
      bridge_delay_ms: 300,
      agent_runtime_backend: "codex",
      is_followup: true,
    });
    expect(summary[0].spans).toMatchObject({
      runtime_client_ready: { offset_ms: 0, skipped: true },
      session_created: { offset_ms: 0, skipped: true },
      prompt_sent_to_backend: { offset_ms: 40, duration_ms: 35 },
      backend_first_token: { offset_ms: 4800, signal: "session.status" },
      bridge_first_visible_event_queued: { offset_ms: 0, skipped: true },
      bridge_first_visible_event_buffered: { offset_ms: 0, skipped: true },
      bridge_first_visible_event: { offset_ms: 5100, first_event_type: "token" },
    });
  });

  it.each(["codex", "claude_code", "opencode"])(
    "waits for the send outcome before emitting a summary when backend and visible events arrive early for %s",
    (backend) => {
      const { tracker, logs, clock } = makeTracker();
      clock.now = 5000;
      tracker.setAnchor(5000);
      tracker.setLatencyTags({
        agent_runtime_backend: backend,
        model: "gpt",
        agent: "build",
        is_followup: false,
        has_memories: false,
      });

      clock.now = 5005;
      tracker.markPromptSendStarted();
      clock.now = 6400;
      tracker.recordBackendFirstToken("message.part.updated");
      clock.now = 6700;
      tracker.recordBridgeFirstVisibleEvent("token");

      expect(logs.filter((l) => l.event === "prompt.dispatch_subspans_completed")).toHaveLength(0);
      expect(tracker.snapshotForTests()).toMatchObject({
        promptSendOutcome: "in_flight",
        pendingBackendFirstToken: {
          recordedAt: 6400,
          signal: "message.part.updated",
        },
      });

      clock.now = 6755;
      tracker.recordPromptSentToBackend();

      const summary = logs.filter((l) => l.event === "prompt.dispatch_subspans_completed");
      expect(summary).toHaveLength(1);
      expect(summary[0]).toMatchObject({
        dispatch_to_first_visible_event_ms: 1700,
        bridge_delay_ms: 300,
      });
      expect(summary[0].spans).toMatchObject({
        prompt_sent_to_backend: { offset_ms: 1755, duration_ms: 1750 },
        backend_first_token: { offset_ms: 1400, signal: "message.part.updated" },
        bridge_first_visible_event: { offset_ms: 1700, first_event_type: "token" },
      });
    },
  );

  it("emits a skipped send only after a send failure is known", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 9000;
    tracker.setAnchor(9000);
    tracker.markPromptSendStarted();
    clock.now = 9050;
    tracker.recordBridgeFirstVisibleEvent("reasoning");

    expect(logs.filter((l) => l.event === "prompt.dispatch_subspans_completed")).toHaveLength(0);

    tracker.recordPromptSendFailed();

    const summary = logs.filter((l) => l.event === "prompt.dispatch_subspans_completed");
    expect(summary).toHaveLength(1);
    expect(summary[0].spans).toMatchObject({
      prompt_sent_to_backend: { offset_ms: 0, skipped: true },
      bridge_first_visible_event: { offset_ms: 50, first_event_type: "reasoning" },
    });
  });

  it("emits a summary when send fails before any visible event arrives", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 12000;
    tracker.setAnchor(12000);
    tracker.setLatencyTags({
      agent_runtime_backend: "codex",
      model: "gpt",
      agent: "build",
      is_followup: false,
      has_memories: false,
    });

    clock.now = 12005;
    tracker.markPromptSendStarted();
    clock.now = 12025;
    tracker.recordPromptSendFailed();

    const summary = logs.filter((l) => l.event === "prompt.dispatch_subspans_completed");
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      dispatch_to_first_visible_event_ms: 0,
      agent_runtime_backend: "codex",
    });
    expect(summary[0].spans).toMatchObject({
      prompt_sent_to_backend: { offset_ms: 0, skipped: true },
      backend_first_token: { offset_ms: 0, skipped: true },
      bridge_first_visible_event: { offset_ms: 0, skipped: true },
    });
  });

  it("is idempotent per span name", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 100;
    tracker.setAnchor(100);
    tracker.recordBackendFirstToken("session.status");
    tracker.recordBackendFirstToken("message.part.updated");
    expect(logs.filter((l) => l.event === "prompt.dispatch_subspan")).toHaveLength(1);
  });

  it("emits the summary only once", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 1000;
    tracker.setAnchor(1000);
    tracker.recordBridgeFirstVisibleEvent("token");
    tracker.recordBridgeFirstVisibleEvent("tool_call");
    expect(logs.filter((l) => l.event === "prompt.dispatch_subspans_completed")).toHaveLength(1);
  });

  it("defers the summary until setAnchor when first visible event arrives early", () => {
    const { tracker, logs, clock } = makeTracker();
    clock.now = 3000;
    tracker.recordBridgeFirstVisibleEvent("token");
    expect(logs.filter((l) => l.event === "prompt.dispatch_subspans_completed")).toHaveLength(0);

    clock.now = 5000;
    tracker.setAnchor(5000);
    expect(logs.filter((l) => l.event === "prompt.dispatch_subspans_completed")).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({
      event: "prompt.dispatch_subspans_completed",
      dispatch_to_first_visible_event_ms: 0,
    });
  });
});
