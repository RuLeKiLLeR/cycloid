// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Claude translator trace harness.
//
// Fixtures are REAL stream-json captures (CLI 2.1.167) under
// tests/test_sandbox-bridge/fixtures/claude-protocol/2.1.167/. The Agent SDK
// emits the SAME typed `SDKMessage` shapes (system/init, stream_event,
// assistant, user/tool_result, result) the translator consumes, so these
// fixtures still validate it. Re-capturing fixtures from the pinned SDK
// in-sandbox is a follow-up during E2E.
//
// The translator must emit the same durable event contract as the Codex
// translator (token / reasoning / tool_call / tool_update / error /
// raw_agent_runtime) and return a TranslateOutcome that drives the prompt loop.

import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.js";
import {
  ClaudeTurnState,
  translateClaudeEvent,
} from "../../apps/sandbox-bridge/src/services/claude-event-translator.js";

const FIXTURE_DIR = join(__dirname, "fixtures", "claude-protocol", "2.1.167");

function loadFixture(name: string) {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const toolTracker = { startSpan: vi.fn(), endSpan: vi.fn(), forceEndAll: vi.fn(), activeSpanCount: 0 };

function makeDeps(emit) {
  return {
    now: 1000,
    messageId: "msg-1",
    emit,
    logToBt: vi.fn(),
    promptLog: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    markPromptStarted: vi.fn(),
    recordRawFallback: vi.fn(),
  };
}

/** Run a full fixture trace through the translator, collecting emitted events + outcomes. */
async function runTrace(name: string) {
  const events = loadFixture(name);
  const emitted: Array<Record<string, unknown>> = [];
  const deps = makeDeps((e) => emitted.push(e));
  const loopState = new PromptLoopState();
  const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };
  const turnState = new ClaudeTurnState();
  const outcomes: string[] = [];
  for (const ev of events) {
    const outcome = await translateClaudeEvent(ev, deps, loopState, promptState, turnState, toolTracker);
    outcomes.push(outcome.control);
  }
  return { emitted, outcomes, loopState, deps };
}

describe("translateClaudeEvent — text-only turn (real fixture)", () => {
  it("streams reasoning + token deltas and breaks on result", async () => {
    const { emitted, outcomes, loopState } = await runTrace("text-only.ndjson");

    const tokens = emitted.filter((e) => e.type === "token");
    const reasoning = emitted.filter((e) => e.type === "reasoning");

    // The assistant streamed thinking, then the literal word "hello".
    expect(tokens.map((t) => t.content).join("")).toBe("hello");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(reasoning.map((r) => r.content).join("")).toContain("hello");

    // Per-block part ids are stable and namespaced by the assistant message id.
    expect(tokens[0].partId).toMatch(/^msg_[^:]+:\d+$/);

    // No tool_call / tool_update on a text-only turn.
    expect(emitted.some((e) => e.type === "tool_call" || e.type === "tool_update")).toBe(false);

    // result is terminal: idle + BREAK, and never before it.
    expect(loopState.idle).toBe(true);
    expect(outcomes[outcomes.length - 1]).toBe("break");
    expect(outcomes.slice(0, -1)).not.toContain("break");
  });
});

describe("translateClaudeEvent — tool-use turn (real fixture)", () => {
  it("emits tool_call from the assistant snapshot and tool_update from the result turn", async () => {
    const { emitted, outcomes, loopState } = await runTrace("tool-use.ndjson");

    const toolCalls = emitted.filter((e) => e.type === "tool_call");
    const toolUpdates = emitted.filter((e) => e.type === "tool_update");

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool).toBe("Read");
    expect(toolCalls[0].callId).toMatch(/^toolu_/);
    expect(toolCalls[0].args.file_path).toMatch(/note\.txt$/);
    expect(toolCalls[0].summary).toBeTruthy();

    // tool_update reuses the same callId, resolves the tool name from the prior
    // tool_call, and reports a completed status with output sizing.
    expect(toolUpdates).toHaveLength(1);
    expect(toolUpdates[0].callId).toBe(toolCalls[0].callId);
    expect(toolUpdates[0].tool).toBe("Read");
    expect(toolUpdates[0].status).toBe("completed");
    expect(toolUpdates[0].outputChars).toBeGreaterThan(0);

    // tool_call precedes tool_update in the emitted stream.
    expect(emitted.indexOf(toolCalls[0])).toBeLessThan(emitted.indexOf(toolUpdates[0]));

    expect(loopState.toolCallCount).toBe(1);
    expect(loopState.idle).toBe(true);
    expect(outcomes[outcomes.length - 1]).toBe("break");
  });
});

