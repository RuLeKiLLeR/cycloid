/** Shared schema for prompt dispatch latency observability events. */
export const DISPATCH_SUBSPAN_EVENT = "prompt.dispatch_subspan";
export const DISPATCH_SUBSPANS_COMPLETED_EVENT = "prompt.dispatch_subspans_completed";

/** Fixed milestone names for the dispatch -> first-visible-event waterfall. */
export const DISPATCH_SUBSPAN_NAMES = [
  "runtime_client_ready",
  "session_created",
  "prompt_sent_to_backend",
  "backend_first_token",
  "bridge_first_visible_event_queued",
  "bridge_first_visible_event_buffered",
  "bridge_first_visible_event",
] as const;

export type DispatchSubspanName = (typeof DISPATCH_SUBSPAN_NAMES)[number];

export const DISPATCH_SUBSPAN_NAME_SET: ReadonlySet<string> = new Set(DISPATCH_SUBSPAN_NAMES);

export const DISPATCH_SUBSPAN_SNAPSHOT_KEYS = [
  "offset_ms",
  "duration_ms",
  "signal",
  "first_event_type",
  "skipped",
] as const;

const DISPATCH_SUBSPAN_SNAPSHOT_KEY_SET: ReadonlySet<string> = new Set(DISPATCH_SUBSPAN_SNAPSHOT_KEYS);

export type DispatchSubspanSnapshot = {
  offset_ms: number;
  duration_ms?: number;
  signal?: string;
  first_event_type?: string;
  skipped?: boolean;
};

export function isDispatchSubspanName(value: string): value is DispatchSubspanName {
  return DISPATCH_SUBSPAN_NAME_SET.has(value);
}

export function isDispatchSubspanSnapshot(value: unknown): value is DispatchSubspanSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.offset_ms !== "number") return false;
  if ("duration_ms" in snapshot && typeof snapshot.duration_ms !== "number") return false;
  if ("signal" in snapshot && typeof snapshot.signal !== "string") return false;
  if ("first_event_type" in snapshot && typeof snapshot.first_event_type !== "string") return false;
  if ("skipped" in snapshot && typeof snapshot.skipped !== "boolean") return false;

  return Object.keys(snapshot).every((key) => DISPATCH_SUBSPAN_SNAPSHOT_KEY_SET.has(key));
}
