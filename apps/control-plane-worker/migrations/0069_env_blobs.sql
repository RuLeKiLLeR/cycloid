CREATE TABLE IF NOT EXISTS env_blobs (
  id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  business_id TEXT REFERENCES businesses(id),
  name TEXT NOT NULL,
  env_text TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK(encrypted IN (0, 1)),
  key_names_json TEXT NOT NULL,
  is_global INTEGER NOT NULL DEFAULT 0 CHECK(is_global IN (0, 1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS env_blob_repos (
  env_blob_id TEXT NOT NULL REFERENCES env_blobs(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (env_blob_id, repo_owner, repo_name)
);

CREATE INDEX IF NOT EXISTS idx_env_blobs_owner_updated ON env_blobs(owner_user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_env_blobs_owner_global ON env_blobs(owner_user_id, is_global);
CREATE INDEX IF NOT EXISTS idx_env_blobs_business_updated ON env_blobs(business_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_env_blob_repos_repo ON env_blob_repos(repo_owner, repo_name, env_blob_id);
