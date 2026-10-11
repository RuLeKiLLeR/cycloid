import { describe, expect, it } from "vitest";

import {
  createInitialSessionState,
  getInFlightPromptId,
  sessionStateReducer,
} from "../../apps/ui/src/hooks/session-state/reducer";
import {
  applyOptimisticQuestionAnswers,
  applyTodoOverrides,
  applyToolStatusOverrides,
  patchTranscriptEventAt,
  reindexPromptTranscripts,
} from "../../apps/ui/src/hooks/session-state/transcript-helpers";
import type {
  CanonicalDurableEvent,
  SessionStateInternal,
  ToolStatus,
} from "../../apps/ui/src/hooks/session-state/types";
import type { ActivityEvent, PromptRow, SessionDetail } from "../../apps/ui/src/types";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-1",
    status: "idle",
    title: "Session",
    repoUrl: "https://github.com/test-owner/test-repo",
    prUrl: null,
    createdAt: 0,
    model: null,
    queueLength: 0,
    prCreating: false,
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  } as SessionDetail;
}

function makePrompt(promptId: string, overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    promptId,
    session_id: "s-1",
    prompt: "Do the thing",
    result: null,
    status: "processing",
    ...overrides,
  };
}

function makeTextRawEvent(promptId: string, sequence: number, id: string, text: string): CanonicalDurableEvent {
  return { sequence, type: "text", data: { promptId, id, text } } as unknown as CanonicalDurableEvent;
}

function seedTranscripts(state: SessionStateInternal, transcripts: Map<string, ActivityEvent[]>): SessionStateInternal {
  const { eventIndex, lastTodowriteByPrompt } = reindexPromptTranscripts(transcripts);
  return { ...state, transcripts, eventIndex, lastTodowriteByPrompt };
}

describe("getInFlightPromptId", () => {
  it("ignores terminal prompts with null results", () => {
    expect(
      getInFlightPromptId([
        makePrompt("p-failed", { result: null, status: "failed" }),
        makePrompt("p-completed", { result: null, status: "completed" }),
        makePrompt("p-canceled", { result: null, status: "canceled" }),
      ]),
    ).toBeNull();
  });

  it("returns the first non-terminal null-result prompt", () => {
    expect(
      getInFlightPromptId([
        makePrompt("p-done", { result: "done", status: "completed" }),
        makePrompt("p-running", { result: null, status: "running" }),
        makePrompt("p-pending", { result: null, status: "pending" }),
      ]),
    ).toBe("p-running");
  });
});

