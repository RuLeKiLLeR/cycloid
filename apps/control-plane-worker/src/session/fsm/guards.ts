// ARC-1330 lifecycle FSM — pure guard predicates (Section B, design §6).
//
// PURE PREDICATES: no DB reads, no I/O. Each guard is a pure boolean function of a
// value the caller has already live-read (here: `reduceCiState(head)` from
// services/review-loop-rollup.ts, reused — NOT re-implemented). The Section E spine
// computes these booleans BEFORE calling `transition`, keeping `transition` a pure
// function of `(state, event, guards)`.
//
// This file grows one guard concern per PR (design §9). PR 7 lands the CI ternary:
// the cascade reads a 3-valued CI bucket, NOT a `¬ci_green` binary (FG-4). PR 8/9 add
// the verification + epoch/review guards.

import { MAX_CI_FIX_ROUNDS, MAX_MERGE_READY_REOPENS } from "../../constants/review-loop";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../../constants/verification";
import type { ReviewLoopCiState } from "../../services/review-loop-rollup";
import type { StopMode, Verdict } from "./types";

// ── CI ternary (design §6, FG-4) ─────────────────────────────────────────────
// `reduceCiState(head)` is 4-valued (`green | absent | failing | pending`). The
// cascade partitions those four into exactly three mutually-exclusive buckets. The
// load-bearing FG-4 point: `¬ci_green` is NOT synonymous with "failing" — it also
// covers `ci_pending` — so callers MUST branch on the bucket, never on `¬ci_green`.
export type CiBucket = "ci_green" | "ci_red" | "ci_pending";

/**
 * The exhaustive + disjoint partition of `reduceCiState`'s four return values into
 * the three cascade buckets (FG-4). This `Record<ReviewLoopCiState, CiBucket>` is the
 * compile-time proof, and `src/` is the only typechecked surface:
 *   - EXHAUSTIVE — every `ReviewLoopCiState` must be a key, so dropping/adding a CI
 *     state without re-bucketing it is a `tsc` "missing property" break right here.
 *   - DISJOINT — each state maps to exactly one bucket (a total function cannot put a
 *     value in two buckets), so the three predicates below can never both be true.
 * Design mapping: `green|absent → ci_green`, `failing → ci_red`, `pending → ci_pending`.
 */
export const CI_BUCKET_OF: Record<ReviewLoopCiState, CiBucket> = {
  // No-CI repo (`absent`, D17/F6/F9) is treated as green — nothing red is gating.
  green: "ci_green",
  absent: "ci_green",
  failing: "ci_red",
  pending: "ci_pending",
};

/** Map a live-read CI state to its single cascade bucket (FG-4 partition). */
export function classifyCi(state: ReviewLoopCiState): CiBucket {
  return CI_BUCKET_OF[state];
}

/**
 * `ci_green` — `reduceCiState(head) ∈ {green, absent}` (live-read, D9). Gates
 * merge-readiness. `¬ci_green` is NOT failing alone — it also includes `ci_pending`
 * (FG-4), so do not treat `¬ci_green` as a red signal.
 */
export function ciGreen(state: ReviewLoopCiState): boolean {
  return classifyCi(state) === "ci_green";
}

/**
 * `ci_red` — `reduceCiState(head) == failing` (a genuine red). Drives the cascade
 * ciFix rows (3/4); distinct from `ci_pending` (still running) and `ci_green` (FG-4).
 */
export function ciRed(state: ReviewLoopCiState): boolean {
  return classifyCi(state) === "ci_red";
}

/**
 * `ci_pending` — `reduceCiState(head) == pending` (`pending` DOMINATES in
 * `reduceCiState`). A pending live-read is a WAIT (cascade row 5), never a ciFix
 * trigger or an exhaustion trip (FG-4). `¬ci_green ∧ ¬ci_red`.
 */
export function ciPending(state: ReviewLoopCiState): boolean {
  return classifyCi(state) === "ci_pending";
}

