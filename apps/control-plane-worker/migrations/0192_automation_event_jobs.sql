CREATE TABLE IF NOT EXISTS automation_event_jobs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('slack_channel_message')),
  trigger_provider TEXT NOT NULL CHECK (trigger_provider IN ('datadog', 'sentry')),
  idempotency_key TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_message_ts TEXT NOT NULL,
  slack_thread_ts TEXT,
  phase TEXT NOT NULL CHECK (
    phase IN (
      'queued',
      'claimed',
      'session_enqueued',
      'succeeded',
      'skipped',
      'failed'
    )
  ),
  payload_json TEXT NOT NULL CHECK (length(CAST(payload_json AS BLOB)) <= 32768),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  session_id TEXT,
  terminal_reason TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claimed_at INTEGER,
  completed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_event_jobs_idempotency
  ON automation_event_jobs (business_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_automation_event_jobs_claimable
  ON automation_event_jobs (phase, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_automation_event_jobs_rule_created
  ON automation_event_jobs (rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automation_event_jobs_slack_message
  ON automation_event_jobs (slack_team_id, slack_channel_id, slack_message_ts);
