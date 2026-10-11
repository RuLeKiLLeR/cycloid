-- Migrate owner_user_id from TEXT to INTEGER across all tables that store it.
-- Fixes the CAST(id AS TEXT) anti-pattern that defeats index usage when joining
-- against users.id (INTEGER). See ARC-326.

-- 1. session_index
CREATE TABLE IF NOT EXISTS session_index_new (
  session_id TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  installation_id INTEGER,
  title TEXT,
  rich_status TEXT,
  model TEXT,
  reasoning_effort TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER,
  last_event_id TEXT
);
INSERT OR IGNORE INTO session_index_new SELECT
  session_id, CAST(owner_user_id AS INTEGER), status, installation_id, title,
  rich_status, model, reasoning_effort, created_at, updated_at, closed_at, last_event_id
FROM session_index;
DROP TABLE IF EXISTS session_index;
ALTER TABLE session_index_new RENAME TO session_index;
CREATE INDEX IF NOT EXISTS idx_session_index_owner_updated ON session_index(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_index_status_updated ON session_index(status, updated_at DESC);

-- 2. usage_records
CREATE TABLE IF NOT EXISTS usage_records_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  owner_user_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'sandbox' CHECK(source IN ('sandbox', 'evaluation')),
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT OR IGNORE INTO usage_records_new SELECT
  id, session_id, prompt_id, CAST(owner_user_id AS INTEGER), source, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cost_usd_micros, created_at
FROM usage_records;
DROP TABLE IF EXISTS usage_records;
ALTER TABLE usage_records_new RENAME TO usage_records;
CREATE INDEX IF NOT EXISTS idx_usage_records_session ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_owner_date ON usage_records(owner_user_id, created_at);

-- 3. prompt_runs
CREATE TABLE IF NOT EXISTS prompt_runs_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  sandbox_id TEXT,
  modal_object_id TEXT,
  opencode_session_id TEXT,
  repo TEXT,
  model TEXT,
  agent TEXT,
  source TEXT,
  outcome TEXT,
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd_micros INTEGER,
  duration_ms INTEGER,
  tool_call_count INTEGER,
  dd_trace_id TEXT,
  bt_span_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at INTEGER,
  UNIQUE(session_id, prompt_id)
);
INSERT OR IGNORE INTO prompt_runs_new SELECT
  id, session_id, prompt_id, CAST(owner_user_id AS INTEGER), sandbox_id,
  modal_object_id, opencode_session_id, repo, model, agent, source, outcome,
  error_code, input_tokens, output_tokens, cost_usd_micros, duration_ms,
  tool_call_count, dd_trace_id, bt_span_id, created_at, completed_at
FROM prompt_runs;
DROP TABLE IF EXISTS prompt_runs;
ALTER TABLE prompt_runs_new RENAME TO prompt_runs;
CREATE INDEX IF NOT EXISTS idx_prompt_runs_session ON prompt_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_owner ON prompt_runs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_repo ON prompt_runs(repo);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_outcome ON prompt_runs(outcome);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_created ON prompt_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_owner_created ON prompt_runs(owner_user_id, created_at);

-- 4. session_completions
CREATE TABLE IF NOT EXISTS session_completions_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  title TEXT,
  diff_summary TEXT,
  branch TEXT,
  commit_sha TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
INSERT OR IGNORE INTO session_completions_new SELECT
  id, session_id, prompt_id, CAST(owner_user_id AS INTEGER), repo_owner,
  repo_name, prompt_text, title, diff_summary, branch, commit_sha,
  success, completed_at, created_at
FROM session_completions;
DROP TABLE IF EXISTS session_completions;
ALTER TABLE session_completions_new RENAME TO session_completions;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_completions_prompt
  ON session_completions(session_id, prompt_id);
CREATE INDEX IF NOT EXISTS idx_session_completions_repo
  ON session_completions(owner_user_id, repo_owner, repo_name, success, completed_at DESC);

-- 5. session_evaluations
CREATE TABLE IF NOT EXISTS session_evaluations_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
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
  id, session_id, CAST(owner_user_id AS INTEGER), installation_id, repo_owner,
  repo_name, pr_url, pr_number, head_sha, status, modal_object_id,
  process_rating, code_rating, completeness_rating, overall_rating,
  summary, gap_classifications, raw_result, error,
  evaluator_model, prompt_version, input_transcript, github_comment_id,
  created_at, started_at, completed_at, updated_at, duration_ms
FROM session_evaluations;
DROP TABLE IF EXISTS session_evaluations;
ALTER TABLE session_evaluations_new RENAME TO session_evaluations;
CREATE INDEX IF NOT EXISTS idx_session_evaluations_session_id ON session_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_session_evaluations_created_at ON session_evaluations(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_evaluations_unique_session_pr
  ON session_evaluations(session_id, pr_number, evaluator_model);
