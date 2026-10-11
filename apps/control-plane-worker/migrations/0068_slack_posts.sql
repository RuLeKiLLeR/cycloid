CREATE TABLE IF NOT EXISTS slack_posts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  channel TEXT,
  message_ts TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_posts_prompt_stage
  ON slack_posts(session_id, prompt_id, stage);
