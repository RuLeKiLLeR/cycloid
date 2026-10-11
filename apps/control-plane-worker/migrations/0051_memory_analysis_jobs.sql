-- Track memory analysis jobs for queue-based processing.
-- Each GitHub review triggers at most one analysis job (UNIQUE on review_id).
-- The queue consumer claims jobs, runs the memory agent, and records outcomes.
-- A cron sweep re-enqueues stale/failed jobs and terminalizes exhausted ones.
CREATE TABLE IF NOT EXISTS memory_analysis_jobs (
  id            TEXT PRIMARY KEY,
  review_id     INTEGER NOT NULL,
  repo_owner    TEXT NOT NULL,
  repo_name     TEXT NOT NULL,
  pr_number     INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK(status IN ('pending','processing','complete','failed','skipped')),
  error         TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  params_json   TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  started_at    INTEGER,
  completed_at  INTEGER,
  UNIQUE(review_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_analysis_jobs_status
  ON memory_analysis_jobs(status);
