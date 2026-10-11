import { REPLAY_WINDOW_SIZE } from "../../../../shared/constants/session.js";
import type { SessionReplayEvent } from "../../../../shared/types/session-replay.js";
import { createLogger } from "../logger";
import type { ReplayState, ReplayWindow, SessionEvent } from "../types";
import { baseReplayState, normalizeEventSequence, normalizeStoredEvents } from "../utils";
import type { DurableEntry } from "./cycloid-event-store.js";
import * as doDb from "./do-db.js";
export type { DurableEntry } from "./cycloid-event-store.js";
export { projectCycloidEventToDurableEntry } from "./cycloid-event-store.js";
export { generateToolSummary } from "./tool-summary.js";

export type AppendDurableEventsOptions = { includeEvents?: boolean };

const log = createLogger({ bindings: { component: "session-events" } });

function getSqlStorage(state: DurableObjectState): SqlStorage {
  return state.storage.sql;
}

function getReplayStateForSession(sql: SqlStorage, sessionId: string): ReplayState {
  const replay = doDb.getReplayState(sql, sessionId);
  return replay.lastEventSequence > 0 ? replay : baseReplayState(sessionId);
}

/**
 * Find the index of the first event with sequence > target.
 * Precondition: events must be sorted by ascending sequence
 * (guaranteed by appendDurableEvents).
 * Uses ?? 0 rather than parseNonNegativeInteger because sequence
 * is always an integer assigned by appendDurableEvents.
 */
export function binarySearchAfterSequence(events: SessionEvent[], target: number): number {
  let lo = 0,
    hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid].sequence ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Filter events belonging to a specific prompt: from its `prompt_processing`
 * event until the next prompt's `prompt_processing` (or end of stream).
 */
export function filterEventsForPrompt(allEvents: SessionEvent[], promptId: string): SessionEvent[] {
  const startIdx = allEvents.findIndex(
    (e) => e.type === "prompt_processing" && (e.data as Record<string, unknown>)?.promptId === promptId,
  );
  if (startIdx === -1) return [];

  let endIdx = allEvents.length;
  for (let i = startIdx + 1; i < allEvents.length; i++) {
    if (
      allEvents[i].type === "prompt_processing" &&
      (allEvents[i].data as Record<string, unknown>)?.promptId !== promptId
    ) {
      endIdx = i;
      break;
    }
  }
  return allEvents.slice(startIdx, endIdx);
}

export function resolveReplayCursor(queryCursorRaw: unknown, headerCursorRaw: unknown): number {
  const queryCursor =
    queryCursorRaw !== null && queryCursorRaw !== undefined ? normalizeEventSequence(queryCursorRaw, -1) : -1;
  if (queryCursor >= 0) return queryCursor;

  const headerCursor =
    headerCursorRaw !== null && headerCursorRaw !== undefined ? normalizeEventSequence(headerCursorRaw, -1) : -1;
  if (headerCursor >= 0) return headerCursor;

  return 0;
}

export function selectReplayWindow(
  events: SessionEvent[],
  afterSequenceRaw: unknown,
  maxEvents = REPLAY_WINDOW_SIZE,
): ReplayWindow {
  const afterSequence = normalizeEventSequence(afterSequenceRaw, 0);
  const normalized = normalizeStoredEvents(events);
  const startIdx = binarySearchAfterSequence(normalized, afterSequence);
  const filtered = normalized.slice(startIdx);

  if (filtered.length <= maxEvents) {
    return { afterSequence, events: filtered, truncated: false, droppedCount: 0 };
  }

  const replayEvents = filtered.slice(filtered.length - maxEvents);
  return {
    afterSequence,
    events: replayEvents,
    truncated: true,
    droppedCount: 1,
  };
}

export function buildSseResponse(
  phaseFields: {
    phase: import("../../../../shared/session/phase.js").Phase;
    sandboxSubstate?: import("../../../../shared/session/phase.js").SandboxSubstate;
    stopMode?: import("../../../../shared/session/phase.js").StopMode;
    finalizingStep?: import("../../../../shared/session/phase.js").FinalizingStep;
  },
  events: SessionEvent[],
  title?: string | null,
  spawnDurationMs?: number | null,
): Response {
  // Canonical phase contract; legacy `status` alias was removed in PR D.
  const statusPayload = {
    phase: phaseFields.phase,
    ...(phaseFields.sandboxSubstate !== undefined ? { sandboxSubstate: phaseFields.sandboxSubstate } : {}),
    ...(phaseFields.stopMode !== undefined ? { stopMode: phaseFields.stopMode } : {}),
    ...(phaseFields.finalizingStep !== undefined ? { finalizingStep: phaseFields.finalizingStep } : {}),
    ...(title && { title }),
    ...(spawnDurationMs != null && { spawnDurationMs }),
  };
  let payload = `event: status\ndata: ${JSON.stringify(statusPayload)}\n\n`;
  for (const event of events) {
    payload += `id: ${event.sequence}\n`;
    payload += `event: ${event.type}\n`;
    payload += `data: ${JSON.stringify(event.data || {})}\n\n`;
  }

  return new Response(payload, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}
export async function appendDurableEvents(
  state: DurableObjectState,
  sessionId: string,
  entries: DurableEntry[],
  promptId?: string,
  options: AppendDurableEventsOptions = {},
): Promise<{
  replay: ReplayState;
  events: SessionEvent[];
  newEvents?: SessionEvent[];
  newReplayEvents?: SessionReplayEvent[];
}> {
  const startedAt = Date.now();
  const sql = getSqlStorage(state);
  const includeEvents = options.includeEvents ?? true;
  if (!Array.isArray(entries) || entries.length === 0) {
    const replay = getReplayStateForSession(sql, sessionId);
    log.info(
      {
        event: "session.append_durable_events.metrics",
        sessionId,
        promptId: promptId ?? null,
        eventCount: 0,
        newEventCount: 0,
        includeEvents,
        durationMs: Date.now() - startedAt,
      },
      "Session durable event append metrics",
    );
    return {
      replay,
      events: includeEvents ? doDb.getEvents(sql, sessionId) : [],
    };
  }
  const { newEvents, newReplayEvents } = doDb.appendEventsWithReplay(sql, sessionId, entries, promptId);
  const replay = getReplayStateForSession(sql, sessionId);
  log.info(
    {
      event: "session.append_durable_events.metrics",
      sessionId,
      promptId: promptId ?? null,
      eventCount: entries.length,
      newEventCount: newEvents.length,
      newReplayEventCount: newReplayEvents.length,
      includeEvents,
      durationMs: Date.now() - startedAt,
    },
    "Session durable event append metrics",
  );
  return {
    replay,
    events: includeEvents ? doDb.getEvents(sql, sessionId) : [],
    newEvents,
    newReplayEvents,
  };
}
