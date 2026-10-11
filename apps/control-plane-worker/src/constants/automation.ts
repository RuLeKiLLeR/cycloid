// Minimum allowed cron cadence in minutes. Mirrors the control-plane every-5-minute sweep.
export const AUTOMATION_MIN_CADENCE_MINUTES = 5;

/** Maximum enabled scheduled rules per business in V1. */
export const AUTOMATION_MAX_ENABLED_RULES_PER_BUSINESS = 20;

/**
 * Maximum total scheduled rules (enabled + paused) per business. Bounds row
 * growth from paused creates/duplicates, which don't count against the
 * enabled cap.
 */
export const AUTOMATION_MAX_RULES_PER_BUSINESS = 40;

/** Maximum concurrent non-terminal automation sessions per business in V1. */
export const AUTOMATION_MAX_CONCURRENT_SESSIONS_PER_BUSINESS = 5;

/** Per-tick budget for the scheduler sweep. */
export const AUTOMATION_PER_TICK_RULE_BUDGET = 50;

/** Maximum length of the optional rule display name. */
export const AUTOMATION_RULE_NAME_MAX_LENGTH = 80;

/** Maximum length of the stored prompt template. */
export const AUTOMATION_RULE_PROMPT_MAX_LENGTH = 8000;

/** Default pagination limit for the schedules list endpoint. */
export const AUTOMATION_LIST_DEFAULT_LIMIT = 50;

/** Maximum pagination limit for the schedules list endpoint. */
export const AUTOMATION_LIST_MAX_LIMIT = 100;

/** Default pagination limit for the per-rule run-history endpoint. */
export const AUTOMATION_RUNS_DEFAULT_LIMIT = 20;

/** Maximum pagination limit for the per-rule run-history endpoint. */
export const AUTOMATION_RUNS_MAX_LIMIT = 100;

/** Rolling window for the 24-hour run-outcome counts on the run-history endpoint. */
export const AUTOMATION_RUN_STATS_WINDOW_24H_MS = 24 * 60 * 60 * 1000;

/** Rolling window for the 7-day run-outcome counts on the run-history endpoint. */
export const AUTOMATION_RUN_STATS_WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000;
