-- Memory usage telemetry: tracks which memories were active during each prompt.
-- Memory content lives in repo files (.arcanist/memories/*.md), not D1.
-- This table exists solely for usage analytics and pruning signals.
CREATE TABLE IF NOT EXISTS session_memory_usage (
  session_id  TEXT NOT NULL,
  prompt_id   TEXT NOT NULL,
  memory_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, prompt_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_session_memory_usage_memory
  ON session_memory_usage (memory_id);
CREATE INDEX IF NOT EXISTS idx_session_memory_usage_session
  ON session_memory_usage (session_id);
