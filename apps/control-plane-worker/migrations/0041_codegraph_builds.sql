CREATE TABLE IF NOT EXISTS codegraph_builds (
  id TEXT PRIMARY KEY,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  r2_size_bytes INTEGER NOT NULL DEFAULT 0,
  build_duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','building','complete','failed')),
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at INTEGER,
  UNIQUE(repo_owner, repo_name, branch, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_codegraph_builds_repo ON codegraph_builds(repo_owner, repo_name, branch);
CREATE INDEX IF NOT EXISTS idx_codegraph_builds_status ON codegraph_builds(status);
