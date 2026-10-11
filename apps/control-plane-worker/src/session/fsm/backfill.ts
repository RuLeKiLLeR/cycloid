// ARC-1330 lifecycle FSM (PR 35A) — SHADOW BACKFILL of in-flight legacy sessions (BLOCKER FIX).
//
// Genesis (PR 35) only inserts the `pr_coordination` row for sessions CREATED *after* shadow turns on.
// Every session already mid-flight at flip time (a PR live for days/weeks) has NO row. Without this
// backfill, that session's next webhook at the flip (PR 46) drives `applyEvent → getPrCoordination →
// null → no_record → DD log_noop`, and with legacy no longer driving it (post-flip) its labels/stage
// freeze. PR 35A materializes a `pr_coordination` row for EVERY non-terminal legacy session from its
// current legacy state (state + head + verdict + counts), so the spine can pick it up seamlessly. A
// backfilled session staying divergence-clean is a HARD precondition of the flip (PR 46 gate).
//
// ADDITIVE and idempotent (a SELECT guard, like genesis — a re-run never clobbers a row a producer
// has since advanced); the CALLER wraps each session best-effort OFF the legacy critical path, so a
// backfill fault never perturbs the live session.
//
// FLEET ENUMERATION IS OUT OF SCOPE HERE (staged at flip time). This PR ships the materialization
// PRIMITIVES — the pure record builder, the idempotent per-session insert, the per-session-isolated
// batch driver over a CALLER-SUPPLIED list of legacy snapshots, and the divergence-metric inclusion.
// The one-time "enumerate every non-terminal legacy session and feed it here" job is an operational
// step run when the flip is staged (the at-risk cohort it covers is the PR-46 gate), not a recurring
// shadow code path; wiring a cron/route for it is deferred so this stays a small additive change.

import { createLogger } from "../../logger";
import {
  getPrCoordination,
  insertPrCoordination,
  type PrCoordinationRecord,
  rebaselinePrCoordinationVersion0,
} from "../pr-coordination-db";
import { type LegacyAdapterInput, legacyAdapterRecord } from "./legacy-adapter";
import type { FsmRecord, FsmState } from "./types";

const log = createLogger({ bindings: { component: "fsm-backfill" } });

/**
 * The legacy signals one in-flight session contributes to its backfilled row: the legacy-adapter input
 * (the canonical `phase` + verification / review-loop signals that map to the FSM state + verdict) PLUS
 * the legacy RUN COUNTERS the adapter zeroes but the spine must carry forward (the spec's "+ counts").
 * Carrying them is load-bearing: they feed `under_verification_cap` / `under_ci_fix_cap` once a producer
 * drives the backfilled session, so a mid-flight PR doesn't get its fix-round / verification budget reset.
 */
export interface BackfillInput extends LegacyAdapterInput {
  /** Legacy verification run accounting (re-expressed `verification_attempt_count`), carried, not zeroed. */
  verificationRunCount: number;
  /** Legacy CI-fix round count, carried, not zeroed. */
  ciFixRounds: number;
  /**
   * The head the CURRENT legacy verdict was validated against (`SessionState.verificationVerdictHeadSha`
   * — the ARC-1243 settle anchor). Retained on the input for compatibility, but NO LONGER STEERS the
   * backfilled seed: post the ARC-1330 CI-ladder cut (PR-E2) verification is off-gate, so
   * `buildBackfillRecord` leaves `verdict_head_sha` / `code_changed_since_verification` at the adapter
   * defaults regardless of this anchor. `null` = no settled claim.
   */
  verificationVerdictHeadSha: string | null;
  /** Drill-down only on the divergence DD event (never a metric group tag). */
  businessId?: string | null;
}

/**
 * States we DO NOT backfill: `CREATED` (genesis territory — a created session is new, not in-flight, and
 * no legacy phase even maps here) and the four FINAL terminals `MERGED` / `CLOSED` / `SUPERSEDED` /
 * `ARCHIVED` (no more activity will ever arrive, so a row buys nothing). Every other state — incl. the
 * re-openable `ANSWERED_NO_PR` / `FAILED` / `STOPPED` and the live-PR `REVIEW` / `VERIFYING` /
 * `MERGE_READY` / `NEEDS_YOU` — IS backfilled: those are the sessions a post-flip webhook / resume can
 * still reach, which is exactly the freeze this PR prevents.
 */
