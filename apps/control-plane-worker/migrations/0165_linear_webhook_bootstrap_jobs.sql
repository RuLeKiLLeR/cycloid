CREATE TABLE IF NOT EXISTS linear_webhook_bootstrap_jobs (
  linear_issue_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  model TEXT,
  prompt_template TEXT NOT NULL,
  issue_snapshot TEXT NOT NULL,
  phase TEXT NOT NULL,
  terminal_outcome TEXT,
  failure_reason TEXT,
  linear_attachment_external_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  retry_after_ms INTEGER NOT NULL,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_linear_bootstrap_jobs_pending
  ON linear_webhook_bootstrap_jobs (terminal_outcome, retry_after_ms, updated_at);

CREATE INDEX IF NOT EXISTS idx_linear_bootstrap_jobs_session
  ON linear_webhook_bootstrap_jobs (session_id);
