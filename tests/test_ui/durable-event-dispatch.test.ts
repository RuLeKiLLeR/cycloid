import { describe, expect, it, vi } from "vitest";

import type { DurableEventDispatchContext } from "../../apps/ui/src/utils/durable-event-dispatch";
import { handleDurableEvent } from "../../apps/ui/src/utils/durable-event-dispatch";

function makeStateSnapshot() {
  return {
    session: null,
    prompts: [
      {
        promptId: "p-1",
        session_id: "s-1",
        prompt: "do the thing",
        result: null,
        status: "running",
      },
    ],
    transcripts: new Map(),
  };
}

function makeCtx(overrides: Partial<DurableEventDispatchContext> = {}): DurableEventDispatchContext {
  return {
    sessionId: "s-1",
    context: "live",
    dispatch: vi.fn(),
    stateRef: {
      current: makeStateSnapshot(),
    },
    syncSessionStatus: vi.fn(),
    syncSessionPrUrl: vi.fn(),
    refresh: vi.fn(),
    fetchPromptEvents: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        events: [],
      },
    }),
    terminalPhases: new Set(["archived"]),
    ...overrides,
  };
}

function dispatchedActions(ctx: DurableEventDispatchContext) {
  return (ctx.dispatch as ReturnType<typeof vi.fn>).mock.calls.map(([action]) => action);
}

