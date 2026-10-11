CREATE TABLE IF NOT EXISTS openai_virtual_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  business_id TEXT,
  monthly_limit_usd_micros INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_virtual_keys_owner
  ON openai_virtual_keys(owner_user_id, created_at);

CREATE TABLE IF NOT EXISTS openai_gateway_ledger (
  id TEXT PRIMARY KEY,
  virtual_key_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  business_id TEXT,
  session_id TEXT,
  prompt_id TEXT,
  request_id TEXT NOT NULL,
  openai_response_id TEXT,
  model TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL,
  estimated_cost_usd_micros INTEGER NOT NULL,
  reserved_cost_usd_micros INTEGER NOT NULL,
  actual_cost_usd_micros INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  settlement_source TEXT NOT NULL DEFAULT 'none',
  unresolved_reason TEXT,
  raw_usage_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER,
  FOREIGN KEY (virtual_key_id) REFERENCES openai_virtual_keys(id)
);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_virtual_key_created
  ON openai_gateway_ledger(virtual_key_id, created_at);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_session
  ON openai_gateway_ledger(session_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_status
  ON openai_gateway_ledger(lifecycle_status, updated_at);
