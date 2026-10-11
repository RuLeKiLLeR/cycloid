import {
  getRawSessionEventData,
  getRawSessionEventKind,
  getRawSessionEventPromptId,
  getRawSessionEventTimestamp,
  partitionEventsByPrompt,
} from "../../../../../shared/transcript/projector.js";
import { buildPromptEventsResult } from "../../api/sessions";
import type { ActivityEvent, PromptRow } from "../../types";
import {
  applyOptimisticQuestionAnswers,
  applyTodoOverrides,
  applyToolStatusOverrides,
  createEmptyTokenUsage,
  reindexPromptTranscripts,
} from "./transcript-helpers";
import type {
  CanonicalDurableEvent,
  PrActivity,
  PromptEventsCacheEntry,
  SessionStateInternal,
  SessionTokenUsage,
  TodoItem,
  ToolStatus,
} from "./types";

function bucketEventRefsMatch(a: CanonicalDurableEvent[], b: CanonicalDurableEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function getEventPromptId(event: CanonicalDurableEvent): string | null {
  return getRawSessionEventPromptId(event) ?? null;
}

/**
 * Latest durable-event sequence number belonging to `promptId`, walking the
 * canonical sequence list backward. Returns undefined when none match.
 */
export function latestDurableSequenceForPrompt(
  state: Pick<SessionStateInternal, "durableEvents" | "durableEventSequences">,
  promptId: string,
): number | undefined {
  for (let i = state.durableEventSequences.length - 1; i >= 0; i--) {
    const event = state.durableEvents.get(state.durableEventSequences[i]);
    if (event && getEventPromptId(event) === promptId) return event.sequence;
  }
  return undefined;
}

function deriveTokenUsage(events: CanonicalDurableEvent[]): SessionTokenUsage {
  const usageEvent = [...events].reverse().find((event) => getRawSessionEventKind(event) === "usage");
  if (!usageEvent) return createEmptyTokenUsage();
  const data = getRawSessionEventData(usageEvent) ?? {};
  const rawInput = (data.inputTokens as number) ?? 0;
  const cacheReadFromNewField = data.cacheReadTokens;
  const cacheReadFromLegacyField = data.cumulativeCacheRead;
  const cacheRead =
    typeof cacheReadFromNewField === "number" ? cacheReadFromNewField : ((cacheReadFromLegacyField as number) ?? 0);
  const cacheWrite =
    typeof data.cacheWriteTokens === "number"
      ? (data.cacheWriteTokens as number)
      : ((data.cumulativeCacheWrite as number) ?? 0);
  const input = typeof cacheReadFromNewField === "number" ? rawInput : Math.max(0, rawInput - cacheRead);
  const output = (data.outputTokens as number) ?? 0;
  const totalTokens = (data.totalTokens as number) ?? input + output;
  const totalBilledTokens = (data.totalBilledTokens as number) ?? input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalBilledTokens,
    context: (data.contextTokens as number) ?? 0,
    peakContext: (data.peakContextTokens as number) ?? (data.contextTokens as number) ?? 0,
    cost: (data.totalCostUsd as number) ?? 0,
    contextCacheRead: (data.contextCacheRead as number) ?? 0,
    contextCacheWrite: (data.contextCacheWrite as number) ?? 0,
    contextUncachedInput: (data.contextUncachedInput as number) ?? 0,
    cumulativeCacheRead: (data.cumulativeCacheRead as number) ?? 0,
    cumulativeCacheWrite: (data.cumulativeCacheWrite as number) ?? 0,
    instructionFilesEst: (data.instructionFilesEst as number) ?? 0,
    contextWindow: (data.contextWindow as number) ?? null,
    model: (data.model as string) ?? null,
  };
}

function deriveCompactionIds(transcripts: Map<string, ActivityEvent[]>): string[] {
  const ids: string[] = [];
  for (const events of transcripts.values()) {
    for (const event of events) {
      if (event.type === "compaction_complete") ids.push(event.id);
    }
  }
  return ids;
}

function derivePrActivity(events: CanonicalDurableEvent[]): PrActivity | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const kind = getRawSessionEventKind(event);
    if (
      kind !== "pr_created" &&
      kind !== "publish.pr.created" &&
      kind !== "pr_updated" &&
      kind !== "publish.pr.updated"
    ) {
      continue;
    }

    const at = getRawSessionEventTimestamp(event);
    if (!at) break;
    return {
      kind: kind === "pr_created" || kind === "publish.pr.created" ? "created" : "updated",
      at,
    };
  }

  return null;
}

function stripPushErrorPrefix(error: string): string {
  return error.replace(/^Push failed(?: \([^)]+\))?:\s*/u, "").trim();
}

function isPublishSuccessEvent(kind: string): boolean {
  return (
    kind === "push_complete" ||
    kind === "pr_created" ||
    kind === "publish.pr.created" ||
    kind === "pr_updated" ||
    kind === "publish.pr.updated"
  );
}

function deriveLatestPushError(events: CanonicalDurableEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const kind = getRawSessionEventKind(event);
    if (isPublishSuccessEvent(kind)) return null;

    const data = getRawSessionEventData(event) ?? {};
    if (kind === "push_error" && typeof data.error === "string" && data.error.trim()) {
      return stripPushErrorPrefix(data.error);
    }
    if (kind === "session_error" && data.code === "push_error" && typeof data.error === "string" && data.error.trim()) {
      return stripPushErrorPrefix(data.error);
    }
  }

  return null;
}

