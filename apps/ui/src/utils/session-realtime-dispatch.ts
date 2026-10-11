import {
  getRawSessionEventData,
  getRawSessionEventKind,
  getRawSessionEventTimestamp,
} from "../../../../shared/transcript/projector.js";
import type { SessionReplayEvent } from "../../../../shared/types/session-replay.js";
import type { DurableEventDispatchContext } from "./durable-event-dispatch";
import { handleDurableEvent } from "./durable-event-dispatch";

type RealtimeDurableEvent = SessionReplayEvent;

type MutableRef<T> = { current: T };

interface RealtimeDispatchState {
  lastSequenceRef: MutableRef<number>;
}

export function dispatchRealtimeDurableEvent(
  event: RealtimeDurableEvent,
  context: DurableEventDispatchContext["context"],
  dispatchCtx: DurableEventDispatchContext,
  state: RealtimeDispatchState,
): boolean {
  if (event.sequence <= state.lastSequenceRef.current) return false;
  state.lastSequenceRef.current = event.sequence;

  if (context === "live") {
    dispatchCtx.dispatch({ type: "event/ingest_live_event", event });
  } else {
    dispatchCtx.dispatch({ type: "event/ingest_replay_page", events: [event] });
  }

  const eventTimestamp = getRawSessionEventTimestamp(event);
  handleDurableEvent(
    getRawSessionEventKind(event),
    getRawSessionEventData(event) ?? {},
    { ...dispatchCtx, context },
    eventTimestamp,
  );
  return true;
}
