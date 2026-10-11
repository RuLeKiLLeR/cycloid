// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
import type { VerificationResult, VerificationState } from "../../../../shared/session/phase.js";
import type { ExecutionVerification } from "../../../../shared/types/sandbox.js";

/**
 * Reconciles the event-derived nested `verification` snapshot (DO storage, key
 * `"verification"`) against the authoritative session columns before any surface
 * reads it.
 *
 * The snapshot is written once, optimistically, by verification-session post-execution
 * (often as a `manual_review_required` / `draft` placeholder). The real
 * verdict lands later in columns: `verificationResult` (gated by
 * `verificationState`), `prDraft`, and `prManualReviewReason`. Nothing rewrites
 * the snapshot, so it drifts. Every read path folds the snapshot through this
 * helper so the columns win and a stale snapshot can never surface a verdict that
 * contradicts the real one.
 *
 * Two independent authority gates (do not conflate them):
 * - `prDraft` / `prManualReviewReason`: the column is authoritative whenever
 *   known, independent of verification state. Written by the PR-draft path and
 *   the publish flow regardless of the verifier.
 * - the verifier verdict surfaced in `verification` (verified / status /
 *   publishMode): authoritative only once `verificationState === "verification-done"`
 *   and a `verificationResult` exists, per the contract documented in
 *   `verification-auto-scheduler.ts`.
 */
export interface DeriveEffectiveVerificationInput {
  /** Event-derived snapshot from DO storage (`"verification"` key). */
  stored: ExecutionVerification | null | undefined;
  /** Authoritative `verificationState` column. */
  verificationState: VerificationState | null;
  /** Authoritative `verificationResult` column. */
  verificationResult: VerificationResult | null;
  /** Authoritative `prDraft` column (`null` when unknown). */
  prDraft: boolean | null;
  /** Authoritative `prManualReviewReason` column. */
  prManualReviewReason: string | null;
}

export interface EffectiveVerification {
  /** Snapshot with verdict-bearing fields reconciled to the columns. */
  verification: ExecutionVerification | null;
  /** Column-authoritative draft state. */
  prDraft: boolean;
  /** Manual-review reason, suppressed when the PR is not a draft. */
  prManualReviewReason: string | null;
}

export function deriveEffectiveVerification(input: DeriveEffectiveVerificationInput): EffectiveVerification {
  const stored = input.stored ?? null;

  // prDraft: column wins whenever known; only fall back to the snapshot's
  // publishMode when the column is null. Independent of verification state.
  const prDraft = input.prDraft ?? stored?.publishMode === "draft";

  // prManualReviewReason: the column is authoritative and always wins. Only fall
  // back to the nested snapshot's reason while the PR is a draft, so a non-draft
  // PR can never surface a *stale nested* "needs manual review" reason.
  const prManualReviewReason =
    input.prManualReviewReason?.trim() || (prDraft ? stored?.manualReviewReason?.trim() : undefined) || null;

  const verification = deriveEffectiveSnapshot(
    stored,
    input.verificationState,
    input.verificationResult,
    prDraft,
    prManualReviewReason,
  );
  return { verification, prDraft, prManualReviewReason };
}

function deriveEffectiveSnapshot(
  stored: ExecutionVerification | null,
  verificationState: VerificationState | null,
  verificationResult: VerificationResult | null,
  prDraft: boolean,
  prManualReviewReason: string | null,
): ExecutionVerification | null {
  // No snapshot stored: nothing to reconcile. Do not synthesize one - the columns
  // still drive prDraft / prManualReviewReason above.
  if (!stored) return null;

  // The verifier verdict is authoritative only once verification has concluded.
  if (verificationState === "verification-done" && verificationResult) {
    if (verificationResult === "merge-ready") {
      return {
        ...stored,
        verified: true,
        status: "passed",
        // Keep publishMode consistent with the column-authoritative draft state
        // rather than hardcoding "normal", so the embedded snapshot can't
        // contradict prDraft.
        publishMode: prDraft ? "draft" : "normal",
        // Align the embedded reason with the column-authoritative value so every
        // surface agrees; a merge-ready non-draft PR carries no reason.
        manualReviewReason: prManualReviewReason ?? undefined,
      };
    }
    // needs-work: the verifier refuted. Leave publishMode to the column-derived
    // draft state (do not force draft purely from the verdict).
    return {
      ...stored,
      verified: false,
      status: "failed",
      publishMode: prDraft ? "draft" : "normal",
      manualReviewReason: prManualReviewReason ?? undefined,
    };
  }

  // Not concluded (pending / in-progress / skipped / stopped / exhausted / no
  // result). Two things still need reconciling against the authoritative columns,
  // because the UI reads `verification.publishMode` / `verification.manualReviewReason`
  // directly (see PrSection):
  //
  // 1. Draft-bearing fields. A draft PR later flipped to non-draft (prDraft column
  //    false) must not keep surfacing publishMode "draft" / a stale manual-review
  //    reason while verification is still running. Align them with the columns.
  let publishMode = stored.publishMode;
  if (prDraft && publishMode === "normal") publishMode = "draft";
  else if (!prDraft && publishMode === "draft") publishMode = "normal";
  const next: ExecutionVerification = {
    ...stored,
    publishMode,
    manualReviewReason: prManualReviewReason ?? undefined,
  };

  // 2. Stale terminal verdict. A prior run may have left status "passed"/"failed"
  //    in the snapshot, which verification-auto-scheduler clears the result for
  //    when a new run starts. Strip it ONLY while a verifier rerun is actually
  //    active/queued, so a prior run's verdict can't masquerade as the current
  //    one. When no verifier is running (state null/skipped/stopped/exhausted),
  //    a "passed" snapshot is the legitimate local result - preserve it.
  const verifierActive =
    verificationState === "verification-in-progress" || verificationState === "verification-pending";
  if (verifierActive && (stored.status === "passed" || stored.status === "failed")) {
    next.verified = false;
    next.status = undefined;
  }

  return next;
}