describe("transcript helpers", () => {
  describe("patchTranscriptEventAt", () => {
    it("returns a new map with the patched event when the patcher emits a different value", () => {
      const events: ActivityEvent[] = [{ type: "text", id: "t-1", text: "hello" } as ActivityEvent];
      const transcripts = new Map<string, ActivityEvent[]>([["p-1", events]]);

      const next = patchTranscriptEventAt(
        transcripts,
        "p-1",
        0,
        (existing) =>
          ({
            ...existing,
            text: "world",
          }) as ActivityEvent,
      );

      expect(next).not.toBe(transcripts);
      expect(next.get("p-1")).not.toBe(events);
      expect(next.get("p-1")?.[0]).toEqual({ type: "text", id: "t-1", text: "world" });
    });

    it("returns the input map unchanged when the patcher returns null", () => {
      const events: ActivityEvent[] = [{ type: "text", id: "t-1", text: "hello" } as ActivityEvent];
      const transcripts = new Map<string, ActivityEvent[]>([["p-1", events]]);

      const next = patchTranscriptEventAt(transcripts, "p-1", 0, () => null);
      expect(next).toBe(transcripts);
    });

    it("returns the input map unchanged when the prompt or index is missing", () => {
      const events: ActivityEvent[] = [{ type: "text", id: "t-1", text: "hello" } as ActivityEvent];
      const transcripts = new Map<string, ActivityEvent[]>([["p-1", events]]);

      expect(patchTranscriptEventAt(transcripts, "missing", 0, () => ({ ...events[0] }))).toBe(transcripts);
      expect(patchTranscriptEventAt(transcripts, "p-1", 9, () => ({ ...events[0] }))).toBe(transcripts);
    });
  });

  describe("reindexPromptTranscripts", () => {
    it("rebuilds eventIndex and lastTodowriteByPrompt from the transcripts map", () => {
      const transcripts = new Map<string, ActivityEvent[]>([
        [
          "p-1",
          [
            { type: "text", id: "t-1", text: "hi" } as ActivityEvent,
            { type: "tool_call", id: "tool-todo-1", tool: "todowrite", summary: "" } as ActivityEvent,
            { type: "tool_call", id: "tool-x", tool: "read", summary: "" } as ActivityEvent,
            { type: "tool_call", id: "tool-todo-2", tool: "todowrite", summary: "" } as ActivityEvent,
          ],
        ],
        ["p-2", [{ type: "tool_call", id: "tool-other", tool: "bash", summary: "" } as ActivityEvent]],
      ]);

      const { eventIndex, lastTodowriteByPrompt } = reindexPromptTranscripts(transcripts);

      expect(eventIndex.get("t-1")).toEqual({ promptId: "p-1", index: 0 });
      expect(eventIndex.get("tool-todo-1")).toEqual({ promptId: "p-1", index: 1 });
      expect(eventIndex.get("tool-todo-2")).toEqual({ promptId: "p-1", index: 3 });
      expect(eventIndex.get("tool-other")).toEqual({ promptId: "p-2", index: 0 });
      // Last write wins for todowrite tools.
      expect(lastTodowriteByPrompt.get("p-1")).toBe(3);
      expect(lastTodowriteByPrompt.has("p-2")).toBe(false);
    });
  });

  describe("overlay appliers", () => {
    it("applyOptimisticQuestionAnswers fills null answers for matching question events", () => {
      const transcripts = new Map<string, ActivityEvent[]>([
        [
          "p-1",
          [
            { type: "question", id: "q-1", question: "ok?", answer: null } as ActivityEvent,
            { type: "question", id: "q-2", question: "already?", answer: "yes" } as ActivityEvent,
          ],
        ],
      ]);
      const next = applyOptimisticQuestionAnswers(transcripts, new Map([["q-1", "go ahead"]]));
      const events = next.get("p-1");
      expect(events?.[0]).toMatchObject({ id: "q-1", answer: "go ahead" });
      expect(events?.[1]).toBe(transcripts.get("p-1")?.[1]);
    });

    it("applyToolStatusOverrides updates only tool_call events with a different status", () => {
      const transcripts = new Map<string, ActivityEvent[]>([
        [
          "p-1",
          [
            { type: "tool_call", id: "tool-1", tool: "bash", summary: "", toolStatus: "running" } as ActivityEvent,
            { type: "tool_call", id: "tool-2", tool: "bash", summary: "", toolStatus: "completed" } as ActivityEvent,
          ],
        ],
      ]);
      const overrides = new Map<string, ToolStatus>([
        ["tool-1", "completed"],
        ["tool-2", "completed"], // no-op: same status
      ]);
      const next = applyToolStatusOverrides(transcripts, overrides);
      const events = next.get("p-1");
      expect(events?.[0]).toMatchObject({ id: "tool-1", toolStatus: "completed" });
      expect(events?.[1]).toBe(transcripts.get("p-1")?.[1]);
    });

    it("applyTodoOverrides rewrites the last todowrite call's todos", () => {
      const transcripts = new Map<string, ActivityEvent[]>([
        [
          "p-1",
          [
            { type: "tool_call", id: "tool-1", tool: "todowrite", summary: "", input: { todos: [] } } as ActivityEvent,
            { type: "tool_call", id: "tool-2", tool: "bash", summary: "" } as ActivityEvent,
            { type: "tool_call", id: "tool-3", tool: "todowrite", summary: "", input: { todos: [] } } as ActivityEvent,
          ],
        ],
      ]);
      const todos = [{ id: "todo-1", content: "ship it", status: "in_progress" }];
      const next = applyTodoOverrides(transcripts, new Map([["p-1", todos]]));
      const events = next.get("p-1");
      // Only the last todowrite event gets the todos applied.
      expect(events?.[0]).toBe(transcripts.get("p-1")?.[0]);
      const last = events?.[2] as Extract<ActivityEvent, { type: "tool_call" }>;
      expect(last.input?.todos).toEqual(todos);
    });
  });
});