describe("translateClaudeEvent — unhandled records", () => {
  it("routes an unknown top-level event type to raw_agent_runtime drift", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const outcome = await translateClaudeEvent(
      { type: "some_future_event", foo: 1 },
      deps,
      new PromptLoopState(),
      { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} },
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(outcome.control).toBe("next");
    expect(deps.recordRawFallback).toHaveBeenCalledWith({ eventType: "some_future_event" });
    expect(emitted).toEqual([{ type: "raw_agent_runtime", eventType: "some_future_event" }]);
  });

  it("surfaces unknown assistant/user snapshot block types as drift, skipping known ones", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const loopState = new PromptLoopState();
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };
    const turnState = new ClaudeTurnState();

    // Known blocks (text/thinking on assistant, text on user) are dropped silently;
    // genuinely new block types surface as raw_agent_runtime drift.
    await translateClaudeEvent(
      { type: "assistant", message: { content: [{ type: "text" }, { type: "image" }] } },
      deps,
      loopState,
      promptState,
      turnState,
      toolTracker,
    );
    await translateClaudeEvent(
      { type: "user", message: { content: [{ type: "text" }, { type: "container_upload" }] } },
      deps,
      loopState,
      promptState,
      turnState,
      toolTracker,
    );

    expect(deps.recordRawFallback).toHaveBeenCalledWith({ partType: "assistant.image" });
    expect(deps.recordRawFallback).toHaveBeenCalledWith({ partType: "user.container_upload" });
    expect(emitted).toEqual([
      { type: "raw_agent_runtime", eventType: "assistant.image" },
      { type: "raw_agent_runtime", eventType: "user.container_upload" },
    ]);
  });

  it("translates an error result into an error event and breaks", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };
    const outcome = await translateClaudeEvent(
      { type: "result", subtype: "error", is_error: true, result: "boom" },
      deps,
      new PromptLoopState(),
      promptState,
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(outcome.control).toBe("break");
    expect(emitted[0].type).toBe("error");
    expect(emitted[0].error).toBe("boom");
    expect(promptState.abortReason).toContain("boom");
  });

  it("translates an SDK-shaped error result (errors[] + error_during_execution) and breaks", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };
    const outcome = await translateClaudeEvent(
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["sdk boom"] },
      deps,
      new PromptLoopState(),
      promptState,
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(outcome.control).toBe("break");
    expect(emitted[0].type).toBe("error");
    expect(emitted[0].error).toBe("sdk boom");
    expect(promptState.abortReason).toContain("sdk boom");
  });
});

describe("translateClaudeEvent — SDK lifecycle + permission gate", () => {
  it("marks prompt-start on system/init without emitting a durable event", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const outcome = await translateClaudeEvent(
      { type: "system", subtype: "init", session_id: "s", model: "claude-opus-4-8" },
      deps,
      new PromptLoopState(),
      { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} },
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(outcome.control).toBe("next");
    expect(deps.markPromptStarted).toHaveBeenCalledWith("system_init");
    expect(emitted).toEqual([]);
    expect(deps.recordRawFallback).not.toHaveBeenCalled();
  });

  it("finalizes a permission_denied tool call as an errored tool_update and dedupes the follow-up tool_result", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const endSpan = vi.fn();
    const tracker = { startSpan: vi.fn(), endSpan, forceEndAll: vi.fn(), activeSpanCount: 0 };
    const deps = makeDeps((e) => emitted.push(e));
    const loopState = new PromptLoopState();
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };
    const turnState = new ClaudeTurnState();

    // Assistant emits the tool_use (starts the span), then the gate denies it.
    await translateClaudeEvent(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "rm -rf /" } }] },
      },
      deps,
      loopState,
      promptState,
      turnState,
      tracker,
    );
    await translateClaudeEvent(
      {
        type: "system",
        subtype: "permission_denied",
        tool_use_id: "toolu_1",
        tool_name: "Bash",
        message: "Access denied",
      },
      deps,
      loopState,
      promptState,
      turnState,
      tracker,
    );
    // The SDK also delivers an errored tool_result for the denied call — must not double-emit.
    await translateClaudeEvent(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Access denied" }],
        },
      },
      deps,
      loopState,
      promptState,
      turnState,
      tracker,
    );

    const updates = emitted.filter((e) => e.type === "tool_update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ callId: "toolu_1", tool: "Bash", status: "error" });
    expect(endSpan).toHaveBeenCalledTimes(1);
    // 5th arg is the model-facing denial reason, now logged as the span output.
    expect(endSpan).toHaveBeenCalledWith("toolu_1", "error", expect.anything(), undefined, expect.any(String));
    expect(deps.logToBt).toHaveBeenCalledWith("tool_denied", expect.objectContaining({ tool: "Bash" }));
  });
});

