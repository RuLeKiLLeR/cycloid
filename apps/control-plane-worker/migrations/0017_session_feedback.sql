CREATE TABLE IF NOT EXISTS session_feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
  message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_session_feedback_session ON session_feedback(session_id);
