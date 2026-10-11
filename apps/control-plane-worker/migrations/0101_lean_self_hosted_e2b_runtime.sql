ALTER TABLE businesses ADD COLUMN self_hosted_sandboxes_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_index ADD COLUMN runtime_backend TEXT;

CREATE TABLE IF NOT EXISTS runtime_capacity_admissions (
  session_id TEXT PRIMARY KEY,
  runtime_backend TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_index_runtime_backend_state
  ON session_index(runtime_backend, runtime_state, runtime_live_lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_runtime_capacity_admissions_active
  ON runtime_capacity_admissions(runtime_backend, released_at, expires_at);

UPDATE businesses
SET self_hosted_sandboxes_enabled = 1,
    updated_at = unixepoch() * 1000
WHERE id = 'biz-arcanist';
