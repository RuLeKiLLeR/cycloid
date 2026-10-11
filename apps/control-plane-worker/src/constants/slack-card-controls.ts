/**
 * Slack status-card control-button affordances (slack/card-control-requests.ts,
 * slack/blocks.ts, session/durable-object.ts phase wiring).
 *
 * The canonical eligibility predicates (`shared/session/eligibility.ts`) are the
 * phase-eligibility FLOOR — a button never renders when its predicate fails.
 * These sets narrow further to the recovery affordance each button exists for
 * (enums/slack-interaction.ts): Resume recovers a stopped session; Retry
 * recovers a failed/blocked one. `isRetryAvailable` is deliberately broader
 * (it admits running/done replays via the API), but rendering Retry on every
 * card would violate the copy principle, so the card only offers it where it
 * is the recovery action.
 */

import type { SlackStatusStage } from "../slack/blocks";

/** Card stages that render the Resume button (with a bound interaction request). */
export const SLACK_RESUME_CONTROL_STAGES: ReadonlySet<SlackStatusStage> = new Set(["stopped"]);

/** Card stages that render the Retry button (with a bound interaction request). */
export const SLACK_RETRY_CONTROL_STAGES: ReadonlySet<SlackStatusStage> = new Set(["failed", "blocked"]);

/**
 * Stages whose phase transitions repaint the Slack status card in place from
 * the SessionDO status projection. Excluded on purpose:
 * - `starting` (idle): the webhook-created starting card already shows it.
 * - `done` (completed): terminal done delivery (`notifySlackThread`) owns the
 *   richer render (summary reply + calibrated verification fold + claim row).
 */
export const SLACK_PHASE_CARD_STAGES: ReadonlySet<SlackStatusStage> = new Set([
  "running",
  "waiting_for_input",
  "finalizing",
  "review_listening",
  "blocked",
  "failed",
  "stopped",
  "superseded",
  "archived",
]);
