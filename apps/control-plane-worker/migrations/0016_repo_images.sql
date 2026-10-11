CREATE TABLE IF NOT EXISTS repo_images (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  build_id TEXT NOT NULL UNIQUE,
  provider_image_id TEXT,
  base_sha TEXT,
  status TEXT NOT NULL DEFAULT 'building',
  error TEXT,
  build_duration_seconds REAL,
  sandbox_image_version TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_repo_images_repo_status
  ON repo_images(repo_owner, repo_name, status);

CREATE INDEX IF NOT EXISTS idx_repo_images_build_id
  ON repo_images(build_id);
