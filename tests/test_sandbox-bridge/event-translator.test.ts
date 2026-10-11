// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateCodexEvent } from "../../apps/sandbox-bridge/src/services/event-translator.js";

const SID = "codex-1";

/** Minimal PromptLoopState stand-in covering the fields the translator touches. */
function makeLoopState() {
  return {
    seenPartIds: new Set<string>(),
    emittedToolParts: new Set<string>(),
    emittedToolStatuses: new Map<string, string>(),
    toolStartTimes: new Map<string, number>(),
    deferredSafetyRejectedToolPartIds: new Set<string>(),
    questionCount: 0,
    toolCallCount: 0,
    idle: false,
    usedVerificationTools: false,
    startNewTextSegment: vi.fn(),
    recordToolCall: vi.fn(),
    recordBehavioralSignals: vi.fn(),
    recordToolFailure: vi.fn(),
    checkExternalStateReferences: vi.fn(),
  };
}

function makePromptState(overrides = {}) {
  return {
    abortReason: null,
    dispatchSucceeded: true,
    handledAutomaticallyBlockCount: 0,
    promptRetryCount: 0,
    promptRetryCountsByErrorCode: {},
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const emit = vi.fn();
  const deps = {
    codexSessionId: SID,
    isVerificationPrompt: false,
    now: 1000,
    messageId: "msg-1",
    requestedProviderID: "openai",
    emit,
    logToBt: vi.fn(),
    promptLog: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    isStarted: () => true,
    markPromptStarted: vi.fn(),
    setPendingQuestion: vi.fn(() => Promise.resolve()),
    emitMemoryRecallUsage: vi.fn(),
    emitParentToolCallWithInput: vi.fn(() => Promise.resolve("emitted")),
    recordTerminalToolEvidence: vi.fn(),
    handleMessageUpdated: vi.fn(),
    recordRawFallback: vi.fn(),
    resetWorktreeForPromptRetry: vi.fn(() => true),
    recordRetryBudgetExhaustion: vi.fn(() => ({ suspectedLoop: false, exhaustionCount: 1 })),
    ...overrides,
  };
  return deps;
}

const toolTracker = { startSpan: vi.fn(), endSpan: vi.fn(), forceEndAll: vi.fn(), activeSpanCount: 0 };

function sessionError(message: string, errorCode?: string) {
  return {
    type: "session.error",
    properties: { sessionID: SID, ...(errorCode ? { errorCode } : {}), error: { data: { message } } },
  };
}

describe("translateCodexEvent — tool error logging", () => {
  it("logs first-seen terminal tool errors with input", async () => {
    const loopState = makeLoopState();
    const deps = makeDeps();

    const outcome = await translateCodexEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: SID,
            tool: "bash",
            state: {
              status: "error",
              input: { command: "grep needle file.txt" },
              error: "grep exited 1",
            },
          },
        },
      },
      deps,
      loopState,
      makePromptState(),
      toolTracker,
    );

    expect(outcome).toEqual({ control: "next" });
    expect(deps.promptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool_call_errored",
        tool: "bash",
        callId: "tool-1",
        reason: "grep exited 1",
      }),
      "Tool call errored",
    );
  });

  it("logs terminal tool errors when input arrives after the first tool part", async () => {
    const loopState = makeLoopState();
    const deps = makeDeps();
    const promptState = makePromptState();

    await translateCodexEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-late-input",
            type: "tool",
            sessionID: SID,
            tool: "bash",
            state: {
              status: "running",
              input: {},
            },
          },
        },
      },
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(deps.emitParentToolCallWithInput).not.toHaveBeenCalled();
    expect(deps.promptLog.warn).not.toHaveBeenCalled();
    expect(loopState.recordToolCall).toHaveBeenCalledWith("bash");

    const outcome = await translateCodexEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-late-input",
            type: "tool",
            sessionID: SID,
            tool: "bash",
            state: {
              status: "error",
              input: { command: "npm test" },
              error: "test command failed",
            },
          },
        },
      },
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "next" });
    expect(deps.emitParentToolCallWithInput).toHaveBeenCalledTimes(1);
    expect(loopState.startNewTextSegment).toHaveBeenCalledTimes(1);
    expect(loopState.recordBehavioralSignals).toHaveBeenCalledWith("bash", { command: "npm test" }, false);
    expect(deps.promptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool_call_errored",
        tool: "bash",
        callId: "tool-late-input",
        reason: "test command failed",
      }),
      "Tool call errored",
    );
  });

  it("logs sanitized tool error updates without an error field", async () => {
    const loopState = makeLoopState();
    loopState.seenPartIds.add("tool-1");
    loopState.emittedToolParts.add("tool-1");
    loopState.emittedToolStatuses.set("tool-1", "running");
    loopState.toolStartTimes.set("tool-1", 900);
    const deps = makeDeps();
    const secret = "sk-proj-123456789012345678901234";
    const largeBody = `${secret} ${"x".repeat(3_000)}`;

    const outcome = await translateCodexEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: SID,
            tool: "bash",
            state: {
              status: "error",
              error: largeBody,
            },
          },
        },
      },
      deps,
      loopState,
      makePromptState(),
      toolTracker,
    );

    expect(outcome).toEqual({ control: "next" });
    expect(deps.promptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "tool_call_errored",
        tool: "bash",
        callId: "tool-1",
        reason: expect.stringContaining("[REDACTED]"),
      }),
      "Tool call errored",
    );
    const fields = deps.promptLog.warn.mock.calls[0]![0];
    expect(fields).not.toHaveProperty("error");
    expect(String(fields.reason)).not.toContain(secret);
    expect(String(fields.reason).length).toBeLessThanOrEqual(2_014);
    expect(loopState.recordToolFailure).toHaveBeenCalledWith("command");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_update",
        status: "error",
        failure: {
          category: "command",
          phase: "command",
          diagnosticsRedacted: true,
          safeSummary: expect.stringContaining("[REDACTED]"),
        },
      }),
    );
    expect(JSON.stringify(deps.emit.mock.calls)).not.toContain(secret);
  });

  it("classifies provider failures and preserves upstream run references without raw output", async () => {
    const loopState = makeLoopState();
    loopState.seenPartIds.add("tool-1");
    loopState.emittedToolParts.add("tool-1");
    loopState.emittedToolStatuses.set("tool-1", "running");
    const deps = makeDeps();

    await translateCodexEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: SID,
            tool: "bash",
            state: {
              status: "error",
              error:
                "Provider API error 503. Logs: https://github.com/trycycloid/cycloid/actions/runs/1234567890\n" +
                "full diagnostic body should not be emitted",
            },
          },
        },
      },
      deps,
      loopState,
      makePromptState(),
      toolTracker,
    );

    expect(loopState.recordToolFailure).toHaveBeenCalledWith("provider");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool_update",
        status: "error",
        failure: {
          category: "provider",
          phase: "provider",
          diagnosticsRedacted: true,
          safeSummary: expect.stringContaining("Provider API error 503"),
          upstream: {
            logUrl: "https://github.com/trycycloid/cycloid/actions/runs/1234567890",
            runId: "1234567890",
          },
        },
      }),
    );
  });
});

