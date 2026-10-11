// Pure projections for the Summary tab: the next-action recommendation and
// the clamp decision for long request/answer text. All presentation-only —
// they read lifecycle fields the session record already carries
// (displayStatus, uiLifecycleStage, closeReason, …) and never derive a new
// lifecycle state.

import type { DisplayStatus } from "../../../../../../shared/session/display-status.js";
import { displayStatusFromPhase } from "../../../../../../shared/session/display-status.js";
import { isRetryAvailable } from "../../../../../../shared/session/eligibility.js";
import type { UiLifecycleStage } from "../../../../../../shared/session/lifecycle-stage.js";
import {
  SUMMARY_TEXT_CLAMP_CHAR_THRESHOLD,
  SUMMARY_TEXT_CLAMP_LINE_THRESHOLD,
} from "../../../constants/session-summary";
import { SESSION_ARTIFACT_TAB_IDS } from "../../../constants/session-workbench";
import type { Phase } from "../../../types";
import { getPrOutcomeBadgeLabel } from "../../../utils/session-close-reason";
import type { ArtifactTabId } from "../workbench";

// -- Next action ---------------------------------------------------------------

export type SummaryNextAction = {
  kind: "review-pr" | "answer-agent" | "retry" | "inspect-runtime" | "read-report";
  /** Button text — a verb, 1-2 words. */
  label: string;
  /** One calm sentence explaining why this is the next action. */
  description: string;
  /** Inspector tab the action switches to, or null when it targets the PR/composer. */
  targetTab: ArtifactTabId | null;
  /** Failure detail rendered with the error treatment (failed sessions only). */
  failureDetail: string | null;
};

export type SummaryNextActionInput = {
  phase: Phase;
  displayStatus?: DisplayStatus;
  uiLifecycleStage?: UiLifecycleStage;
  prUrl: string | null;
  publishError?: string | null;
  closeReason?: string | null;
};

/**
 * Derive the single primary recommendation for the session's current state.
 * The status value is the same projection the rest of the page renders —
 * `displayStatus` falling back to `displayStatusFromPhase` — never a new
 * derivation. Returns null when the session is settled and needs nothing
 * (merged, closed, superseded, or stopped without a live PR).
 */
export function deriveSummaryNextAction(input: SummaryNextActionInput): SummaryNextAction | null {
  const status = input.displayStatus ?? displayStatusFromPhase(input.phase);
  const stage = input.uiLifecycleStage ?? null;

  // Settled PR lifecycle: nothing left to recommend.
  if (stage === "merged" || stage === "closed" || stage === "superseded") return null;

  if (status === "failed") {
    const failureDetail = input.publishError?.trim() || input.closeReason?.trim() || null;
    // Retry replays the last terminal prompt via POST /api/sessions/:id/retry
    // (api/sessions.ts `retrySession`). The shared eligibility helper is the
    // same phase gate the route and DO enforce, so the card never recommends a
    // predictably-rejected action; when retry is unavailable the failure
    // evidence plus the Runtime tab remains the recommendation.
    if (isRetryAvailable(input.phase)) {
      return {
        kind: "retry",
        label: "Retry",
        description: "Session stopped on a failure. Retry replays the last prompt.",
        targetTab: null,
        failureDetail,
      };
    }
    return {
      kind: "inspect-runtime",
      label: "Inspect runtime",
      description: "Session stopped on a failure.",
      targetTab: SESSION_ARTIFACT_TAB_IDS.runtime,
      failureDetail,
    };
  }

  if (status === "waiting_for_input") {
    return {
      kind: "answer-agent",
      label: "Answer agent",
      description: "Cycloid is waiting on your answer.",
      targetTab: null,
      failureDetail: null,
    };
  }

  if (status === "working") {
    return {
      kind: "inspect-runtime",
      label: "Inspect runtime",
      description: "Cycloid is working. Runtime shows live activity.",
      targetTab: SESSION_ARTIFACT_TAB_IDS.runtime,
      failureDetail: null,
    };
  }

  // Terminal-ish states: completed, stopped, archived.
  const settledPrOutcome = getPrOutcomeBadgeLabel(input.closeReason);
  if (input.prUrl && settledPrOutcome === null) {
    const description =
      stage === "merge_ready"
        ? "Review loop caught up and checks passed."
        : stage === "verifying"
          ? "Cycloid opened a PR. Verification is still running."
          : "Cycloid opened a PR for your review.";
    // The button opens GitHub, so it says "Open PR" — one PR-open idiom
    // everywhere; "review" lives in the description, not the verb.
    return { kind: "review-pr", label: "Open PR", description, targetTab: null, failureDetail: null };
  }

  if (status === "completed" && !input.prUrl) {
    return {
      kind: "read-report",
      label: "Read report",
      description: "Session completed without a PR. The report holds the summary.",
      targetTab: SESSION_ARTIFACT_TAB_IDS.report,
      failureDetail: null,
    };
  }

  return null;
}

// -- Text clamp --------------------------------------------------------------------

/**
 * Whether a request/answer readout is long enough to collapse behind an expand
 * toggle. Threshold-based (chars or newlines) so the decision is deterministic
 * and needs no layout measurement.
 */
export function isSummaryTextClampable(text: string): boolean {
  if (text.length > SUMMARY_TEXT_CLAMP_CHAR_THRESHOLD) return true;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") newlines++;
    if (newlines >= SUMMARY_TEXT_CLAMP_LINE_THRESHOLD) return true;
  }
  return false;
}
