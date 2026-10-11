-- Track memory PR creation and outcomes for learning/analytics.
-- Each row represents one memory PR created by the memory analysis system.
CREATE TABLE IF NOT EXISTS memory_pr_tracking (
  id                  TEXT PRIMARY KEY,
  repo_owner          TEXT NOT NULL,
  repo_name           TEXT NOT NULL,
  source_pr_url       TEXT NOT NULL,
  source_pr_number    INTEGER NOT NULL,
  source_session_id   TEXT NOT NULL,
  memory_pr_url       TEXT UNIQUE,
  memory_pr_number    INTEGER,
  memories_added      INTEGER DEFAULT 0,
  memories_updated    INTEGER DEFAULT 0,
  memories_removed    INTEGER DEFAULT 0,
  outcome             TEXT,
  outcome_at          INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_pr_tracking_repo
  ON memory_pr_tracking (repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_memory_pr_tracking_outcome
  ON memory_pr_tracking (outcome);