describe("handleDurableEvent", () => {
  it("leaves transcript assembly to canonical event ingestion for text deltas", () => {
    const ctx = makeCtx();

    handleDurableEvent("text", { id: "t-1", text: "hello", promptId: "p-1" }, ctx);

    expect(dispatchedActions(ctx)).toEqual([]);
  });

  it("leaves tool-call transcript updates to canonical event ingestion", () => {
    const ctx = makeCtx();

    handleDurableEvent("tool_call", { id: "tc-1", tool: "bash" }, ctx);

    expect(dispatchedActions(ctx)).toEqual([]);
  });

  it("dispatches session status actions and refreshes on terminal live phase", () => {
    const ctx = makeCtx({ context: "live" });

    handleDurableEvent("status", { phase: "archived", title: "Done" }, ctx);

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/session_status",
        phase: "archived",
        title: "Done",
      },
    ]);
    expect(ctx.syncSessionStatus).toHaveBeenCalledWith("archived", "Done");
    expect(ctx.refresh).toHaveBeenCalled();
  });

  it("dispatches session_closed as an archived state transition with a close reason", () => {
    const ctx = makeCtx({ context: "live" });

    handleDurableEvent("session_closed", { reason: "pr_merged", prUrl: "https://github.com/org/repo/pull/42" }, ctx);

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/session_closed",
        reason: "pr_merged",
        prUrl: "https://github.com/org/repo/pull/42",
      },
    ]);
    expect(ctx.syncSessionStatus).toHaveBeenCalledWith("archived");
  });

  it("does not refresh on terminal replay status", () => {
    const ctx = makeCtx({ context: "replay" });

    handleDurableEvent("status", { phase: "archived" }, ctx);

    expect(ctx.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh on stopped live phase when only archived is terminal", () => {
    const ctx = makeCtx({ context: "live" });

    handleDurableEvent("status", { phase: "stopped" }, ctx);

    expect(ctx.syncSessionStatus).toHaveBeenCalledWith("stopped", undefined);
    expect(ctx.refresh).not.toHaveBeenCalled();
  });

  it("leaves usage derivation to canonical event ingestion", () => {
    const ctx = makeCtx();

    handleDurableEvent("usage", { inputTokens: 100, outputTokens: 50 }, ctx);

    expect(dispatchedActions(ctx)).toEqual([]);
  });

  it("dispatches todo updates to the active prompt", () => {
    const ctx = makeCtx();

    handleDurableEvent(
      "todo_update",
      {
        todos: [{ id: "todo-1", content: "Render checklist", status: "in_progress" }],
      },
      ctx,
    );

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/todo_update",
        promptId: "p-1",
        todos: [{ id: "todo-1", content: "Render checklist", status: "in_progress" }],
      },
    ]);
  });

  it("prefers the event prompt id for todo updates when present", () => {
    const ctx = makeCtx();

    handleDurableEvent(
      "todo_update",
      {
        promptId: "prompt-from-event",
        todos: [{ id: "todo-1", content: "Render checklist", status: "completed" }],
      },
      ctx,
    );

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/todo_update",
        promptId: "prompt-from-event",
        todos: [{ id: "todo-1", content: "Render checklist", status: "completed" }],
      },
    ]);
  });

  it("dispatches empty todo arrays as checklist clear updates", () => {
    const ctx = makeCtx();

    handleDurableEvent("todo_update", { todos: [] }, ctx);

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/todo_update",
        promptId: "p-1",
        todos: [],
      },
    ]);
  });

  it("ignores malformed todo updates", () => {
    const ctx = makeCtx();

    handleDurableEvent("todo_update", { todos: [{ id: "todo-1", content: "Missing status" }] }, ctx);

    expect(dispatchedActions(ctx)).toEqual([]);
  });

  it("only notifies on live question events", () => {
    const liveCtx = makeCtx({ context: "live" });

    handleDurableEvent("question", { id: "q-1", question: "what?", promptId: "p-1" }, liveCtx);

    expect(dispatchedActions(liveCtx)).toEqual([]);

    const replayCtx = makeCtx({ context: "replay" });
    handleDurableEvent("question", { id: "q-1", question: "what?", promptId: "p-1" }, replayCtx);
  });

  it("dispatches PR lifecycle actions only in live mode", () => {
    const liveCtx = makeCtx({ context: "live" });

    handleDurableEvent(
      "pr_created",
      {
        prUrl: "https://github.com/pr/1",
        draft: true,
        manualReviewReason: "Broad typecheck was resource-killed.",
      },
      liveCtx,
    );

    expect(dispatchedActions(liveCtx)).toEqual([
      {
        type: "event/publish_state",
        prUrl: "https://github.com/pr/1",
        draft: true,
        manualReviewReason: "Broad typecheck was resource-killed.",
        publishStatus: "published",
        publishedBranch: null,
      },
    ]);

    const replayCtx = makeCtx({ context: "replay" });
    handleDurableEvent("pr_created", { prUrl: "https://github.com/pr/1" }, replayCtx);
    expect(dispatchedActions(replayCtx)).toEqual([]);
  });

  it("syncs the draft flag to the session list as a definite boolean so a ready PR clears the Draft pill", () => {
    const draftCtx = makeCtx({ context: "live" });
    handleDurableEvent("pr_created", { prUrl: "https://github.com/pr/1", draft: true }, draftCtx);
    expect(draftCtx.syncSessionPrUrl).toHaveBeenCalledWith("https://github.com/pr/1", true);

    // A non-draft (ready) update omits the `draft` field on the wire; it must still
    // sync prDraft=false so a previously-draft list row clears, not linger as undefined.
    const readyCtx = makeCtx({ context: "live" });
    handleDurableEvent("pr_updated", { prUrl: "https://github.com/pr/1" }, readyCtx);
    expect(readyCtx.syncSessionPrUrl).toHaveBeenCalledWith("https://github.com/pr/1", false);
    expect(dispatchedActions(readyCtx)).toEqual([
      {
        type: "event/publish_state",
        prUrl: "https://github.com/pr/1",
        draft: false,
        manualReviewReason: null,
        publishStatus: "published",
        publishedBranch: null,
      },
    ]);
  });

  it("preserves manual-review metadata on ready PR events", () => {
    const liveCtx = makeCtx({ context: "live" });

    handleDurableEvent(
      "pr_created",
      {
        prUrl: "https://github.com/pr/1",
        manualReviewReason: "Verification was inconclusive; review before merge.",
      },
      liveCtx,
    );

    expect(dispatchedActions(liveCtx)).toEqual([
      {
        type: "event/publish_state",
        prUrl: "https://github.com/pr/1",
        draft: false,
        manualReviewReason: "Verification was inconclusive; review before merge.",
        publishStatus: "published",
        publishedBranch: null,
      },
    ]);
  });

  it("dispatches a failed publish state when a live pr_failed event arrives", () => {
    const liveCtx = makeCtx({
      stateRef: {
        current: {
          ...makeStateSnapshot(),
          session: {
            publishStatus: "publishing",
          },
        } as never,
      },
    });

    handleDurableEvent("pr_failed", { error: "PR creation failed: review-loop guard blocked" }, liveCtx);

    expect(dispatchedActions(liveCtx)).toEqual([
      {
        type: "event/publish_state",
        publishStatus: "failed",
        publishError: "PR creation failed: review-loop guard blocked",
      },
    ]);
  });

  it("dispatches prompt completion with embedded history through the reducer contract", () => {
    const ctx = makeCtx();

    handleDurableEvent(
      "prompt_completed",
      {
        promptId: "p-1",
        prompt: {
          promptId: "p-1",
          session_id: "s-1",
          prompt: "plan it",
          result: "done",
          status: "completed",
        },
        history: [{ type: "text", data: { id: "t-1", text: "response" } }],
      },
      ctx,
    );

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/prompt_upsert",
        prompt: expect.objectContaining({ promptId: "p-1", status: "completed" }),
        mode: "replace",
        appendIfMissing: true,
      },
    ]);
  });

  it("patches an existing prompt row on lightweight prompt failures", () => {
    const ctx = makeCtx({
      stateRef: {
        current: {
          ...makeStateSnapshot(),
          prompts: [
            {
              promptId: "p-1",
              session_id: "s-1",
              prompt: "test",
              result: null,
              status: "processing",
              error: null,
              createdAt: "2026-03-30T00:00:00.000Z",
            },
          ],
        },
      },
    });

    handleDurableEvent(
      "prompt_failed",
      {
        promptId: "p-1",
        status: "failed",
        error: "Follow-up prompt did not start",
      },
      ctx,
    );

    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/prompt_status",
        promptId: "p-1",
        status: "failed",
        error: "Follow-up prompt did not start",
        hasError: true,
      },
    ]);
  });

  it("fetches prompt history when completion arrives without embedded history", async () => {
    const fetchPromptEvents = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        events: [{ type: "text", id: "t-2", text: "fetched" }],
      },
    });
    const ctx = makeCtx({
      fetchPromptEvents,
      stateRef: {
        current: {
          ...makeStateSnapshot(),
          transcripts: new Map(),
        },
      },
    });

    handleDurableEvent("prompt_completed", { promptId: "p-1" }, ctx);
    await Promise.resolve();

    expect(fetchPromptEvents).toHaveBeenCalledWith("s-1", "p-1");
    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/prompt_history",
        promptId: "p-1",
        result: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            events: [{ type: "text", id: "t-2", text: "fetched" }],
          }),
        }),
      },
    ]);
  });

  it("fetches prompt history even when the live transcript already has assistant text", async () => {
    const fetchPromptEvents = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        events: [{ type: "text", id: "t-2", text: "recovered assistant reply" }],
      },
    });
    const ctx = makeCtx({
      fetchPromptEvents,
      stateRef: {
        current: {
          ...makeStateSnapshot(),
          transcripts: new Map([
            [
              "p-1",
              [
                { type: "text", id: "t-echo", text: "do the thing" },
                { type: "text", id: "t-1", text: "assistant reply" },
              ],
            ],
          ]),
        },
      },
    });

    handleDurableEvent("prompt_completed", { promptId: "p-1", status: "completed" }, ctx);
    await Promise.resolve();

    expect(fetchPromptEvents).toHaveBeenCalledWith("s-1", "p-1");
    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/prompt_status",
        promptId: "p-1",
        status: "completed",
        error: null,
        hasError: false,
      },
      {
        type: "event/prompt_history",
        promptId: "p-1",
        result: expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            events: [{ type: "text", id: "t-2", text: "recovered assistant reply" }],
          }),
        }),
      },
    ]);
  });

  it("does not fetch prompt history for replay terminal events", async () => {
    const fetchPromptEvents = vi.fn();
    const ctx = makeCtx({
      context: "replay",
      fetchPromptEvents,
    });

    handleDurableEvent("prompt_completed", { promptId: "p-1", status: "completed" }, ctx);
    await Promise.resolve();

    expect(fetchPromptEvents).not.toHaveBeenCalled();
    expect(dispatchedActions(ctx)).toEqual([
      {
        type: "event/prompt_status",
        promptId: "p-1",
        status: "completed",
        error: null,
        hasError: false,
      },
    ]);
  });

  it("ignores unknown event types silently", () => {
    const ctx = makeCtx();

    handleDurableEvent("totally_unknown_type", { foo: "bar" }, ctx);

    expect(dispatchedActions(ctx)).toEqual([]);
    expect(ctx.refresh).not.toHaveBeenCalled();
  });
});