describe("translateClaudeEvent — per-prompt usage telemetry", () => {
  it("emits one usage event from the text-only result, mapping Anthropic fields without re-subtracting cache", async () => {
    const { emitted } = await runTrace("text-only.ndjson");
    const usage = emitted.filter((e) => e.type === "usage");

    expect(usage).toHaveLength(1);
    // Anthropic `input_tokens` (10) already excludes the 17786 cache-read tokens,
    // so it must pass through verbatim — NOT 10-17786 clamped to 0.
    expect(usage[0]).toMatchObject({
      type: "usage",
      inputTokens: 10,
      outputTokens: 42,
      cacheReadTokens: 17786,
      cacheWriteTokens: 8819,
      contextTokens: 10 + 17786 + 8819,
      totalCostUsd: 0.01302235,
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("emits usage from the tool-use result with the SDK-authoritative cost", async () => {
    const { emitted } = await runTrace("tool-use.ndjson");
    const usage = emitted.filter((e) => e.type === "usage");

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 18,
      outputTokens: 176,
      cacheReadTokens: 44403,
      cacheWriteTokens: 8974,
      totalCostUsd: 0.0165558,
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("emits usage on an error result that carries usage, before the error event", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };
    await translateClaudeEvent(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"],
        total_cost_usd: 0.5,
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
      },
      deps,
      new PromptLoopState(),
      promptState,
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(emitted.map((e) => e.type)).toEqual(["usage", "error"]);
    expect(emitted[0]).toMatchObject({ inputTokens: 7, cacheReadTokens: 100, totalCostUsd: 0.5 });
  });

  it("emits no usage event when the result carries no usage (minimal synthetic error)", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    await translateClaudeEvent(
      { type: "result", subtype: "error", is_error: true, result: "boom" },
      deps,
      new PromptLoopState(),
      { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} },
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(emitted.some((e) => e.type === "usage")).toBe(false);
  });

  it("emits no usage event when every token bucket is zero", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    await translateClaudeEvent(
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      deps,
      new PromptLoopState(),
      { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} },
      new ClaudeTurnState(),
      toolTracker,
    );
    expect(emitted.some((e) => e.type === "usage")).toBe(false);
  });

  it("attributes the dominant model when a result mixes models", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    await translateClaudeEvent(
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 1,
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {
          "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 10 },
          "claude-opus-4-8": { inputTokens: 5000, outputTokens: 4000 },
        },
      },
      deps,
      new PromptLoopState(),
      { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} },
      new ClaudeTurnState(),
      toolTracker,
    );
    const usage = emitted.find((e) => e.type === "usage");
    expect(usage?.model).toBe("claude-opus-4-8");
  });

  it("counts cache tokens when ranking the dominant model", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    await translateClaudeEvent(
      {
        type: "result",
        subtype: "success",
        total_cost_usd: 1,
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {
          // Fewer raw tokens but the bulk of the work came through cache reads —
          // must still win over the small compaction model.
          "claude-opus-4-8": { inputTokens: 20, outputTokens: 20, cacheReadInputTokens: 90000 },
          "claude-haiku-4-5-20251001": { inputTokens: 500, outputTokens: 500 },
        },
      },
      deps,
      new PromptLoopState(),
      { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} },
      new ClaudeTurnState(),
      toolTracker,
    );
    const usage = emitted.find((e) => e.type === "usage");
    expect(usage?.model).toBe("claude-opus-4-8");
  });
});

describe("translateClaudeEvent — bridge-synthetic question", () => {
  it("emits a durable question event, marks prompt started, and counts the question", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const loopState = new PromptLoopState();
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };

    const outcome = await translateClaudeEvent(
      {
        type: "cycloid_question",
        id: "q-1",
        question: "Which database should we use?",
        options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }, "redis", { bogus: true }],
      },
      deps,
      loopState,
      promptState,
      new ClaudeTurnState(),
      toolTracker,
    );

    expect(outcome.control).toBe("next");
    expect(deps.markPromptStarted).toHaveBeenCalledWith("question.asked");
    expect(loopState.questionCount).toBe(1);
    expect(emitted).toEqual([
      {
        type: "question",
        questionId: "q-1",
        question: "Which database should we use?",
        options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }, "redis"],
      },
    ]);
    expect(deps.logToBt).toHaveBeenCalledWith("question", expect.objectContaining({ questionId: "q-1" }));
  });

  it("omits options when none are usable", async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const deps = makeDeps((e) => emitted.push(e));
    const loopState = new PromptLoopState();
    const promptState = { abortReason: null, dispatchSucceeded: true, promptRetryCountsByErrorCode: {} };

    await translateClaudeEvent(
      { type: "cycloid_question", id: "q-2", question: "Free-form?", options: [] },
      deps,
      loopState,
      promptState,
      new ClaudeTurnState(),
      toolTracker,
    );

    expect(emitted[0]).toEqual({ type: "question", questionId: "q-2", question: "Free-form?" });
  });
});