describe("translateCodexEvent — tool output capture (codex path)", () => {
  it("threads the complete tool output into endSpan on a terminal completed tool part", async () => {
    const loopState = makeLoopState();
    // The span was already opened (bridge startSpan on the first-seen part) and last emitted as
    // "running"; this terminal "completed" update is the follow-up that closes it — so the part is
    // NOT new (seenPartIds), and takes the status-change branch that calls endSpan with the output.
    loopState.seenPartIds.add("tool-1");
    loopState.emittedToolParts.add("tool-1");
    loopState.emittedToolStatuses.set("tool-1", "running");
    loopState.toolStartTimes.set("tool-1", 900);
    const deps = makeDeps();
    const endSpan = vi.fn();
    const tracker = { startSpan: vi.fn(), endSpan, forceEndAll: vi.fn(), activeSpanCount: 0 };

    const output = "ripgrep found 3 matches:\nsrc/a.ts:1\nsrc/b.ts:2\nsrc/c.ts:3";
    const outcome = await translateCodexEvent(
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-1",
            type: "tool",
            sessionID: SID,
            tool: "bash",
            state: { status: "completed", input: { command: "rg pattern ." }, output },
          },
        },
      },
      deps,
      loopState,
      makePromptState(),
      tracker,
    );

    expect(outcome).toEqual({ control: "next" });
    // 5th arg is the COMPLETE tool output — codex spans previously carried only status.
    expect(endSpan).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      expect.any(Number),
      expect.any(Number),
      output,
    );
  });
});

