// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
// Load harness mocks before bridge modules are evaluated.
import "./helpers/bridge-test-harness.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentBridge } from "../../apps/sandbox-bridge/src/bridge.ts";
import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.ts";
import { DispatchLatencyTracker } from "../../apps/sandbox-bridge/src/services/dispatch-latency-tracker.js";
import { defaultConfig, setupBridgeTestLifecycle } from "./helpers/bridge-test-harness.ts";

setupBridgeTestLifecycle();

function parseEventLogs(spy: ReturnType<typeof vi.spyOn>, event: string): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((entry) => entry.includes(`"event":"${event}"`))
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "msg-1",
    startTime: 1000,
    dispatchStartedAt: 4000,
    predispatchLatencyEmitted: false,
    predispatchTimings: {
      setupMs: 15,
      uploadsMs: 5,
      baselineCaptureMs: 800,
      systemContextBuildMs: 30,
      repoSnapshotMs: 4,
      diffBaseMs: 6,
    },
    effectiveModel: "gpt-5.5",
    requestedAgent: "build",
    reasoningEffort: "medium",
    isFollowup: true,
    ...overrides,
  };
}

describe("per-turn latency instrumentation", () => {
  let bridge: AgentBridge;
  let prevOwner: string | undefined;
  let prevName: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    prevOwner = process.env.REPO_OWNER;
    prevName = process.env.REPO_NAME;
    process.env.REPO_OWNER = "trycycloid";
    process.env.REPO_NAME = "cycloid";
    bridge = new AgentBridge(defaultConfig());
  });

  afterEach(() => {
    bridge.shutdown();
    if (prevOwner === undefined) delete process.env.REPO_OWNER;
    else process.env.REPO_OWNER = prevOwner;
    if (prevName === undefined) delete process.env.REPO_NAME;
    else process.env.REPO_NAME = prevName;
    vi.restoreAllMocks();
  });

  describe("buildPromptLatencyTags", () => {
    it("emits repo/model/agent/effort/is_followup/has_memories with no memories", () => {
      bridge.orgMemories = [];
      const tags = bridge["buildPromptLatencyTags"](makeCtx());
      expect(tags).toEqual({
        repo: "trycycloid/cycloid",
        agent_runtime_backend: "codex",
        model: "gpt-5.5",
        agent: "build",
        reasoning_effort: "medium",
        is_followup: true,
        has_memories: false,
      });
    });

    it("flips has_memories when org memories are loaded", () => {
      bridge.orgMemories = [{ id: "m1", content: "x" }];
      const tags = bridge["buildPromptLatencyTags"](makeCtx());
      expect(tags.has_memories).toBe(true);
    });

    it("falls back to a provider_default sentinel when reasoning effort is unset", () => {
      bridge.orgMemories = [];
      const tags = bridge["buildPromptLatencyTags"](makeCtx({ reasoningEffort: undefined }));
      expect(tags.reasoning_effort).toBe("provider_default");
    });

    it("omits repo when REPO_OWNER/REPO_NAME are absent", () => {
      delete process.env.REPO_OWNER;
      delete process.env.REPO_NAME;
      bridge.orgMemories = [];
      const tags = bridge["buildPromptLatencyTags"](makeCtx());
      expect(tags).not.toHaveProperty("repo");
    });
  });

  describe("emitPredispatchLatency", () => {
    it("emits predispatch_ms, the substep breakdown, and tags on the dispatched path", () => {
      bridge.orgMemories = [];
      const consoleSpy = vi.spyOn(console, "log");
      const ctx = makeCtx();
      bridge["emitPredispatchLatency"](ctx, "dispatched");

      const logs = parseEventLogs(consoleSpy, "prompt.predispatch");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: "prompt.predispatch",
        prompt_id: "msg-1",
        predispatch_ms: 3000, // dispatchStartedAt 4000 - startTime 1000
        outcome: "dispatched",
        setup_ms: 15,
        uploads_ms: 5,
        baseline_capture_ms: 800,
        system_context_build_ms: 30,
        repo_snapshot_ms: 4,
        diff_base_ms: 6,
        model: "gpt-5.5",
        agent: "build",
        reasoning_effort: "medium",
        is_followup: true,
        has_memories: false,
      });
      expect(logs[0]).not.toHaveProperty("error_code");
      expect(ctx.predispatchLatencyEmitted).toBe(true);
    });

    it("is idempotent: a second call does not re-emit", () => {
      bridge.orgMemories = [];
      const consoleSpy = vi.spyOn(console, "log");
      const ctx = makeCtx();
      bridge["emitPredispatchLatency"](ctx, "dispatched");
      bridge["emitPredispatchLatency"](ctx, "dispatched");
      expect(parseEventLogs(consoleSpy, "prompt.predispatch")).toHaveLength(1);
    });

    it("on pre-dispatch failure, uses failure time, sets outcome=error, and includes error_code", () => {
      bridge.orgMemories = [];
      vi.setSystemTime(new Date(0));
      const ctx = makeCtx({ dispatchStartedAt: null, startTime: 500, predispatchTimings: { uploadsMs: 12 } });
      vi.setSystemTime(new Date(2500));
      const consoleSpy = vi.spyOn(console, "log");
      bridge["emitPredispatchLatency"](ctx, "error", "codex_not_ready");

      const logs = parseEventLogs(consoleSpy, "prompt.predispatch");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        outcome: "error",
        error_code: "codex_not_ready",
        predispatch_ms: 2000, // 2500 - 500
        uploads_ms: 12,
      });
      // Steps that never ran are omitted, not zero-filled.
      expect(logs[0]).not.toHaveProperty("memory_ranking_ms");
    });
  });

  describe("dispatch_to_first_event (anchored on first visible event)", () => {
    function seedTracker(overrides: Record<string, unknown> = {}): void {
      bridge["promptActivity"].recordFirstPromptActivityTracker("msg-1", {
        startedAt: 9_000,
        agent: "build",
        model: "gpt-5.5",
        dispatchStartedAt: 10_000,
        latencyTags: {
          repo: "trycycloid/cycloid",
          agent_runtime_backend: "codex",
          model: "gpt-5.5",
          agent: "build",
          reasoning_effort: "medium",
          is_followup: true,
          has_memories: false,
        },
        ...overrides,
      });
    }

    it("emits dispatch_to_first_event_ms from dispatchStartedAt to the first visible event", () => {
      seedTracker();
      vi.setSystemTime(new Date(15_500));
      const consoleSpy = vi.spyOn(console, "log");
      bridge["promptActivity"].recordFirstPromptActivitySent({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sbx-1",
        timestamp: Date.now(),
      });

      const logs = parseEventLogs(consoleSpy, "prompt.dispatch_to_first_event");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: "prompt.dispatch_to_first_event",
        prompt_id: "msg-1",
        dispatch_to_first_event_ms: 5500, // 15500 - dispatchStartedAt 10000
        first_event_type: "token",
        model: "gpt-5.5",
        agent_runtime_backend: "codex",
        is_followup: true,
        has_memories: false,
      });
      // Anchored on the visible event, not the session.status ack.
      expect(logs[0]).not.toHaveProperty("first_event_signal");
    });

    it("does not emit dispatch_to_first_event when the dispatch boundary was never recorded", () => {
      // Pre-dispatch first-activity (no dispatchStartedAt/latencyTags on tracker).
      bridge["promptActivity"].recordFirstPromptActivityTracker("msg-1", {
        startedAt: 9_000,
        agent: "build",
        model: "gpt-5.5",
      });
      const consoleSpy = vi.spyOn(console, "log");
      bridge["promptActivity"].recordFirstPromptActivitySent({
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sbx-1",
        timestamp: Date.now(),
      });
      // The existing first_message metric still fires; bucket B does not.
      expect(parseEventLogs(consoleSpy, "prompt.first_message")).toHaveLength(1);
      expect(parseEventLogs(consoleSpy, "prompt.dispatch_to_first_event")).toHaveLength(0);
    });
  });

  describe("dispatch subspan instrumentation", () => {
    it("recordDispatchBoundary sets anchor and latency tags on the tracker", () => {
      bridge.orgMemories = [];
      const logs: Record<string, unknown>[] = [];
      const trackerLog = {
        info: (obj: Record<string, unknown>) => logs.push(obj),
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => trackerLog,
      };
      const tracker = new DispatchLatencyTracker({
        promptId: "msg-1",
        promptLog: trackerLog,
      });
      const ctx = makeCtx({ dispatchLatencyTracker: tracker });
      vi.setSystemTime(new Date(4000));
      bridge["recordDispatchBoundary"](ctx, 4000);
      expect(ctx.dispatchStartedAt).toBe(4000);
      expect(tracker.snapshotForTests().anchorAt).toBe(4000);
    });

    it("recordDispatchLatencyVisibleEvent emits bridge_first_visible_event summary", () => {
      bridge.orgMemories = [];
      const logs: Record<string, unknown>[] = [];
      const trackerLog = {
        info: (obj: Record<string, unknown>) => logs.push(obj),
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => trackerLog,
      };
      const tracker = new DispatchLatencyTracker({
        promptId: "msg-1",
        promptLog: trackerLog,
      });
      bridge["promptActivity"].recordDispatchLatencyTracker("msg-1", tracker);
      tracker.setAnchor(1000);
      bridge["promptActivity"].recordDispatchLatencyVisibleEvent({
        type: "token",
        content: "hi",
        messageId: "msg-1",
        sandboxId: "sbx-1",
        timestamp: 2000,
      });
      expect(logs.some((l) => l.event === "prompt.dispatch_subspan" && l.span === "bridge_first_visible_event")).toBe(
        true,
      );
      expect(logs.some((l) => l.event === "prompt.dispatch_subspans_completed")).toBe(true);
    });

    it("verification dispatch seeds anchor and emits send-span telemetry", async () => {
      bridge.orgMemories = [];
      const trackerLogs: Record<string, unknown>[] = [];
      const trackerLog = {
        info: (obj: Record<string, unknown>) => trackerLogs.push(obj),
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => trackerLog,
      };
      const tracker = new DispatchLatencyTracker({ promptId: "msg-1", promptLog: trackerLog });
      const stream = { async *[Symbol.asyncIterator]() {} };
      bridge.agentSessionId = "session-1";
      vi.spyOn(bridge.runtime, "isInitialized", "get").mockReturnValue(true);
      vi.spyOn(bridge.runtime, "subscribeEvents").mockResolvedValue({ stream } as unknown);
      vi.spyOn(bridge.runtime, "sendPrompt").mockResolvedValue(undefined as unknown);
      const streamSpy = vi
        .spyOn(bridge as unknown as Record<string, unknown>, "streamPromptToClient")
        .mockResolvedValue({
          started: true,
        } as unknown);

      const ctx = {
        messageId: "msg-1",
        promptLog: trackerLog,
        promptState: { abortReason: null, dispatchSucceeded: false },
        promptSignal: new AbortController().signal,
        promptDispatchAbort: new AbortController(),
        promptDispatchStillRelevant: true,
        requestedAgent: "build",
        agentRole: "verification",
        agentProfile: "verification",
        requestedProviderID: "openai",
        logToBt: () => {},
        startupAttemptId: "attempt-1",
        dispatchLatencyTracker: tracker,
        dispatchStartedAt: null,
        predispatchLatencyEmitted: true,
        predispatchTimings: {},
        startTime: Date.now(),
        effectiveModel: "gpt-5.4",
        reasoningEffort: "medium",
        isFollowup: false,
        loopState: null,
      };

      await bridge["invokeVerificationPhase"](ctx, {
        invocation: { phase: "planner", attempt: 1 },
        prompt: "Run verification planner",
      });

      expect(ctx.dispatchStartedAt).not.toBeNull();
      expect(tracker.snapshotForTests().anchorAt).toBe(ctx.dispatchStartedAt);
      expect(
        trackerLogs.some(
          (entry) => entry.event === "prompt.dispatch_subspan" && entry.span === "prompt_sent_to_backend",
        ),
      ).toBe(true);
      expect(streamSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ dispatchLatencyTracker: tracker }),
      );
    });

    it("verification dispatch records send span even when prompt becomes irrelevant", async () => {
      bridge.orgMemories = [];
      const trackerLogs: Record<string, unknown>[] = [];
      const trackerLog = {
        info: (obj: Record<string, unknown>) => trackerLogs.push(obj),
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => trackerLog,
      };
      const tracker = new DispatchLatencyTracker({ promptId: "msg-1", promptLog: trackerLog });
      const stream = { async *[Symbol.asyncIterator]() {} };
      bridge.agentSessionId = "session-1";
      vi.spyOn(bridge.runtime, "isInitialized", "get").mockReturnValue(true);
      vi.spyOn(bridge.runtime, "subscribeEvents").mockResolvedValue({ stream } as unknown);
      vi.spyOn(bridge.runtime, "sendPrompt").mockResolvedValue(undefined as unknown);
      vi.spyOn(bridge as unknown as Record<string, unknown>, "streamPromptToClient").mockResolvedValue({
        started: true,
      } as unknown);

      const ctx = {
        messageId: "msg-1",
        promptLog: trackerLog,
        promptState: { abortReason: null, dispatchSucceeded: false },
        promptSignal: new AbortController().signal,
        promptDispatchAbort: new AbortController(),
        promptDispatchStillRelevant: false,
        requestedAgent: "build",
        agentRole: "verification",
        agentProfile: "verification",
        requestedProviderID: "openai",
        logToBt: () => {},
        startupAttemptId: "attempt-1",
        dispatchLatencyTracker: tracker,
        dispatchStartedAt: null,
        predispatchLatencyEmitted: true,
        predispatchTimings: {},
        startTime: Date.now(),
        effectiveModel: "gpt-5.4",
        reasoningEffort: "medium",
        isFollowup: false,
        loopState: null,
      };

      await bridge["invokeVerificationPhase"](ctx, {
        invocation: { phase: "planner", attempt: 1 },
        prompt: "Run verification planner",
      });

      expect(
        trackerLogs.some(
          (entry) => entry.event === "prompt.dispatch_subspan" && entry.span === "prompt_sent_to_backend",
        ),
      ).toBe(true);
      expect(ctx.promptState.dispatchSucceeded).toBe(false);
    });

    it("first-prompt dispatch records send span even when prompt becomes irrelevant", async () => {
      bridge.orgMemories = [];
      const trackerLogs: Record<string, unknown>[] = [];
      const trackerLog = {
        info: (obj: Record<string, unknown>) => trackerLogs.push(obj),
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: () => trackerLog,
      };
      const tracker = new DispatchLatencyTracker({ promptId: "msg-1", promptLog: trackerLog });
      const stream = { async *[Symbol.asyncIterator]() {} };
      bridge.agentSessionId = "session-1";
      vi.spyOn(bridge.runtime, "isInitialized", "get").mockReturnValue(true);
      vi.spyOn(bridge.runtime, "sendPrompt").mockResolvedValue(undefined as unknown);
      vi.spyOn(bridge as unknown as Record<string, unknown>, "streamPromptToClient").mockResolvedValue({
        started: true,
      } as unknown);
      vi.spyOn(bridge.promptActivity, "sendAgentProgress").mockImplementation(() => {});
      vi.spyOn(bridge.promptActivity, "withPromptActivityPulse").mockImplementation(
        async (_promptId: string, _phase: string, work: () => Promise<unknown>) => work(),
      );

      const ctx = {
        messageId: "msg-1",
        promptLog: trackerLog,
        promptState: { abortReason: null, dispatchSucceeded: false },
        promptSignal: new AbortController().signal,
        promptDispatchAbort: new AbortController(),
        promptDispatchStillRelevant: false,
        requestedAgent: "build",
        agentRole: "coding",
        agentProfile: "build",
        requestedProviderID: "openai",
        logToBt: () => {},
        startupAttemptId: "attempt-1",
        dispatchLatencyTracker: tracker,
        dispatchStartedAt: null,
        predispatchLatencyEmitted: true,
        predispatchTimings: {},
        startTime: Date.now(),
        effectiveModel: "gpt-5.4",
        reasoningEffort: "medium",
        isFollowup: false,
        stream,
        loopState: new PromptLoopState(),
        promptBody: { parts: [{ type: "text", text: "hello" }], agent: "build" },
        systemContext: { totalTokenCountEstimate: 10 },
        promptStartSnapshot: null,
        preparedUploads: {
          syntheticTextParts: [],
          imageParts: [],
          filesToCommit: [],
          imagesToCommit: [],
          estimatedUploadTokens: 0,
        },
      };

      await bridge["runDispatchPhase"](ctx);

      expect(
        trackerLogs.some(
          (entry) => entry.event === "prompt.dispatch_subspan" && entry.span === "prompt_sent_to_backend",
        ),
      ).toBe(true);
      expect(ctx.promptState.dispatchSucceeded).toBe(false);
    });
  });
});
