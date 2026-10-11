-- Change memory analysis job uniqueness from per-review to per-PR.
-- Memory analysis now triggers on PR merge, not on review submission.
-- SQLite cannot ALTER constraints, so recreate the table.

-- Back up existing data
CREATE TABLE IF NOT EXISTS _bak_memory_analysis_jobs AS SELECT * FROM memory_analysis_jobs;

-- Drop old table and index
DROP INDEX IF EXISTS idx_memory_analysis_jobs_status;
DROP TABLE IF EXISTS memory_analysis_jobs;

-- Recreate with new unique constraint and nullable review_id
CREATE TABLE memory_analysis_jobs (
  id            TEXT PRIMARY KEY,
  review_id     INTEGER,
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
  UNIQUE(repo_owner, repo_name, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_memory_analysis_jobs_status
  ON memory_analysis_jobs(status);

-- Keep a UNIQUE index on review_id for backwards compatibility with the
-- current deployed code that uses ON CONFLICT(review_id). SQLite allows
-- multiple NULLs in UNIQUE indexes, so merge-triggered jobs (review_id=NULL)
-- won't conflict. This index can be dropped once the code PR lands.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_analysis_jobs_review_id
  ON memory_analysis_jobs(review_id);

-- Restore data (table was empty at time of migration, but safe either way)
INSERT OR IGNORE INTO memory_analysis_jobs SELECT * FROM _bak_memory_analysis_jobs;
DROP TABLE IF EXISTS _bak_memory_analysis_jobs;
