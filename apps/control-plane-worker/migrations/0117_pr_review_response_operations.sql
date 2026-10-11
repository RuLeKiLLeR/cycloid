CREATE TABLE IF NOT EXISTS pr_review_response_operations (
  operation_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  kind TEXT NOT NULL,
  target_source_id TEXT,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  github_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_operations_epoch
  ON pr_review_response_operations(epoch_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_operations_session
  ON pr_review_response_operations(session_id, status, updated_at);
