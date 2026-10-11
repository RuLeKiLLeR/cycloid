CREATE TABLE IF NOT EXISTS qa_loop_session_bindings (
  pr_url TEXT NOT NULL,
  automated_lifecycle_id TEXT NOT NULL,
  qa_session_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'expired')),
  last_scheduled_head_sha TEXT,
  active_prompt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pr_url, automated_lifecycle_id)
);

CREATE INDEX IF NOT EXISTS idx_qa_loop_session_bindings_qa_session
  ON qa_loop_session_bindings(qa_session_id);
