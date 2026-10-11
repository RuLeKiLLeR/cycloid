CREATE TABLE IF NOT EXISTS pr_review_status_comments (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  github_comment_id INTEGER,
  last_rendered_body_hash TEXT,
  posting_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url)
);
