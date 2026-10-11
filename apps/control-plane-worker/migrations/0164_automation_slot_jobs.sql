CREATE TABLE IF NOT EXISTS automation_slot_jobs (
  job_key TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  slot_ms INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  phase TEXT NOT NULL,
  terminal_outcome TEXT,
  failure_reason TEXT,
  retry_after_ms INTEGER NOT NULL,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_slot_jobs_rule_slot
  ON automation_slot_jobs (rule_id, slot_ms);

CREATE INDEX IF NOT EXISTS idx_automation_slot_jobs_pending
  ON automation_slot_jobs (terminal_outcome, retry_after_ms, updated_at);
