CREATE TABLE IF NOT EXISTS scheduled_rules (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  configured_by_user_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  prompt_template TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  normalized_cron TEXT NOT NULL,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at INTEGER NOT NULL,
  last_enqueued_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_rules_due
  ON scheduled_rules (enabled, next_fire_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_rules_business
  ON scheduled_rules (business_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_rules_active_identity
  ON scheduled_rules (business_id, repo_owner, repo_name, normalized_cron, prompt_template)
  WHERE enabled = 1;
