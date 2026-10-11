/**
 * Code-side validation for `slack_interaction_requests.kind` / `.status`. The
 * table deliberately carries no CHECK constraints (SQLite constraint changes
 * force full table rebuilds), so these discriminants are the only authority on
 * legal values. Keep values stable: they are persisted in D1 rows, embedded in
 * Slack action ids (`cycloid:<kind>:<requestId>`), and used as observability
 * tags.
 */
export const SlackInteractionKind = {
  /** Answer an agent question from the thread ask. */
  AnswerQuestion: "answer_question",
  /** Retry a failed/blocked session from the card. */
  RetrySession: "retry_session",
  /** Resume a stopped session from the card. */
  ResumeSession: "resume_session",
  /** Approve a parked kickoff (yellow/red confidence) so it enqueues. */
  ApproveStart: "approve_start",
  /** Approve the exact pending plan revision carried by a PlanReady DM. */
  ApprovePlan: "approve_plan",
  /** Keep going / close / snooze choice on a stale-PR nudge. */
  StaleChoice: "stale_choice",
  /** Confirm waking a thread older than the wake age gate. */
  WakeConfirm: "wake_confirm",
  /** "Go" on a beat diagnosis ask (spawn the fix session). */
  BeatGo: "beat_go",
} as const;

export type SlackInteractionKind = (typeof SlackInteractionKind)[keyof typeof SlackInteractionKind];

const SLACK_INTERACTION_KIND_VALUES = new Set<string>(Object.values(SlackInteractionKind));

export function isSlackInteractionKind(value: string): value is SlackInteractionKind {
  return SLACK_INTERACTION_KIND_VALUES.has(value);
}

/**
 * Request lifecycle. `pending` is the only consumable state; every other state
 * is terminal and eligible for GC after the retention window.
 */
export const SlackInteractionRequestStatus = {
  Pending: "pending",
  Consumed: "consumed",
  Expired: "expired",
  Superseded: "superseded",
} as const;

export type SlackInteractionRequestStatus =
  (typeof SlackInteractionRequestStatus)[keyof typeof SlackInteractionRequestStatus];

const SLACK_INTERACTION_STATUS_VALUES = new Set<string>(Object.values(SlackInteractionRequestStatus));

export function isSlackInteractionRequestStatus(value: string): value is SlackInteractionRequestStatus {
  return SLACK_INTERACTION_STATUS_VALUES.has(value);
}
