/** Observability constants for the control plane worker. */

export const DD_DEFAULT_SITE = "us5.datadoghq.com";
export const DD_SOURCE = "cycloid";
export const DD_HOSTNAME = "cf-worker";
export const CONTROL_PLANE_SERVICE_NAME = "cycloid-control-plane";
// ARC-1196: lifecycle event types excluded from the Datadog direct post.
// These fire at heartbeat/sub-second cadence per active session; the console
// log keeps them, but direct-posting each would dominate event volume.
export const HIGH_FREQUENCY_LIFECYCLE_EVENT_TYPES = new Set(["sandbox.heartbeat_received", "prompt.running_activity"]);
export const SQL_TRUNCATION_LENGTH = 100;
export const URL_TRUNCATION_LENGTH = 200;
export const PROMPT_RUNS_DEFAULT_LIMIT = 50;
export const PROMPT_RUNS_MAX_LIMIT = 200;
