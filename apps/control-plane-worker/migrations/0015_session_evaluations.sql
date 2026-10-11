CREATE TABLE IF NOT EXISTS session_evaluations (
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
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_session_evaluations_session_id
  ON session_evaluations(session_id);

CREATE INDEX IF NOT EXISTS idx_session_evaluations_created_at
  ON session_evaluations(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_evaluations_unique_session_pr
  ON session_evaluations(session_id, pr_number);
