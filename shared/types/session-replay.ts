import type { CycloidEvent, Phase } from "../events/schema.js";
import type { DurableSessionEvent } from "./session.js";

export type SessionReplayTransportEvent<P extends Phase = Phase> = CycloidEvent<P> & {
  sequence: number;
};

export type SessionReplayEvent = DurableSessionEvent | SessionReplayTransportEvent;

export type SessionReplayPage = {
  afterSequence: number;
  beforeSequence?: number | null;
  events: SessionReplayEvent[];
  hasMore: boolean;
  // Lower-bound truncation sentinel: 1 means at least one replay event was omitted.
  droppedCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
};

export type SessionReplayResponse = {
  ok: boolean;
} & SessionReplayPage;
