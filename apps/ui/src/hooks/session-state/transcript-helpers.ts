import { isTodoTool } from "../../constants/tools";
import type { ActivityEvent } from "../../types";
import type { EventIndexEntry, SessionTokenUsage, TodoItem, ToolStatus } from "./types";

export function createEmptyTokenUsage(): SessionTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalBilledTokens: 0,
    context: 0,
    peakContext: 0,
    cost: 0,
    contextCacheRead: 0,
    contextCacheWrite: 0,
    contextUncachedInput: 0,
    cumulativeCacheRead: 0,
    cumulativeCacheWrite: 0,
    instructionFilesEst: 0,
    contextWindow: null,
    model: null,
  };
}

/**
 * Canonical (re)build of the `eventIndex` and `lastTodowriteByPrompt` lookups
 * from the current transcripts map. Kept as the only place those indexes are
 * populated so reducer actions stay in sync.
 */
export function reindexPromptTranscripts(transcripts: Map<string, ActivityEvent[]>): {
  eventIndex: Map<string, EventIndexEntry>;
  lastTodowriteByPrompt: Map<string, number>;
} {
  const eventIndex = new Map<string, EventIndexEntry>();
  const lastTodowriteByPrompt = new Map<string, number>();

  for (const [promptId, events] of transcripts) {
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (event.id) eventIndex.set(event.id, { promptId, index });
      if (event.type === "tool_call" && isTodoTool(event.tool)) {
        lastTodowriteByPrompt.set(promptId, index);
      }
    }
  }

  return { eventIndex, lastTodowriteByPrompt };
}

/**
 * Locate-copy-update an event inside a transcripts map. Returns a new
 * transcripts map when `patcher` produces a different event; returns the
 * input map unchanged otherwise.
 *
 * Centralizes the cloning protocol shared by `applyToolUpdate`,
 * `applyQuestionAnswer`, and `applyTodoUpdate`.
 */
export function patchTranscriptEventAt(
  transcripts: Map<string, ActivityEvent[]>,
  promptId: string,
  index: number,
  patcher: (event: ActivityEvent) => ActivityEvent | null,
): Map<string, ActivityEvent[]> {
  const events = transcripts.get(promptId);
  if (!events) return transcripts;
  const existing = events[index];
  if (!existing) return transcripts;
  const patched = patcher(existing);
  if (patched === null || patched === existing) return transcripts;
  const next = new Map(transcripts);
  const updated = [...events];
  updated[index] = patched;
  next.set(promptId, updated);
  return next;
}

export function applyOptimisticQuestionAnswers(
  transcripts: Map<string, ActivityEvent[]>,
  optimisticQuestionAnswers: Map<string, string>,
): Map<string, ActivityEvent[]> {
  if (optimisticQuestionAnswers.size === 0) return transcripts;

  const next = new Map<string, ActivityEvent[]>();
  let changed = false;
  for (const [promptId, events] of transcripts) {
    let updatedEvents = events;
    for (let index = 0; index < events.length; index++) {
      const event = updatedEvents[index];
      if (event.type !== "question" || event.answer !== null) continue;
      const optimisticAnswer = optimisticQuestionAnswers.get(event.id);
      if (optimisticAnswer === undefined) continue;
      if (updatedEvents === events) updatedEvents = [...events];
      updatedEvents[index] = { ...event, answer: optimisticAnswer };
    }
    if (updatedEvents !== events) changed = true;
    next.set(promptId, updatedEvents);
  }
  return changed ? next : transcripts;
}

export function applyToolStatusOverrides(
  transcripts: Map<string, ActivityEvent[]>,
  toolStatusOverrides: Map<string, ToolStatus>,
): Map<string, ActivityEvent[]> {
  if (toolStatusOverrides.size === 0) return transcripts;

  const next = new Map<string, ActivityEvent[]>();
  let changed = false;
  for (const [promptId, events] of transcripts) {
    let updatedEvents = events;
    for (let index = 0; index < updatedEvents.length; index += 1) {
      const event = updatedEvents[index];
      if (event.type !== "tool_call" || !event.id) continue;
      const toolStatus = toolStatusOverrides.get(event.id);
      if (toolStatus === undefined || event.toolStatus === toolStatus) continue;
      if (updatedEvents === events) updatedEvents = [...events];
      updatedEvents[index] = { ...event, toolStatus };
    }
    if (updatedEvents !== events) changed = true;
    next.set(promptId, updatedEvents);
  }
  return changed ? next : transcripts;
}

export function applyTodoOverrides(
  transcripts: Map<string, ActivityEvent[]>,
  todoOverrides: Map<string, TodoItem[]>,
): Map<string, ActivityEvent[]> {
  if (todoOverrides.size === 0) return transcripts;

  const next = new Map<string, ActivityEvent[]>();
  let changed = false;
  for (const [promptId, events] of transcripts) {
    const todos = todoOverrides.get(promptId);
    if (!todos) {
      next.set(promptId, events);
      continue;
    }

    let todoIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === "tool_call" && isTodoTool(event.tool)) {
        todoIndex = index;
        break;
      }
    }

    if (todoIndex < 0) {
      next.set(promptId, events);
      continue;
    }

    const existing = events[todoIndex];
    if (existing.type !== "tool_call") {
      next.set(promptId, events);
      continue;
    }
    if ((existing.input as { todos?: unknown } | undefined)?.todos === todos) {
      next.set(promptId, events);
      continue;
    }
    const updatedEvents = [...events];
    updatedEvents[todoIndex] = {
      ...existing,
      input: {
        ...(existing.input ?? {}),
        todos,
      },
    };
    changed = true;
    next.set(promptId, updatedEvents);
  }
  return changed ? next : transcripts;
}
