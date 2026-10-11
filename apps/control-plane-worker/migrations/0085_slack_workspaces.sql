CREATE TABLE IF NOT EXISTS slack_workspaces (
  team_id TEXT PRIMARY KEY,
  bot_token_encrypted TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  team_name TEXT,
  installed_by_user_id INTEGER REFERENCES users(id),
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  uninstalled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_slack_workspaces_installed_by
  ON slack_workspaces(installed_by_user_id);