describe("translateCodexEvent — session.error retry classification", () => {
  let loopState: ReturnType<typeof makeLoopState>;
  beforeEach(() => {
    loopState = makeLoopState();
  });

  it("retries on a transient rate_limit error (under the retry cap)", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("rate limit exceeded"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "retry", delayMs: expect.any(Number), attempt: 1 });
    expect(promptState.promptRetryCount).toBe(1);
    expect(promptState.promptRetryCountsByErrorCode.rate_limit).toBe(1);
    expect(promptState.abortReason).toBeNull();
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "retry_status", errorCode: "rate_limit" }));
  });

  it("retries on a transient api_error (503 / overloaded)", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("503 service unavailable"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("retry");
    expect(promptState.promptRetryCount).toBe(1);
  });

  it("retries Codex app-server transport death as codex_transport_closed", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("Request aborted because Codex app-server is closed"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "retry", delayMs: expect.any(Number), attempt: 1 });
    expect(promptState.promptRetryCount).toBe(1);
    expect(promptState.promptRetryCountsByErrorCode.codex_transport_closed).toBe(1);
    expect(promptState.abortReason).toBeNull();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "retry_status", errorCode: "codex_transport_closed" }),
    );
  });

  it("does NOT retry an auth error — emits error and breaks", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("401 unauthorized"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "break" });
    expect(promptState.promptRetryCount).toBe(0);
    expect(promptState.abortReason).toContain("Session error");
    expect(promptState.lastErrorCode).toBe("auth");
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "auth" }));
  });

  it("does NOT retry an aborted error — breaks", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("operation was aborted"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(0);
  });

  it("stops retrying once the per-error-code budget is exhausted (breaks instead)", async () => {
    const deps = makeDeps();
    // rate_limit budget is 2; already at 2 means no further retry.
    const promptState = makePromptState({ promptRetryCountsByErrorCode: { rate_limit: 2 } });

    const outcome = await translateCodexEvent(
      sessionError("rate limit exceeded"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCountsByErrorCode.rate_limit).toBe(2);
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "rate_limit" }));
  });

  it("caps verification prompts at 3 total attempts even when the current error budget allows another retry", async () => {
    const deps = makeDeps({ isVerificationPrompt: true });
    const promptState = makePromptState({
      promptRetryCount: 2,
      promptRetryCountsByErrorCode: { rate_limit: 1 },
    });

    const outcome = await translateCodexEvent(
      sessionError("rate limit exceeded"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(2);
    expect(promptState.promptRetryCountsByErrorCode.rate_limit).toBe(1);
    expect(promptState.lastErrorCode).toBe("rate_limit");
    expect(promptState.abortReason).toContain("Verification prompt retry cap reached after 3 total attempts");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        code: "rate_limit",
        error: expect.stringContaining("Verification prompt retry cap reached after 3 total attempts"),
      }),
    );
    expect(deps.recordRetryBudgetExhaustion).not.toHaveBeenCalled();
    expect(deps.logToBt).toHaveBeenCalledWith("verification_prompt_retry_cap_reached", {
      errorCode: "rate_limit",
      totalAttempts: 3,
      maxAttempts: 3,
    });
  });

  it("caps verification prompts at 3 total attempts even after the per-error retry budget is exhausted", async () => {
    const deps = makeDeps({ isVerificationPrompt: true });
    const promptState = makePromptState({
      promptRetryCount: 2,
      promptRetryCountsByErrorCode: { rate_limit: 2 },
    });

    const outcome = await translateCodexEvent(
      sessionError("rate limit exceeded"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(2);
    expect(promptState.promptRetryCountsByErrorCode.rate_limit).toBe(2);
    expect(promptState.lastErrorCode).toBe("rate_limit");
    expect(promptState.abortReason).toContain("Verification prompt retry cap reached after 3 total attempts");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        code: "rate_limit",
        error: expect.stringContaining("Verification prompt retry cap reached after 3 total attempts"),
      }),
    );
    expect(deps.recordRetryBudgetExhaustion).not.toHaveBeenCalled();
    expect(deps.logToBt).toHaveBeenCalledWith("verification_prompt_retry_cap_reached", {
      errorCode: "rate_limit",
      totalAttempts: 3,
      maxAttempts: 3,
    });
  });

  it("keeps current retry behavior for implementation prompts after mixed retryable failures", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({
      promptRetryCount: 2,
      promptRetryCountsByErrorCode: { rate_limit: 1 },
    });

    const outcome = await translateCodexEvent(
      sessionError("503 service unavailable"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "retry", delayMs: expect.any(Number), attempt: 1 });
    expect(promptState.promptRetryCount).toBe(3);
    expect(promptState.promptRetryCountsByErrorCode.api_error).toBe(1);
    expect(promptState.abortReason).toBeNull();
  });

  it("caps verification prompts across mixed retryable error classes", async () => {
    const deps = makeDeps({ isVerificationPrompt: true });
    const promptState = makePromptState({
      promptRetryCount: 2,
      promptRetryCountsByErrorCode: { rate_limit: 1 },
    });

    const outcome = await translateCodexEvent(
      sessionError("503 service unavailable"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(2);
    expect(promptState.promptRetryCountsByErrorCode.api_error).toBeUndefined();
    expect(promptState.lastErrorCode).toBe("api_error");
    expect(promptState.abortReason).toContain("Verification prompt retry cap reached after 3 total attempts");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        code: "api_error",
        error: expect.stringContaining("Last retryable error (api_error): 503 service unavailable"),
      }),
    );
  });

  it("fails codex_transport_closed after its retry budget is exhausted", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCountsByErrorCode: { codex_transport_closed: 2 } });

    const outcome = await translateCodexEvent(
      sessionError("Codex app-server exited unexpectedly (code=1 signal=null)"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(0);
    expect(promptState.promptRetryCountsByErrorCode.codex_transport_closed).toBe(2);
    expect(promptState.lastErrorCode).toBe("codex_transport_closed");
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "codex_transport_closed" }));
  });

  it("records budget exhaustion with the failure-loop tracker (first exhaustion: normal error)", async () => {
    const recordRetryBudgetExhaustion = vi.fn(() => ({ suspectedLoop: false, exhaustionCount: 1 }));
    const deps = makeDeps({ recordRetryBudgetExhaustion });
    const promptState = makePromptState({ promptRetryCountsByErrorCode: { rate_limit: 2 } });

    const outcome = await translateCodexEvent(
      sessionError("rate limit exceeded"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(recordRetryBudgetExhaustion).toHaveBeenCalledWith("rate_limit");
    expect(promptState.lastErrorCode).toBe("rate_limit");
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "rate_limit" }));
  });

  it("aborts with failure_loop_suspected on the second exhaustion of the same failure class", async () => {
    const recordRetryBudgetExhaustion = vi.fn(() => ({ suspectedLoop: true, exhaustionCount: 2 }));
    const deps = makeDeps({ recordRetryBudgetExhaustion });
    const promptState = makePromptState({ promptRetryCountsByErrorCode: { failed_edits: 1 } });

    const outcome = await translateCodexEvent(
      sessionError("failed to apply edits to file"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.lastErrorCode).toBe("failure_loop_suspected");
    expect(promptState.abortReason).toContain("Suspected failure loop");
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        code: "failure_loop_suspected",
        error: expect.stringContaining("failed_edits"),
      }),
    );
    expect(deps.logToBt).toHaveBeenCalledWith("failure_loop_suspected", {
      errorCode: "failed_edits",
      exhaustionCount: 2,
    });
  });

  it("does not consult the failure-loop tracker for non-retryable error classes", async () => {
    const recordRetryBudgetExhaustion = vi.fn(() => ({ suspectedLoop: true, exhaustionCount: 5 }));
    const deps = makeDeps({ recordRetryBudgetExhaustion });
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("401 unauthorized"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(recordRetryBudgetExhaustion).not.toHaveBeenCalled();
    expect(promptState.lastErrorCode).toBe("auth");
  });

  it("does NOT retry codex_unrecoverable — breaks", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("Malformed Codex app-server NDJSON line: {not-json}"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(0);
    expect(promptState.lastErrorCode).toBe("codex_unrecoverable");
  });

  it("preserves a structured codex_unrecoverable code when the message looks retryable", async () => {
    const deps = makeDeps();
    const promptState = makePromptState({ promptRetryCount: 0 });

    const outcome = await translateCodexEvent(
      sessionError("Internal Server Error while steering review turn", "codex_unrecoverable"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(promptState.promptRetryCount).toBe(0);
    expect(promptState.lastErrorCode).toBe("codex_unrecoverable");
  });

  it("retries failed_edits after a successful worktree reset", async () => {
    const deps = makeDeps({ resetWorktreeForPromptRetry: vi.fn(() => true) });
    const promptState = makePromptState();

    const outcome = await translateCodexEvent(
      sessionError("failed to find expected lines"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("retry");
    expect(deps.resetWorktreeForPromptRetry).toHaveBeenCalledWith("failed_edits");
    expect(promptState.promptRetryCountsByErrorCode.failed_edits).toBe(1);
  });

  it("does NOT retry failed_edits when the worktree reset fails — breaks", async () => {
    const deps = makeDeps({ resetWorktreeForPromptRetry: vi.fn(() => false) });
    const promptState = makePromptState();

    const outcome = await translateCodexEvent(
      sessionError("failed to find expected lines"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome.control).toBe("break");
    expect(deps.resetWorktreeForPromptRetry).toHaveBeenCalledWith("failed_edits");
    expect(promptState.promptRetryCount).toBe(0);
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ type: "error", code: "failed_edits" }));
  });

  it("suppresses a stale session.error before prompt start (no emit, advances)", async () => {
    const deps = makeDeps({ isStarted: () => false });
    const promptState = makePromptState({ dispatchSucceeded: false });

    const outcome = await translateCodexEvent(
      sessionError("rate limit exceeded"),
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "next" });
    expect(deps.emit).not.toHaveBeenCalled();
    expect(promptState.promptRetryCount).toBe(0);
  });
});

