// Static copy and chip mappings for the session PR panel. Derivation logic
// lives in `components/session/panels/PrPanel.tsx`; only the fixed values sit
// here per the constants-placement convention.

import type {
  CycloidDoneReason,
  ReviewLoopDoneState,
  VerificationResult,
  VerificationState,
} from "../../../../shared/session/phase.js";
import type { SessionStatus } from "../components/ui";

/**
 * PR lifecycle states the panel's chip can render. Sourced from the FSM
 * projection (`uiLifecycleStage`), with `draft`/`open` derived from the
 * publish fields when the projection carries no post-publish stage.
 */
export const PR_STATE_CHIP_LABELS = {
  draft: "Draft",
  open: "Open",
  verifying: "Verifying",
  merge_ready: "Merge ready",
  merged: "Merged",
  closed: "Closed",
  superseded: "Superseded",
} as const;

export type PrStateKey = keyof typeof PR_STATE_CHIP_LABELS;

/**
 * StatusChip tone family per PR state (labels overridden with
 * `PR_STATE_CHIP_LABELS`). Terminal/static states stay neutral grayscale;
 * `verifying` is live, `merge_ready`/`merged` read as grayscale success —
 * mirrors `PR_BUCKET_STATUS` in the PR inbox.
 */
export const PR_STATE_CHIP_STATUS = {
  draft: "pr-open",
  open: "pr-open",
  verifying: "verifying",
  merge_ready: "ready-for-review",
  merged: "done",
  closed: "pr-open",
  superseded: "pr-open",
} as const satisfies Record<PrStateKey, SessionStatus>;

/** Review-loop claim labels (`reviewLoopDoneState`; null renders nothing). */
export const REVIEW_LOOP_STATE_LABELS: Record<ReviewLoopDoneState, string> = {
  working: "Listening",
  done: "Caught up",
};

/** One-line detail per review-loop claim. */
export const REVIEW_LOOP_STATE_DETAILS: Record<ReviewLoopDoneState, string> = {
  working: "Watching reviewer comments and CI",
  done: "No unhandled review feedback",
};

/** Sentence-case labels for `cycloidDoneReasons` needs-attention flags. */
export const CYCLOID_DONE_REASON_LABELS: Record<CycloidDoneReason, string> = {
  ci_red: "CI failing",
  verification_exhausted: "QA rounds exhausted",
  verification_stopped: "QA stopped",
  verification_inconclusive: "QA inconclusive",
};

/**
 * Post-publish QA-verification lifecycle labels (`verificationState`). Distinct
 * from the pre-publish test-gate outcome (`verificationSummary`) the Checks
 * evidence renders. "QA" matches the done-reason copy above pending the
 * qa-rename (ARC-1330).
 */
export const VERIFICATION_STATE_CHIP_LABELS: Record<VerificationState, string> = {
  "verification-pending": "QA queued",
  "verification-in-progress": "QA running",
  "verification-done": "QA done",
  "verification-skipped": "QA skipped",
  "verification-stopped": "QA stopped",
  "verification-exhausted": "QA exhausted",
};

/** Terminal QA-verification verdict labels (`verificationResult`). */
export const VERIFICATION_RESULT_CHIP_LABELS: Record<VerificationResult, string> = {
  "merge-ready": "QA merge ready",
  "needs-work": "QA needs work",
};
