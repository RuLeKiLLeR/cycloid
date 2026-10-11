CREATE TABLE IF NOT EXISTS slack_thread_session_refs (
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel_id, thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_thread_session_refs_session
  ON slack_thread_session_refs(session_id);

CREATE TABLE IF NOT EXISTS linear_issue_session_refs (
  linear_issue_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_linear_issue_session_refs_session
  ON linear_issue_session_refs(session_id);