describe("translateCodexEvent — idle and misc control flow", () => {
  let loopState: ReturnType<typeof makeLoopState>;
  beforeEach(() => {
    loopState = makeLoopState();
  });

  it("breaks and marks idle on session.idle", async () => {
    const deps = makeDeps();
    const promptState = makePromptState();

    const outcome = await translateCodexEvent(
      { type: "session.idle", properties: { sessionID: SID } },
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "break" });
    expect(loopState.idle).toBe(true);
  });

  it("ignores a stale idle before prompt start (advances, not idle)", async () => {
    const deps = makeDeps({ isStarted: () => false });
    const promptState = makePromptState({ dispatchSucceeded: false });

    const outcome = await translateCodexEvent(
      { type: "session.idle", properties: { sessionID: SID } },
      deps,
      loopState,
      promptState,
      toolTracker,
    );

    expect(outcome).toEqual({ control: "next" });
    expect(loopState.idle).toBe(false);
  });

  it("routes memory.recall.telemetry to emitMemoryRecallUsage and advances", async () => {
    const deps = makeDeps();
    const event = { type: "memory.recall.telemetry", properties: {} };

    const outcome = await translateCodexEvent(event, deps, loopState, makePromptState(), toolTracker);

    expect(outcome).toEqual({ control: "next" });
    expect(deps.emitMemoryRecallUsage).toHaveBeenCalledWith(event, "msg-1", 1000);
  });

  it("emits raw_agent_runtime for an unhandled event type", async () => {
    const deps = makeDeps();

    await translateCodexEvent(
      { type: "lsp.client.diagnostics", properties: { foo: "bar" } },
      deps,
      loopState,
      makePromptState(),
      toolTracker,
    );

    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "raw_agent_runtime", eventType: "lsp.client.diagnostics" }),
    );
  });
});

