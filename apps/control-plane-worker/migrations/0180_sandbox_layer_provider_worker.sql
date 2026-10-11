ALTER TABLE sandbox_layer_builds ADD COLUMN provider_logs_offset INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sandbox_layer_builds ADD COLUMN lease_owner TEXT;
ALTER TABLE sandbox_layer_builds ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE sandbox_layer_builds ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE sandbox_layer_builds ADD COLUMN smoke_sandbox_id TEXT;
