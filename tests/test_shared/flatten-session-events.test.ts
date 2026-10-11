import { describe, expect, it } from "vitest";

import { flattenSessionEvents, type RawSessionEvent } from "../../shared/transcript/projector.js";

describe("flattenSessionEvents", () => {
  it("flattens text events from nested to flat format", () => {
    const raw = [{ type: "text", data: { id: "t1", text: "hello" } }];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([{ type: "text", id: "t1", text: "hello" }]);
  });

  it("projects prompt_retrying as a soft retry_status note (not a failure)", () => {
    // Mirror the real emitted payload: timestamp lives at the top level, not in
    // `data`, so the projected id must be keyed off retryPromptId, not timestamp.
    const raw = [
      {
        type: "prompt_retrying",
        data: {
          sessionId: "session-1",
          promptId: "p-1",
          retryPromptId: "p-2",
          attempt: 1,
          cap: 2,
          reason: "sandbox_disconnected",
        },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "retry_status",
      id: "pr-retry-p-2",
      promptId: "p-2",
      attempt: 1,
      maxAttempts: 2,
      scope: "sandbox_disconnect",
      message: "Sandbox dropped mid-task; retrying on a fresh sandbox",
    });
  });

  it("merges consecutive text deltas with the same id", () => {
    const raw = [
      { type: "text", data: { id: "t1", text: "hel" } },
      { type: "text", data: { id: "t1", text: "lo " } },
      { type: "text", data: { id: "t1", text: "world" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", id: "t1", text: "hello world" });
  });

  it("does not merge text deltas with different ids", () => {
    const raw = [
      { type: "text", data: { id: "t1", text: "first" } },
      { type: "text", data: { id: "t2", text: "second" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("text");
    expect(result[1].type).toBe("text");
  });

  it("keeps same-stream text segments split across intervening tool_call events", () => {
    const raw = [
      { type: "text", data: { id: "t1", text: "before" } },
      { type: "tool_call", data: { id: "c1", tool: "Read", summary: "Reading" } },
      { type: "text", data: { id: "t1", text: "after" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "text", id: "t1", text: "before" });
    expect(result[1]).toEqual({ type: "tool_call", id: "c1", tool: "Read", summary: "Reading" });
    expect(result[2]).toEqual({ type: "text", id: "t1#1", streamId: "t1", text: "after" });
  });

  it("keeps same-stream reasoning segments split across intervening tool_call events", () => {
    const raw = [
      { type: "reasoning", data: { id: "r1", text: "think" } },
      { type: "tool_call", data: { id: "c1", tool: "Read", summary: "Reading" } },
      { type: "reasoning", data: { id: "r1", text: "more" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "reasoning", id: "r1", text: "think" });
    expect(result[1]).toEqual({ type: "tool_call", id: "c1", tool: "Read", summary: "Reading" });
    expect(result[2]).toEqual({ type: "reasoning", id: "r1#1", streamId: "r1", text: "more" });
  });

  it("records reasoning start/end timestamps across coalesced deltas", () => {
    const raw = [
      { type: "reasoning", data: { id: "r1", text: "think", timestamp: 1000 } },
      { type: "reasoning", data: { id: "r1", text: "ing", timestamp: 4000 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([{ type: "reasoning", id: "r1", text: "thinking", startedAtMs: 1000, endedAtMs: 4000 }]);
  });

  it("omits reasoning timestamps when the raw events carry none", () => {
    const raw = [{ type: "reasoning", data: { id: "r1", text: "think" } }];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([{ type: "reasoning", id: "r1", text: "think" }]);
  });

  it("gives each split reasoning segment its own start/end timestamps", () => {
    const raw = [
      { type: "reasoning", data: { id: "r1", text: "think", timestamp: 1000 } },
      { type: "tool_call", data: { id: "c1", tool: "Read", summary: "Reading" } },
      { type: "reasoning", data: { id: "r1", text: "more", timestamp: 5000 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([
      { type: "reasoning", id: "r1", text: "think", startedAtMs: 1000, endedAtMs: 1000 },
      { type: "tool_call", id: "c1", tool: "Read", summary: "Reading" },
      { type: "reasoning", id: "r1#1", streamId: "r1", text: "more", startedAtMs: 5000, endedAtMs: 5000 },
    ]);
  });

  it("anchors startedAtMs to the first timestamped delta when the segment opens untimed", () => {
    const raw = [
      { type: "reasoning", data: { id: "r1", text: "think" } },
      { type: "reasoning", data: { id: "r1", text: "ing", timestamp: 4000 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([{ type: "reasoning", id: "r1", text: "thinking", startedAtMs: 4000, endedAtMs: 4000 }]);
  });

  it("suppresses long duplicate replay text across split same-stream segments", () => {
    const raw = [
      { type: "text", data: { id: "t1", text: "Let me check if there is a sleep helper." } },
      { type: "tool_call", data: { id: "c1", tool: "Read", summary: "Reading" } },
      { type: "text", data: { id: "t1", text: "Let me check if there is a sleep helper." } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", id: "t1", text: "Let me check if there is a sleep helper." });
    expect(result[1]).toEqual({ type: "tool_call", id: "c1", tool: "Read", summary: "Reading" });
  });

  it("suppresses bash EOF assistant text after a malformed search block", () => {
    const raw: RawSessionEvent[] = [
      {
        type: "text",
        data: {
          promptId: "p1",
          id: "text-1",
          text: "Ran the exact malformed command.\n\n/bin/bash: -c: line 1: unexpected EOF while looking for matching `''\n",
        },
      },
      {
        phase: "error",
        sessionId: "s1",
        promptId: "p1",
        timestampMs: 100,
        payload: {
          message:
            "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.",
          code: "unknown",
        },
      },
      { type: "text", data: { promptId: "p2", id: "text-2", text: "Normal answer." } },
    ];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      {
        type: "session_error",
        id: "err-1",
        promptId: "p1",
        error:
          "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.",
        code: "unknown",
      },
      { type: "text", id: "text-2", text: "Normal answer.", promptId: "p2" },
    ]);
  });

  it("suppresses split bash EOF assistant text after a malformed search block", () => {
    const raw: RawSessionEvent[] = [
      {
        type: "text",
        data: {
          promptId: "p1",
          id: "text-1",
          text: "Ran the exact malformed command.\n\n/bin/bash: -c: line 1: unexpected EOF ",
        },
      },
      {
        type: "text",
        data: {
          promptId: "p1",
          id: "text-1",
          text: "while looking for matching `''\n",
        },
      },
      {
        phase: "error",
        sessionId: "s1",
        promptId: "p1",
        timestampMs: 100,
        payload: {
          message:
            "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.",
          code: "unknown",
        },
      },
      { type: "text", data: { promptId: "p2", id: "text-2", text: "Normal answer." } },
    ];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      {
        type: "session_error",
        id: "err-1",
        promptId: "p1",
        error:
          "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.",
        code: "unknown",
      },
      { type: "text", id: "text-2", text: "Normal answer.", promptId: "p2" },
    ]);
  });

  it("preserves normal assistant text in a prompt with a malformed search block", () => {
    const blockError =
      "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.";
    const raw: RawSessionEvent[] = [
      { type: "text", data: { promptId: "p1", id: "text-1", text: "Let me search the codebase." } },
      {
        phase: "error",
        sessionId: "s1",
        promptId: "p1",
        timestampMs: 100,
        payload: { message: blockError, code: "unknown" },
      },
      {
        type: "text",
        data: {
          promptId: "p1",
          id: "text-2",
          text: "/bin/bash: -c: line 1: unexpected EOF while looking for matching `''\n",
        },
      },
      { type: "tool_call", data: { promptId: "p1", id: "c1", tool: "Bash", summary: "Searching" } },
      { type: "text", data: { promptId: "p1", id: "text-3", text: "This repo does not contain " } },
      { type: "text", data: { promptId: "p1", id: "text-3", text: "the footer; it lives elsewhere." } },
    ];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      { type: "text", id: "text-1", text: "Let me search the codebase.", promptId: "p1" },
      { type: "session_error", id: "err-1", promptId: "p1", error: blockError, code: "unknown" },
      { type: "tool_call", id: "c1", tool: "Bash", summary: "Searching", promptId: "p1" },
      {
        type: "text",
        id: "text-3",
        text: "This repo does not contain the footer; it lives elsewhere.",
        promptId: "p1",
      },
    ]);
  });

  it("suppresses split bash EOF assistant text after an unprompted malformed search block", () => {
    const blockError =
      "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.";
    const raw: RawSessionEvent[] = [
      {
        type: "text",
        data: { id: "text-1", text: "Ran the exact malformed command.\n\n/bin/bash: -c: line 1: unexpected EOF " },
      },
      { type: "text", data: { id: "text-1", text: "while looking for matching `''\n" } },
      {
        phase: "error",
        sessionId: "s1",
        timestampMs: 100,
        payload: { message: blockError, code: "unknown" },
      },
      { type: "text", data: { id: "text-2", text: "Normal answer." } },
    ];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      { type: "session_error", id: "err-1", error: blockError, code: "unknown" },
      { type: "text", id: "text-2", text: "Normal answer." },
    ]);
  });

  it("preserves non-EOF assistant text after an unprompted malformed search block", () => {
    const raw: RawSessionEvent[] = [
      {
        phase: "error",
        sessionId: "s1",
        timestampMs: 100,
        payload: {
          message:
            "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.",
          code: "unknown",
        },
      },
      {
        type: "text",
        data: {
          id: "text-1",
          text: "Normal answer from another legacy prompt.",
        },
      },
    ];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      {
        type: "session_error",
        id: "err-0",
        error:
          "Cycloid blocked this malformed search command before execution. Malformed rg search command is blocked before execution: unclosed ' quote.",
        code: "unknown",
      },
      { type: "text", id: "text-1", text: "Normal answer from another legacy prompt." },
    ]);
  });

  it("flattens tool_call events", () => {
    const raw = [{ type: "tool_call", data: { id: "c1", tool: "Bash", summary: "Running tests" } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "tool_call", id: "c1", tool: "Bash", summary: "Running tests" });
  });

  it("flattens canonical agent timeline events", () => {
    const raw: RawSessionEvent[] = [
      {
        phase: "timeline",
        sessionId: "s-1",
        promptId: "p-1",
        timestampMs: 100,
        payload: {
          eventType: "context.selected",
          source: "observed",
          observer: "sandbox_bridge",
          summary: "Selected 3 system context sections.",
          status: "completed",
          metadata: { systemContextSectionCount: 3 },
        },
      },
    ];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      {
        type: "agent_timeline",
        id: "atl-0-context.selected",
        eventType: "context.selected",
        source: "observed",
        observer: "sandbox_bridge",
        summary: "Selected 3 system context sections.",
        status: "completed",
        metadata: { systemContextSectionCount: 3 },
        promptId: "p-1",
      },
    ]);
  });

  it("preserves bridgeData fields for compat timeline events", () => {
    const raw = [
      {
        phase: "timeline",
        sessionId: "s-1",
        promptId: "p-1",
        timestampMs: 100,
        payload: {
          bridgeEventType: "agent_timeline",
          bridgeData: {
            eventType: "git.push",
            source: "observed",
            observer: "sandbox_bridge",
            summary: "Pushed the session branch.",
            status: "completed",
            metadata: { attempts: 1 },
          },
        },
      },
    ] as unknown as RawSessionEvent[];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      {
        type: "agent_timeline",
        id: "atl-0-git.push",
        eventType: "git.push",
        source: "observed",
        observer: "sandbox_bridge",
        summary: "Pushed the session branch.",
        status: "completed",
        metadata: { attempts: 1 },
        promptId: "p-1",
      },
    ]);
  });

  it("flattens canonical agent progress events from compat payloads", () => {
    const raw = [
      {
        phase: "prompt.dispatch",
        sessionId: "s-1",
        promptId: "p-1",
        timestampMs: 100,
        payload: {
          bridgeEventType: "agent_progress",
          bridgeData: {
            promptId: "p-1",
            step: "preparing_context",
            label: "Preparing context",
          },
        },
      },
    ] as unknown as RawSessionEvent[];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([
      {
        type: "agent_progress",
        id: "ap-0",
        step: "preparing_context",
        label: "Preparing context",
        terminal: false,
        promptId: "p-1",
      },
    ]);
  });

  it("hides internal prompt activity events from transcript output", () => {
    const raw = [
      {
        phase: "prompt.dispatch",
        promptId: "p-1",
        payload: {
          bridgeEventType: "prompt_activity",
          bridgeData: {
            phase: "waiting_for_agent_event",
            detail: "draining",
            promptId: "p-1",
          },
        },
      },
    ] as unknown as RawSessionEvent[];

    const result = flattenSessionEvents(raw);

    expect(result).toEqual([]);
  });

  it("applies tool_update status to existing tool_call", () => {
    const raw = [
      { type: "tool_call", data: { id: "c1", tool: "Read", summary: "Reading" } },
      { type: "tool_update", data: { id: "c1", status: "completed" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "tool_call",
      id: "c1",
      tool: "Read",
      summary: "Reading",
      toolStatus: "completed",
    });
  });

  it("applies bridge.event tool_update status to canonical tool.call entries", () => {
    const raw: RawSessionEvent[] = [
      {
        phase: "tool.call",
        sessionId: "s-1",
        promptId: "p-1",
        timestampMs: 100,
        payload: {
          callId: "c1",
          tool: "Read",
          summary: "Reading",
          args: {},
        },
      },
      {
        phase: "bridge.event",
        sessionId: "s-1",
        promptId: "p-1",
        timestampMs: 200,
        payload: {
          bridgeEventType: "tool_update",
          bridgeData: {
            callId: "c1",
            status: "completed",
          },
        },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "tool_call",
      id: "c1",
      tool: "Read",
      summary: "Reading",
      input: {},
      promptId: "p-1",
      toolStatus: "completed",
    });
  });

  it("includes question events", () => {
    const raw = [{ type: "question", data: { id: "q1", question: "Continue?", answer: null } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "question", id: "q1", question: "Continue?", answer: null });
  });

  it("includes question events with options", () => {
    const options = ["Continue working", "Try a different approach", "Stop the agent"];
    const raw = [{ type: "question", data: { id: "q2", question: "What next?", answer: null, options } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "question", id: "q2", question: "What next?", answer: null, options });
  });

  it("applies answer events to a matching question", () => {
    const raw = [
      { type: "question", data: { id: "q1", question: "Continue?", answer: null } },
      { type: "answer", data: { id: "q1", answer: "yes" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toEqual([{ type: "question", id: "q1", question: "Continue?", answer: "yes" }]);
  });

  it("filters out non-UI event types", () => {
    const raw = [
      { type: "usage", data: { inputTokens: 100 } },
      { type: "unknown_event", data: {} },
      { type: "prompt_completed", data: { promptId: "p1" } },
      { type: "prompt_result", data: {} },
      { type: "text", data: { id: "t1", text: "visible" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
  });

  it("returns empty array for empty input", () => {
    expect(flattenSessionEvents([])).toEqual([]);
  });

  it("handles events with missing data gracefully", () => {
    const raw = [{ type: "text" }, { type: "tool_call", data: { id: "c1", tool: "Read", summary: "r" } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
  });

  it("flattens session_error events", () => {
    const raw = [{ type: "session_error", data: { error: "Sandbox spawn failed", code: "sandbox_spawn" } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("session_error");
    expect((result[0] as { error: string }).error).toBe("Sandbox spawn failed");
    expect((result[0] as { code?: string }).code).toBe("sandbox_spawn");
  });

  it("flattens session_error with default error message", () => {
    const raw = [{ type: "session_error", data: {} }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect((result[0] as { error: string }).error).toBe("Unknown error");
  });

  it("preserves session_error among other events", () => {
    const raw = [
      { type: "text", data: { id: "t1", text: "hello" } },
      { type: "session_error", data: { error: "Push failed", code: "push_error" } },
      { type: "tool_call", data: { id: "c1", tool: "Read", summary: "r" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe("text");
    expect(result[1].type).toBe("session_error");
    expect(result[2].type).toBe("tool_call");
  });
});

describe("todo_update patches last todowrite tool_call", () => {
  it("updates the last todowrite tool_call's input.todos", () => {
    const raw = [
      {
        type: "tool_call",
        data: {
          id: "tc-1",
          tool: "todowrite",
          summary: "Plan tasks",
          input: {
            todos: [
              { id: "1", content: "Implement feature", status: "in_progress" },
              { id: "2", content: "Write tests", status: "pending" },
            ],
          },
        },
      },
      { type: "text", data: { id: "t1", text: "Working on it..." } },
      {
        type: "todo_update",
        data: {
          todos: [
            { id: "1", content: "Implement feature", status: "completed" },
            { id: "2", content: "Write tests", status: "in_progress" },
          ],
        },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    const todoEvent = result.find((e) => e.type === "tool_call") as { input?: { todos: Array<{ status: string }> } };
    expect(todoEvent.input?.todos[0].status).toBe("completed");
    expect(todoEvent.input?.todos[1].status).toBe("in_progress");
  });

  it("only updates the last todowrite when multiple exist", () => {
    const raw = [
      {
        type: "tool_call",
        data: {
          id: "tc-1",
          tool: "todowrite",
          summary: "Plan v1",
          input: { todos: [{ id: "1", content: "Task A", status: "pending" }] },
        },
      },
      {
        type: "tool_call",
        data: {
          id: "tc-2",
          tool: "todowrite",
          summary: "Plan v2",
          input: {
            todos: [
              { id: "1", content: "Task A", status: "in_progress" },
              { id: "2", content: "Task B", status: "pending" },
            ],
          },
        },
      },
      {
        type: "todo_update",
        data: {
          todos: [
            { id: "1", content: "Task A", status: "completed" },
            { id: "2", content: "Task B", status: "completed" },
          ],
        },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);
    // First todowrite unchanged
    const first = result[0] as { input?: { todos: Array<{ status: string }> } };
    expect(first.input?.todos[0].status).toBe("pending");
    // Second todowrite updated
    const second = result[1] as { input?: { todos: Array<{ status: string }> } };
    expect(second.input?.todos[0].status).toBe("completed");
    expect(second.input?.todos[1].status).toBe("completed");
  });

  it("silently drops todo_update when no todowrite tool_call exists", () => {
    const raw = [
      { type: "text", data: { id: "t1", text: "hello" } },
      { type: "todo_update", data: { todos: [{ id: "1", content: "Task", status: "completed" }] } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("text");
  });

  it("ignores todo_update with empty todos array", () => {
    const raw = [
      {
        type: "tool_call",
        data: {
          id: "tc-1",
          tool: "todowrite",
          summary: "Plan",
          input: { todos: [{ id: "1", content: "Task", status: "pending" }] },
        },
      },
      { type: "todo_update", data: { todos: [] } },
    ];
    const result = flattenSessionEvents(raw);
    const todoEvent = result[0] as { input?: { todos: Array<{ status: string }> } };
    expect(todoEvent.input?.todos[0].status).toBe("pending");
  });
});

describe("prompt_completed SSE payload hydration (ARC-132)", () => {
  // Simulates how the client processes the embedded history from prompt_completed events
  const sampleHistory = [
    { type: "prompt_processing", data: { promptId: "p-1", status: "processing" } },
    { type: "text", data: { id: "t-1", text: "Let me " } },
    { type: "text", data: { id: "t-1", text: "check that." } },
    { type: "tool_call", data: { id: "tc-1", tool: "bash", input: { command: "ls" }, summary: "ls" } },
    { type: "prompt_completed", data: { promptId: "p-1", status: "completed" } },
  ];

  it("flattenSessionEvents correctly processes embedded history", () => {
    const events = flattenSessionEvents(sampleHistory);
    // prompt_processing and prompt_completed are not activity events, filtered out
    // text deltas merged, tool_call kept
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as { text: string }).text).toBe("Let me check that.");

    const toolEvents = events.filter((e) => e.type === "tool_call");
    expect(toolEvents).toHaveLength(1);
  });

  it("flattens a session_resumed_cold event with lostSnapshotImageId", () => {
    const raw = [
      {
        type: "session_resumed_cold",
        data: { reason: "prompt", lostSnapshotImageId: "img-old", promptId: "p-2" },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "session_resumed_cold",
      reason: "prompt",
      lostSnapshotImageId: "img-old",
      promptId: "p-2",
    });
  });

  it("flattens a session_resumed_cold event with no prior snapshot", () => {
    const raw = [{ type: "session_resumed_cold", data: { reason: "manual", lostSnapshotImageId: null } }];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "session_resumed_cold",
      reason: "manual",
      lostSnapshotImageId: null,
    });
  });
});
