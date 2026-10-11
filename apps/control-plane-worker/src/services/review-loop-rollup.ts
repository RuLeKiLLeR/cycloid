import type { CommitCheckRun, CommitStatusContext } from "../github/pr";
import { getCommitCheckRuns, getCommitStatusContexts, hasPendingCheckRuns, isFailingCheckRun } from "../github/pr";
import type { ReviewLoopEpochStatus, ReviewLoopSourceKind } from "./review-loop-epochs";

/** Coarse CI verdict for a single head, derived from check-runs + commit-status contexts. */
export type ReviewLoopCiState = "pending" | "failing" | "green" | "absent";

/** Minimal epoch projection the rollup reasons over (status + why-blocked + kind). */
export interface ReviewLoopEpochSummary {
  status: ReviewLoopEpochStatus;
  blockedReason: string | null;
  /** Optional for older call sites/fixtures; the DAO always provides it. Treated as a comment kind when absent. */
  // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
  sourceKind?: ReviewLoopSourceKind;
}

/**
 * The blocked_reason literals for the three "ran out of road" cap shapes. Defined once and referenced
 * by both {@link EXHAUSTED_BLOCKED_REASONS} and {@link ciFixGaveUp}, so a new cap reason is added in
 * exactly one place and the done-claim, the page gate, and the settled-vs-failed classification cannot
 * drift on the same string (ARC-1300/1301).
 */
const REASON_GENERIC_ATTEMPT_CAP = "attempt_cap_reached";
const REASON_CI_ATTEMPT_CAP = "ci_attempt_cap_reached";
const REASON_CI_PENDING_CAP = "ci_checks_pending_cap_reached";

/**
 * Blocked reasons that mean "the loop ran out of road" — it tried and capped out.
 * These count as SETTLED (no more work pending). At settle time CI no longer
 * splits the outcome (green/absent vs red both collapse to `done`); the set still
 * distinguishes "settled" (-> `done`-eligible) from "real failure" (-> `working`)
 * and "disabled" (-> null).
 */
export const EXHAUSTED_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  REASON_GENERIC_ATTEMPT_CAP,
  REASON_CI_ATTEMPT_CAP,
  REASON_CI_PENDING_CAP,
]);

/**
 * Blocked reasons that mean "the loop is intentionally not acting" (turned off,
 * scoped out, or no longer this session's job). These make NO done-claim at all
 * (render nothing) rather than asserting caught-up.
 *
 * `auto_response_disabled` / `ci_response_disabled` are legacy (ARC-1288): the
 * opt-out toggles were removed, so no new epoch is blocked with them, but they are
 * retained here to keep classifying any pre-ARC-1288 `blocked` epoch rows still in D1.
 */
export const DISABLED_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  // Legacy (ARC-1288): no longer produced; retained for historical blocked rows.
  "auto_response_disabled",
  "ci_response_disabled",
  "empty_expected_bots",
  "expected_bots_changed",
  "merge_conflict_resolution_disabled",
  "session_not_review_listening",
  "session_mismatch",
]);

/**
 * Collapse check-runs + commit-status contexts for one head into a single CI
 * verdict. Pending dominates (we don't claim caught-up while CI is still
 * running); then failing; then any positive signal -> green; otherwise absent
 * (no CI configured / nothing reported).
 */
// `checkRuns` is expected to be collapsed to latest-per-name already (getCommitCheckRuns runs
// dedupeLatestCheckRunsByName at the fetch layer). This function votes over the raw list, so passing
// un-deduped runs would re-introduce the stale-failure wedge — keep the dedup at the source.
export function reduceCiState(checkRuns: CommitCheckRun[], statusContexts: CommitStatusContext[]): ReviewLoopCiState {
  let pending = hasPendingCheckRuns(checkRuns);
  let failing = checkRuns.some(isFailingCheckRun);
  // Only "success" conclusion counts as an ok signal; cancelled/neutral/skipped are
  // neither failing nor a positive green signal (they are neutral / non-votes).
  let okSignal = checkRuns.some((r) => r.status === "completed" && r.conclusion === "success");

  // Collapse status contexts to the latest entry per context name (highest id
  // wins). GitHub re-posts the same context name as a commit progresses; only
  // the most recent state is authoritative. Null context names are ignored.
  const latestByContext = new Map<string, CommitStatusContext>();
  for (const sc of statusContexts) {
    if (sc.context == null) continue;
    const existing = latestByContext.get(sc.context);
    if (!existing || sc.id > existing.id) latestByContext.set(sc.context, sc);
  }
  for (const sc of latestByContext.values()) {
    if (sc.state === "pending") pending = true;
    else if (sc.state === "failure" || sc.state === "error") failing = true;
    else if (sc.state === "success") okSignal = true;
    // other states (e.g. "expected") contribute neither signal.
  }

  if (pending) return "pending";
  if (failing) return "failing";
  if (okSignal) return "green";
  return "absent";
}