describe("translateCodexEvent — rate-limit telemetry", () => {
  it("logs a sandbox_agent.rate_limited event for rate-limit session errors", async () => {
    const loopState = makeLoopState();
    const deps = makeDeps({ effectiveModel: "gpt-5.5" });

    const outcome = await translateCodexEvent(
      sessionError("Rate limit exceeded for this model", "rate_limit"),
      deps,
      loopState,
      makePromptState({
        promptRetryCount: 99,
        promptRetryCountsByErrorCode: { rate_limit: 99 },
      }),
      toolTracker,
    );

    expect(outcome).toEqual({ control: "break" });
    expect(deps.promptLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sandbox_agent.rate_limited",
        provider: "openai",
        model: "gpt-5.5",
        agent_runtime_backend: "codex",
        reason: "session_error",
      }),
      "Sandbox agent rate limited",
    );
  });
});

describe("translateCodexEvent — emittedToolParts dedup guard", () => {
  it("skips emission for a new-by-seenPartIds part whose id is already in emittedToolParts", async () => {
    // Mirrors the subtask path: subtaskPid was added to emittedToolParts WITHOUT
    // seenPartIds, so this part is `isNew` yet must not be re-emitted.
    const loopState = makeLoopState();
    loopState.emittedToolParts.add("part-x");
    const deps = makeDeps();

    const event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-x",
          type: "tool",
          sessionID: SID,
          tool: "bash",
          state: { input: { command: "ls" }, status: "running" },
        },
      },
    };

    await translateCodexEvent(event, deps, loopState, makePromptState(), toolTracker);

    expect(deps.emitParentToolCallWithInput).not.toHaveBeenCalled();
    // Still marked seen + counted (isNew branch ran), just not re-emitted.
    expect(loopState.seenPartIds.has("part-x")).toBe(true);
    expect(loopState.toolCallCount).toBe(1);
  });

  it("emits the parent tool call for a genuinely new tool part with input", async () => {
    const loopState = makeLoopState();
    const deps = makeDeps();

    const event = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-new",
          type: "tool",
          sessionID: SID,
          tool: "bash",
          state: { input: { command: "ls" }, status: "running" },
        },
      },
    };

    await translateCodexEvent(event, deps, loopState, makePromptState(), toolTracker);

    expect(deps.emitParentToolCallWithInput).toHaveBeenCalledTimes(1);
  });
});
