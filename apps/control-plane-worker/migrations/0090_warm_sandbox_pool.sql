CREATE TABLE IF NOT EXISTS warm_sandbox_pool_specs (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  runtime_provider TEXT NOT NULL DEFAULT 'e2b',
  runtime_template_id TEXT NOT NULL,
  sandbox_image_version TEXT,
  runtime_environment TEXT NOT NULL,
  docker_enabled INTEGER NOT NULL DEFAULT 0,
  installation_id INTEGER,
  target_size INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_warm_sandbox_pool_specs_key
  ON warm_sandbox_pool_specs(
    repo_owner,
    repo_name,
    base_branch,
    runtime_provider,
    runtime_template_id,
    COALESCE(sandbox_image_version, ''),
    runtime_environment,
    docker_enabled
  );

CREATE INDEX IF NOT EXISTS idx_warm_sandbox_pool_specs_enabled
  ON warm_sandbox_pool_specs(enabled, target_size, updated_at);

CREATE TABLE IF NOT EXISTS warm_sandbox_pool_entries (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  runtime_provider TEXT NOT NULL DEFAULT 'e2b',
  runtime_sandbox_id TEXT NOT NULL,
  runtime_template_id TEXT NOT NULL,
  status TEXT NOT NULL,
  heartbeat_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER,
  claimed_at INTEGER,
  claimed_session_id TEXT,
  failure_reason TEXT,
  FOREIGN KEY (spec_id) REFERENCES warm_sandbox_pool_specs(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_warm_sandbox_pool_entries_spec_status
  ON warm_sandbox_pool_entries(spec_id, status, ready_at, created_at);

CREATE INDEX IF NOT EXISTS idx_warm_sandbox_pool_entries_status_heartbeat
  ON warm_sandbox_pool_entries(status, heartbeat_at, created_at);

CREATE INDEX IF NOT EXISTS idx_warm_sandbox_pool_entries_claimed_session
  ON warm_sandbox_pool_entries(claimed_session_id)
  WHERE claimed_session_id IS NOT NULL;
