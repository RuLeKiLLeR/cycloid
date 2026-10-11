/**
 * Active-prompt silence watchdog. The bridge reports prompt activity pulses;
 * the control plane owns stale-prompt failure when a running prompt goes quiet.
 */
export const STALE_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

/** Hard prompt ceiling while the bridge reports activity but never emits a terminal event. */
export const PROMPT_MAX_DURATION_MS = 30 * 60 * 1000;

/**
 * Headroom over the answer byte cap for the cheap pre-parse Content-Length guard
 * on /respond. Covers the JSON envelope (`{"answer":"…","questionId":"…"}`) so a
 * valid near-cap answer is not falsely rejected before parsing; the post-parse
 * UTF-8 byte check on the answer field remains authoritative.
 */
export const RESPOND_BODY_ENVELOPE_HEADROOM_BYTES = 64 * 1024;

// Bound is 128 (not 64) so internally-generated ids stay valid: Slack channel
// automation builds `automation-slack-alert-<32hex>-<ts>` (~73 chars) and routes
// it through createSessionState. The charset stays tight for injection safety.
export const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;
export const INVALID_SESSION_ID_MESSAGE =
  "sessionId must be 1-128 characters of letters, numbers, underscores, or hyphens";

export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_REGEX.test(value);
}

/** Durable marker for who stopped a prompt, used for late terminal reconciliation. */
export const PROMPT_STOPPED_BY_STORAGE_KEY = "prompt_stopped_by";

// Live-idle user-stop (resume-stopped-session): stamped when a manual user stop keeps the
// sandbox live-idle instead of pausing. Durable timestamp for the `sandbox.stop_kept_alive`
// telemetry (resume_latency_ms) and the source of truth for the userStopped badge across DO
// eviction. Deliberately a DO storage key, never a D1 column.
export const STOPPED_KEPT_ALIVE_AT_STORAGE_KEY = "stopped_kept_alive_at";

/** Hot-path mirror of authoritative DO-SQLite session_plans.status='pending'. */
export const PLAN_APPROVAL_PENDING_STORAGE_KEY = "plan_approval_pending";

/**
 * Durable record of the answer a user submitted for the active prompt's pending
 * question. Persisted on `/session/respond` so a `respond` frame dropped by a
 * mid-flight disconnect (or a DO eviction that races the send) is redelivered
 * when the bridge reconnects, instead of deadlocking the prompt that is blocked
 * awaiting the answer. Cleared when the owning prompt reaches a terminal state
 * (`clearPromptMarkers`) or when it is observed stale on reconnect. One pending
 * question is open per session at a time, so a single record suffices. (9.3.)
 */
export const PENDING_ANSWER_STORAGE_KEY = "pending_answer";

export interface PendingAnswerRecord {
  /** The processing prompt that owns the question this answer resolves. */
  promptId: string;
  /** The question id echoed back to the bridge as the `respond` requestId. */
  questionId: string;
  /** The user's answer text. */
  answer: string;
}

/** Durable PR-readiness evidence captured for review-loop publishes. */
export const PR_READINESS_STORAGE_KEY = "pr_readiness";

/**
 * Durable anchor for the prompt that owns the in-flight publish. A publish
 * interrupted by a DO restart (e.g. a deploy-induced eviction) is resumed via
 * `resumeStuckPublish`; recovering this promptId lets the resumed attempt re-key
 * the dedup marker, the `create_pr_*` durable step, and the per-prompt
 * single-flight on the SAME `(sessionId, promptId)` as the interrupted attempt,
 * so resume adopts the prior attempt's PR instead of opening a duplicate.
 */
export const PUBLISHING_PROMPT_ID_STORAGE_KEY = "publishing_prompt_id";

/** Connection generation counter key mirrored into DO storage. */
export const SANDBOX_CONNECTION_GENERATION_STORAGE_KEY = "sandbox_connection_gen";

export type PromptStoppedBy = "user";

/**
 * Time to wait for a spawned sandbox to connect back via WebSocket before
 * failing fast instead of waiting for the full stale prompt timeout.
 */
export const SPAWN_CONNECT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Extended timeout for fresh-clone sandboxes (no pre-built repo image).
 * Fresh clones need to git clone + install deps from scratch, which can
 * take several minutes for larger repos.
 */
