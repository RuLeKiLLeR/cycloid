-- Prompt-run index for fast lookup, grouping, and observability queries.
CREATE TABLE IF NOT EXISTS prompt_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_prompt_runs_session ON prompt_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_owner ON prompt_runs(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_repo ON prompt_runs(repo);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_outcome ON prompt_runs(outcome);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_created ON prompt_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_runs_owner_created ON prompt_runs(owner_user_id, created_at);