const BACKFILL_SKIP_STATES: ReadonlySet<FsmState> = new Set<FsmState>([
  "CREATED",
  "MERGED",
  "CLOSED",
  "SUPERSEDED",
  "ARCHIVED",
]);

/** True iff a session in this FSM state should be materialized by the backfill (non-final, post-genesis). */
export function isBackfillTargetState(state: FsmState): boolean {
  return !BACKFILL_SKIP_STATES.has(state);
}

/**
 * Build the persistable `pr_coordination` row for one in-flight legacy session. PURE.
 *
 * The legacy → FSM mapping (state, verdict, blocked_reason, pr/head) is the SINGLE SOURCE OF TRUTH in
 * `legacyAdapterRecord` (PR 35) — reused verbatim so backfill never drifts from the divergence legacy
 * side. Backfill only layers on the persistence bookkeeping a real row needs (`version=0` — a fresh row
 * the spine then CASes forward; `state_entered_at:=now` — the dwell anchor from the backfill instant, the
 * best available signal for a pre-shadow session), the carried run counters, and the STOPPED-resume seeding:
 *
 *   • NO VERIFICATION STEERING (ARC-1330 CI-ladder cut, PR-E2). The merge-ready door is now a PURE CI
 *     LADDER — verification runs off-gate (spawned at publish, recorded as bookkeeping), and the
 *     `caught_up` cascade no longer reads `verification_pass` / `verification_fresh` /
 *     `code_changed_since_verification`. The former flip-time seeding (settled-fresh `verdict_head_sha`
 *     stamping, the `code_changed:=true` re-verify blanket, and the approving-verdict run-count zeroing)
 *     steered a verification gate that no longer exists, so it is DROPPED: `code_changed_since_verification`
 *     and `verdict_head_sha` ride the adapter defaults and `verification_run_count` is carried RAW.
 *   • `STOPPED` seeds `stop_mode := "resumable"` + a derived `pre_stop_state` — the adapter leaves both
 *     null, which made EVERY backfilled stopped session unresumable post-flip (the
 *     `STOPPED — user.input[resumable]` edge requires both; legacy's own semantics resume a stopped
 *     session on the next prompt). `pre_stop_state` has no faithful legacy source, so it derives from
 *     the PR: a live PR resumes into `REVIEW` (re-arm the watch, no side-effects); pre-PR resumes into
 *     `GENERATING` (dispatch the prompt / re-provision a dead sandbox) — exactly what a follow-up
 *     prompt should do.
 *   • A backfilled `VERIFYING` row carries `verification_run_id=0` / `verification_run_head=null` /
 *     `verification_child_id=null` (adapter defaults) — SANE for the live edges: an in-VERIFYING
 *     `head.changed` runs kill(null child → logged no-op) + `redispatch_verification` (run-id 0→1) +
 *     spawn (which now stamps the new run's `verification_child_id`, W11-V1), no null crash. The
 *     in-flight LEGACY verifier that predates the flip returns a verdict with NO echoed run-id token,
 *     so at LIVE it is REJECTED (mints nothing — fail-toward-NOT-fresh, B4; the VERIFYING deadline
 *     backstop unwedges the session), NOT recorded off a self-sourced run-id 0 — self-sourcing is the
 *     shadow-only fallback (verification-producer `shadowEmitVerifierTerminalVerdict`).
 */
export function buildBackfillRecord(input: BackfillInput, now: number): FsmRecord {
  const adapted = legacyAdapterRecord(input);
  return {
    ...adapted,
    version: 0,
    stateEnteredAt: now,
    verificationRunCount: input.verificationRunCount,
    ciFixRounds: input.ciFixRounds,
    ...(adapted.state === "STOPPED"
      ? { stopMode: "resumable" as const, preStopState: (adapted.prUrl ? "REVIEW" : "GENERATING") as FsmState }
      : {}),
  };
}

/** Outcome of a single-session backfill attempt (observe-only; the batch driver tallies these). */
export type BackfillOutcome = "skipped_terminal" | "inserted" | "exists" | "rebaselined";

export interface BackfillDeps {
  db: D1Database;
  /** Clock seam (deterministic in tests). */
  now: () => number;
  /**
   * PR 46 re-baseline mode: repair a row an EARLIER (bug-shaped) backfill run seeded, in place. Only
   * a row still at `version = 0` (no producer has ever CASed it — the seed is its only content) is
   * rewritten from current legacy state via the fixed `buildBackfillRecord`; the version-0 predicate
   * rides the UPDATE itself, so a `version >= 1` row (real spine history) is NEVER touched. Default
   * absent/false = the original insert-only behavior.
   */
  rebaseline?: boolean;
}

