import type { Phase } from "../../../../shared/session/phase.js";

export const AUTOMATION_EXECUTION_OUTCOMES = ["completed", "failed", "blocked", "superseded"] as const;
export type AutomationExecutionOutcome = (typeof AUTOMATION_EXECUTION_OUTCOMES)[number];

export function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function executionOutcomeFromPhase(phase: Phase): AutomationExecutionOutcome | null {
  switch (phase) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "superseded":
      return "superseded";
    case "idle":
    case "running":
    case "waiting_for_input":
    case "finalizing":
    case "review_listening":
    case "stopped":
    case "archived":
      return null;
  }
}

export async function recordAutomationExecutionOutcome(
  db: D1Database,
  input: { sessionId: string; phase: Phase; reason: string | null; completedAt: number },
): Promise<"recorded" | "not_terminal" | "ambiguous" | "not_found"> {
  const outcome = executionOutcomeFromPhase(input.phase);
  if (!outcome) return "not_terminal";

  const matches = await db
    .prepare(
      `SELECT source FROM (
         SELECT 'schedule' AS source FROM automation_slot_jobs WHERE session_id = ? AND execution_outcome IS NULL
         UNION ALL
         SELECT 'slack_alert' AS source FROM automation_event_jobs WHERE session_id = ? AND execution_outcome IS NULL
         UNION ALL
         SELECT 'github_check_failure' AS source FROM github_check_automation_jobs WHERE session_id = ? AND execution_outcome IS NULL
       ) LIMIT 2`,
    )
    .bind(input.sessionId, input.sessionId, input.sessionId)
    .all<{ source: "schedule" | "slack_alert" | "github_check_failure" }>();
  const sources = matches.results ?? [];
  if (sources.length === 0) return "not_found";
  if (sources.length !== 1) return "ambiguous";

  const updateSql =
    sources[0]!.source === "schedule"
      ? `UPDATE automation_slot_jobs
         SET execution_outcome = ?, execution_completed_at = ?, execution_reason = ?, updated_at = ?
         WHERE session_id = ? AND execution_outcome IS NULL`
      : sources[0]!.source === "slack_alert"
        ? `UPDATE automation_event_jobs
           SET execution_outcome = ?, execution_completed_at = ?, execution_reason = ?, updated_at = ?
           WHERE session_id = ? AND execution_outcome IS NULL`
        : `UPDATE github_check_automation_jobs
           SET execution_outcome = ?, execution_completed_at = ?, execution_reason = ?, updated_at = ?
           WHERE session_id = ? AND execution_outcome IS NULL`;
  const result = await db
    .prepare(updateSql)
    .bind(outcome, input.completedAt, truncateUtf8(input.reason, 512), input.completedAt, input.sessionId)
    .run();
  return result.meta.changes === 1 ? "recorded" : "ambiguous";
}
