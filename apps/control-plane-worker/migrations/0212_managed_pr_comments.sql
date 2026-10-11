CREATE TABLE IF NOT EXISTS managed_pr_comments (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  owner_session_id TEXT,
  comment_id INTEGER,
  body_hash TEXT,
  prompt_id TEXT,
  head_sha TEXT,
  state TEXT NOT NULL,
  state_rank INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_owner, repo_name, installation_id, pr_number, kind)
);

CREATE INDEX IF NOT EXISTS idx_managed_pr_comments_session
  ON managed_pr_comments(owner_session_id, updated_at DESC);
