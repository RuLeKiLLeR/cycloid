import { describe, expect, it } from "vitest";

import { displayStatusFromPhase } from "../../../../../shared/session/display-status";
import type { ActivityEvent, PromptRow, SessionDetail, SessionMetadata } from "../../types";
import { createInitialSessionState, sessionStateReducer } from "./reducer";
import { applyOptimisticQuestionAnswers, applyTodoOverrides, applyToolStatusOverrides } from "./transcript-helpers";
import type { CanonicalDurableEvent, SessionStateInternal, TodoItem, ToolStatus } from "./types";

function makeSessionMetadata(sessionId: string, phase: SessionMetadata["phase"]): SessionMetadata {
  return {
    sessionId,
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    createdAt: 0,
    model: null,
    title: sessionId,
  } as SessionMetadata;
}

function makePrompt(promptId: string, overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    promptId,
    session_id: "session-1",
    prompt: `prompt for ${promptId}`,
    result: null,
    status: "running",
    ...overrides,
  } as PromptRow;
}

function makeQuestion(promptId: string, id: string): ActivityEvent {
  return { type: "question", id, question: "?", answer: null, promptId } as ActivityEvent;
}

function makeToolCall(promptId: string, id: string, toolStatus: ToolStatus = "running"): ActivityEvent {
  return { type: "tool_call", id, tool: "shell", summary: "", promptId, toolStatus } as ActivityEvent;
}

function makeTextRawEvent(promptId: string, sequence: number, id: string, text: string): CanonicalDurableEvent {
  return { sequence, type: "text", data: { promptId, id, text } } as unknown as CanonicalDurableEvent;
}