// ── verification guards (design §6, the merge-ready conjunction inputs) ───────
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
//
// Pure predicates over the record fields the cascade live-reads (design §6 table:
// `qa_pass`/`qa_fresh`/`under_qa_cap`/`code_changed_since_qa`, named here in the
// retained 'verification' vocabulary). Each is a function of an already-read scalar;
// no DB reads. The cascade (PR 16) and the §9 verification edges consume these.

/**
 * `verification_pass` — `verdict ∈ {pass, skipped}` (design §6 `qa_pass`). An
 * approving verdict; `skipped` counts as passing (a no-op repo/skip is not a block).
 * `app_breaks`/`none` are NOT passing.
 */
export function verificationPass(verdict: Verdict | null): boolean {
  return verdict === "pass" || verdict === "skipped";
}

/**
 * `verification_fresh` — the cascade freshness guard: the recorded verdict applies to
 * the live head (design §6 `qa_fresh` = `qa_head_sha == head_sha`). Requires a
 * recorded verdict head (`verdictHeadSha !== null`): with no verdict recorded there is
 * nothing fresh, so a null `verdictHeadSha` is never fresh even against a null head.
 * Distinct from verdict-ARRIVAL freshness (`event.runId == verification_run_id`, the
 * §9/PR 17 VERIFYING edges) — this reads the RECORD, that reads the event payload.
 */
export function verificationFresh(verdictHeadSha: string | null, headSha: string | null): boolean {
  return verdictHeadSha !== null && verdictHeadSha === headSha;
}

/**
 * `under_verification_cap` — `verification_run_count < MAX_VERIFICATION_RUNS_PER_PR`
 * (design §6 `under_qa_cap`, reusing the `=3` per-PR constant). `verification_run_count`
 * is consecutive FAILED rounds (B1), reset on a `pass|skipped` record; the cap trips the
 * cascade's `verification_noconverge → NEEDS_YOU` row.
 * W11-V7 authority pin (flipped at D-51): this FSM cap is now the SOLE cap authority.
 * The legacy PR-scoped `checkVerificationRunLimit` is KEPT as a run-budget surface but
 * no longer runs in series as a second binding cap.
 */
export function underVerificationCap(verificationRunCount: number): boolean {
  return verificationRunCount < MAX_VERIFICATION_RUNS_PER_PR;
}

/**
 * `code_changed_since_verification` — the stored bool (design §6 `code_changed_since_qa`,
 * writer set D12: init TRUE at `init_record`, TRUE on real-diff `epoch.committed`, cleared
 * inside `record_verification`). A thin named predicate so the cascade reads a guard, not a
 * raw field. When TRUE the cascade re-dispatches verification; when FALSE the recorded
 * verdict still applies to the current code.
 */
export function codeChangedSinceVerification(codeChanged: boolean): boolean {
  return codeChanged;
}

// ── epoch / review guards (design §6, the REVIEW + caught_up inputs) ──────────
// Pure predicates over already-live-read record fields + an injected read interface.
// `caught_up` is the strong merge-progress trigger (the sole emitter of MERGE_READY via
// the §9 cascade); `no_inflight_epoch`/`actionable`/`under_ci_fix_cap` gate the REVIEW
// dispatch self-loops; `resumable` reads the stop mode. None reads the DB — caught_up's
// disposition + reviewer-settle reads are delegated to a caller-supplied snapshot store
// (the real DAOs land in PR 22 / PR 22A), keeping `transition` pure.

/**
 * `no_inflight_epoch` — no review/ciFix epoch is currently in flight (design §6, reads
 * `in_flight_epoch_id`). A non-null id means one is running; null means none. Gates the
 * eager epoch dispatch + the ciFix self-loops so a second epoch isn't dispatched (and
 * `ci_fix_rounds` isn't double-counted) while one runs. `in_flight_epoch := ¬this`.
 */
export function noInflightEpoch(inFlightEpochId: string | null): boolean {
  return inFlightEpochId === null;
}

