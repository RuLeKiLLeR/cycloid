CREATE TABLE IF NOT EXISTS github_check_automation_rules (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  configured_by_user_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  check_name TEXT,
  model_id TEXT,
  prompt_template TEXT NOT NULL CHECK (length(CAST(prompt_template AS BLOB)) <= 32768),
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_github_check_rules_business ON github_check_automation_rules (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_check_rules_match ON github_check_automation_rules (repo_owner, repo_name, enabled, check_name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_check_rules_active_identity ON github_check_automation_rules (business_id, lower(repo_owner), lower(repo_name), COALESCE(check_name, '')) WHERE enabled = 1 AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS github_check_automation_jobs (
  id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  rule_id TEXT NOT NULL REFERENCES github_check_automation_rules(id),
  business_id TEXT NOT NULL,
  check_run_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  check_name TEXT NOT NULL,
  event_snapshot_json TEXT NOT NULL CHECK (length(CAST(event_snapshot_json AS BLOB)) <= 4096),
  phase TEXT NOT NULL CHECK (phase IN ('queued','claimed','session_projected','prompt_enqueued','succeeded','skipped','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  session_id TEXT,
  admission_outcome TEXT,
  admission_reason TEXT,
  execution_outcome TEXT CHECK (execution_outcome IN ('completed','failed','blocked','superseded')),
  execution_completed_at INTEGER,
  execution_reason TEXT CHECK (execution_reason IS NULL OR length(CAST(execution_reason AS BLOB)) <= 512),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_check_jobs_rule_pr_head ON github_check_automation_jobs (rule_id, pr_number, head_sha);
CREATE INDEX IF NOT EXISTS idx_github_check_jobs_due ON github_check_automation_jobs (phase, next_attempt_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_github_check_jobs_business_time ON github_check_automation_jobs (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_check_jobs_unreconciled ON github_check_automation_jobs (session_id, created_at) WHERE session_id IS NOT NULL AND execution_outcome IS NULL;