describe("applyPromptHistoryResult canonical durable-event merge (ARC-936 #1)", () => {
  it("does not mark an active prompt incomplete when history is behind live", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const prompt = makePrompt(promptId, { result: null, status: "running" });
    const liveEvent = makeTextRawEvent(promptId, 42, "live", "live tail");

    const state: SessionStateInternal = {
      ...base,
      prompts: [prompt],
      durableEvents: new Map([[42, liveEvent]]),
      durableEventSequences: [42],
      incompletePromptIds: new Set([promptId]),
    };

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: { events: [], maxSequence: 10 },
        rawEvents: [makeTextRawEvent(promptId, 10, "history", "history")],
      },
    });

    expect(next.incompletePromptIds.has(promptId)).toBe(false);
    expect(next.transcripts.get(promptId)).toEqual([
      expect.objectContaining({ text: "history" }),
      expect.objectContaining({ text: "live tail" }),
    ]);
  });

  it("backfills a middle gap from history without showing the banner", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const prompt = makePrompt(promptId, { result: null, status: "running" });
    const liveOne = makeTextRawEvent(promptId, 1, "one", "one");
    const liveTwo = makeTextRawEvent(promptId, 2, "two", "two");
    const liveFive = makeTextRawEvent(promptId, 5, "five", "five");

    const state: SessionStateInternal = {
      ...base,
      prompts: [prompt],
      durableEvents: new Map([
        [1, liveOne],
        [2, liveTwo],
        [5, liveFive],
      ]),
      durableEventSequences: [1, 2, 5],
    };

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: { events: [], maxSequence: 4 },
        rawEvents: [
          liveOne,
          liveTwo,
          makeTextRawEvent(promptId, 3, "three", "three"),
          makeTextRawEvent(promptId, 4, "four", "four"),
        ],
      },
    });

    expect(next.incompletePromptIds.has(promptId)).toBe(false);
    expect(next.transcripts.get(promptId)?.map((event) => (event as { text?: string }).text)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
    ]);
  });

  it("marks the prompt incomplete when the history fetch fails", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const state: SessionStateInternal = {
      ...base,
      prompts: [makePrompt(promptId, { result: null, status: "running" })],
    };

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: { ok: false, error: new Error("failed") },
    });

    expect(next.incompletePromptIds.has(promptId)).toBe(true);
  });

  it("defers the active-prompt banner for intermediate partial pages but shows it for terminal partial history", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const prompt = makePrompt(promptId, { result: null, status: "running" });
    const state: SessionStateInternal = {
      ...base,
      prompts: [prompt],
    };

    const intermediate = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t1", text: "first page", promptId }],
          maxSequence: 42,
          complete: false,
          nextAfterSequence: 42,
        },
        rawEvents: [makeTextRawEvent(promptId, 42, "t1", "first page")],
      },
    });

    expect(intermediate.incompletePromptIds.has(promptId)).toBe(false);

    const terminal = sessionStateReducer(intermediate, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t1", text: "first page", promptId }],
          maxSequence: 42,
          complete: false,
          nextAfterSequence: null,
        },
        rawEvents: [makeTextRawEvent(promptId, 42, "t1", "first page")],
      },
    });

    expect(terminal.incompletePromptIds.has(promptId)).toBe(true);

    const complete = sessionStateReducer(terminal, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t1", text: "first page", promptId }],
          maxSequence: 42,
          complete: true,
        },
        rawEvents: [makeTextRawEvent(promptId, 42, "t1", "first page")],
      },
    });

    expect(complete.incompletePromptIds.has(promptId)).toBe(false);
  });

  it("does not treat an omitted next cursor as terminal partial history for an active prompt", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const state: SessionStateInternal = {
      ...base,
      prompts: [makePrompt(promptId, { result: null, status: "running" })],
    };

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t1", text: "first page", promptId }],
          maxSequence: 42,
          complete: false,
        },
        rawEvents: [makeTextRawEvent(promptId, 42, "t1", "first page")],
      },
    });

    expect(next.incompletePromptIds.has(promptId)).toBe(false);
  });

  it("keeps the banner on when a successful history fetch only returns unsequenced raw events", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const state: SessionStateInternal = {
      ...base,
      prompts: [makePrompt(promptId, { result: null, status: "running" })],
    };

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t1", text: "missing sequence", promptId }],
          maxSequence: 0,
          complete: true,
        },
        rawEvents: [{ type: "text", data: { promptId, id: "t1", text: "missing sequence" } }],
      },
    });

    expect(next.incompletePromptIds.has(promptId)).toBe(true);
    expect(next.transcripts.has(promptId)).toBe(false);
  });

  it("renders completed prompt history from ingested raw events", () => {
    const base = createInitialSessionState();
    const promptId = "p1";
    const state: SessionStateInternal = {
      ...base,
      prompts: [makePrompt(promptId, { result: "done", status: "completed" })],
    };

    const partial = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t1", text: "first page", promptId }],
          maxSequence: 10,
          complete: false,
          nextAfterSequence: 10,
        },
        rawEvents: [makeTextRawEvent(promptId, 10, "t1", "first page")],
      },
    });

    expect(partial.incompletePromptIds.has(promptId)).toBe(true);
    expect(partial.transcripts.get(promptId)).toEqual([expect.objectContaining({ text: "first page" })]);

    const complete = sessionStateReducer(partial, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [
            { type: "text", id: "t1", text: "first page", promptId },
            { type: "text", id: "t2", text: "second page", promptId },
          ],
          maxSequence: 20,
          complete: true,
        },
        rawEvents: [
          makeTextRawEvent(promptId, 10, "t1", "first page"),
          makeTextRawEvent(promptId, 20, "t2", "second page"),
        ],
      },
    });

    expect(complete.incompletePromptIds.has(promptId)).toBe(false);
    expect(complete.transcripts.get(promptId)).toHaveLength(2);
  });
});

describe("state/question_answer_latest prompt recency (ARC-936 #2)", () => {
  it("answers the question on the newest prompt, not the oldest unanswered one", () => {
    const base = createInitialSessionState();
    const oldQuestion = makeQuestion("p-old", "q-old");
    const newQuestion = makeQuestion("p-new", "q-new");

    const state: SessionStateInternal = {
      ...base,
      prompts: [makePrompt("p-old"), makePrompt("p-new")],
      transcripts: new Map([
        ["p-old", [oldQuestion]],
        ["p-new", [newQuestion]],
      ]),
    };

    const next = sessionStateReducer(state, { type: "state/question_answer_latest", answer: "yes" });

    expect(next.optimisticQuestionAnswers.get("q-new")).toBe("yes");
    expect(next.optimisticQuestionAnswers.has("q-old")).toBe(false);

    const newEvents = next.transcripts.get("p-new")!;
    expect((newEvents[0] as { answer: string | null }).answer).toBe("yes");
    const oldEvents = next.transcripts.get("p-old")!;
    expect((oldEvents[0] as { answer: string | null }).answer).toBeNull();
  });

  it("falls back to an older prompt when the newest has no unanswered question", () => {
    const base = createInitialSessionState();
    const oldQuestion = makeQuestion("p-old", "q-old");
    const answeredQuestion = { ...makeQuestion("p-new", "q-new"), answer: "already" } as ActivityEvent;

    const state: SessionStateInternal = {
      ...base,
      prompts: [makePrompt("p-old"), makePrompt("p-new")],
      transcripts: new Map([
        ["p-old", [oldQuestion]],
        ["p-new", [answeredQuestion]],
      ]),
    };

    const next = sessionStateReducer(state, { type: "state/question_answer_latest", answer: "fallback" });

    expect(next.optimisticQuestionAnswers.get("q-old")).toBe("fallback");
  });
});

