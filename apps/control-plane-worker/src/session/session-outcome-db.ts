import { upsertRow } from "../db-helpers";
import type { SessionOutcomeAttribution } from "./lifecycle/session-outcome";

/**
 * D1 write path for the session-deduped outcome-truth layer (table `session_outcomes`,
 * migration 0172; termination_reason added in 0174). One row per session, written once at
 * the terminal close convergence point. The harm read query lives in services/observability.ts
 * alongside queryPromptRuns.
 */

export interface SessionOutcomeRow extends SessionOutcomeAttribution {
  sessionId: string;
  ownerUserId: string;
  businessId: string | null;
  repo: string | null;
  sessionKind: string | null;
  closeReason: string;
  prCreated: boolean;
  promptCount: number;
  completedPromptCount: number;
  failedPromptCount: number;
  /** Session created_at, unix epoch ms (null if unparseable). */
  createdAtMs: number | null;
  /** Close time, unix epoch ms. */
  recordedAtMs: number;
}

const SESSION_OUTCOME_COLUMNS = [
  "session_id",
  "owner_user_id",
  "business_id",
  "repo",
  "session_kind",
  "outcome",
  "reached_terminal",
  "terminal_stage",
  "failure_cause",
  "close_reason",
  "pr_created",
  "prompt_count",
  "completed_prompt_count",
  "failed_prompt_count",
  "created_at",
  "recorded_at",
  "termination_reason",
];

function outcomeRowBindings(row: SessionOutcomeRow): unknown[] {
  return [
    row.sessionId,
    row.ownerUserId,
    row.businessId,
    row.repo,
    row.sessionKind,
    row.outcome,
    row.reachedTerminal ? 1 : 0,
    row.terminalStage,
    row.failureCause,
    row.closeReason,
    row.prCreated ? 1 : 0,
    row.promptCount,
    row.completedPromptCount,
    row.failedPromptCount,
    row.createdAtMs,
    row.recordedAtMs,
    row.terminationReason,
  ];
}

/**
 * Upsert one session's attributed outcome. Idempotent by session_id (re-close or a
 * later, more-accurate terminal overwrites the prior row), so the table stays deduped
 * by construction. This is the authoritative live close-path writer.
 */
export async function recordSessionOutcome(db: D1Database, row: SessionOutcomeRow): Promise<void> {
  await upsertRow(db, {
    table: "session_outcomes",
    columns: SESSION_OUTCOME_COLUMNS,
    values: outcomeRowBindings(row),
    conflictKeys: ["session_id"],
  });
}
