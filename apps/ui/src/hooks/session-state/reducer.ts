import { type DisplayStatus, displayStatusFromPhase } from "../../../../../shared/session/display-status";
import { isPublishTerminalFailure } from "../../../../../shared/session/publish";
import type { PromptHistoryFetchResult } from "../../api/sessions";
import { isTodoTool } from "../../constants/tools";
import type { PromptRow, SessionDetail, SessionMetadata } from "../../types";
import {
  applyLatestPushError,
  deriveCanonicalDurableState,
  ingestDurableEvents,
  isGenericPushPublishError,
} from "./durable-events";
import { createEmptyTokenUsage, patchTranscriptEventAt } from "./transcript-helpers";
import type { SessionState, SessionStateAction, SessionStateInternal, SessionStatusCounts, TodoItem } from "./types";

function bumpDisplayStatusCount(counts: SessionStatusCounts, status: DisplayStatus, delta: number) {
  const next = (counts[status] ?? 0) + delta;
  if (next > 0) counts[status] = next;
  else delete counts[status];
}

function reconcileStatusCounts(
  previousCounts: SessionStatusCounts,
  previousSessions: SessionMetadata[],
  nextSessions: SessionMetadata[],
): SessionStatusCounts {
  if (previousSessions === nextSessions) return previousCounts;

  const previousStatusBySessionId = new Map(
    previousSessions.map((session) => [session.sessionId, session.displayStatus]),
  );
  const nextStatusBySessionId = new Map(nextSessions.map((session) => [session.sessionId, session.displayStatus]));
  let counts = previousCounts;

  for (const [sessionId, previousStatus] of previousStatusBySessionId) {
    const nextStatus = nextStatusBySessionId.get(sessionId);
    if (nextStatus === previousStatus) {
      nextStatusBySessionId.delete(sessionId);
      continue;
    }
    if (counts === previousCounts) counts = { ...previousCounts };
    bumpDisplayStatusCount(counts, previousStatus, -1);
    if (nextStatus) {
      bumpDisplayStatusCount(counts, nextStatus, 1);
      nextStatusBySessionId.delete(sessionId);
    }
  }

  for (const nextStatus of nextStatusBySessionId.values()) {
    if (counts === previousCounts) counts = { ...previousCounts };
    bumpDisplayStatusCount(counts, nextStatus, 1);
  }

  return counts;
}

export function createInitialSessionState(initialSession: SessionDetail | null = null): SessionStateInternal {
  return {
    session: initialSession,
    sessions: [],
    statusCounts: {},
    prompts: [],
    durableEvents: new Map(),
    durableEventSequences: [],
    transcripts: new Map(),
    compactionIds: [],
    incompletePromptIds: new Set(),
    tokenUsage: createEmptyTokenUsage(),
    prError: null,
    prUpdated: false,
    prActivity: null,
    liveMode: false,
    eventIndex: new Map(),
    lastTodowriteByPrompt: new Map(),
    optimisticQuestionAnswers: new Map(),
    toolStatusOverrides: new Map(),
    todoOverrides: new Map(),
    promptEventsCache: new Map(),
  };
}

export function toPublicState(state: SessionStateInternal): SessionState {
  const {
    durableEvents: _durableEvents,
    durableEventSequences: _durableEventSequences,
    eventIndex: _eventIndex,
    lastTodowriteByPrompt: _lastTodowriteByPrompt,
    optimisticQuestionAnswers: _optimisticQuestionAnswers,
    promptEventsCache: _promptEventsCache,
    toolStatusOverrides: _toolStatusOverrides,
    todoOverrides: _todoOverrides,
    ...publicState
  } = state;
  return publicState;
}

export function getInFlightPromptId(promptList: PromptRow[]): string | null {
  const active = promptList.find(
    (prompt) =>
      prompt.result === null &&
      prompt.status !== "completed" &&
      prompt.status !== "failed" &&
      prompt.status !== "canceled",
  );
  return active?.promptId ?? null;
}

