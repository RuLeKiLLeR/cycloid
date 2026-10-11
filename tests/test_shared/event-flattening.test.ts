import { describe, expect, it } from "vitest";

import {
  type ActivityEvent,
  applyToolCallUpdate,
  coalesceStreamDelta,
  createStreamCoalescerState,
  flattenSessionEvents,
  mergeToolCall,
  type ToolCallActivityEvent,
} from "../../shared/transcript/projector.js";

describe("stream coalescing", () => {
  it("coalesces consecutive text deltas into one activity event", () => {
    const events: ActivityEvent[] = [];
    const state = createStreamCoalescerState();

    expect(coalesceStreamDelta(events, state, "text", "T1", "hello ")).toBe(true);
    expect(coalesceStreamDelta(events, state, "text", "T1", "world", "p-1")).toBe(true);

    expect(events).toEqual([{ type: "text", id: "T1", text: "hello world", promptId: "p-1" }]);
  });

  it("starts a new same-stream segment after an intervening event", () => {
    const events: ActivityEvent[] = [];
    const state = createStreamCoalescerState();

    coalesceStreamDelta(events, state, "reasoning", "R1", "think ");
    events.push({ type: "tool_call", id: "tool-1", tool: "Read", summary: "Read file" });
    coalesceStreamDelta(events, state, "reasoning", "R1", "more");

    expect(events).toEqual([
      { type: "reasoning", id: "R1", text: "think " },
      { type: "tool_call", id: "tool-1", tool: "Read", summary: "Read file" },
      { type: "reasoning", id: "R1#1", streamId: "R1", text: "more" },
    ]);
  });

  it("skips long duplicate stream deltas across split segments", () => {
    const events: ActivityEvent[] = [];
    const state = createStreamCoalescerState();

    coalesceStreamDelta(events, state, "text", "T1", "Let me check if there is a sleep helper.");
    events.push({ type: "tool_call", id: "tool-1", tool: "Read", summary: "Read file" });

    expect(coalesceStreamDelta(events, state, "text", "T1", "Let me check if there is a sleep helper.")).toBe(false);
    expect(events).toEqual([
      { type: "text", id: "T1", text: "Let me check if there is a sleep helper." },
      { type: "tool_call", id: "tool-1", tool: "Read", summary: "Read file" },
    ]);
  });
});

describe("tool call projection helpers", () => {
  it("merges duplicate tool_call entries while preserving previous metadata missing from the incoming entry", () => {
    const previous: ToolCallActivityEvent = {
      type: "tool_call",
      id: "tool-1",
      tool: "bash",
      summary: "ls",
      promptId: "p-1",
      input: { command: "ls" },
      toolStatus: "running",
      inputEstimatedTokens: 10,
      outputEstimatedTokens: 20,
      outputChars: 80,
      truncated: true,
      duplicateCount: 2,
    };
    const incoming: ToolCallActivityEvent = {
      type: "tool_call",
      id: "tool-1",
      tool: "bash",
      summary: "ls -la",
    };

    expect(mergeToolCall(previous, incoming)).toEqual({
      type: "tool_call",
      id: "tool-1",
      tool: "bash",
      summary: "ls -la",
      promptId: "p-1",
      input: { command: "ls" },
      toolStatus: "running",
      inputEstimatedTokens: 10,
      outputEstimatedTokens: 20,
      outputChars: 80,
      truncated: true,
      duplicateCount: 2,
    });
  });

  it("applies tool_update terminal fields to an existing tool_call", () => {
    const previous: ToolCallActivityEvent = {
      type: "tool_call",
      id: "tool-1",
      tool: "Read",
      summary: "Reading",
      toolStatus: "running",
    };

    expect(
      applyToolCallUpdate(previous, {
        status: "completed",
        outputEstimatedTokens: 30,
        outputChars: 120,
        truncated: false,
      }),
    ).toEqual({
      type: "tool_call",
      id: "tool-1",
      tool: "Read",
      summary: "Reading",
      toolStatus: "completed",
      outputEstimatedTokens: 30,
      outputChars: 120,
      truncated: false,
    });
  });
});

