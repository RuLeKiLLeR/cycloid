-- session_index: convert TEXT timestamps to INTEGER (Unix ms)
CREATE TABLE IF NOT EXISTS session_index_new (
  session_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  installation_id INTEGER,
  title TEXT,
  rich_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_event_id TEXT
);
INSERT OR IGNORE INTO session_index_new SELECT
  session_id, owner_user_id, status, installation_id, title, rich_status,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
  CASE WHEN closed_at IS NOT NULL THEN CAST(strftime('%s', closed_at) AS INTEGER) * 1000 END,
  last_event_id
FROM session_index;
DROP TABLE IF EXISTS session_index;
ALTER TABLE session_index_new RENAME TO session_index;

-- session_evaluations: convert TEXT timestamps to INTEGER (Unix ms)
CREATE TABLE IF NOT EXISTS session_evaluations_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  installation_id INTEGER,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_url TEXT,
  pr_number INTEGER,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  modal_object_id TEXT,
  process_rating TEXT,
  code_rating TEXT,
  completeness_rating TEXT,
  overall_rating TEXT,
  summary TEXT,
  gap_classifications TEXT,
  raw_result TEXT,
  error TEXT,
  evaluator_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_transcript TEXT,
  github_comment_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  duration_ms INTEGER
);
INSERT OR IGNORE INTO session_evaluations_new SELECT
  id, session_id, owner_user_id, installation_id, repo_owner, repo_name,
  pr_url, pr_number, head_sha, status, modal_object_id,
  process_rating, code_rating, completeness_rating, overall_rating,
  summary, gap_classifications, raw_result, error,
  evaluator_model, prompt_version, input_transcript, github_comment_id,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CASE WHEN started_at IS NOT NULL THEN CAST(strftime('%s', started_at) AS INTEGER) * 1000 END,
  CASE WHEN completed_at IS NOT NULL THEN CAST(strftime('%s', completed_at) AS INTEGER) * 1000 END,
  CAST(strftime('%s', updated_at) AS INTEGER) * 1000,
  duration_ms
FROM session_evaluations;
DROP TABLE IF EXISTS session_evaluations;
ALTER TABLE session_evaluations_new RENAME TO session_evaluations;
CREATE INDEX IF NOT EXISTS idx_session_evaluations_session_id ON session_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_session_evaluations_created_at ON session_evaluations(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_evaluations_unique_session_pr ON session_evaluations(session_id, pr_number);

-- session_feedback: convert TEXT timestamps to INTEGER (Unix ms)
CREATE TABLE IF NOT EXISTS session_feedback_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK(rating IN ('up', 'down')),
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, user_id)
);
INSERT OR IGNORE INTO session_feedback_new SELECT
  id, session_id, user_id, rating, message,
  CAST(strftime('%s', created_at) AS INTEGER) * 1000,
  CAST(strftime('%s', updated_at) AS INTEGER) * 1000
FROM session_feedback;
DROP TABLE IF EXISTS session_feedback;
ALTER TABLE session_feedback_new RENAME TO session_feedback;
CREATE INDEX IF NOT EXISTS idx_session_feedback_session ON session_feedback(session_id);