export function getActivePromptId(promptList: PromptRow[]): string | null {
  return getInFlightPromptId(promptList) ?? promptList[promptList.length - 1]?.promptId ?? null;
}

function resolvePublishError(
  publishStatus: SessionDetail["publishStatus"],
  nextError: string | null | undefined,
  currentError: string | null | undefined,
): string | null {
  // Only preserve push errors across the generic terminal failure emitted after
  // a failed branch push.
  if (
    publishStatus === "failed" &&
    currentError &&
    isGenericPushPublishError(nextError) &&
    !isGenericPushPublishError(currentError)
  ) {
    return currentError;
  }
  return nextError !== undefined ? nextError : (currentError ?? null);
}

function applyToolUpdate(
  state: SessionStateInternal,
  id: string,
  status?: "running" | "completed" | "error",
): SessionStateInternal {
  if (state.toolStatusOverrides.has(id) && state.toolStatusOverrides.get(id) === status) {
    return state;
  }
  const toolStatusOverrides = new Map(state.toolStatusOverrides);
  toolStatusOverrides.set(id, status);

  const entry = state.eventIndex.get(id);
  if (!entry) return { ...state, toolStatusOverrides };

  const transcripts = patchTranscriptEventAt(state.transcripts, entry.promptId, entry.index, (existing) => {
    if (existing.type !== "tool_call" || existing.id !== id || existing.toolStatus === status) return null;
    return { ...existing, toolStatus: status };
  });

  return { ...state, toolStatusOverrides, transcripts };
}

function applyQuestionAnswer(state: SessionStateInternal, id: string, answer: unknown): SessionStateInternal {
  const entry = state.eventIndex.get(id);
  if (!entry) return state;

  const transcripts = patchTranscriptEventAt(state.transcripts, entry.promptId, entry.index, (existing) => {
    if (existing.type !== "question" || existing.id !== id) return null;
    return { ...existing, answer: answer as string | null };
  });
  if (transcripts === state.transcripts) return state;

  const optimisticQuestionAnswers = new Map(state.optimisticQuestionAnswers);
  optimisticQuestionAnswers.delete(id);
  return { ...state, transcripts, optimisticQuestionAnswers };
}

function applyTodoUpdate(state: SessionStateInternal, promptId: string, todos: TodoItem[]): SessionStateInternal {
  const todoOverrides = new Map(state.todoOverrides);
  todoOverrides.set(promptId, todos);

  const todoIndex = state.lastTodowriteByPrompt.get(promptId);
  if (todoIndex === undefined) return { ...state, todoOverrides };

  const transcripts = patchTranscriptEventAt(state.transcripts, promptId, todoIndex, (existing) => {
    if (existing.type !== "tool_call" || !isTodoTool(existing.tool)) return null;
    return {
      ...existing,
      input: {
        ...(existing.input ?? {}),
        todos,
      },
    };
  });

  return { ...state, todoOverrides, transcripts };
}

function applyPromptHistoryResult(
  state: SessionStateInternal,
  promptId: string,
  fetchResult: PromptHistoryFetchResult,
): SessionStateInternal {
  if (!fetchResult.ok) {
    if (state.incompletePromptIds.has(promptId)) return state;
    const incompletePromptIds = new Set(state.incompletePromptIds);
    incompletePromptIds.add(promptId);
    return { ...state, incompletePromptIds };
  }

  const prompt = state.prompts.find((candidate) => candidate.promptId === promptId) ?? null;
  const promptIsCompleted = prompt
    ? prompt.result !== null || prompt.status === "completed" || prompt.status === "failed"
    : true;

  const promptHistoryIsPartial = fetchResult.result.complete === false;
  const incompletePromptIds = new Set(state.incompletePromptIds);
  const sequencedRawEvents = fetchResult.rawEvents.filter(
    (event): event is (typeof fetchResult.rawEvents)[number] & { sequence: number } =>
      typeof event.sequence === "number" && Number.isFinite(event.sequence) && event.sequence > 0,
  );

  if (fetchResult.rawEvents.length > 0 && sequencedRawEvents.length === 0) {
    incompletePromptIds.add(promptId);
    return { ...state, incompletePromptIds };
  }

  const terminalPartialHistory = promptHistoryIsPartial && fetchResult.result.nextAfterSequence === null;
  if (promptHistoryIsPartial && (promptIsCompleted || terminalPartialHistory)) {
    incompletePromptIds.add(promptId);
  } else {
    incompletePromptIds.delete(promptId);
  }

  const nextState = ingestDurableEvents(state, sequencedRawEvents);
  return {
    ...nextState,
    incompletePromptIds,
  };
}