export const SPAWN_CONNECT_TIMEOUT_COLD_MS = 10 * 60 * 1000;

/**
 * Grace period before auto-closing an idle session after sandbox disconnect (24 hours).
 *
 * UX dial, not an infra constraint. Override via the `SESSION_AUTO_CLOSE_GRACE_MS`
 * Cloudflare env var (config edit, no redeploy needed) before changing this default.
 */
const AUTO_CLOSE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the auto-close grace at runtime. Reads `SESSION_AUTO_CLOSE_GRACE_MS` from env
 * when set to a positive integer (milliseconds); otherwise falls back to AUTO_CLOSE_GRACE_MS.
 *
 * Uses `Number()` rather than `parseInt()` so scientific notation like "1e9" parses to
 * 1_000_000_000 instead of being silently truncated to 1, which would set the grace to
 * 1 ms and make sessions immediately eligible for auto-close.
 */
export function getAutoCloseGraceMs(env: { SESSION_AUTO_CLOSE_GRACE_MS?: string }): number {
  const raw = env.SESSION_AUTO_CLOSE_GRACE_MS;
  if (!raw) return AUTO_CLOSE_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return AUTO_CLOSE_GRACE_MS;
  return parsed;
}

/**
 * Observation window from the last proven bridge heartbeat before the control
 * plane asks the runtime provider to confirm sandbox loss. Tool activity and
 * prompt inactivity do not alter this independent deadline.
 */
export const SANDBOX_LOSS_RECOVERY_BUDGET_MS = 60 * 1000;

/** Grace period for a transient sandbox WebSocket disconnect before failing work. */
export const SANDBOX_RECONNECT_GRACE_MS = SANDBOX_LOSS_RECOVERY_BUDGET_MS;

/**
 * Heartbeat-liveness window for an open sandbox socket. The bridge heartbeats
 * every 30s; 60s = 2 missed beats. Drives the phase-independent liveness
 * watchdog so a socket that accepts but goes silent (zombie transport, bridge
 * crash) triggers an independent provider check in ~60s instead of riding the
 * prompt inactivity ceilings. Provider alive/unknown results remain under
 * observation and are not treated as sandbox loss.
 */
export const SANDBOX_HEARTBEAT_LIVENESS_MS = SANDBOX_LOSS_RECOVERY_BUDGET_MS;

/**
 * ARC-1248: heartbeat-staleness bound the orphan reaper's liveness guard uses to
 * decide whether a session-tagged candidate VM is provably alive. Far more
 * conservative than the 60s dispatch bound above: the reaper is a backstop, a
 * candidate that reaches it is already unreferenced AND >10min old, and a healthy
 * bridge beats every 30s — so >5min (~10 missed beats) is the threshold below
 * which we refuse to treat the VM as dead. Compared with signed `ageMs` (not the
 * `Math.abs` `fresh` flag) so a future-skewed clock protects rather than kills.
 */
export const SANDBOX_REAPER_LIVENESS_STALE_MS = 5 * 60 * 1000;

/**
 * ARC-1248: consecutive reaper sweeps a candidate must be observed physically
 * `running` with a stale heartbeat before the guard reclaims it as a zombie. A
 * live WS-dropped builder re-beats and resets this within one sweep; only a
 * bridge-dead VM accumulates to the bound. Debounce, not inline-terminate-on-
 * stale, is what stops a deploy/eviction-disconnect from re-introducing churn.
 */
export const SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS = 3;

/**
 * Consecutive orphan-reaper sweeps that must observe an unavailable owner runtime
 * read before the owner guard falls back to the existing reclaim decision. A
 * single null/unreadable DO read must never kill a live paused runtime.
 */
export const SANDBOX_REAPER_RUNTIME_READ_UNAVAILABLE_SWEEPS = 3;

/**
 * ARC-1248: cap on how many distinct runtime ids the per-runtime zombie-sweep
 * debounce map (one DO-storage record) tracks at once. A session normally has a
 * handful of unreferenced-but-running leftover VMs; this only bounds a
 * pathological long-churning session whose leftovers vanish without being
 * reclaimed. Over the cap, the lowest-progress entries are dropped (they simply
 * restart from 1 on their next stale sweep — fail-safe toward not reaping).
 */
