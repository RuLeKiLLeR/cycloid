import type { VerificationVerdict } from "./types/sandbox.js";

/**
 * The small bundle of bad-news signals that fully determines the publish verdict
 * under the optimistic default. There is no positive-proof accumulation: a change
 * is CONFIRMED unless one of these signals fires.
 */
export type PublishSignals = {
  /** Genuine "a human should look" reasons from the gate fold. */
  warnReasons: string[];
  /** The agent explicitly asked for manual review. */
  manualReviewReason?: string;
  /**
   * Verdict forced by abnormal finalization (e.g. the session stopped before
   * verification could run). Only ever a non-success verdict — a forced verdict
   * must never assert CONFIRMED, or it would short-circuit the warn/manual
   * checks below with an unverified success.
   */
  forcedVerdict?: Exclude<VerificationVerdict, "CONFIRMED">;
};

/**
 * The single verdict computation on the bridge. Guard ordering is intentional:
 *
 * 1. `forcedVerdict` (REFUTED | INCONCLUSIVE) short-circuits the soft signals.
 * 2. Any warn / manual-review signal → INCONCLUSIVE.
 * 3. Otherwise the optimistic default: CONFIRMED.
 */
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export function resolvePublishVerdict(signals: PublishSignals): VerificationVerdict {
  if (signals.forcedVerdict) return signals.forcedVerdict;
  if (signals.warnReasons.some(hasNonEmptySignal) || hasNonEmptySignal(signals.manualReviewReason)) {
    return "INCONCLUSIVE";
  }
  return "CONFIRMED";
}

function hasNonEmptySignal(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
