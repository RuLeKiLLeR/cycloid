ALTER TABLE session_index ADD COLUMN runtime_provider TEXT;
ALTER TABLE session_index ADD COLUMN runtime_state TEXT;
ALTER TABLE session_index ADD COLUMN runtime_sandbox_id TEXT;
ALTER TABLE session_index ADD COLUMN runtime_template_id TEXT;
ALTER TABLE session_index ADD COLUMN runtime_state_expires_at INTEGER;
ALTER TABLE session_index ADD COLUMN runtime_live_lease_expires_at INTEGER;
ALTER TABLE session_index ADD COLUMN runtime_preview_url TEXT;
ALTER TABLE session_index ADD COLUMN runtime_created_at INTEGER;
ALTER TABLE session_index ADD COLUMN runtime_last_resumed_at INTEGER;
ALTER TABLE session_index ADD COLUMN runtime_last_paused_at INTEGER;
ALTER TABLE session_index ADD COLUMN runtime_last_provider_refreshed_at INTEGER;
ALTER TABLE session_index ADD COLUMN runtime_provider_ttl_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_session_index_runtime_expiry
  ON session_index(runtime_provider, runtime_state, runtime_state_expires_at);

CREATE INDEX IF NOT EXISTS idx_session_index_runtime_live_lease
  ON session_index(runtime_provider, runtime_state, runtime_live_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_session_index_runtime_repair_created
  ON session_index(runtime_provider, runtime_state, runtime_created_at);
