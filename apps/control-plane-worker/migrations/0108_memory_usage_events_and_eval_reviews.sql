CREATE TABLE IF NOT EXISTS memory_usage_events (
  id TEXT PRIMARY KEY,
  repo_owner TEXT,
  repo_name TEXT,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('prompt_start', 'recall')),
  selection_rank INTEGER,
  selection_score REAL,
  explanation TEXT,
  expected_effect TEXT,
  observed_effect TEXT,
  intent TEXT,
  files_json TEXT,
  symbols_json TEXT,
  review_outcome TEXT CHECK(review_outcome IN ('helpful', 'incorrect', 'missed') OR review_outcome IS NULL),
  used_at INTEGER NOT NULL,
  UNIQUE(session_id, prompt_id, memory_id, source)
);

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_repo_memory
  ON memory_usage_events(repo_owner, repo_name, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_session
  ON memory_usage_events(session_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_used_at
  ON memory_usage_events(used_at);

ALTER TABLE session_evaluations ADD COLUMN memory_review_json TEXT;
