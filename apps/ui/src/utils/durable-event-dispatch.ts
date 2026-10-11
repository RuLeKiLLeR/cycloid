/**
 * Dispatches durable session events from the WebSocket to UI state.
 *
 * Extracted from SessionDetail.tsx SSE event listeners so it can be
 * tested independently and shared between live and replay contexts.
 */

import type { PromptHistoryFetchResult } from "../api/sessions";
import { getActivePromptId } from "../hooks/session-state/reducer";
import type { TodoItem } from "../hooks/session-state/types";
import { type SessionEventAction, type SessionState } from "../hooks/useSessionState";
import type { Phase, PromptRow } from "../types";
import { shouldFetchPromptEvents } from "./transcript";

export interface DurableEventDispatchContext {
  sessionId: string;
  context: "live" | "replay";
  dispatch: (action: SessionEventAction) => void;
  applyPromptHistoryFetchResult?: (
    promptId: string,
    result: PromptHistoryFetchResult,
  ) => { replacedPartialReplay: boolean; staleDiscarded: boolean };
  stateRef: { current: Pick<SessionState, "session" | "prompts" | "transcripts"> };
  syncSessionStatus: (phase: Phase, title?: string) => void;
  syncSessionPrUrl?: (prUrl: string, draft: boolean) => void;
  refresh: () => void;
  fetchPromptEvents: (sessionId: string, promptId: string) => Promise<PromptHistoryFetchResult>;
  terminalPhases: Set<Phase>;
}

function dispatch(ctx: DurableEventDispatchContext, action: SessionEventAction) {
  ctx.dispatch(action);
}

function parseTodoItems(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const todos: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.content !== "string" || typeof record.status !== "string") {
      return null;
    }
    todos.push({ id: record.id, content: record.content, status: record.status });
  }
  return todos;
}

/**
 * Dispatch a single durable event (from session_event or replay_event WS messages).
 *
 * When context is "replay", side effects like notifications, refresh calls on
 * terminal events, and PR UI state transitions are suppressed.
 */
