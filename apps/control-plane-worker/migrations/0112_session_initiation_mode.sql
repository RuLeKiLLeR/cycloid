ALTER TABLE session_index ADD COLUMN initiation_mode TEXT NOT NULL DEFAULT 'user';
ALTER TABLE session_index ADD COLUMN scheduled_rule_id TEXT;
ALTER TABLE session_index ADD COLUMN rule_name_snapshot TEXT;
ALTER TABLE session_index ADD COLUMN cron_snapshot TEXT;
CREATE INDEX IF NOT EXISTS idx_session_index_scheduled_rule ON session_index (scheduled_rule_id);
