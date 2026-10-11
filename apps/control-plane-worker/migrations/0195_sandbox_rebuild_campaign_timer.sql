ALTER TABLE sandbox_layer_rebuild_campaigns ADD COLUMN scan_cursor_updated_at INTEGER;
ALTER TABLE sandbox_layer_rebuild_campaigns ADD COLUMN scan_cursor_artifact_id TEXT;
ALTER TABLE sandbox_layer_rebuild_campaigns ADD COLUMN scan_completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_rebuild_campaigns_timer
  ON sandbox_layer_rebuild_campaigns (status, created_at);
