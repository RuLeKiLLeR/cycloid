// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Focused tests for assistant text recording into PromptLoopState.
//
// The Claude translator streams text to the UI via `token` events but must
// also record the fully assembled text into loop state, because every
// downstream consumer of the final message (PR `## Summary`, post-execution
// narrative, response assertions) reads `loopState.latestResponseText()` /
// `responseTextByPartId`. Before this suite existed, the Claude path never
// wrote loop state text and 100% of claude_code PRs published the
// "No summary was captured from the agent." placeholder.

import { readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it, vi } from "vitest";

import { PromptLoopState } from "../../apps/sandbox-bridge/src/prompt-loop-state.js";
import {
  ClaudeTurnState,
  translateClaudeEvent,
} from "../../apps/sandbox-bridge/src/services/claude-event-translator.js";

const FIXTURE_DIR = join(__dirname, "fixtures", "claude-protocol", "2.1.167");

const toolTracker = { startSpan: vi.fn(), endSpan: vi.fn(), forceEndAll: vi.fn(), activeSpanCount: 0 };

function makeDeps(emit = () => {}) {
  return {
    now: 1000,
    messageId: "msg-1",
    emit,
    logToBt: vi.fn(),
    promptLog: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    markPromptStarted: vi.fn(),
    recordRawFallback: vi.fn(),
    emitMemoryRecallUsage: vi.fn(),
  };
}

function makeHarness() {
  const emitted: Array<Record<string, unknown>> = [];
  const deps = makeDeps((e) => emitted.push(e));
  const loopState = new PromptLoopState();
  const promptState = {
    abortReason: null,
    dispatchSucceeded: true,
    handledAutomaticallyBlockCount: 0,
    promptRetryCount: 0,
    promptRetryCountsByErrorCode: {},
  };
  const turnState = new ClaudeTurnState();
  const translate = (event) => translateClaudeEvent(event, deps, loopState, promptState, turnState, toolTracker);
  return { emitted, deps, loopState, promptState, turnState, translate };
}

function makeHarnessForRepo(repoRoot: string) {
  const emitted: Array<Record<string, unknown>> = [];
  const deps = makeDeps((e) => emitted.push(e));
  const loopState = new PromptLoopState();
  const promptState = {
    abortReason: null,
    dispatchSucceeded: true,
    handledAutomaticallyBlockCount: 0,
    promptRetryCount: 0,
    promptRetryCountsByErrorCode: {},
  };
  const turnState = new ClaudeTurnState(repoRoot);
  const translate = (event) => translateClaudeEvent(event, deps, loopState, promptState, turnState, toolTracker);
  return { emitted, deps, loopState, promptState, turnState, translate };
}

function streamTextDelta(messageId: string, index: number, text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  };
}

function assistantSnapshot(messageId: string, content: Array<Record<string, unknown>>) {
  return { type: "assistant", message: { role: "assistant", id: messageId, content } };
}

function userSnapshot(messageId: string, content: Array<Record<string, unknown>>) {
  return { type: "user", message: { role: "user", id: messageId, content } };
}

