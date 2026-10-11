import type { DisplayStatus } from "../../../../../shared/session/display-status";
import type { RawSessionEvent } from "../../../../../shared/transcript/projector.js";
import type { PromptEventsResult, PromptHistoryFetchResult } from "../../api/sessions";
import type { ActivityEvent, Phase, PromptRow, SessionDetail, SessionMetadata } from "../../types";

export type SessionTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalBilledTokens: number;
  context: number;
  peakContext: number;
  cost: number;
  contextCacheRead: number;
  contextCacheWrite: number;
  contextUncachedInput: number;
  cumulativeCacheRead: number;
  cumulativeCacheWrite: number;
  instructionFilesEst: number;
  contextWindow: number | null;
  model: string | null;
};

export type TodoItem = { id: string; content: string; status: string };
export type EventIndexEntry = { promptId: string; index: number };
export type CanonicalDurableEvent = RawSessionEvent & { sequence: number };
export type ToolStatus = "running" | "completed" | "error" | undefined;
export type PrActivity = { kind: "created" | "updated"; at: string | number };
export type SessionStatusCounts = Partial<Record<DisplayStatus, number>>;

export type PromptEventsCacheEntry = {
  /**
   * Exact event-reference list that produced `result`. `ingestDurableEvents`
   * replaces an event object when its payload changes (same sequence, new
   * object), so reference equality over the full bucket detects both
   * appended-event and in-place-replacement mutations.
   */
  rawEvents: CanonicalDurableEvent[];
  result: PromptEventsResult;
};

export type SessionStateInternal = {
  session: SessionDetail | null;
  sessions: SessionMetadata[];
  statusCounts: SessionStatusCounts;
  prompts: PromptRow[];
  durableEvents: Map<number, CanonicalDurableEvent>;
  durableEventSequences: number[];
  transcripts: Map<string, ActivityEvent[]>;
  compactionIds: string[];
  incompletePromptIds: Set<string>;
  tokenUsage: SessionTokenUsage;
  prError: string | null;
  prUpdated: boolean;
  prActivity: PrActivity | null;
  liveMode: boolean;
  eventIndex: Map<string, EventIndexEntry>;
  lastTodowriteByPrompt: Map<string, number>;
  optimisticQuestionAnswers: Map<string, string>;
  toolStatusOverrides: Map<string, ToolStatus>;
  todoOverrides: Map<string, TodoItem[]>;
  /**
   * Per-promptId cache for `buildPromptEventsResult`. Keyed by promptId, storing
   * the bucket length and last raw-event sequence so we can reuse the flattened
   * result when the bucket is unchanged. Avoids re-flattening every prompt on
   * every durable-event ingest.
   */
  promptEventsCache: Map<string, PromptEventsCacheEntry>;
};

export type SessionState = Omit<
  SessionStateInternal,
  | "durableEvents"
  | "durableEventSequences"
  | "eventIndex"
  | "lastTodowriteByPrompt"
  | "optimisticQuestionAnswers"
  | "promptEventsCache"
  | "toolStatusOverrides"
  | "todoOverrides"
>;

export type SessionEventAction =
  | { type: "event/ingest_replay_page"; events: CanonicalDurableEvent[] }
  | { type: "event/ingest_live_event"; event: CanonicalDurableEvent }
  | {
      type: "event/session_status";
      phase: Phase;
      title?: string;
      spawnDurationMs?: number | null;
    }
  | {
      type: "event/session_closed";
      reason: string | null;
      prUrl?: string | null;
    }
  | {
      type: "event/prompt_upsert";
      prompt: PromptRow;
      mode: "merge" | "replace";
      appendIfMissing: boolean;
    }
  | {
      type: "event/prompt_status";
      promptId: string;
      status?: string;
      error: string | null;
      hasError: boolean;
    }
  | { type: "event/prompt_history"; promptId: string; result: PromptHistoryFetchResult }
  | { type: "event/tool_update"; id: string; status?: "running" | "completed" | "error" }
  | { type: "event/todo_update"; promptId: string; todos: TodoItem[] }
  | { type: "event/question_answer"; id: string; answer: unknown }
  | { type: "event/live_mode" }
  | { type: "event/token_usage"; usage: SessionTokenUsage }
  | {
      type: "event/publish_state";
      publishStatus: SessionDetail["publishStatus"];
      publishError?: string | null;
      prUrl?: string | null;
      publishedBranch?: string | null;
      draft?: boolean;
      manualReviewReason?: string | null;
      prActivityKind?: PrActivity["kind"];
      prActivityAt?: PrActivity["at"] | null;
    };

export type SessionInternalAction =
  | { type: "state/reset"; initialSession: SessionDetail | null }
  | { type: "state/initialize"; session: SessionDetail; prompts: PromptRow[] }
  | { type: "state/merge_session_metadata"; session: SessionDetail; prompts: PromptRow[] }
  | { type: "state/sessions"; updater: (prev: SessionMetadata[]) => SessionMetadata[] }
  | {
      type: "state/update_session";
      updater: (prev: SessionDetail | null) => SessionDetail | null;
    }
  | { type: "state/pr_updated"; value: boolean }
  | { type: "state/question_answer_latest"; answer: string };

export type SessionStateAction = SessionEventAction | SessionInternalAction;