export const SANDBOX_REAPER_ZOMBIE_SWEEP_MAX_RUNTIMES = 64;

/**
 * Grace-overlap window for sandbox HTTP auth-token rotation. Every WS accept
 * (including a transport reconnect) mints a fresh `sandbox_auth_token_hash` and
 * the upgrade path marks the presented token consumed. A still-running bridge
 * whose transport reconnected but that never adopted the new token (zombie /
 * dropped transport) still holds the prior token; we keep that prior hash valid
 * for REST calls (rollout, clone-token) for this window so its in-flight work
 * can finish instead of 403-ing and being abandoned.
 *
 * Sized to the first liveness-observation horizon, NOT the prompt ceiling. A
 * longer window adds exposure (the prior token, incl. the GitHub clone-token,
 * stays REST-valid). The prior token is bounded by both
 * expiry and fail-closed-after-expiry; it is sandbox- and session-scoped and
 * cannot open a second socket (the one-time-exchange consume marker still
 * blocks that independently).
 */
export const SANDBOX_AUTH_TOKEN_OVERLAP_MS = SANDBOX_HEARTBEAT_LIVENESS_MS;

/**
 * How many prior auth-token generations stay valid inside the overlap window.
 *
 * A deploy/network storm can roll the token several times in quick succession
 * (each WS reconnect mints a new one), so a single prior slot leaves an in-flight
 * REST call against a 2+-generations-old token to be 403'd. Retaining a few prior
 * generations covers a storm of this depth. Kept small on purpose: each generation
 * is independently bounded by `SANDBOX_AUTH_TOKEN_OVERLAP_MS` expiry, so a larger N
 * only widens the accepted-token surface without extending any token's useful life.
 * Set to 1 to fall back to single-generation overlap (the pre-ARC behavior).
 */
export const SANDBOX_AUTH_TOKEN_OVERLAP_GENERATIONS = 3;

/**
 * Bound for the observational disconnect cross-check (`listCycloidSandboxes` per
 * backend at terminalize time). The cross-check is diagnosis-only and runs off the
 * decision path via `waitUntil`; this timeout keeps a slow/hung E2B list call from
 * lingering. It never gates the terminate/defer decision. Matches the 5s liveness
 * probe budget.
 */
export const SANDBOX_DISCONNECT_CROSSCHECK_TIMEOUT_MS = 5_000;

/**
 * Per-attempt bound for the Freestyle disconnect cross-check, which reads the
 * session's OWN VM (`getSandboxInfo` = GET /v1/vms/{vm_id}) instead of an
 * account-wide list (ARC-1484: Freestyle's list is shared across envs, so it can
 * never reliably cross-check a single env's VM). 15s, not the 5s list budget: this
 * is the same per-VM read the liveness probe makes, and a live Freestyle read was
 * observed taking 11.6s (ARC-1478); a 5s cap would clip a slow-but-alive read to
 * `unknown` and make the cross-check report `inconclusive` on healthy VMs. Safe
 * because the cross-check runs off the decision path via `waitUntil` (no 60s
 * watchdog pressure). `getSandboxInfo` self-bounds each attempt with this value and
 * never throws, so no outer timeout is layered on top.
 */
export const SANDBOX_DISCONNECT_CROSSCHECK_PROBE_TIMEOUT_MS = 15_000;

/** Minimum delay when arming a SessionDO alarm to prevent immediate-fire loops. */
export const MIN_ALARM_DELAY_MS = 1000;

/** Lifecycle reducer durable storage keys. */
export const LIFECYCLE_SANDBOX_STATE_STORAGE_KEY = "lifecycle:sandbox:state";
export const LIFECYCLE_PROMPT_PHASE_STORAGE_KEY = "lifecycle:prompt:phase";
export const LIFECYCLE_SPAWN_IN_PROGRESS_STORAGE_KEY = "lifecycle:spawn:in_progress";
export const LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY = "lifecycle:spawn:failure_count";
export const LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY = "lifecycle:spawn:last_failure_at";
export const LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY = "lifecycle:deadline:sandbox_reconnect_grace";
export const LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY = "lifecycle:deadline:sandbox_liveness";
export const LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY = "lifecycle:deadline:prompt_startup";
export const LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY = "lifecycle:deadline:prompt_dispatch";
export const LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY = "lifecycle:deadline:prompt_running_inactivity";
export const LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY = "lifecycle:deadline:spawn_timeout";

