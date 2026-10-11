-- Add immutable tenant snapshots for historical session data.
ALTER TABLE session_index ADD COLUMN business_id TEXT;
ALTER TABLE usage_records ADD COLUMN business_id TEXT;
ALTER TABLE prompt_runs ADD COLUMN business_id TEXT;
ALTER TABLE session_completions ADD COLUMN business_id TEXT;
ALTER TABLE codegraph_observations ADD COLUMN business_id TEXT;

CREATE INDEX IF NOT EXISTS idx_session_index_business_updated
  ON session_index(business_id, updated_at DESC, session_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_business_created
  ON usage_records(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_business_created
  ON prompt_runs(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_completions_business_repo
  ON session_completions(business_id, repo_owner, repo_name, success, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_business_repo
  ON codegraph_observations(business_id, repo_owner, repo_name, stale, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_business_session
  ON codegraph_observations(business_id, session_id);
