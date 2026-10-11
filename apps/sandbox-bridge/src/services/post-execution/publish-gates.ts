import { PUBLISH_MODE_PRIORITY } from "../../../../../shared/post-execution.js";
import type { ExecutionVerification, VerificationVerdict } from "../../../../../shared/types/sandbox.js";

export type PublishMode = NonNullable<ExecutionVerification["publishMode"]>;

/**
 * Outcome of a single pre-publish gate. Gates no longer mutate the shared
 * publish decision directly; they return a `GateResult` and the bridge folds it
 * through {@link applyGateResult}. This keeps the precedence + composition rules
 * in one tested place instead of scattered `publishMode = "draft"` assignments.
 *
 * - `decision: "pass"` contributes nothing.
 * - `decision: "draft"` raises the mode to at least `draft` and (by default)
 *   APPENDS its `warnReasons` to the running set.
 * `warnReasonsMode: "replace"` overwrites the accumulated warn reasons instead
 * of appending.
 */
export interface GateResult {
  decision: "pass" | "draft";
  warnReasons?: string[];
  warnReasonsMode?: "append" | "replace";
  manualReviewReason?: string;
  verdictOverride?: VerificationVerdict;
  explanationOverride?: string;
}

/**
 * The running publish decision folded from gate results. Mirrors the set of
 * `let`s that `runPostExecution` previously mutated inline.
 */
export interface PublishDecision {
  publishMode: PublishMode;
  publishWarnReasons: string[];
  manualReviewReason?: string;
  verificationVerdictOverride?: VerificationVerdict;
  verificationExplanationOverride?: string;
}

export function initialPublishDecision(): PublishDecision {
  return { publishMode: "normal", publishWarnReasons: [] };
}

// Precedence lives in shared/post-execution.ts so the bridge gate fold and the
// control-plane re-derivation cannot drift.
const MODE_PRIORITY = PUBLISH_MODE_PRIORITY;

/**
 * Fold a gate result into the running decision. Warn reasons append+dedupe by default, or
 * replace when `warnReasonsMode === "replace"`. Verdict / explanation /
 * manual-review overrides are last-wins, matching the previous inline `let`
 * assignments. Mutates and returns `decision` for ergonomic chaining.
 */
export function applyGateResult(decision: PublishDecision, result: GateResult): PublishDecision {
  if (result.decision === "pass") return decision;

  if (MODE_PRIORITY.draft > MODE_PRIORITY[decision.publishMode]) {
    decision.publishMode = "draft";
  }
  if (result.warnReasonsMode === "replace") {
    // Replace unconditionally — even an empty array clears accumulated warns.
    decision.publishWarnReasons = result.warnReasons ? [...result.warnReasons] : [];
  } else if (result.warnReasons && result.warnReasons.length > 0) {
    decision.publishWarnReasons = Array.from(new Set([...decision.publishWarnReasons, ...result.warnReasons]));
  }
  if (result.manualReviewReason) {
    decision.manualReviewReason = result.manualReviewReason;
  }
  if (result.verdictOverride) {
    decision.verificationVerdictOverride = result.verdictOverride;
  }
  if (result.explanationOverride) {
    decision.verificationExplanationOverride = result.explanationOverride;
  }
  return decision;
}

/**
 * The common "gate failed, require manual review" outcome: raise the internal
 * publish mode to `draft` and append `reason` as a warn. GitHub PRs still open
 * ready for review; `draft` is retained as storage/wire compatibility for the
 * manual-review state. When a verdict is supplied, set the verdict + explanation
 * overrides together (the pre-refactor gates always set both or neither).
 * Extracted so configured test failures share one shape.
 */
export function markGateFailedDraft(reason: string, opts: { verdict?: VerificationVerdict } = {}): GateResult {
  return {
    decision: "draft",
    warnReasons: [reason],
    ...(opts.verdict ? { verdictOverride: opts.verdict, explanationOverride: reason } : {}),
  };
}

/**
 * The "gate was killed by resource limits" outcome: internal manual review, no
 * verdict override (the gate result is inconclusive, not refuted).
 */
export function markGateResourceKilled(manualReviewReason: string): GateResult {
  return { decision: "draft", manualReviewReason };
}
