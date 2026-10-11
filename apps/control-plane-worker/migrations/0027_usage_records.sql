-- Per-prompt usage records for historical cost tracking.
-- Each row represents one prompt completion (or evaluation) with its token counts and cost.
-- cost_usd_micros stores micro-dollars (USD * 1,000,000) to avoid floating-point drift in SUM().
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT,
  owner_user_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sandbox' CHECK(source IN ('sandbox', 'evaluation')),
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_usage_records_session ON usage_records(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_owner_date ON usage_records(owner_user_id, created_at);