describe("flattenSessionEvents ordering", () => {
  it("text events interleaved with tool calls maintain correct positions", () => {
    const raw = [
      { type: "text", data: { id: "A", text: "hello " } },
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "ls", input: {} } },
      { type: "text", data: { id: "A", text: "world" } },
      { type: "tool_call", data: { id: "T2", tool: "read", summary: "read foo", input: {} } },
      { type: "text", data: { id: "B", text: "new part" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(5);
    expect(result[0]).toMatchObject({ type: "text", id: "A", text: "hello " });
    expect(result[1]).toMatchObject({ type: "tool_call", id: "T1" });
    expect(result[2]).toMatchObject({ type: "text", id: "A#1", streamId: "A", text: "world" });
    expect(result[3]).toMatchObject({ type: "tool_call", id: "T2" });
    expect(result[4]).toMatchObject({ type: "text", id: "B", text: "new part" });
  });

  it("tool_update applies to existing tool_call without creating new entry", () => {
    const raw = [
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "ls", input: {} } },
      { type: "text", data: { id: "A", text: "hello" } },
      { type: "tool_update", data: { id: "T1", status: "completed" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "tool_call", id: "T1" });
    expect((result[0] as Record<string, unknown>).toolStatus).toBe("completed");
    expect(result[1]).toMatchObject({ type: "text", id: "A" });
  });

  it("question events appear in arrival order among other events", () => {
    const raw = [
      { type: "text", data: { id: "A", text: "hello" } },
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "ls", input: {} } },
      { type: "question", data: { id: "Q1", question: "Confirm?" } },
      { type: "text", data: { id: "B", text: "after" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("text");
    expect(result[1].type).toBe("tool_call");
    expect(result[2].type).toBe("question");
    expect(result[3].type).toBe("text");
  });

  it("question events with options preserve options through flattening", () => {
    const options = [{ label: "Yes", description: "Proceed" }, { label: "No" }];
    const raw = [{ type: "question", data: { id: "Q2", question: "Continue?", options } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).options).toEqual(options);
  });

  it("reasoning events interleaved with text maintain separate positions", () => {
    const raw = [
      { type: "reasoning", data: { id: "R1", text: "thinking " } },
      { type: "text", data: { id: "T1", text: "hello " } },
      { type: "reasoning", data: { id: "R1", text: "more" } },
      { type: "text", data: { id: "T1", text: "world" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ type: "reasoning", id: "R1", text: "thinking " });
    expect(result[1]).toMatchObject({ type: "text", id: "T1", text: "hello " });
    expect(result[2]).toMatchObject({ type: "reasoning", id: "R1#1", streamId: "R1", text: "more" });
    expect(result[3]).toMatchObject({ type: "text", id: "T1#1", streamId: "T1", text: "world" });
  });

  it("skips long duplicate text deltas for the same part ID", () => {
    const raw = [
      { type: "text", data: { id: "A", text: "Let me check if there is a sleep helper." } },
      { type: "text", data: { id: "A", text: "Let me check if there is a sleep helper." } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([{ type: "text", id: "A", text: "Let me check if there is a sleep helper." }]);
  });

  it("duplicate tool_call IDs update in place, preserving position", () => {
    const raw = [
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "Reading foo" } },
      { type: "text", data: { id: "A", text: "hello" } },
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "Reading foo.ts" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "tool_call", id: "T1", summary: "Reading foo.ts" });
    expect(result[1]).toMatchObject({ type: "text", id: "A" });
  });

  it("duplicate tool_call preserves prior toolStatus", () => {
    const raw = [
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "ls" } },
      { type: "tool_update", data: { id: "T1", status: "running" } },
      { type: "tool_call", data: { id: "T1", tool: "bash", summary: "ls -la" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).toolStatus).toBe("running");
    expect((result[0] as Record<string, unknown>).summary).toBe("ls -la");
  });

  it("duplicate partial tool_call events preserve prior metadata", () => {
    const raw = [
      {
        type: "tool_call",
        data: {
          id: "T1",
          tool: "bash",
          summary: "Run tests",
          input: { command: "npm test" },
          toolStatus: "running",
        },
      },
      { type: "tool_call", data: { id: "T1", input: {} } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "tool_call",
      id: "T1",
      tool: "bash",
      summary: "Run tests",
      input: { command: "npm test" },
      toolStatus: "running",
    });
  });

  it("session_error events appear in correct position", () => {
    const raw = [
      { type: "text", data: { id: "A", text: "hello" } },
      { type: "session_error", data: { error: "Auth failed" } },
      { type: "text", data: { id: "B", text: "after" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("text");
    expect(result[1]).toMatchObject({ type: "session_error", error: "Auth failed" });
    expect(result[2].type).toBe("text");
  });

  it("compaction_start and compaction_complete forward enriched token data", () => {
    const raw = [
      { type: "text", data: { id: "A", text: "hello" } },
      { type: "sandbox_compaction_start", data: { timestamp: 1000, contextTokens: 892000 } },
      {
        type: "sandbox_compaction_complete",
        data: { timestamp: 1001, contextTokensBefore: 892000, contextTokensAfter: 245000 },
      },
      { type: "text", data: { id: "B", text: "after" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(4);
    expect(result[0].type).toBe("text");
    expect(result[1]).toMatchObject({ type: "compaction_start", contextTokens: 892000 });
    expect(result[2]).toMatchObject({
      type: "compaction_complete",
      contextTokensBefore: 892000,
      contextTokensAfter: 245000,
    });
    expect(result[3].type).toBe("text");
  });

  it("compaction events without token data remain valid (backward compat)", () => {
    const raw = [
      { type: "sandbox_compaction_start", data: { timestamp: 1000 } },
      { type: "sandbox_compaction_complete", data: { timestamp: 1001 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "compaction_start" });
    expect(result[1]).toMatchObject({ type: "compaction_complete" });
    expect((result[0] as Record<string, unknown>).contextTokens).toBeUndefined();
    expect((result[1] as Record<string, unknown>).contextTokensBefore).toBeUndefined();
  });

  it("context_fill_warning forwards contextTokens and contextWindow", () => {
    const raw = [
      {
        type: "sandbox_context_fill_warning",
        data: { timestamp: 2000, fillPercent: 0.834, contextTokens: 834000, contextWindow: 1000000 },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "context_fill_warning",
      fillPercent: 0.834,
      contextTokens: 834000,
      contextWindow: 1000000,
    });
  });

  it("retry_status events preserve provider and retry timing", () => {
    const raw = [
      {
        type: "retry_status",
        data: {
          timestamp: 3000,
          attempt: 7,
          message: "Provider is overloaded",
          nextRetryAt: "2026-03-31T18:36:00.000Z",
          provider: "openai",
          errorCode: "api_error",
        },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "retry_status",
      attempt: 7,
      message: "Provider is overloaded",
      nextRetryAt: "2026-03-31T18:36:00.000Z",
      provider: "openai",
      errorCode: "api_error",
    });
  });

  it("todo_update patches the most recent todowrite tool_call", () => {
    const raw = [
      {
        type: "tool_call",
        data: {
          id: "T1",
          tool: "todowrite",
          summary: "tasks",
          input: { todos: [{ id: "1", content: "Fix", status: "pending" }] },
        },
      },
      { type: "text", data: { id: "A", text: "hello" } },
      { type: "todo_update", data: { todos: [{ id: "1", content: "Fix", status: "done" }] } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("tool_call");
    const tc = result[0] as Record<string, unknown>;
    const input = tc.input as Record<string, unknown>;
    expect(input.todos).toEqual([{ id: "1", content: "Fix", status: "done" }]);
    expect(result[1]).toMatchObject({ type: "text", id: "A" });
  });

  it("patch events with files appear in order", () => {
    const raw = [
      { type: "tool_call", data: { id: "T1", tool: "edit", summary: "edit" } },
      { type: "patch", data: { files: ["a.ts", "b.ts"] } },
      { type: "text", data: { id: "A", text: "hello" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("tool_call");
    expect(result[1]).toMatchObject({ type: "patch", files: ["a.ts", "b.ts"] });
    expect(result[2].type).toBe("text");
  });

  it("memory_usage events appear with active memory ids", () => {
    const raw = [
      { type: "memory_usage", data: { activeMemoryIds: ["mem-route", "mem-ui", 42], promptId: "p-1" } },
      { type: "text", data: { id: "A", text: "done", promptId: "p-1" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "memory_usage",
      activeMemoryIds: ["mem-route", "mem-ui"],
      promptId: "p-1",
    });
    expect(result[1]).toMatchObject({ type: "text", text: "done" });
  });

  it("handles events with undefined data field", () => {
    const raw: Array<{ type: string; data?: Record<string, unknown> }> = [
      { type: "unknown_event" },
      { type: "text", data: { id: "t1", text: "hi" } },
    ];
    const result = flattenSessionEvents(raw);
    // unknown events are not recognized for flattening, so only text passes
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "text", id: "t1", text: "hi" });
  });

  it("realistic agent turn: reasoning -> text -> tool -> tool_update -> text -> tool -> text", () => {
    const raw = [
      { type: "reasoning", data: { id: "R1", text: "Let me think..." } },
      { type: "text", data: { id: "T1", text: "I'll read the file." } },
      {
        type: "tool_call",
        data: { id: "TC1", tool: "read", summary: "Reading foo.ts", input: { filePath: "foo.ts" } },
      },
      { type: "tool_update", data: { id: "TC1", status: "completed" } },
      { type: "text", data: { id: "T2", text: "Now I'll edit it." } },
      {
        type: "tool_call",
        data: { id: "TC2", tool: "edit", summary: "Editing foo.ts", input: { filePath: "foo.ts" } },
      },
      { type: "tool_update", data: { id: "TC2", status: "completed" } },
      { type: "text", data: { id: "T3", text: "Done!" } },
    ];
    const result = flattenSessionEvents(raw);
    // 6 entries: reasoning, text(T1), tool_call(TC1), text(T2), tool_call(TC2), text(T3)
    // tool_updates apply to existing tool_calls, no separate entries
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({ type: "reasoning", id: "R1", text: "Let me think..." });
    expect(result[1]).toMatchObject({ type: "text", id: "T1", text: "I'll read the file." });
    expect(result[2]).toMatchObject({ type: "tool_call", id: "TC1", toolStatus: "completed" });
    expect(result[3]).toMatchObject({ type: "text", id: "T2", text: "Now I'll edit it." });
    expect(result[4]).toMatchObject({ type: "tool_call", id: "TC2", toolStatus: "completed" });
    expect(result[5]).toMatchObject({ type: "text", id: "T3", text: "Done!" });
  });
});
