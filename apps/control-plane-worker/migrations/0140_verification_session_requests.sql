-- Idempotency claims for automatic verifier sessions.
-- One verifier is scheduled for each target pull request head SHA.
CREATE TABLE IF NOT EXISTS verification_session_requests (
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'prompt_enqueued',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(pr_url, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_verification_session_requests_session
  ON verification_session_requests(session_id);

CREATE INDEX IF NOT EXISTS idx_verification_session_requests_parent
  ON verification_session_requests(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
