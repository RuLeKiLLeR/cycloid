CREATE TABLE IF NOT EXISTS offboarding_jobs (
  job_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  captured_user_ids_json TEXT NOT NULL,
  captured_session_ids_json TEXT NOT NULL,
  phase TEXT NOT NULL,
  step_markers_json TEXT NOT NULL,
  table_counts_json TEXT NOT NULL,
  external_results_json TEXT NOT NULL,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_offboarding_jobs_business_created
  ON offboarding_jobs (business_id, created_at DESC);
