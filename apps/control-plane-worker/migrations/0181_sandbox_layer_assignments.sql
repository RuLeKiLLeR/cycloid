CREATE TABLE IF NOT EXISTS sandbox_layer_business_default_sources (
  business_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES sandbox_layer_sources(id)
);

CREATE TABLE IF NOT EXISTS sandbox_layer_repo_source_assignments (
  business_id TEXT NOT NULL,
  target_repo_owner TEXT NOT NULL,
  target_repo_name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  updated_by_user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, target_repo_owner, target_repo_name),
  FOREIGN KEY (source_id) REFERENCES sandbox_layer_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_sandbox_layer_repo_assignments_source
  ON sandbox_layer_repo_source_assignments(source_id);