/**
 * Materialize the `pr_coordination` row for ONE in-flight legacy session — idempotent, terminal-safe.
 * A final/terminal mapped state → `skipped_terminal` (nothing to drive). Otherwise a SELECT guard makes
 * a re-run (or a race with genesis / an already-advanced row) a no-op `exists` instead of a PK-collision
 * throw. A rarer concurrent-INSERT race still throws — the CALLER (the batch driver below) isolates each
 * session, so a throw is swallowed there, not here.
 *
 * REBASELINE (`deps.rebaseline`): an existing row still at `version = 0` is recomputed from current
 * legacy state and rewritten in place (`rebaselined`) — the repair path for the prod cohort the merged
 * runner seeded with the pre-fix shape (`code_changed=false`, null `verdict_head_sha`, lifetime run
 * counts, null stop fields), which the insert-only exists-guard would otherwise leave broken forever.
 * `version` stays 0 (a producer CAS still starts from 0) and only `state_entered_at` is refreshed to the
 * re-baseline instant. Idempotent:
 * re-running rewrites the same seed. A row a producer has advanced (`version >= 1`) reports `exists`
 * untouched — including the race where a producer CASes between our SELECT and UPDATE (the UPDATE's
 * own `version = 0` predicate loses cleanly).
 */
export async function backfillInFlightSession(deps: BackfillDeps, input: BackfillInput): Promise<BackfillOutcome> {
  const record = buildBackfillRecord(input, deps.now());
  if (!isBackfillTargetState(record.state)) {
    return "skipped_terminal";
  }
  // Idempotency guard: genesis may have already inserted a row (a session straddling the shadow flip), or
  // a producer may have advanced it — never clobber an existing row back to its legacy snapshot.
  const existing = await getPrCoordination(deps.db, input.sessionId);
  if (existing) {
    if (deps.rebaseline === true && existing.version === 0) {
      const changed = await rebaselinePrCoordinationVersion0(deps.db, record as PrCoordinationRecord);
      if (changed === 1) {
        log.debug({ sessionId: input.sessionId, state: record.state }, "fsm backfill: re-baselined version-0 row");
        return "rebaselined";
      }
      // Lost the version-0 race — a producer advanced the row between the SELECT and the UPDATE.
      return "exists";
    }
    return "exists";
  }
  await insertPrCoordination(deps.db, record as PrCoordinationRecord);
  log.debug({ sessionId: input.sessionId, state: record.state }, "fsm backfill: inserted row");
  return "inserted";
}

/** Per-outcome tally for one backfill batch (observe-only; the operational driver logs/metrics it). */
export interface BackfillBatchResult {
  skippedTerminal: number;
  inserted: number;
  exists: number;
  /** PR 46 re-baseline mode: version-0 rows rewritten in place from current legacy state. */
  rebaselined: number;
  failed: number;
}

/**
 * Backfill a CALLER-SUPPLIED list of in-flight legacy sessions, ISOLATING each one: a single session's
 * throw (the rare concurrent-INSERT race, or a bad legacy snapshot) is caught and tallied as `failed`,
 * never aborting the rest of the batch — the whole point is to materialize the WHOLE cohort. Returns the
 * per-outcome tally. (The list itself is produced by the operational flip-staging enumeration, out of
 * scope here.)
 */
export async function backfillSessions(
  deps: BackfillDeps,
  inputs: readonly BackfillInput[],
): Promise<BackfillBatchResult> {
  const result: BackfillBatchResult = { skippedTerminal: 0, inserted: 0, exists: 0, rebaselined: 0, failed: 0 };
  for (const input of inputs) {
    try {
      const outcome = await backfillInFlightSession(deps, input);
      switch (outcome) {
        case "skipped_terminal":
          result.skippedTerminal += 1;
          break;
        case "inserted":
          result.inserted += 1;
          break;
        case "exists":
          result.exists += 1;
          break;
        case "rebaselined":
          result.rebaselined += 1;
          break;
      }
    } catch (err) {
      result.failed += 1;
      log.warn({ sessionId: input.sessionId, error: String(err) }, "fsm backfill: session failed (isolated)");
    }
  }
  return result;
}