describe("translateClaudeEvent — assistant text recording", () => {
  it("logs sandbox_agent.rate_limited for non-allowed Claude rate_limit_event statuses", async () => {
    const { translate, deps } = makeHarness();
    deps.effectiveModel = "claude-sonnet-4-6";

    const outcome = await translate({
      type: "rate_limit_event",
      rate_limit_info: { status: "rate_limited", rateLimitType: "five_hour" },
    });

    expect(outcome).toEqual({ control: "next" });
    expect(deps.promptLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sandbox_agent.rate_limited",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        agent_runtime_backend: "claude_code",
        reason: "rate_limited",
        rate_limit_type: "five_hour",
      }),
      "Sandbox agent rate limited",
    );
  });

  it("records snapshot text into loop state exactly once for a streamed turn", async () => {
    const { translate, loopState, emitted } = makeHarness();

    // message_start pins the message id, deltas stream the text (content index 1,
    // because a thinking block occupies index 0), then the per-block snapshot
    // carries the assembled text in a single-element content array.
    await translate({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_a" } },
    });
    await translate(streamTextDelta("msg_a", 1, "hel"));
    await translate(streamTextDelta("msg_a", 1, "lo"));
    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "hello" }]));

    expect(loopState.latestResponseText()).toBe("hello");
    expect([...loopState.responseTextByPartId.entries()]).toEqual([["msg_a:text:0", "hello"]]);

    // Streaming behavior is unchanged: deltas still emit token events and the
    // snapshot does not re-emit them.
    expect(emitted.filter((e) => e.type === "token").map((e) => e.content)).toEqual(["hel", "lo"]);
  });

  it("populates loop state from the snapshot alone on a non-streaming turn", async () => {
    const { translate, loopState } = makeHarness();

    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "done, no deltas" }]));

    expect(loopState.latestResponseText()).toBe("done, no deltas");
  });

  it("gives distinct text blocks of one message distinct parts (per-block snapshots)", async () => {
    const { translate, loopState } = makeHarness();

    // Real captures emit one assistant snapshot per content block, each with a
    // single-element content array — so the array index is always 0 and cannot
    // be used as the partId. Distinct text must not collide into one part.
    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "first part" }]));
    await translate(assistantSnapshot("msg_a", [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }]));
    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "second" }]));

    expect([...loopState.responseTextByPartId.values()]).toEqual(["first part", "second"]);
    expect(loopState.latestResponseText()).toBe("second");
    expect(loopState.latestMessageResponseText()).toBe("second");
  });

  it("collapses a re-snapshotted identical text block instead of duplicating it", async () => {
    const { translate, loopState } = makeHarness();

    // A consolidated snapshot after the per-block snapshot repeats the same
    // text; the tracker's identical-text alias keeps a single part.
    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "hello" }]));
    await translate(
      assistantSnapshot("msg_a", [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "hello" },
      ]),
    );

    expect([...loopState.responseTextByPartId.entries()]).toEqual([["msg_a:text:0", "hello"]]);
  });

  it("keeps text from multiple assistant messages, latest last", async () => {
    const { translate, loopState } = makeHarness();

    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "looking at the repo" }]));
    await translate(assistantSnapshot("msg_b", [{ type: "text", text: "final answer" }]));

    expect([...loopState.responseTextByPartId.values()]).toEqual(["looking at the repo", "final answer"]);
    expect(loopState.latestResponseText()).toBe("final answer");
  });

  it("ignores empty text blocks so they cannot clobber the final response", async () => {
    const { translate, loopState } = makeHarness();

    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "real text" }]));
    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "" }]));

    expect([...loopState.responseTextByPartId.values()]).toEqual(["real text"]);
    expect(loopState.latestResponseText()).toBe("real text");
  });

  it("records external-state references from snapshot text (Codex-path parity)", async () => {
    const { translate, loopState } = makeHarness();
    expect(loopState.referencedExternalState).toBe(false);

    await translate(assistantSnapshot("msg_a", [{ type: "text", text: "see PR #123 for context" }]));

    expect(loopState.referencedExternalState).toBe(true);
  });

  it.each(["Edit", "Write", "MultiEdit"])(
    "counts completed Claude %s calls as edit attempts and successful edits",
    async (toolName) => {
      const { translate, loopState } = makeHarness();

      await translate(
        assistantSnapshot("msg_a", [
          { type: "tool_use", id: `toolu_${toolName}`, name: toolName, input: { file_path: "src/app.ts" } },
        ]),
      );
      expect(loopState.editCount).toBe(1);
      expect(loopState.successfulEditCount).toBe(0);

      await translate(
        userSnapshot("msg_b", [
          { type: "tool_result", tool_use_id: `toolu_${toolName}`, is_error: false, content: "updated" },
        ]),
      );

      expect(loopState.editCount).toBe(1);
      expect(loopState.successfulEditCount).toBe(1);
    },
  );

  it("does not count errored Claude edit results as successful edits", async () => {
    const { translate, loopState } = makeHarness();

    await translate(
      assistantSnapshot("msg_a", [
        { type: "tool_use", id: "toolu_edit_error", name: "Edit", input: { file_path: "src/app.ts" } },
      ]),
    );
    await translate(
      userSnapshot("msg_b", [
        { type: "tool_result", tool_use_id: "toolu_edit_error", is_error: true, content: "failed" },
      ]),
    );

    expect(loopState.editCount).toBe(1);
    expect(loopState.successfulEditCount).toBe(0);
  });

  describe("Bash is_error reclassification", () => {
    // The SDK sets is_error on Bash purely from a non-zero exit, so benign
    // commands (grep no-match, diff, failing tests) arrive flagged as errors.
    // Only genuine execution failures should keep the error status.
    async function bashResultStatus(content: string) {
      const { translate, emitted } = makeHarness();
      await translate(
        assistantSnapshot("msg_a", [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "run" } }]),
      );
      await translate(
        userSnapshot("msg_b", [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true, content }]),
      );
      const update = emitted.find((e) => e.type === "tool_update" && e.callId === "toolu_bash");
      return update?.status;
    }

    it("downgrades benign non-zero Bash exits to completed", async () => {
      // grep no-match: empty output
      expect(await bashResultStatus("")).toBe("completed");
      // diff reporting differences
      expect(await bashResultStatus("< old\n> new")).toBe("completed");
      // a test suite that ran but reported failures
      expect(await bashResultStatus("Tests: 1 failed, 4 passed")).toBe("completed");
    });

    it("keeps error status for genuine Bash execution failures", async () => {
      expect(await bashResultStatus("Error: Command timed out after 120000ms")).toBe("error");
      expect(await bashResultStatus("bash: rga: command not found")).toBe("error");
      expect(await bashResultStatus("FATAL ERROR: JavaScript heap out of memory")).toBe("error");
    });

    it("still honors is_error for non-Bash tools", async () => {
      const { translate, emitted } = makeHarness();
      await translate(
        assistantSnapshot("msg_a", [{ type: "tool_use", id: "toolu_mcp", name: "mcp__linear__search", input: {} }]),
      );
      await translate(
        userSnapshot("msg_b", [
          { type: "tool_result", tool_use_id: "toolu_mcp", is_error: true, content: "no results" },
        ]),
      );
      const update = emitted.find((e) => e.type === "tool_update" && e.callId === "toolu_mcp");
      expect(update?.status).toBe("error");
    });
  });

  it("emits patch events with repo-relative files after successful Claude edit tools", async () => {
    const repoRoot = process.cwd();
    const { translate, emitted } = makeHarnessForRepo(repoRoot);

    await translate(
      assistantSnapshot("msg_a", [
        { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: resolve(repoRoot, "src/app.ts") } },
      ]),
    );
    expect(emitted.some((event) => event.type === "patch")).toBe(false);

    await translate(userSnapshot("msg_b", [{ type: "tool_result", tool_use_id: "toolu_edit", content: "updated" }]));

    expect(emitted.filter((event) => event.type === "patch")).toEqual([{ type: "patch", files: ["src/app.ts"] }]);
  });

  it("emits patch events for successful Claude NotebookEdit tools", async () => {
    const repoRoot = process.cwd();
    const { translate, emitted } = makeHarnessForRepo(repoRoot);

    await translate(
      assistantSnapshot("msg_a", [
        {
          type: "tool_use",
          id: "toolu_notebook",
          name: "NotebookEdit",
          input: { notebook_path: resolve(repoRoot, "notebooks/demo.ipynb") },
        },
      ]),
    );
    await translate(
      userSnapshot("msg_b", [{ type: "tool_result", tool_use_id: "toolu_notebook", content: "updated" }]),
    );

    expect(emitted.filter((event) => event.type === "patch")).toEqual([
      { type: "patch", files: ["notebooks/demo.ipynb"] },
    ]);
  });

  it("does not emit patch events for failed Claude edit results", async () => {
    const repoRoot = process.cwd();
    const { translate, emitted } = makeHarnessForRepo(repoRoot);

    await translate(
      assistantSnapshot("msg_a", [
        { type: "tool_use", id: "toolu_edit", name: "Write", input: { file_path: resolve(repoRoot, "src/app.ts") } },
      ]),
    );
    await translate(
      userSnapshot("msg_b", [
        { type: "tool_result", tool_use_id: "toolu_edit", is_error: true, content: "permission denied" },
      ]),
    );

    expect(emitted.some((event) => event.type === "patch")).toBe(false);
  });

  it("does not emit patch events for Claude edit paths outside the repo", async () => {
    const repoRoot = process.cwd();
    const { translate, emitted } = makeHarnessForRepo(repoRoot);

    await translate(
      assistantSnapshot("msg_a", [
        { type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: resolve(repoRoot, "../outside.ts") } },
      ]),
    );
    await translate(userSnapshot("msg_b", [{ type: "tool_result", tool_use_id: "toolu_edit", content: "updated" }]));

    expect(emitted.some((event) => event.type === "patch")).toBe(false);
  });

  it("emits a retry_status event from the synthetic cycloid_retry_status record", async () => {
    const { translate, emitted } = makeHarness();

    await translate({ type: "cycloid_retry_status", attempt: 2, maxAttempts: 3, delayMs: 1000 });

    expect(emitted.filter((event) => event.type === "retry_status")).toEqual([
      {
        type: "retry_status",
        attempt: 2,
        maxAttempts: 3,
        message: "Retrying Anthropic request (attempt 2/3)",
        nextRetryAt: new Date(1000 + 1000).toISOString(),
        provider: "Anthropic",
      },
    ]);
  });

  it("omits maxAttempts from retry_status when it is unknown", async () => {
    const { translate, emitted } = makeHarness();

    await translate({ type: "cycloid_retry_status", attempt: 1, delayMs: 0 });

    const retry = emitted.find((event) => event.type === "retry_status");
    expect(retry).toMatchObject({ type: "retry_status", attempt: 1, provider: "Anthropic" });
    expect(retry).not.toHaveProperty("maxAttempts");
    expect(retry.message).toBe("Retrying Anthropic request (attempt 1)");
  });

  it("redacts projected first-party dynamic tool inputs before emitting persisted tool calls", async () => {
    const { translate, emitted } = makeHarness();

    await translate(
      assistantSnapshot("msg_a", [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__cycloid_first_party_dynamic_tools__cloudflare__query_d1",
          input: { sql: "select * from users where email = 'ada@example.com'", params: ["ada@example.com"] },
        },
      ]),
    );

    expect(emitted.find((event) => event.type === "tool_call")).toMatchObject({
      type: "tool_call",
      args: { sql: "select * from users where email = '?'", paramCount: 1 },
    });
    expect(toolTracker.startSpan).toHaveBeenLastCalledWith(
      "toolu_1",
      "mcp__cycloid_first_party_dynamic_tools__cloudflare__query_d1",
      { sql: "select * from users where email = '?'", paramCount: 1 },
    );
  });

  it("does not redact unrelated project MCP tools with first-party-looking names", async () => {
    const { translate, emitted } = makeHarness();

    await translate(
      assistantSnapshot("msg_a", [
        {
          type: "tool_use",
          id: "toolu_project",
          name: "cloudflare__query_d1",
          input: { sql: "select * from users where email = 'ada@example.com'", params: ["ada@example.com"] },
        },
      ]),
    );

    expect(emitted.find((event) => event.type === "tool_call")).toMatchObject({
      type: "tool_call",
      tool: "cloudflare__query_d1",
      args: { sql: "select * from users where email = 'ada@example.com'", params: ["ada@example.com"] },
    });
  });

  it("routes memory recall telemetry through the shared usage emitter", async () => {
    const { translate, deps } = makeHarness();
    const event = {
      type: "memory.recall.telemetry",
      properties: {
        sessionID: "s",
        eventName: "memory_recall.requested",
        requestedMemoryIds: ["mem-live-1"],
      },
    };

    await translate(event);

    expect(deps.emitMemoryRecallUsage).toHaveBeenCalledWith(event, "msg-1", 1000);
  });

  it("populates the final response text from the real text-only fixture", async () => {
    const { translate, loopState } = makeHarness();
    const events = readFileSync(join(FIXTURE_DIR, "text-only.ndjson"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));

    for (const event of events) await translate(event);

    // The fixture's assistant streamed thinking, then the literal word "hello".
    // Thinking snapshots must not be recorded as response text.
    expect(loopState.latestResponseText()).toBe("hello");
    expect([...loopState.responseTextByPartId.values()]).toEqual(["hello"]);
  });
});

