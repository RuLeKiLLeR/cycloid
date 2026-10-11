// ARC-1330 review-loop caps (design §6/§7, B7). Named constants so the FSM guards and
// the caught_up cascade read one source of truth, retunable post-shadow (tech-spec
// fork (b): caps are named constants + a cap-trip metric).

/**
 * `MAX_CI_FIX_ROUNDS` — the consecutive-ciFix-round bound (design §6 `under_ci_fix_cap`,
 * B7). `ci_fix_rounds` counts CONSECUTIVE ciFix dispatches, reset to 0 by the FG-2
 * conditional universal post-action on any committed post-PR transition reaching
 * `ci_green ∧ no_inflight_epoch`. When it reaches this cap the cascade's ciFix row trips
 * `→ NEEDS_YOU(ci_fix_exhausted)`. Mirrors `MAX_VERIFICATION_RUNS_PER_PR`'s `=3` shape.
 */
export const MAX_CI_FIX_ROUNDS = 3;

/**
 * `MAX_MERGE_READY_REOPENS` — the LIFETIME cap on red-CI re-opens out of `MERGE_READY`
 * (design §17-D, tech-spec fork (b) `=5`). `merge_ready_reopen_count` counts those re-opens
 * and is NEVER reset on `MERGE_READY` entry (unlike `ci_fix_rounds`, which resets at the
 * green that produced READY), so it bounds an indefinite CI flap (READY⇄REVIEW): once a
 * red-CI re-open would push the count past this cap, the `MERGE_READY — ci.signal(failing)`
 * edge routes to `NEEDS_YOU{ci_flapping}` (decision 5a) instead of re-opening again.
 */
export const MAX_MERGE_READY_REOPENS = 5;

/**
 * `BOT_FIRST_CONTACT_WINDOW_MS` — the per-PR-per-reviewer first-contact no-show window for a
 * BOT (installed/configured review app) reviewer (design §4/§6, v7 §B4 + v8 per-kind pin).
 * Armed once at `init_record`; if the bot has not posted within this window the per-session
 * DO alarm (PR 43) settles it `no_show` (sticky). "Fast-or-down" — a review app responds in
 * seconds-to-minutes or not at all, so this is short; tunable post-shadow from §18 per-kind p95.
 */
export const BOT_FIRST_CONTACT_WINDOW_MS = 3 * 60 * 1000;

/**
 * `NO_SIGNAL_ADVANCE_WINDOW_MS` — bounded per-session poll cadence for the no-bots / no-CI cohort.
 * When no expected review bot can ever arrive, this DO alarm supplies the missing `ci.signal` recompute
 * trigger so the FSM can request verification and then settle MERGE_READY without waiting for the
 * `REVIEW_STUCK_DEADLINE_MS` REVIEW backstop. The two-poll absent debounce still leaves late CI checks
 * room to register while
 * cutting the no-signal absent floor to about 3 minutes.
 */
export const NO_SIGNAL_ADVANCE_WINDOW_MS = 90 * 1000;

/**
 * `HUMAN_FIRST_CONTACT_WINDOW_MS` — the first-contact window for a HUMAN reviewer is ZERO
 * (design §4/§6, v8 latency pin). A human is armed straight to `no_show` so they NEVER gate
 * the first `caught_up`: `MERGE_READY` is signal-only and a human merges anyway, so blocking
 * on a human's first contact is dead-wait. A late human comment re-opens via the §9
 * `MERGE_READY → REVIEW` path (PR 18) — optimistic settle, not a block.
 */
export const HUMAN_FIRST_CONTACT_WINDOW_MS = 0;

// ── Per-state deadline-class windows (ARC-1330 design §10 `deadline_class(state)`, PR 44) ──
// The `arm_deadline` post-action stamps `deadline_at := now + deadline_class(state)` on every
// transition; the per-session DO alarm fires `deadline_exceeded` when it elapses (the §10
// anti-silent-stall backstop). Every value here is PROVISIONAL — the shadow phase runs the
// deadline producer observe-only ("would-fire", F39) precisely so each class can be tuned
// against the live per-state dwell-time distribution (§18) BEFORE any teardown fires. The
// codegen-phase windows reuse the legacy watchdog timeouts (`constants/sessions.ts`) so the
// shadow row's deadline tracks legacy; the post-publish/wait windows are new FSM tunables.

/**
 * `AWAITING_INPUT_DEADLINE_MS` — the abandon window for an `AWAITING_INPUT` session waiting on
 * user input that never comes (`→ STOPPED(resumable)`, §10; a wait-state abandon, NOT a block).
 * A user may step away for hours; sized long so a resumable wait is never prematurely stopped.
 */
export const AWAITING_INPUT_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * `REVIEW_STUCK_DEADLINE_MS` — the abandon window for a `REVIEW` session that never converges to
 * `caught_up` (`→ NEEDS_YOU(review_stuck)`, §10; drains the transient verification queue, loud).
 * Measured from the last REAL progress (a field-write/registration), NOT from PR creation — the
 * churn-immunity (dwell-neutral CI re-polls / `epoch.deferred`) keeps this reachable, and every
 * genuine event (push, actionable review, CI bucket transition, epoch dispatch) re-arms it. Tuned
 * DOWN to 4h (from 24h) so a wedged loop surfaces to a human within a workday instead of a full day:
 * within ~4h a session should have settled — either converged to `caught_up`/`MERGE_READY` or
 * genuinely stuck. Safe because `NEEDS_YOU(review_stuck)` is RE-OPENABLE (transition.ts §NEEDS_YOU):
 * a later actionable review / push / retrigger clears the block and re-opens to REVIEW with fresh
 * budgets, so a premature trip on a slow human reviewer self-heals (cost is one loud page + a drain,
 * not lost work). Backstops a permanently-pending CI / a stranded worklist.
 */
export const REVIEW_STUCK_DEADLINE_MS = 4 * 60 * 60 * 1000;

/**
 * `VERIFYING_BACKSTOP_DEADLINE_MS` — the COARSE contract backstop for a verification child that
 * emitted no terminal event (`→ NEEDS_YOU(verification_stopped)` + kill + drain, §10). This is
 * EXPLICITLY NOT a liveness signal (P2/D16): QA-internal liveness is out of scope, so the spine
 * only guards against a contract-violating child that goes silent. Sized against the verification
 * run distribution with generous headroom (a long run must not trip it); tunable post-shadow.
 */
export const VERIFYING_BACKSTOP_DEADLINE_MS = 60 * 60 * 1000;

/** Conservative fan-out for due review-loop epoch dispatch; per-session groups still run serially. */
export const REVIEW_LOOP_DISPATCH_CONCURRENCY = 6;

/**
 * `MERGE_READY_RECONCILE_DEADLINE_MS` — the long reconcile re-poll for a `MERGE_READY` session
 * (D17): NOT a terminal — it re-polls PR state via the cross-session cron sweep to catch a dropped
 * `pr.merged`/`pr.closed` webhook, then re-arms (the `deadline_exceeded` edge is a handled
 * `MERGE_READY → MERGE_READY` self-loop). The cron poll normally fires first; this is the floor so
 * a "Ready" session is never stuck forever on a lost terminal webhook.
 */
export const MERGE_READY_RECONCILE_DEADLINE_MS = 6 * 60 * 60 * 1000;