export function isGenericPushPublishError(error: string | null | undefined): boolean {
  if (!error) return true;
  return error === "Push did not complete" || error === "PR creation failed: Push did not complete";
}

export function applyLatestPushError(session: SessionStateInternal["session"], pushError: string | null) {
  if (
    !session ||
    session.publishStatus !== "failed" ||
    !pushError ||
    !isGenericPushPublishError(session.publishError)
  ) {
    return session;
  }
  return { ...session, publishError: pushError };
}

export function deriveCanonicalDurableState(
  durableEvents: Map<number, CanonicalDurableEvent>,
  durableEventSequences: number[],
  prompts: PromptRow[],
  optimisticQuestionAnswers: Map<string, string>,
  toolStatusOverrides: Map<string, ToolStatus>,
  todoOverrides: Map<string, TodoItem[]>,
  previousState: Pick<SessionStateInternal, "tokenUsage" | "promptEventsCache" | "prActivity">,
): Pick<
  SessionStateInternal,
  | "transcripts"
  | "compactionIds"
  | "tokenUsage"
  | "eventIndex"
  | "lastTodowriteByPrompt"
  | "promptEventsCache"
  | "prActivity"
> & { latestPushError: string | null } {
  const orderedEvents = durableEventSequences
    .map((sequence) => durableEvents.get(sequence))
    .filter((event): event is CanonicalDurableEvent => event !== undefined);

  const promptIds = prompts.map((prompt) => prompt.promptId);
  const buckets = partitionEventsByPrompt(orderedEvents, promptIds);
  const transcripts = new Map<string, ActivityEvent[]>();
  const promptEventsCache = new Map<string, PromptEventsCacheEntry>();
  const prevCache = previousState?.promptEventsCache;

  for (const prompt of prompts) {
    const promptId = prompt.promptId;
    const rawEvents = buckets.get(promptId) ?? [];

    // Memoize per-promptId. `ingestDurableEvents` replaces mutated events
    // with new object refs (via `durableEvents.set(sequence, event)`), so
    // reference equality over the full bucket catches both appended events
    // and in-place replacements of existing sequences. Cheaper than
    // re-running `buildPromptEventsResult`, which rebuilds several Maps.
    const cached = prevCache?.get(promptId);
    const result =
      cached && bucketEventRefsMatch(cached.rawEvents, rawEvents) ? cached.result : buildPromptEventsResult(rawEvents);
    promptEventsCache.set(promptId, { rawEvents, result });

    if (result.events.length > 0) transcripts.set(promptId, result.events);
  }

  const transcriptsWithQuestionAnswers = applyOptimisticQuestionAnswers(transcripts, optimisticQuestionAnswers);
  const transcriptsWithToolStatuses = applyToolStatusOverrides(transcriptsWithQuestionAnswers, toolStatusOverrides);
  const hydratedTranscripts = applyTodoOverrides(transcriptsWithToolStatuses, todoOverrides);
  const { eventIndex, lastTodowriteByPrompt } = reindexPromptTranscripts(hydratedTranscripts);

  return {
    transcripts: hydratedTranscripts,
    compactionIds: deriveCompactionIds(hydratedTranscripts),
    tokenUsage: orderedEvents.some((event) => getRawSessionEventKind(event) === "usage")
      ? deriveTokenUsage(orderedEvents)
      : (previousState?.tokenUsage ?? createEmptyTokenUsage()),
    prActivity: derivePrActivity(orderedEvents) ?? previousState?.prActivity ?? null,
    latestPushError: deriveLatestPushError(orderedEvents),
    promptEventsCache,
    eventIndex,
    lastTodowriteByPrompt,
  };
}

export function ingestDurableEvents(
  state: SessionStateInternal,
  events: CanonicalDurableEvent[],
  options?: { markLive?: boolean },
): SessionStateInternal {
  if (events.length === 0) return state;

  const durableEvents = new Map(state.durableEvents);
  const sequenceSet = new Set(state.durableEventSequences);
  let mutated = false;

  for (const event of events) {
    if (!Number.isFinite(event.sequence) || event.sequence <= 0) continue;
    const existing = durableEvents.get(event.sequence);
    if (existing && JSON.stringify(existing) === JSON.stringify(event)) {
      continue;
    }
    durableEvents.set(event.sequence, event);
    sequenceSet.add(event.sequence);
    mutated = true;
  }

  if (!mutated) {
    if (options?.markLive && !state.liveMode) return { ...state, liveMode: true };
    return state;
  }

  const durableEventSequences = [...sequenceSet].sort((a, b) => a - b);
  const derived = deriveCanonicalDurableState(
    durableEvents,
    durableEventSequences,
    state.prompts,
    state.optimisticQuestionAnswers,
    state.toolStatusOverrides,
    state.todoOverrides,
    state,
  );

  const { latestPushError, ...derivedState } = derived;
  return {
    ...state,
    session: applyLatestPushError(state.session, latestPushError),
    durableEvents,
    durableEventSequences,
    ...derivedState,
    ...(options?.markLive ? { liveMode: true } : {}),
  };
}