/**
 * Bounded single-head CI read: poll the head's check-runs + commit-status contexts and reduce them to a
 * coarse {@link ReviewLoopCiState}. One PR head, no scans. Throws propagate to the caller — the caller
 * owns the fallback (e.g. the verdict-return seam keeps its conservative `ci_pending` default on a fault).
 */
export async function readHeadCiState(
  token: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<ReviewLoopCiState> {
  const [checkRuns, statusContexts] = await Promise.all([
    getCommitCheckRuns(token, owner, repo, sha),
    getCommitStatusContexts(token, owner, repo, sha),
  ]);
  return reduceCiState(checkRuns, statusContexts);
}

/**
 * SINGLE SOURCE OF TRUTH for "a CI-fix epoch gave up on this head". Both the done-claim
 * ({@link ciFixExhausted}) and the `review-loop:ci-red` page gate ({@link ciRedExhaustedForCurrentRed})
 * derive from this, so they cannot drift on what "gave up" means — the failure mode ARC-1300/1301
 * fought. Add a new give-up reason HERE once.
 *
 * Give-up shapes (all genuine CI-fix exhaustion):
 *  - {@link REASON_CI_ATTEMPT_CAP}  — the CI-specific per-change streak cap.
 *  - {@link REASON_CI_PENDING_CAP}  — the CI-specific timed-out-WAIT cap. Counted ONLY when
 *    `includePendingCap` (the done-claim) — NOT for the page: a wait timeout never attempted a fix, and
 *    its path posts its own "needs human" PR comment, so paging "exhausted CI-fix attempts" would lie
 *    (ARC-1301 F2).
 *  - a `ci`-source epoch blocked with the bare {@link REASON_GENERIC_ATTEMPT_CAP} — a CI-fix epoch that
 *    crash/reclaim-looped past the GENERIC claim cap (it never reaches the `ci_` variant). The
 *    `sourceKind === "ci"` guard keeps a comment/human epoch's own generic cap (the comment loop giving
 *    up) from counting as CI exhaustion. sourceKind is absent only on legacy fixtures → read as non-ci
 *    (safe).
 */
function ciFixGaveUp(epochs: ReviewLoopEpochSummary[], includePendingCap: boolean): boolean {
  return epochs.some(
    (e) =>
      e.status === "blocked" &&
      (e.blockedReason === REASON_CI_ATTEMPT_CAP ||
        (includePendingCap && e.blockedReason === REASON_CI_PENDING_CAP) ||
        (e.sourceKind === "ci" && e.blockedReason === REASON_GENERIC_ATTEMPT_CAP)),
  );
}

/**
 * Done-claim variant: did the CI-fix loop give up on this head (so a `failing` CI verdict settles to
 * `done`)? Counts EVERY give-up shape, including the timed-out pending-wait cap. The rollup computes
 * this once over its in-scope epochs and reuses the result, so the done-claim and the label cannot
 * drift (ARC-1300). See {@link ciFixGaveUp}.
 */
export function ciFixExhausted(epochs: ReviewLoopEpochSummary[]): boolean {
  return ciFixGaveUp(epochs, /* includePendingCap */ true);
}

/**
 * Page variant of {@link ciFixGaveUp}: STRICTER than {@link ciFixExhausted} — it excludes the
 * timed-out pending-wait cap (ARC-1301 F2). Answers ONLY "did the loop give up on a fixable CI
 * failure?"; the caller ({@link computeReviewLoopRollup}) ALSO requires a LIVE fixable red
 * (`ciFailingCheckRunsPresent`) before paging, so a sticky cap does not fire for a later non-fixable
 * red on the same head (ARC-1301 F3). Do not page on this predicate alone.
 */
export function ciRedExhaustedForCurrentRed(epochs: ReviewLoopEpochSummary[]): boolean {
  return ciFixGaveUp(epochs, /* includePendingCap */ false);
}

// ARC-1330 D-59b: the review-loop done-claim engine (`computeReviewLoopRollup` /
// `computeReviewLoopDoneClaim` + the `ReviewLoopRollup`/`ReviewLoopRollupInput` shapes and the
// `ReviewLoopDoneState` done-state vocabulary it produced) is deleted. Its sole caller — the cron
// `reconcileReviewLoopDoneState` decision site — was removed in D-59a, and the pure `transition()`
// reducer (`fsm/`) now owns the caught-up/`ci_green` claim. `reduceCiState` (the `ci_green` guard
// helper), `readHeadCiState`, `ciFixExhausted` / `ciRedExhaustedForCurrentRed`, and the
// `EXHAUSTED_/DISABLED_BLOCKED_REASONS` sets survive for the FSM/sweep consumers that still read them.
