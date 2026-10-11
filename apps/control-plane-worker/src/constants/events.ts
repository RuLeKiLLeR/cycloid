/** Flush interval (ms) for buffered text/reasoning delta persistence. */
export const TEXT_DELTA_FLUSH_MS = 50;

export const HEARTBEAT_EVENT_TYPE = "heartbeat";
export const PROMPT_HEARTBEAT_EVENT_TYPE = "prompt_heartbeat";
export const SANDBOX_HEARTBEAT_EVENT_TYPE = `sandbox_${HEARTBEAT_EVENT_TYPE}`;