// ── Braintrust per-call llm spans (message_start .. message_stop) ──

function makeLlmSpansFake() {
  return {
    startCall: vi.fn(),
    appendText: vi.fn(),
    appendReasoning: vi.fn(),
    noteUsage: vi.fn(),
    endCall: vi.fn(),
    recordCompletedCall: vi.fn(),
    forceEndAll: vi.fn(() => 0),
    activeCallCount: 0,
  };
}

function makeLlmHarness() {
  const llmSpans = makeLlmSpansFake();
  const deps = { ...makeDeps(), llmSpans };
  const loopState = new PromptLoopState();
  const promptState = {
    abortReason: null,
    dispatchSucceeded: true,
    handledAutomaticallyBlockCount: 0,
    promptRetryCount: 0,
    promptRetryCountsByErrorCode: {},
  };
  const turnState = new ClaudeTurnState();
  const translate = (event) => translateClaudeEvent(event, deps, loopState, promptState, turnState, toolTracker);
  return { llmSpans, deps, turnState, translate };
}

describe("Braintrust llm span lifecycle", () => {
  it("opens an llm call on message_start with model and input-side usage", async () => {
    const { llmSpans, turnState, translate } = makeLlmHarness();

    await translate({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "msg_abc",
          model: "claude-fable-5",
          usage: { input_tokens: 18, cache_read_input_tokens: 44_000, cache_creation_input_tokens: 120 },
        },
      },
    });

    expect(llmSpans.startCall).toHaveBeenCalledWith("msg_abc", {
      now: 1000,
      model: "claude-fable-5",
      inputTokens: 18,
      cacheReadTokens: 44_000,
      cacheWriteTokens: 120,
    });
    expect(turnState.activeLlmCallId).toBe("msg_abc");
  });

  it("routes text and thinking deltas into the active call and closes it on message_stop", async () => {
    const { llmSpans, turnState, translate } = makeLlmHarness();

    await translate({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_abc", model: "claude-fable-5" } },
    });
    await translate({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } },
    });
    await translate({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } },
    });
    await translate({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 77 } },
    });
    await translate({ type: "stream_event", event: { type: "message_stop" } });

    expect(llmSpans.appendReasoning).toHaveBeenCalledWith("msg_abc", "hmm ");
    expect(llmSpans.appendText).toHaveBeenCalledWith("msg_abc", "Answer");
    expect(llmSpans.noteUsage).toHaveBeenCalledWith("msg_abc", { outputTokens: 77, stopReason: "end_turn" });
    expect(llmSpans.endCall).toHaveBeenCalledWith("msg_abc", 1000);
    expect(turnState.activeLlmCallId).toBeNull();
  });

  it("brackets each model call separately across a multi-call turn", async () => {
    const { llmSpans, translate } = makeLlmHarness();

    await translate({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_1", model: "claude-fable-5" } },
    });
    await translate({ type: "stream_event", event: { type: "message_stop" } });
    await translate({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_2", model: "claude-fable-5" } },
    });
    await translate({ type: "stream_event", event: { type: "message_stop" } });

    expect(llmSpans.startCall).toHaveBeenCalledTimes(2);
    expect(llmSpans.endCall).toHaveBeenNthCalledWith(1, "msg_1", 1000);
    expect(llmSpans.endCall).toHaveBeenNthCalledWith(2, "msg_2", 1000);
  });

  it("translates the full stream without llmSpans wired (optional dep guard)", async () => {
    const { translate } = makeHarness();

    await expect(
      translate({
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_abc", model: "claude-fable-5" } },
      }),
    ).resolves.toEqual({ control: "next" });
    await expect(translate({ type: "stream_event", event: { type: "message_stop" } })).resolves.toEqual({
      control: "next",
    });
  });
});