/** Merge authoritative session/prompt metadata into existing state, preserving the
 *  canonical durable-event store and re-deriving transcripts from it. Used by both
 *  WebSocket subscribe/reconnect hydration and resilience polling refreshes. */
function mergeSessionMetadata(
  state: SessionStateInternal,
  session: SessionDetail,
  prompts: PromptRow[],
): SessionStateInternal {
  const nextState = {
    ...state,
    session,
    prompts,
  };
  const { latestPushError, ...derivedState } = deriveCanonicalDurableState(
    nextState.durableEvents,
    nextState.durableEventSequences,
    prompts,
    nextState.optimisticQuestionAnswers,
    nextState.toolStatusOverrides,
    nextState.todoOverrides,
    nextState,
  );

  return {
    ...nextState,
    session: applyLatestPushError(nextState.session, latestPushError),
    ...derivedState,
  };
}

function promptWithPreservedImageData(existing: PromptRow, incoming: PromptRow): PromptRow {
  if (!existing.uploadedImages?.length || !incoming.uploadedImages?.length) return incoming;
  const existingDataByKey = new Map<string, NonNullable<typeof existing.uploadedImages>[number]["data"]>();
  for (const image of existing.uploadedImages) {
    if (image.data) existingDataByKey.set(`${image.name}\0${image.mediaType ?? ""}`, image.data);
  }
  if (existingDataByKey.size === 0) return incoming;

  return {
    ...incoming,
    uploadedImages: incoming.uploadedImages.map((image) => {
      if (image.data) return image;
      const data = existingDataByKey.get(`${image.name}\0${image.mediaType ?? ""}`);
      return data ? { ...image, data } : image;
    }),
  };
}

