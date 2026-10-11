import { describe, expect, it } from "vitest";

import type { PromptHistoryFetchResult } from "../api/sessions";
import type { SessionEventAction } from "../hooks/useSessionState";
import type { Phase } from "../types";
import { type DurableEventDispatchContext, handleDurableEvent } from "./durable-event-dispatch";

/**
 * Helper: invoke handleDurableEvent in live context and return the last
 * dispatched action (cast to the publish_state shape for convenience).
 */
function dispatchDurableEvent(event: { type: string; data: Record<string, unknown> }): {
  publishStatus?: string;
  publishError?: string | null;
} {
  let dispatched: SessionEventAction | null = null;
  const ctx: DurableEventDispatchContext = {
    sessionId: "test-session",
    context: "live",
    dispatch: (action) => {
      dispatched = action;
    },
    stateRef: {
      current: {
        session: null,
        prompts: [],
        transcripts: new Map(),
      },
    },
    syncSessionStatus: (_phase: Phase) => {},
    syncSessionPrUrl: undefined,
    refresh: () => {},
    fetchPromptEvents: async (_sessionId: string, _promptId: string): Promise<PromptHistoryFetchResult> => ({
      ok: false,
      error: new Error("not implemented"),
    }),
    terminalPhases: new Set<Phase>(),
  };
  handleDurableEvent(event.type, event.data, ctx);
  return (dispatched ?? {}) as { publishStatus?: string; publishError?: string | null };
}

function dispatchDurableEventActions(event: { type: string; data: Record<string, unknown> }): SessionEventAction[] {
  const dispatched: SessionEventAction[] = [];
  const ctx: DurableEventDispatchContext = {
    sessionId: "test-session",
    context: "live",
    dispatch: (action) => {
      dispatched.push(action);
    },
    stateRef: {
      current: {
        session: null,
        prompts: [
          {
            promptId: "prompt-1",
            session_id: "test-session",
            prompt: "do the work",
            result: null,
            status: "running",
            error: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            uploadedImages: [],
          },
        ],
        transcripts: new Map(),
      },
    },
    syncSessionStatus: (_phase: Phase) => {},
    syncSessionPrUrl: undefined,
    refresh: () => {},
    fetchPromptEvents: async (_sessionId: string, _promptId: string): Promise<PromptHistoryFetchResult> => ({
      ok: false,
      error: new Error("not implemented"),
    }),
    terminalPhases: new Set<Phase>(),
  };
  handleDurableEvent(event.type, event.data, ctx);
  return dispatched;
}

describe("durable-event-dispatch", () => {
  describe("publish.failed", () => {
    it("maps publish.failed to publishStatus failed", () => {
      const next = dispatchDurableEvent({
        type: "publish.failed",
        data: { reason: "review-loop publish guard blocked" },
      });
      expect(next.publishStatus).toBe("failed");
    });
  });

  describe("publish.superseded", () => {
    it("maps publish.superseded to publishStatus superseded", () => {
      const next = dispatchDurableEvent({ type: "publish.superseded", data: { reason: "the PR is merged" } });
      expect(next.publishStatus).toBe("superseded");
    });

    it("sets publishError to null for a benign supersede", () => {
      const next = dispatchDurableEvent({ type: "publish.superseded", data: { reason: "the PR is merged" } });
      expect(next.publishError).toBeNull();
    });
  });

  describe("todo_update", () => {
    it("dispatches todo updates to the active prompt", () => {
      const actions = dispatchDurableEventActions({
        type: "todo_update",
        data: {
          todos: [{ id: "todo-1", content: "Render checklist", status: "in_progress" }],
        },
      });

      expect(actions).toEqual([
        {
          type: "event/todo_update",
          promptId: "prompt-1",
          todos: [{ id: "todo-1", content: "Render checklist", status: "in_progress" }],
        },
      ]);
    });

    it("prefers the event prompt id when present", () => {
      const actions = dispatchDurableEventActions({
        type: "todo_update",
        data: {
          promptId: "prompt-from-event",
          todos: [{ id: "todo-1", content: "Render checklist", status: "completed" }],
        },
      });

      expect(actions).toEqual([
        {
          type: "event/todo_update",
          promptId: "prompt-from-event",
          todos: [{ id: "todo-1", content: "Render checklist", status: "completed" }],
        },
      ]);
    });

    it("dispatches empty todo arrays as checklist clear updates", () => {
      const actions = dispatchDurableEventActions({
        type: "todo_update",
        data: { todos: [] },
      });

      expect(actions).toEqual([
        {
          type: "event/todo_update",
          promptId: "prompt-1",
          todos: [],
        },
      ]);
    });

    it("ignores malformed todo payloads", () => {
      const actions = dispatchDurableEventActions({
        type: "todo_update",
        data: { todos: [{ id: "todo-1", content: "Missing status" }] },
      });

      expect(actions).toEqual([]);
    });
  });
});