describe("overlay appliers preserve referential identity on no-op (ARC-936 #3)", () => {
  it("applyOptimisticQuestionAnswers returns the input map when every override already matches", () => {
    const answered = { ...makeQuestion("p1", "q1"), answer: "yes" } as ActivityEvent;
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [answered]]]);
    const overrides = new Map([["q1", "yes"]]);

    expect(applyOptimisticQuestionAnswers(transcripts, overrides)).toBe(transcripts);
  });

  it("applyToolStatusOverrides returns the input map when every override already matches", () => {
    const completed = makeToolCall("p1", "t1", "completed");
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [completed]]]);
    const overrides = new Map<string, ToolStatus>([["t1", "completed"]]);

    expect(applyToolStatusOverrides(transcripts, overrides)).toBe(transcripts);
  });

  it("applyToolStatusOverrides still returns a new map when something actually changes", () => {
    const running = makeToolCall("p1", "t1", "running");
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [running]]]);
    const overrides = new Map<string, ToolStatus>([["t1", "completed"]]);

    const next = applyToolStatusOverrides(transcripts, overrides);
    expect(next).not.toBe(transcripts);
    expect((next.get("p1")![0] as { toolStatus: ToolStatus }).toolStatus).toBe("completed");
  });

  it("applyTodoOverrides returns the input map when the override is the same reference", () => {
    const todos: TodoItem[] = [{ id: "t1", content: "do thing", status: "pending" }];
    const todoCall: ActivityEvent = {
      type: "tool_call",
      id: "tc1",
      tool: "TodoWrite",
      summary: "",
      promptId: "p1",
      input: { todos },
    } as ActivityEvent;
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [todoCall]]]);
    const overrides = new Map<string, TodoItem[]>([["p1", todos]]);

    expect(applyTodoOverrides(transcripts, overrides)).toBe(transcripts);
  });

  it("applyTodoOverrides still returns a new map when something actually changes", () => {
    const originalTodos: TodoItem[] = [{ id: "t1", content: "do thing", status: "pending" }];
    const updatedTodos: TodoItem[] = [{ id: "t1", content: "do thing", status: "completed" }];
    const todoCall: ActivityEvent = {
      type: "tool_call",
      id: "tc1",
      tool: "TodoWrite",
      summary: "",
      promptId: "p1",
      input: { todos: originalTodos },
    } as ActivityEvent;
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [todoCall]]]);
    const overrides = new Map<string, TodoItem[]>([["p1", updatedTodos]]);

    const next = applyTodoOverrides(transcripts, overrides);
    expect(next).not.toBe(transcripts);
    expect((next.get("p1")![0] as { input?: { todos?: TodoItem[] } }).input?.todos).toBe(updatedTodos);
  });

  it("applyOptimisticQuestionAnswers still returns a new map when something actually changes", () => {
    const unanswered = makeQuestion("p1", "q1");
    const transcripts = new Map<string, ActivityEvent[]>([["p1", [unanswered]]]);
    const overrides = new Map([["q1", "yes"]]);

    const next = applyOptimisticQuestionAnswers(transcripts, overrides);
    expect(next).not.toBe(transcripts);
    expect((next.get("p1")![0] as { answer: string | null }).answer).toBe("yes");
  });
});

