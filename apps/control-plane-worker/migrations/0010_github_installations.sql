CREATE TABLE IF NOT EXISTS github_installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL UNIQUE,
  owner_login TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  owner_type TEXT NOT NULL,
  repository_selection TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  suspended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_github_installations_owner
  ON github_installations(owner_login);