describe("Braintrust turn cost", () => {
  it("accumulates the terminal result's per-turn cost onto loop state", async () => {
    const { translate, loopState } = makeHarness();

    await translate({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 18, output_tokens: 42, cache_read_input_tokens: 44_000 },
      modelUsage: { "claude-fable-5": { inputTokens: 18, outputTokens: 42, cacheReadInputTokens: 44_000 } },
      total_cost_usd: 0.0731,
    });

    expect(loopState.totalCostUsd).toBeCloseTo(0.0731, 10);
  });
});

describe("translateClaudeEvent — model refusal fallback", () => {
  it("waits for the fallback result and completes normally", async () => {
    const { translate, emitted, loopState, promptState, deps } = makeHarness();

    await expect(
      translate({
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        direction: "retry",
        original_model: "claude-fable-5",
        fallback_model: "claude-sonnet-5",
        api_refusal_category: "cyber",
        api_refusal_explanation: "policy explanation",
      }),
    ).resolves.toMatchObject({ control: "next" });

    await expect(
      translate({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "fallback response",
        stop_reason: "end_turn",
      }),
    ).resolves.toMatchObject({ control: "break" });

    expect(loopState.idle).toBe(true);
    expect(promptState.abortReason).toBeNull();
    expect(emitted.filter((event) => event.type === "error")).toHaveLength(0);
    expect(emitted.filter((event) => event.type === "raw_agent_runtime")).toHaveLength(0);
    expect(deps.markPromptStarted).toHaveBeenCalledWith("model_refusal_fallback");
  });
});

