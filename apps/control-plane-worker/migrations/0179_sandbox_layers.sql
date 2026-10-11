CREATE TABLE IF NOT EXISTS sandbox_layer_sources (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (business_id, repo_owner, repo_name, manifest_path)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_sources_business_updated
  ON sandbox_layer_sources (business_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_sources_repo
  ON sandbox_layer_sources (business_id, repo_owner, repo_name);

CREATE TABLE IF NOT EXISTS sandbox_layer_builds (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  layer_hash TEXT NOT NULL,
  normalized_layer_hash TEXT NOT NULL DEFAULT '',
  manifest_path TEXT NOT NULL DEFAULT '',
  layer_path TEXT NOT NULL DEFAULT '',
  layer_instructions_json TEXT NOT NULL DEFAULT '[]',
  smoke_commands_json TEXT NOT NULL DEFAULT '[]',
  base_template_ref TEXT NOT NULL,
  base_version TEXT NOT NULL,
  resource_profile_key TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  runtime_backend TEXT NOT NULL,
  provider_template_ref TEXT,
  provider_template_id TEXT,
  provider_build_id TEXT,
  provider_artifact_ref TEXT,
  provider_logs_json TEXT,
  requested_ref TEXT,
  promotion_eligibility TEXT,
  status TEXT NOT NULL,
  will_promote INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  build_log_artifact_id TEXT,
  smoke_result_json TEXT,
  created_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  next_attempt_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (
    source_id,
    source_content_hash,
    base_template_ref,
    base_version,
    resource_profile_key,
    compiler_version,
    provider
  ),
  FOREIGN KEY (source_id) REFERENCES sandbox_layer_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_builds_source_created
  ON sandbox_layer_builds (source_id, resource_profile_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_builds_source_profile_created
  ON sandbox_layer_builds (source_id, resource_profile_key, created_at);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_builds_status_next
  ON sandbox_layer_builds (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS sandbox_layer_artifacts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  base_template_ref TEXT NOT NULL,
  base_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_artifact_ref TEXT NOT NULL,
  runtime_backend TEXT NOT NULL,
  resource_profile_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  blocked_at INTEGER,
  UNIQUE (provider, provider_artifact_ref),
  FOREIGN KEY (source_id) REFERENCES sandbox_layer_sources(id),
  FOREIGN KEY (build_id) REFERENCES sandbox_layer_builds(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_layer_artifacts_build
  ON sandbox_layer_artifacts (build_id);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_artifacts_source_status
  ON sandbox_layer_artifacts (source_id, resource_profile_key, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_artifacts_source_profile
  ON sandbox_layer_artifacts (source_id, resource_profile_key, status);

CREATE TABLE IF NOT EXISTS sandbox_layer_active_artifacts (
  source_id TEXT NOT NULL,
  resource_profile_key TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, resource_profile_key),
  FOREIGN KEY (source_id) REFERENCES sandbox_layer_sources(id),
  FOREIGN KEY (artifact_id) REFERENCES sandbox_layer_artifacts(id),
  FOREIGN KEY (build_id) REFERENCES sandbox_layer_builds(id)
);

CREATE TABLE IF NOT EXISTS sandbox_layer_build_log_chunks (
  id TEXT PRIMARY KEY,
  build_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (build_id, sequence),
  FOREIGN KEY (build_id) REFERENCES sandbox_layer_builds(id)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_build_log_chunks_build_sequence
  ON sandbox_layer_build_log_chunks (build_id, sequence);
