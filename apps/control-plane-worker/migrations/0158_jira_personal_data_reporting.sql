CREATE TABLE IF NOT EXISTS jira_personal_data_reports (
  jira_account_id TEXT PRIMARY KEY,
  personal_data_updated_at INTEGER NOT NULL,
  last_reported_at INTEGER,
  next_report_after INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jira_personal_data_reports_due
  ON jira_personal_data_reports(next_report_after);

INSERT OR IGNORE INTO jira_personal_data_reports (
  jira_account_id,
  personal_data_updated_at,
  next_report_after,
  created_at,
  updated_at
)
SELECT
  account_id,
  MIN(observed_at),
  0,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
FROM (
  SELECT
    external_user_id AS account_id,
    MIN(COALESCE(connected_at, updated_at, strftime('%s', 'now') * 1000)) AS observed_at
  FROM user_integrations
  WHERE integration_id = 'jira'
    AND external_user_id IS NOT NULL
    AND external_user_id != ''
    AND external_user_id != 'unknown'
  GROUP BY external_user_id

  UNION ALL

  SELECT
    jira_account_id AS account_id,
    MIN(COALESCE(created_at, updated_at, strftime('%s', 'now') * 1000)) AS observed_at
  FROM jira_user_sites
  WHERE jira_account_id IS NOT NULL
    AND jira_account_id != ''
    AND jira_account_id != 'unknown'
  GROUP BY jira_account_id
)
GROUP BY account_id;
