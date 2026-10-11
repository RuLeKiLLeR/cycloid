CREATE TABLE IF NOT EXISTS slack_repo_disambiguations (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  message_ts TEXT,
  actor_user_id TEXT NOT NULL,
  actor_slack_user_id TEXT,
  prompt_text TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_slack_repo_disambiguations_expires_at
  ON slack_repo_disambiguations(expires_at);