/**
 * `actionable` — the `review.received{actionable}` payload field (design §6/§5), surfaced
 * as a thin named predicate so the REVIEW edges read a guard, not a raw event field. TRUE
 * = the review carries a concrete change/comment to disposition; FALSE = noise (e.g. an
 * approving/empty review) that must not register an undispositioned worklist item.
 */
export function actionable(actionableField: boolean): boolean {
  return actionableField;
}

/**
 * `under_ci_fix_cap` — `ci_fix_rounds < MAX_CI_FIX_ROUNDS` (design §6, B7). `ci_fix_rounds`
 * is CONSECUTIVE ciFix rounds (reset to 0 by the FG-2 universal post-action on reaching
 * `ci_green ∧ no_inflight_epoch`), so the cap bounds the ciFix loop, not lifetime spawns;
 * tripping it routes the cascade's ciFix row to `NEEDS_YOU(ci_fix_exhausted)`.
 */
export function underCiFixCap(ciFixRounds: number): boolean {
  return ciFixRounds < MAX_CI_FIX_ROUNDS;
}

/**
 * `under_merge_ready_reopen_cap` — `merge_ready_reopen_count < MAX_MERGE_READY_REOPENS`
 * (design §17-D, the lifetime READY⇄REVIEW flap bound). Unlike `under_ci_fix_cap`,
 * `merge_ready_reopen_count` is a LIFETIME counter (never reset on `MERGE_READY` entry), so
 * this gate bounds an indefinite CI flap, not a single ciFix burst: when it goes false, the
 * `MERGE_READY — ci.signal(failing)` re-open trips `→ NEEDS_YOU(ci_flapping)` (decision 5a)
 * instead of re-opening to REVIEW again.
 */
export function underMergeReadyReopenCap(mergeReadyReopenCount: number): boolean {
  return mergeReadyReopenCount < MAX_MERGE_READY_REOPENS;
}

/**
 * `resumable` — `stop_mode == resumable` (design §6). Distinguishes a resumable stop (a
 * recoverable interruption that can re-enter the loop) from a user cancel. A null stop
 * mode (not stopped) is NOT resumable.
 */
export function resumable(stopMode: StopMode | null): boolean {
  return stopMode === "resumable";
}

/**
 * The caller-supplied snapshot the `caught_up` guard reads its store-backed conjuncts from.
 * PURE seam: both methods are SYNCHRONOUS reads of an already-loaded snapshot (no I/O at
 * call time), so `caught_up` — and `transition` — stay pure. PR 9 codes against this
 * interface; the real DAO-backed readers land in PR 22 (disposition store) and PR 22A
 * (reviewer-settle store); tests pass a stub store.
 */
export interface CaughtUpStore {
  /**
   * Count of registered actionable items NOT yet dispositioned (`fixed`/`replied`/`declined`/
   * `no_action_needed_informational`). Registered-but-undispositioned reviews count here as
   * actionable-undispositioned (design §6, F2/F5). `caught_up` requires this to be 0.
   */
  countUndispositionedActionable(): number;
}

/**
 * `caught_up` — the strong merge-progress trigger (design §6/§9/D11). EXCLUDES `ci_green` and,
 * post-decoupling (ARC-1330 CI-ladder cut), EXCLUDES verification and reviewer-settle: verification
 * runs off-gate (spawned at publish, recorded as bookkeeping), and merge-readiness is decided by the
 * CI ladder in the cascade. Two conjuncts:
 *   1. `no_inflight_epoch` — no epoch currently running.
 *   2. every actionable item dispositioned — `store.countUndispositionedActionable() === 0`.
 * The `caught_up` internal event then runs the §9 CI-ladder cascade (the SOLE emitter of MERGE_READY).
 */
export function caughtUp(noInflightEpochValue: boolean, store: CaughtUpStore): boolean {
  return noInflightEpochValue && store.countUndispositionedActionable() === 0;
}