describe("sessionStateReducer override no-op guards", () => {
  it("derives displayStatus from live session_status phase updates", () => {
    const base = createInitialSessionState({
      ...makeSessionMetadata("s-1", "running"),
      prUrl: "https://github.com/org/repo/pull/1",
    } as never);

    const next = sessionStateReducer(base, {
      type: "event/session_status",
      phase: "completed",
      title: "Done",
    });

    expect(next.session?.phase).toBe("completed");
    expect(next.session?.displayStatus).toBe("completed");
    expect(next.session?.title).toBe("Done");
  });

  it("sets displayStatus to archived when a session_closed event lands", () => {
    const base = createInitialSessionState({
      ...makeSessionMetadata("s-1", "running"),
      prUrl: null,
    } as never);

    const next = sessionStateReducer(base, {
      type: "event/session_closed",
      reason: "pr_merged",
      prUrl: "https://github.com/org/repo/pull/1",
    });

    expect(next.session?.phase).toBe("archived");
    expect(next.session?.displayStatus).toBe("archived");
    expect(next.session?.closeReason).toBe("pr_merged");
    expect(next.session?.prUrl).toBe("https://github.com/org/repo/pull/1");
  });

  it("updates reducer-owned statusCounts when sidebar sessions change", () => {
    const base = createInitialSessionState();

    const next = sessionStateReducer(base, {
      type: "state/sessions",
      updater: () => [makeSessionMetadata("s-1", "running"), makeSessionMetadata("s-2", "idle")],
    });

    expect(next.sessions).toHaveLength(2);
    expect(next.statusCounts).toEqual({
      working: 1,
      stopped: 1,
    });

    const updated = sessionStateReducer(next, {
      type: "state/sessions",
      updater: (prev) =>
        prev.map((session) =>
          session.sessionId === "s-1" ? { ...session, phase: "archived", displayStatus: "archived" } : session,
        ),
    });

    expect(updated.statusCounts).toEqual({
      archived: 1,
      stopped: 1,
    });
  });

  it("returns the identical state reference when sidebar sessions updater is a no-op", () => {
    const base = createInitialSessionState();

    const next = sessionStateReducer(base, {
      type: "state/sessions",
      updater: (prev) => prev,
    });

    expect(next).toBe(base);
  });

  it("returns the identical state reference when tool_update repeats the current override", () => {
    const base = createInitialSessionState();
    const state: SessionStateInternal = {
      ...base,
      transcripts: new Map([
        [
          "p1",
          [
            {
              type: "tool_call",
              id: "tool-1",
              tool: "shell",
              summary: "",
              promptId: "p1",
              toolStatus: "completed",
            } as ActivityEvent,
          ],
        ],
      ]),
      eventIndex: new Map([["tool-1", { promptId: "p1", index: 0 }]]),
      toolStatusOverrides: new Map<string, ToolStatus>([["tool-1", "completed"]]),
    };

    const next = sessionStateReducer(state, {
      type: "event/tool_update",
      id: "tool-1",
      status: "completed",
    });

    expect(next).toBe(state);
  });
});

describe("sessionStateReducer plan-approval metadata plumbing (PR15)", () => {
  // The park projects `phase: waiting_for_input` like a real pending question;
  // `planApprovalPending` is what lets the header chip, watchdog disarm, and
  // Discuss composer distinguish the two. It reaches the detail session two ways:
  // the live `session_status` frame (`state/update_session`) and the WS subscribe
  // bootstrap (`state/merge_session_metadata`). Both flow through the reducer.

  it("carries plan metadata from the live status frame (state/update_session)", () => {
    const base = createInitialSessionState({
      ...makeSessionMetadata("s-1", "running"),
      prUrl: null,
    } as never);

    const parked = sessionStateReducer(base, {
      type: "state/update_session",
      updater: (prev) => (prev ? { ...prev, planApprovalPending: true, planRevision: 2, planStatus: "pending" } : prev),
    });

    expect(parked.session?.planApprovalPending).toBe(true);
    expect(parked.session?.planRevision).toBe(2);
    expect(parked.session?.planStatus).toBe("pending");

    // Approve broadcasts planApprovalPending:false — the frame must clear the park.
    const approved = sessionStateReducer(parked, {
      type: "state/update_session",
      updater: (prev) =>
        prev ? { ...prev, planApprovalPending: false, planRevision: 2, planStatus: "approved" } : prev,
    });

    expect(approved.session?.planApprovalPending).toBe(false);
    expect(approved.session?.planStatus).toBe("approved");
  });

  it("carries plan metadata from the WS subscribe bootstrap (state/merge_session_metadata)", () => {
    const base = createInitialSessionState();

    const next = sessionStateReducer(base, {
      type: "state/merge_session_metadata",
      session: {
        ...makeSessionMetadata("s-1", "waiting_for_input"),
        planApprovalPending: true,
        planRevision: 4,
        planStatus: "pending",
      } as unknown as SessionDetail,
      prompts: [],
    });

    expect(next.session?.planApprovalPending).toBe(true);
    expect(next.session?.planRevision).toBe(4);
    expect(next.session?.planStatus).toBe("pending");
  });
});
