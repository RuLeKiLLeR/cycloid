CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  configured_by_user_id TEXT,
  name TEXT,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('slack_channel_message')),
  trigger_provider TEXT NOT NULL CHECK (trigger_provider IN ('datadog', 'sentry')),
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_bot_user_id TEXT,
  allowed_slack_app_ids_json TEXT NOT NULL,
  allowed_slack_bot_ids_json TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  prompt_template TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_slack_lookup
  ON automation_rules (
    business_id,
    trigger_kind,
    slack_team_id,
    slack_channel_id,
    enabled,
    trigger_provider
  );

CREATE INDEX IF NOT EXISTS idx_automation_rules_business
  ON automation_rules (business_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_rules_active_identity
  ON automation_rules (
    business_id,
    trigger_kind,
    trigger_provider,
    slack_team_id,
    slack_channel_id,
    repo_owner,
    repo_name
  )
  WHERE enabled = 1;