// ARC-1248: per-runtime debounce counter for the orphan reaper's zombie reclaim.
// Stores `{ runtimeSandboxId, count }` so a `running`-but-stale candidate is
// reclaimed only after SANDBOX_REAPER_ZOMBIE_STALE_SWEEPS consecutive sweeps.
// Keyed on the runtime id so a fresh heartbeat or a new runtime resets the count.
export const LIFECYCLE_REAPER_ZOMBIE_SWEEPS_STORAGE_KEY = "lifecycle:reaper:zombie_sweeps";

// ARC-1054: the DO-resident E2B cleanup workflow arms this deadline to retry a
// failed cleanup attempt. The stored value is `{ runtimeSandboxId, deadlineAt }`
// so the alarm handler knows which sandbox's cleanup job to resume. Its source
// is in IMMEDIATE_CATCH_UP_ALARM_SOURCES so a past-due retry still fires.
export const LIFECYCLE_E2B_CLEANUP_RETRY_DEADLINE_STORAGE_KEY = "lifecycle:deadline:e2b_cleanup_retry";

// ARC-1054: per-sandbox cleanup job record key prefix. The full key is
// `${prefix}${runtimeSandboxId}`; keying by sandbox id means a newer runtime
// gets a fresh job and never inherits a stale one's attempt count.
export const E2B_CLEANUP_JOB_STORAGE_KEY_PREFIX = "e2b_cleanup_job:";

/**
 * ARC-876 watchdog deadlines. Post-execution and publishing are durable
 * pending states whose exit depends on a later async event; without a deadline
 * a lost or delayed event leaves the session stuck in `finalizing`.
 *
 * Defaults are provisional: tune with `session.watchdog.expired`. Normal
 * post_execution arrives in ~30s; publishing is single-digit seconds. 20
 * minutes absorbs slow git push, large diffs, and multiple retries without
 * forcing premature failure.
 */
export const POST_EXECUTION_DEADLINE_MS = 20 * 60 * 1000;
export const PUBLISHING_DEADLINE_MS = 20 * 60 * 1000;

/** Maximum time to wait for a final stop-boundary snapshot before recording failure. */
export const STOP_BOUNDARY_SNAPSHOT_TIMEOUT_MS = 30 * 1000;

/** Maximum length of a derived session title. */
export const SESSION_TITLE_MAX_LENGTH = 72;

/** Derive a session title from the first line of prompt text. */
export function deriveFirstLineTitle(text: string): string | null {
  const line = text
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, SESSION_TITLE_MAX_LENGTH);
  return line || null;
}

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

/** Sources that generate usage records. */
export const USAGE_SOURCE_SANDBOX = "sandbox" as const;

/** Multiplier for storing USD as integer micro-dollars in D1 to avoid floating-point drift. */
export const USD_TO_MICROS = 1_000_000;

/** Shape of per-prompt usage stored in DO durable storage keyed by promptId. */
export interface PerPromptUsage {
  promptId: string;
  model: string | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

/** Model-level usage breakdown within the usage cache. */
interface ModelUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalBilledTokens: number;
  costUsd: number;
}

/**
 * Session usage summary derived from per-prompt usage snapshots.
 * Computed on-demand from `prompt_usage` for GET /session/usage responses.
 */
export interface UsageCache {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
  totalTokens: number;
  totalBilledTokens: number;
  promptCount: number;
  byModel: Record<string, ModelUsageBreakdown>;
  byPrompt: PerPromptUsage[];
}

/**
 * Byte budget for the check-run output evidence embedded in CI-fix review-loop
 * worklist items. Check-run `output.summary`/`output.text` can be arbitrarily
 * large (some apps dump full logs); the worklist item only needs enough for the
 * agent to identify the failure without a re-run, and the prompt tells it how
 * to fetch full logs itself.
 */
export const CI_CHECK_OUTPUT_EVIDENCE_MAX_CHARS = 3000;
