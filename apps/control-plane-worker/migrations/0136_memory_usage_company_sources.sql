CREATE TABLE IF NOT EXISTS memory_usage_events_new (
  id TEXT PRIMARY KEY,
  repo_owner TEXT,
  repo_name TEXT,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('prompt_start', 'recall', 'company_bootstrap', 'company_recall', 'company_reasoning_chain')),
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

INSERT OR IGNORE INTO memory_usage_events_new (
  id, repo_owner, repo_name, session_id, prompt_id, memory_id, source,
  selection_rank, selection_score, explanation, expected_effect, observed_effect,
  intent, files_json, symbols_json, review_outcome, used_at
)
SELECT
  id, repo_owner, repo_name, session_id, prompt_id, memory_id, source,
  selection_rank, selection_score, explanation, expected_effect, observed_effect,
  intent, files_json, symbols_json, review_outcome, used_at
FROM memory_usage_events;

DROP TABLE memory_usage_events;
ALTER TABLE memory_usage_events_new RENAME TO memory_usage_events;

CREATE INDEX IF NOT EXISTS idx_memory_usage_events_repo_memory
  ON memory_usage_events(repo_owner, repo_name, memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_usage_events_session
  ON memory_usage_events(session_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_memory_usage_events_used_at
  ON memory_usage_events(used_at);
