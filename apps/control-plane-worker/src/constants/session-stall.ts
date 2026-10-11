/**
 * Live session-stall watch constants.
 *
 * The FSM already emits `arcanist.fsm.stage_dwell_ms` — but ONLY on a committed
 * transition (a log-metric over the `fsm.transition` event). A session that
 * WEDGES in a state never transitions, so that metric stays silent exactly when
 * we most need a signal (the OpenEvidence/xyla OOM: sessions sat in FINALIZING
 * 30+ min and nothing paged). This sweep closes that gap by sampling the age of
 * the oldest session still sitting in each automated state.
 */
import type { FsmState } from "../session/fsm/types";

/**
 * States where prolonged dwell means "the machine is stuck", not "waiting on a
 * human/CI". This mirrors the FSM's HARD_FAILURE_STATES group (transition.ts):
 * the automated pre-publish arc a session should move through in seconds-to-
 * minutes. Post-publish states (REVIEW/VERIFYING/MERGE_READY/NEEDS_YOU/
 * AWAITING_INPUT) are deliberately excluded — they legitimately dwell for hours
 * on CI or an owner, so a long dwell there is not a stall.
 */
export const STALL_WATCH_STATES: readonly FsmState[] = [
  "CREATED",
  "PROVISIONING",
  "GENERATING",
  "FINALIZING",
  "PUBLISHING",
];

/** Gauge: age (ms) of the OLDEST session currently in the tagged state. */
export const SESSION_STATE_DWELL_OLDEST_METRIC = "arcanist.session.state_dwell_oldest_ms";
/** Gauge: number of sessions in the tagged state older than the stall threshold. */
export const SESSION_STALLED_COUNT_METRIC = "arcanist.session.stalled_count";
/** Gauge: total age of the oldest live verification-role session. */
export const VERIFICATION_SESSION_AGE_OLDEST_METRIC = "arcanist.verification.session_age_oldest_ms";
/** Gauge: live verification sessions older than the hard completion budget. */
export const VERIFICATION_SESSION_STALLED_COUNT_METRIC = "arcanist.verification.session_stalled_count";
/** Gauge: live verifier rows whose created_at cannot be parsed. */
export const VERIFICATION_SESSION_UNANCHORED_COUNT_METRIC = "arcanist.verification.session_unanchored_count";

/**
 * "Running long" threshold: a session in FINALIZING past this gets a warn log +
 * a `stalled_count` gauge point (investigation signal, not a page). Normal-repo
 * finalize is ~1–5 min; a heavy repo can legitimately take longer (an OBSERVED
 * healthy xyla finalize took ~15 min), and the OOM-wedged cases sat 30+ min. So
 * the PAGING monitor (infra/datadog-session-stall.tf) fires higher — 20 min
 * critical, above the healthy-slow band — while this 10-min mark surfaces the
 * "finalize is dragging" cases for review without paging on slow-but-healthy.
 */
export const FINALIZING_STALL_THRESHOLD_MS = 600_000;

/** Verification sessions are expected to reach a terminal state within ten minutes. */
export const VERIFICATION_SESSION_DEADLINE_MS = 600_000;

/**
 * Hard cross-session recovery threshold. This is deliberately above every
 * normal pre-publish watchdog window, so the sweep is a last-resort backstop
 * for a dormant DO rather than a second happy-path timer.
 */
export const PRE_PUBLISH_STALL_BACKSTOP_MS = 45 * 60_000;

/** Bound mutations per cron tick; remaining candidates retry on the next tick. */
export const PRE_PUBLISH_STALL_BACKSTOP_BATCH_SIZE = 50;

/** Bound the sweep's aggregate scan (pr_coordination holds hundreds of rows). */
export const SESSION_STALL_SWEEP_MAX_STATES = STALL_WATCH_STATES.length;