export function sessionStateReducer(state: SessionStateInternal, action: SessionStateAction): SessionStateInternal {
  switch (action.type) {
    case "state/reset":
      return createInitialSessionState(action.initialSession);

    case "state/initialize": {
      const nextState = createInitialSessionState(action.session);
      return {
        ...nextState,
        session: action.session,
        prompts: action.prompts,
      };
    }

    case "state/merge_session_metadata":
      return mergeSessionMetadata(state, action.session, action.prompts);

    case "state/sessions": {
      const sessions = action.updater(state.sessions);
      if (sessions === state.sessions) return state;
      return {
        ...state,
        sessions,
        statusCounts: reconcileStatusCounts(state.statusCounts, state.sessions, sessions),
      };
    }

    case "event/ingest_replay_page":
      return ingestDurableEvents(state, action.events);

    case "event/ingest_live_event":
      return ingestDurableEvents(state, [action.event], { markLive: true });

    case "state/update_session": {
      const session = action.updater(state.session);
      if (session === state.session) return state;
      return { ...state, session };
    }

    case "state/pr_updated":
      return state.prUpdated === action.value ? state : { ...state, prUpdated: action.value };

    case "state/question_answer_latest": {
      const optimisticQuestionAnswers = new Map(state.optimisticQuestionAnswers);
      for (let promptIndex = state.prompts.length - 1; promptIndex >= 0; promptIndex--) {
        const promptId = state.prompts[promptIndex].promptId;
        const events = state.transcripts.get(promptId);
        if (!events) continue;
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index];
          if (event.type !== "question" || event.answer !== null) continue;
          const transcripts = patchTranscriptEventAt(state.transcripts, promptId, index, (existing) => {
            if (existing.type !== "question") return null;
            return { ...existing, answer: action.answer };
          });
          if (transcripts === state.transcripts) return state;
          optimisticQuestionAnswers.set(event.id, action.answer);
          return { ...state, transcripts, optimisticQuestionAnswers };
        }
      }
      return state;
    }

    case "event/session_status": {
      const session = state.session
        ? {
            ...state.session,
            phase: action.phase,
            displayStatus: displayStatusFromPhase(action.phase),
            closeReason: action.phase === "archived" ? (state.session.closeReason ?? null) : null,
            ...(action.title ? { title: action.title } : {}),
            ...(action.spawnDurationMs != null ? { spawnDurationMs: action.spawnDurationMs } : {}),
          }
        : state.session;
      return {
        ...state,
        session,
      };
    }

    case "event/session_closed":
      return {
        ...state,
        session: state.session
          ? {
              ...state.session,
              phase: "archived",
              displayStatus: "archived",
              closeReason: action.reason,
              ...(action.prUrl !== undefined ? { prUrl: action.prUrl } : {}),
            }
          : state.session,
      };

    case "event/prompt_upsert": {
      const index = state.prompts.findIndex((prompt) => prompt.promptId === action.prompt.promptId);
      if (index >= 0) {
        const prompts = [...state.prompts];
        const incoming = action.mode === "merge" ? { ...prompts[index], ...action.prompt } : action.prompt;
        prompts[index] = promptWithPreservedImageData(prompts[index], incoming);
        return { ...state, prompts };
      }
      if (!action.appendIfMissing) return state;
      return { ...state, prompts: [...state.prompts, action.prompt] };
    }

    case "event/prompt_status": {
      const prompts = state.prompts.map((prompt) =>
        prompt.promptId === action.promptId
          ? {
              ...prompt,
              ...(action.status ? { status: action.status } : {}),
              ...(action.hasError ? { error: action.error } : {}),
            }
          : prompt,
      );
      return { ...state, prompts };
    }

    case "event/prompt_history":
      return applyPromptHistoryResult(state, action.promptId, action.result);

    case "event/tool_update":
      return applyToolUpdate(state, action.id, action.status);

    case "event/todo_update":
      return applyTodoUpdate(state, action.promptId, action.todos);

    case "event/question_answer":
      return applyQuestionAnswer(state, action.id, action.answer);

    case "event/live_mode":
      return state.liveMode ? state : { ...state, liveMode: true };

    case "event/token_usage":
      return {
        ...state,
        tokenUsage: action.usage,
        liveMode: true,
      };

    case "event/publish_state": {
      const published = action.publishStatus === "published" && Boolean(action.prUrl);
      const terminalFailure = isPublishTerminalFailure(action.publishStatus);
      const publishError = resolvePublishError(
        action.publishStatus,
        action.publishError,
        state.session?.publishError ?? null,
      );
      const prActivity =
        published && action.prActivityKind && action.prActivityAt != null
          ? { kind: action.prActivityKind, at: action.prActivityAt }
          : state.prActivity;
      return {
        ...state,
        session: state.session
          ? {
              ...state.session,
              ...(action.prUrl !== undefined ? { prUrl: action.prUrl } : {}),
              ...(action.publishedBranch !== undefined ? { publishedBranch: action.publishedBranch } : {}),
              publishStatus: action.publishStatus,
              publishError,
              prDraft: action.draft ?? state.session.prDraft,
              prManualReviewReason:
                action.manualReviewReason !== undefined
                  ? action.manualReviewReason
                  : (state.session.prManualReviewReason ?? null),
            }
          : state.session,
        prError: terminalFailure ? publishError : null,
        prUpdated: published ? true : state.prUpdated,
        prActivity,
      };
    }

    default:
      return state;
  }
}
