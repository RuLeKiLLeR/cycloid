-- Extend pr_review_response_epochs with source_kind.
ALTER TABLE pr_review_response_epochs
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'bot'
  CHECK (source_kind IN ('bot', 'human', 'mixed'));

CREATE INDEX IF NOT EXISTS pr_review_response_epochs_source_kind_idx
  ON pr_review_response_epochs (source_kind);

-- Widen pr_review_response_operations.kind to include 'summary_comment'.
-- SQLite cannot alter CHECK constraints; rebuild the table.
-- The original table (0117) had no CHECK constraints on kind or status.
-- This rebuild adds them explicitly.
CREATE TABLE pr_review_response_operations_new (
  operation_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('push', 'reply', 'summary_comment')),
  target_source_id TEXT,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  github_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO pr_review_response_operations_new
  (operation_id, epoch_id, session_id, prompt_id, kind, target_source_id,
   head_sha, status, attempts, github_id, last_error, created_at, updated_at)
SELECT operation_id, epoch_id, session_id, prompt_id, kind, target_source_id,
       head_sha, status, attempts, github_id, last_error, created_at, updated_at
FROM pr_review_response_operations;

DROP TABLE pr_review_response_operations;
ALTER TABLE pr_review_response_operations_new RENAME TO pr_review_response_operations;

CREATE INDEX IF NOT EXISTS idx_pr_review_response_operations_epoch
  ON pr_review_response_operations (epoch_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_pr_review_response_operations_session
  ON pr_review_response_operations (session_id, status, updated_at);