export function handleDurableEvent(
  type: string,
  data: Record<string, unknown>,
  ctx: DurableEventDispatchContext,
  eventTimestamp?: string | number,
): void {
  const isLive = ctx.context === "live";

  switch (type) {
    case "status": {
      const phase = data.phase as Phase;
      const title = data.title as string | undefined;
      const spawnDurationMs = data.spawnDurationMs as number | null | undefined;
      dispatch(ctx, {
        type: "event/session_status",
        phase,
        ...(title ? { title } : {}),
        ...(spawnDurationMs != null ? { spawnDurationMs } : {}),
      });
      ctx.syncSessionStatus(phase, title);
      if (isLive && ctx.terminalPhases.has(phase)) ctx.refresh();
      break;
    }

    case "session_closed": {
      dispatch(ctx, {
        type: "event/session_closed",
        reason: typeof data.reason === "string" ? data.reason : null,
        ...(typeof data.prUrl === "string" ? { prUrl: data.prUrl } : {}),
      });
      ctx.syncSessionStatus("archived");
      break;
    }

    case "prompt_completed":
    case "prompt_failed": {
      handlePromptDone(data, ctx);
      break;
    }

    case "prompt_updated": {
      const prompt = data.prompt as PromptRow | undefined;
      if (prompt) {
        dispatch(ctx, {
          type: "event/prompt_upsert",
          prompt,
          mode: "merge",
          appendIfMissing: false,
        });
      }
      break;
    }

    case "tool_call": {
      break;
    }

    case "text": {
      break;
    }

    case "reasoning": {
      break;
    }

    case "patch": {
      break;
    }

    case "question": {
      break;
    }

    case "tool_update": {
      break;
    }

    case "todo_update": {
      const todos = parseTodoItems(data.todos);
      const promptId =
        typeof data.promptId === "string" && data.promptId.length > 0
          ? data.promptId
          : getActivePromptId(ctx.stateRef.current.prompts);
      if (todos !== null && promptId) {
        dispatch(ctx, { type: "event/todo_update", promptId, todos });
      }
      break;
    }

    case "raw_agent_runtime": {
      // Raw runtime frames are rendered inline by the projector; nothing to dispatch here.
      break;
    }

    case "answer": {
      dispatch(ctx, {
        type: "event/question_answer",
        id: data.id as string,
        answer: data.answer,
      });
      break;
    }

    case "sandbox_compaction_start": {
      break;
    }

    case "sandbox_compaction_complete": {
      break;
    }

    case "sandbox_context_fill_warning": {
      break;
    }

    case "sandbox_tool_truncated": {
      break;
    }

    case "retry_status": {
      break;
    }

    case "prompt_retrying": {
      // Soft recovery note; rendered inline by the projector. No notification —
      // a transparent sandbox re-run is not a user-actionable event.
      break;
    }

    case "session_error": {
      break;
    }

    case "idle": {
      break;
    }

    case "usage": {
      break;
    }

    case "pr_created":
    case "pr_updated":
    case "publish.pr.created":
    case "publish.pr.updated": {
      if (isLive) {
        const prUrl = data.prUrl as string;
        const draft = data.draft === true;
        const prActivityKind: "created" | "updated" =
          type === "pr_created" || type === "publish.pr.created" ? "created" : "updated";
        const prActivity = eventTimestamp != null ? { prActivityKind, prActivityAt: eventTimestamp } : {};
        dispatch(ctx, {
          type: "event/publish_state",
          publishStatus: "published",
          prUrl,
          publishedBranch: (data.branchName as string) ?? null,
          draft,
          manualReviewReason: typeof data.manualReviewReason === "string" ? data.manualReviewReason : null,
          ...prActivity,
        });
        // pr_created/pr_updated always know the draft state; the wire omits `draft`
        // when false, so treat a missing field as not-draft to clear a stale pill.
        ctx.syncSessionPrUrl?.(prUrl, draft);
      }
      break;
    }

    case "pr_failed":
    case "publish.failed": {
      if (isLive) {
        dispatch(ctx, {
          type: "event/publish_state",
          publishStatus: "failed",
          publishError: ((data.reason ?? data.error) as string) ?? "PR publish failed",
        });
      }
      break;
    }

    case "publish.superseded": {
      if (isLive) {
        dispatch(ctx, {
          type: "event/publish_state",
          publishStatus: "superseded",
          publishError: null,
        });
      }
      break;
    }

    default:
      // Unknown event type -- ignore silently
      break;
  }
}

function handlePromptDone(data: Record<string, unknown>, ctx: DurableEventDispatchContext): void {
  try {
    const promptId = data.promptId as string | undefined;
    const prompt = data.prompt as PromptRow | undefined;
    const history = data.history as Array<{ type: string; data?: Record<string, unknown> }> | undefined;
    const hasErrorField = Object.prototype.hasOwnProperty.call(data, "error");
    const error = typeof data.error === "string" ? data.error : null;
    const status = typeof data.status === "string" ? data.status : undefined;

    if (prompt) {
      dispatch(ctx, {
        type: "event/prompt_upsert",
        prompt,
        mode: "replace",
        appendIfMissing: true,
      });
    } else if (promptId && (status || hasErrorField)) {
      dispatch(ctx, {
        type: "event/prompt_status",
        promptId,
        status,
        error,
        hasError: hasErrorField,
      });
    }

    if (ctx.context === "live" && promptId && shouldFetchPromptEvents(history)) {
      ctx
        .fetchPromptEvents(ctx.sessionId, promptId)
        .then((result) => {
          if (ctx.applyPromptHistoryFetchResult) {
            ctx.applyPromptHistoryFetchResult(promptId, result);
            return;
          }
          dispatch(ctx, { type: "event/prompt_history", promptId, result });
        })
        .catch((err) => {
          console.error("[handleDurableEvent] Failed to fetch prompt history", err);
        });
    }
  } catch (err) {
    console.error("[handleDurableEvent] Failed to handle prompt completion", err);
  }
}