describe("translateClaudeEvent — throughput/efficiency telemetry (ARC-1580)", () => {
  function infoCallsWithEvent(deps, eventName: string) {
    return deps.promptLog.info.mock.calls.filter((c) => c[0]?.event === eventName);
  }

  it("logs sandbox_agent.rate_limited when rate_limit_info status is not allowed", async () => {
    const { translate, deps, emitted } = makeHarness();

    await expect(
      translate({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1780791000 },
      }),
    ).resolves.toMatchObject({ control: "next" });

    const calls = infoCallsWithEvent(deps, "sandbox_agent.rate_limited");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      event: "sandbox_agent.rate_limited",
      provider: "anthropic",
      model: null,
      agent_runtime_backend: "claude_code",
      reason: "rejected",
      rate_limit_type: "five_hour",
    });
    // Telemetry only: no durable event, no drift fallback.
    expect(emitted).toHaveLength(0);
  });

  it("does not log sandbox_agent.rate_limited for routine allowed statuses", async () => {
    const { translate, deps } = makeHarness();

    await translate({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
    });

    expect(infoCallsWithEvent(deps, "sandbox_agent.rate_limited")).toHaveLength(0);
  });

  it("logs prompt.compaction on compact_boundary without surfacing drift", async () => {
    const { translate, deps, emitted } = makeHarness();

    await expect(
      translate({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 155000 },
      }),
    ).resolves.toMatchObject({ control: "next" });

    const calls = infoCallsWithEvent(deps, "prompt.compaction");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({
      event: "prompt.compaction",
      trigger: "auto",
      contextTokensBefore: 155000,
      agent_runtime_backend: "claude_code",
    });
    expect(deps.recordRawFallback).not.toHaveBeenCalled();
    expect(emitted.filter((event) => event.type === "raw_agent_runtime")).toHaveLength(0);
  });
});
