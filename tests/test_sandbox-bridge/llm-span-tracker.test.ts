// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Unit tests for the Braintrust per-call llm span tracker: streaming lifecycle
// (Claude message_start..message_stop), retrospective one-shot recording
// (opencode/Codex completed assistant messages), dedupe, leak force-end, and
// degradation safety (a span failure never throws into the prompt stream).

import { describe, expect, it, vi } from "vitest";

import { LlmSpanTracker } from "../../apps/sandbox-bridge/src/trackers/llm-span-tracker.js";

function makeFakeParentSpan() {
  const children: Array<{ opts: Record<string, unknown>; span: ReturnType<typeof makeChild> }> = [];
  function makeChild() {
    return { id: `child-${children.length}`, log: vi.fn(), end: vi.fn(), startSpan: vi.fn() };
  }
  const parent = {
    id: "root-1",
    log: vi.fn(),
    end: vi.fn(),
    startSpan: vi.fn((opts: Record<string, unknown>) => {
      const span = makeChild();
      children.push({ opts, span });
      return span;
    }),
  };
  return { parent, children };
}

function makeTracker(parent: unknown) {
  return new LlmSpanTracker({
    getActiveBtPromptSpan: () => parent,
    getSessionId: () => "session-1",
    getSandboxId: () => "sandbox-1",
    getPromptId: () => "prompt-1",
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  });
}

describe("LlmSpanTracker", () => {
  it("opens an llm-typed child span on startCall and closes it with usage, text, and latency", () => {
    const { parent, children } = makeFakeParentSpan();
    const tracker = makeTracker(parent);

    tracker.startCall("call-1", {
      now: 1_000,
      model: "claude-fable-5",
      inputTokens: 12,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
    });
    tracker.appendText("call-1", "Hello ");
    tracker.appendText("call-1", "world");
    tracker.appendReasoning("call-1", "thinking...");
    tracker.noteUsage("call-1", { outputTokens: 42, stopReason: "end_turn" });
    tracker.endCall("call-1", 3_500);

    expect(parent.startSpan).toHaveBeenCalledTimes(1);
    const { opts, span } = children[0];
    expect(opts.name).toBe("llm:claude-fable-5");
    expect(opts.type).toBe("llm");
    expect(span.log).toHaveBeenCalledTimes(1);
    const logged = span.log.mock.calls[0][0];
    expect(logged.output.text).toBe("Hello world");
    expect(logged.output.reasoning).toBe("thinking...");
    expect(logged.metadata.model).toBe("claude-fable-5");
    expect(logged.metadata.stopReason).toBe("end_turn");
    // prompt_tokens = input + cacheRead + cacheWrite; Braintrust-native names.
    expect(logged.metrics.prompt_tokens).toBe(117);
    expect(logged.metrics.completion_tokens).toBe(42);
    expect(logged.metrics.tokens).toBe(159);
    expect(logged.metrics.durationMs).toBe(2_500);
    expect(span.end).toHaveBeenCalledTimes(1);
    expect(tracker.activeCallCount).toBe(0);
  });

  it("records a retrospective completed call one-shot and dedupes repeats by call id", () => {
    const { parent, children } = makeFakeParentSpan();
    const tracker = makeTracker(parent);

    const call = {
      callId: "msg-9",
      model: "gpt-5.4-mini",
      startedAt: 10_000,
      endedAt: 14_000,
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      costUsd: 0.0123,
      outputText: "final answer",
    };
    expect(tracker.recordCompletedCall(call, 20_000)).toBe(true);
    // Re-fired message.updated — must not duplicate, and must report false so
    // callers skip side effects (cost accumulation) on the repeat.
    expect(tracker.recordCompletedCall(call, 21_000)).toBe(false);

    expect(parent.startSpan).toHaveBeenCalledTimes(1);
    const { opts, span } = children[0];
    expect(opts.name).toBe("llm:gpt-5.4-mini");
    expect(opts.type).toBe("llm");
    expect(opts.event.metadata.costUsd).toBe(0.0123);
    const logged = span.log.mock.calls[0][0];
    expect(logged.output.text).toBe("final answer");
    expect(logged.metrics.prompt_tokens).toBe(250);
    expect(logged.metrics.completion_tokens).toBe(80);
    expect(logged.metrics.durationMs).toBe(4_000);
    expect(span.end).toHaveBeenCalledTimes(1);
  });

  it("aggregates incremental deltas into one span per call, flushed at teardown", () => {
    const { parent, children } = makeFakeParentSpan();
    const tracker = makeTracker(parent);

    // Codex-style: the same message updates its counts twice (no completion
    // signal). Deltas must SUM into one span, not two, and not freeze at the
    // first partial.
    tracker.accumulateCall("msg-a", {
      model: "gpt-5.4-mini",
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      outputText: "partial",
    });
    tracker.accumulateCall("msg-a", {
      inputTokens: 40,
      outputTokens: 35,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      costUsd: 0.0015,
      outputText: "final text",
    });
    // Nothing records until teardown.
    expect(parent.startSpan).not.toHaveBeenCalled();

    const leaked = tracker.forceEndAll(9_000);

    // Flushed retro aggregates are normal completions, not leaks.
    expect(leaked).toBe(0);
    expect(parent.startSpan).toHaveBeenCalledTimes(1);
    const { opts, span } = children[0];
    expect(opts.type).toBe("llm");
    expect(opts.event.metadata.costUsd).toBeCloseTo(0.0025, 10);
    const logged = span.log.mock.calls[0][0];
    expect(logged.metrics.prompt_tokens).toBe(137); // (80+40) + (10+5) + (0+2)
    expect(logged.metrics.completion_tokens).toBe(55);
    expect(logged.output.text).toBe("final text"); // latest full text wins
    expect(span.end).toHaveBeenCalledTimes(1);

    // A second teardown must not re-record the flushed call.
    tracker.forceEndAll(10_000);
    expect(parent.startSpan).toHaveBeenCalledTimes(1);
  });

  it("force-ends leaked open calls and reports the count", () => {
    const { parent, children } = makeFakeParentSpan();
    const tracker = makeTracker(parent);

    tracker.startCall("leak-1", { now: 1_000, model: "m" });
    tracker.startCall("leak-2", { now: 1_200 });
    expect(tracker.activeCallCount).toBe(2);

    const leaked = tracker.forceEndAll(2_000);

    expect(leaked).toBe(2);
    expect(tracker.activeCallCount).toBe(0);
    for (const { span } of children) {
      expect(span.end).toHaveBeenCalledTimes(1);
    }
  });

  it("never throws into the prompt stream when the span source fails", () => {
    const throwingParent = {
      id: "root-x",
      log: vi.fn(),
      end: vi.fn(),
      startSpan: vi.fn(() => {
        throw new Error("bt down");
      }),
    };
    const tracker = makeTracker(throwingParent);

    expect(() => tracker.startCall("c1", { now: 1 })).not.toThrow();
    expect(() => tracker.recordCompletedCall({ callId: "c2", inputTokens: 1, outputTokens: 1 }, 2)).not.toThrow();
    // Calls against a never-opened id are safe no-ops.
    expect(() => tracker.appendText("c1", "x")).not.toThrow();
    expect(() => tracker.endCall("c1", 5)).not.toThrow();
    expect(tracker.activeCallCount).toBe(0);
  });
});
