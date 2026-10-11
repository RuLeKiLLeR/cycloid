export type AutomationRunHistoryRow = {
  source: "schedule" | "slack_alert" | "github_check_failure";
  id: string;
  rule_id: string;
  rule_name: string | null;
  trigger_provider: string | null;
  phase: string;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
  session_id: string | null;
  session_status: string | null;
  execution_outcome: string | null;
  execution_completed_at: number | null;
  execution_reason: string | null;
};

export async function listAutomationRunHistory(
  db: D1Database,
  input: { businessId: string; cursor: { createdAt: number; id: string; source: string } | null; limit: number },
): Promise<AutomationRunHistoryRow[]> {
  const cursorCreatedAt = input.cursor?.createdAt ?? Number.MAX_SAFE_INTEGER;
  const cursorKey = input.cursor ? `${input.cursor.source}:${input.cursor.id}` : "\uffff";
  const result = await db
    .prepare(
      `SELECT * FROM (
        SELECT 'schedule' AS source, j.job_key AS id, j.rule_id, r.name AS rule_name,
               NULL AS trigger_provider, COALESCE(j.terminal_outcome, j.phase) AS phase,
               CASE WHEN j.terminal_outcome = 'failed' THEN 'execution_failed' ELSE NULL END AS failure_code,
               j.created_at, j.updated_at, j.execution_outcome, j.execution_completed_at, j.execution_reason,
               CASE WHEN s.business_id = r.business_id THEN j.session_id ELSE NULL END AS session_id,
               CASE WHEN s.business_id = r.business_id THEN s.rich_status ELSE NULL END AS session_status
        FROM automation_slot_jobs j
        JOIN scheduled_rules r ON r.id = j.rule_id AND r.business_id = ?
        LEFT JOIN session_index s ON s.session_id = j.session_id AND s.business_id = r.business_id
        UNION ALL
        SELECT 'slack_alert' AS source, e.id, e.rule_id, r.name AS rule_name,
               e.trigger_provider, e.phase,
               CASE
                 WHEN e.phase = 'failed' THEN CASE WHEN e.terminal_reason IN ('missing_slack_token','missing_configured_user','repo_gate_failed','thread_already_claimed','enqueue_failed','lease_expired','stale_unclaimed') THEN e.terminal_reason ELSE 'execution_failed' END
                 WHEN e.phase = 'skipped' THEN CASE WHEN e.terminal_reason IN ('resolved_alert','duplicate_recent_alert') THEN e.terminal_reason ELSE 'skipped' END
                 ELSE NULL
               END AS failure_code,
               e.created_at, e.updated_at, e.execution_outcome, e.execution_completed_at, e.execution_reason,
               CASE WHEN s.business_id = e.business_id THEN e.session_id ELSE NULL END AS session_id,
               CASE WHEN s.business_id = e.business_id THEN s.rich_status ELSE NULL END AS session_status
        FROM automation_event_jobs e
        JOIN automation_rules r ON r.id = e.rule_id AND r.business_id = e.business_id
        LEFT JOIN session_index s ON s.session_id = e.session_id AND s.business_id = e.business_id
        WHERE e.business_id = ?
        UNION ALL
        SELECT 'github_check_failure' AS source, g.id, g.rule_id, r.name AS rule_name,
               'github' AS trigger_provider, COALESCE(g.admission_outcome, g.phase) AS phase,
               CASE WHEN g.phase IN ('failed','skipped') THEN COALESCE(g.admission_reason, g.phase) ELSE NULL END AS failure_code,
               g.created_at, g.updated_at, g.execution_outcome, g.execution_completed_at, g.execution_reason,
               CASE WHEN s.business_id = g.business_id THEN g.session_id ELSE NULL END AS session_id,
               CASE WHEN s.business_id = g.business_id THEN s.rich_status ELSE NULL END AS session_status
        FROM github_check_automation_jobs g
        JOIN github_check_automation_rules r ON r.id = g.rule_id AND r.business_id = g.business_id
        LEFT JOIN session_index s ON s.session_id = g.session_id AND s.business_id = g.business_id
        WHERE g.business_id = ?
      ) runs
      WHERE created_at < ? OR (created_at = ? AND (source || ':' || id) < ?)
      ORDER BY created_at DESC, source DESC, id DESC
      LIMIT ?`,
    )
    .bind(
      input.businessId,
      input.businessId,
      input.businessId,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorKey,
      input.limit,
    )
    .all<AutomationRunHistoryRow>();
  return result.results ?? [];
}