describe("sessionStateReducer", () => {
  function baseState(): SessionStateInternal {
    return {
      ...createInitialSessionState(makeSession()),
      prompts: [makePrompt("p-1")],
    };
  }

  it("event/tool_update routes through the central patch helper to update transcripts and toolStatusOverrides together", () => {
    const transcript: ActivityEvent[] = [
      { type: "tool_call", id: "tool-1", tool: "bash", summary: "", toolStatus: "running" } as ActivityEvent,
    ];
    const state = seedTranscripts(baseState(), new Map([["p-1", transcript]]));

    const next = sessionStateReducer(state, { type: "event/tool_update", id: "tool-1", status: "completed" });

    expect(next.toolStatusOverrides.get("tool-1")).toBe("completed");
    const updated = next.transcripts.get("p-1");
    expect(updated).not.toBe(transcript);
    expect(updated?.[0]).toMatchObject({ id: "tool-1", toolStatus: "completed" });
  });

  it("event/tool_update without a matching transcript entry still records the override", () => {
    const state = baseState();
    const next = sessionStateReducer(state, { type: "event/tool_update", id: "ghost-tool", status: "error" });

    expect(next.toolStatusOverrides.get("ghost-tool")).toBe("error");
    expect(next.transcripts).toBe(state.transcripts);
  });

  it("event/question_answer patches the question event and clears the optimistic answer", () => {
    const transcript: ActivityEvent[] = [
      { type: "question", id: "q-1", question: "ok?", answer: null } as ActivityEvent,
    ];
    let state = seedTranscripts(baseState(), new Map([["p-1", transcript]]));
    state = { ...state, optimisticQuestionAnswers: new Map([["q-1", "yes"]]) };

    const next = sessionStateReducer(state, { type: "event/question_answer", id: "q-1", answer: "yes" });

    expect(next.optimisticQuestionAnswers.has("q-1")).toBe(false);
    expect(next.transcripts.get("p-1")?.[0]).toMatchObject({ id: "q-1", answer: "yes" });
  });

  it("event/todo_update writes todos onto the indexed todowrite call and records the override", () => {
    const transcript: ActivityEvent[] = [
      { type: "tool_call", id: "tool-1", tool: "todowrite", summary: "", input: { todos: [] } } as ActivityEvent,
    ];
    const state = seedTranscripts(baseState(), new Map([["p-1", transcript]]));
    const todos = [{ id: "todo-1", content: "do it", status: "pending" }];

    const next = sessionStateReducer(state, { type: "event/todo_update", promptId: "p-1", todos });

    expect(next.todoOverrides.get("p-1")).toEqual(todos);
    const patched = next.transcripts.get("p-1")?.[0] as Extract<ActivityEvent, { type: "tool_call" }>;
    expect(patched.input?.todos).toEqual(todos);
  });

  it("keeps active intermediate partial history without marking the prompt incomplete", () => {
    const promptId = "p-1";
    const durableEvent: CanonicalDurableEvent = {
      sequence: 42,
      type: "tool_call",
      data: { promptId },
    } as unknown as CanonicalDurableEvent;
    const state = {
      ...baseState(),
      prompts: [makePrompt(promptId, { result: null, status: "running" })],
      durableEvents: new Map([[42, durableEvent]]),
      durableEventSequences: [42],
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t-1", text: "first page", promptId } as ActivityEvent],
          maxSequence: 10,
          complete: false,
          nextAfterSequence: 10,
        },
        rawEvents: [makeTextRawEvent(promptId, 10, "t-1", "first page")],
      },
    });

    expect(next).not.toBe(state);
    expect(next.incompletePromptIds.has(promptId)).toBe(false);
    expect(next.transcripts.get(promptId)).toEqual([
      expect.objectContaining({ text: "first page" }),
      expect.objectContaining({ type: "tool_call" }),
    ]);
  });

  it("renders active partial fresh history from ingested raw events", () => {
    const promptId = "p-1";
    const durableEvent: CanonicalDurableEvent = {
      sequence: 42,
      type: "tool_call",
      data: { promptId },
    } as unknown as CanonicalDurableEvent;
    const state = {
      ...baseState(),
      prompts: [makePrompt(promptId, { result: null, status: "running" })],
      durableEvents: new Map([[42, durableEvent]]),
      durableEventSequences: [42],
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId,
      result: {
        ok: true,
        result: {
          events: [{ type: "text", id: "t-1", text: "first page", promptId } as ActivityEvent],
          maxSequence: 42,
          complete: false,
          nextAfterSequence: 42,
        },
        rawEvents: [makeTextRawEvent(promptId, 42, "t-1", "first page")],
      },
    });

    expect(next).not.toBe(state);
    expect(next.incompletePromptIds.has(promptId)).toBe(false);
    expect(next.transcripts.get(promptId)).toEqual([expect.objectContaining({ text: "first page" })]);
  });

  it("event/publish_state marks prUpdated when a published prUrl arrives", () => {
    const state = {
      ...baseState(),
      session: { ...makeSession(), prUrl: null },
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/publish_state",
      publishStatus: "published",
      prUrl: "https://github.com/owner/repo/pull/1",
      prActivityKind: "created",
      prActivityAt: "2026-06-12T14:30:00.000Z",
    });

    expect(next.prUpdated).toBe(true);
    expect(next.prActivity).toEqual({ kind: "created", at: "2026-06-12T14:30:00.000Z" });
    expect(next.session?.prUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(next.session?.publishStatus).toBe("published");
  });

  it("does not fall back to an older PR event when the latest PR event has no timestamp", () => {
    const next = sessionStateReducer(baseState(), {
      type: "event/ingest_replay_page",
      events: [
        {
          type: "pr_created",
          sequence: 1,
          data: {
            prUrl: "https://github.com/owner/repo/pull/1",
            timestamp: "2026-06-12T14:30:00.000Z",
          },
        },
        {
          type: "pr_updated",
          sequence: 2,
          data: {
            prUrl: "https://github.com/owner/repo/pull/1",
          },
        },
      ],
    });

    expect(next.prActivity).toBeNull();
  });

  it("uses the detailed push_error from replay instead of a generic publish error", () => {
    const workflowError =
      "updating `.github/workflows/lint.yml` requires the `workflows` permission, which the Cycloid GitHub App does not hold for this repo.";
    const state = {
      ...baseState(),
      session: makeSession({ publishStatus: "failed", publishError: "Push did not complete" }),
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/ingest_replay_page",
      events: [
        {
          type: "push_error",
          sequence: 1,
          data: {
            branchName: "verification-for-pr-5518",
            error: workflowError,
          },
        },
        {
          type: "publish.failed",
          sequence: 2,
          data: {
            stage: "pushing",
            reason: "Push did not complete",
          },
        },
      ],
    });

    expect(next.session?.publishError).toBe(workflowError);
  });

  it("does not restore an older push_error after a later publish success event", () => {
    const workflowError =
      "updating `.github/workflows/lint.yml` requires the `workflows` permission, which the Cycloid GitHub App does not hold for this repo.";
    const state = {
      ...baseState(),
      session: makeSession({ publishStatus: "failed", publishError: "Push did not complete" }),
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/ingest_replay_page",
      events: [
        {
          type: "push_error",
          sequence: 1,
          data: {
            branchName: "verification-for-pr-5518",
            error: workflowError,
          },
        },
        {
          type: "push_complete",
          sequence: 2,
          data: {
            branchName: "verification-for-pr-5518",
          },
        },
      ],
    });

    expect(next.session?.publishError).toBe("Push did not complete");
  });

  it("keeps a detailed push_error when the later publish failure is generic", () => {
    const workflowError =
      "updating `.github/workflows/lint.yml` requires the `workflows` permission, which the Cycloid GitHub App does not hold for this repo.";
    const state = {
      ...baseState(),
      session: makeSession({ publishStatus: "publishing", publishError: workflowError }),
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/publish_state",
      publishStatus: "failed",
      publishError: "Push did not complete",
    });

    expect(next.session?.publishStatus).toBe("failed");
    expect(next.session?.publishError).toBe(workflowError);
    expect(next.prError).toBe(workflowError);
  });

  it("lets a terminal failed publish replace stale push errors", () => {
    const workflowError =
      "updating `.github/workflows/lint.yml` requires the `workflows` permission, which the Cycloid GitHub App does not hold for this repo.";
    const state = {
      ...baseState(),
      session: makeSession({ publishStatus: "publishing", publishError: workflowError }),
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/publish_state",
      publishStatus: "failed",
      publishError: "Review-loop publish guard blocked.",
    });

    expect(next.session?.publishStatus).toBe("failed");
    expect(next.session?.publishError).toBe("Review-loop publish guard blocked.");
    expect(next.prError).toBe("Review-loop publish guard blocked.");
  });

  it("preserves PR activity when prompt history re-derives durable state", () => {
    const state = {
      ...baseState(),
      prActivity: { kind: "updated", at: "2026-06-12T15:45:00.000Z" },
    } satisfies SessionStateInternal;

    const next = sessionStateReducer(state, {
      type: "event/prompt_history",
      promptId: "p-1",
      result: { ok: true, result: { events: [], maxSequence: 0 }, rawEvents: [] },
    });

    expect(next.prActivity).toEqual({ kind: "updated", at: "2026-06-12T15:45:00.000Z" });
  });
});
