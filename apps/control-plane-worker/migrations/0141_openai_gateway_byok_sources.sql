CREATE TABLE IF NOT EXISTS openai_gateway_session_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_user_id INTEGER NOT NULL,
  business_id TEXT,
  credential_source TEXT NOT NULL,
  credential_provider TEXT NOT NULL DEFAULT 'openai',
  credential_owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_session_tokens_owner_expires
  ON openai_gateway_session_tokens(owner_user_id, expires_at);

CREATE TABLE IF NOT EXISTS openai_gateway_ledger_new (
  id TEXT PRIMARY KEY,
  virtual_key_id TEXT,
  owner_user_id TEXT NOT NULL,
  business_id TEXT,
  session_id TEXT,
  prompt_id TEXT,
  request_id TEXT NOT NULL,
  openai_response_id TEXT,
  model TEXT NOT NULL,
  credential_source TEXT NOT NULL DEFAULT 'managed_virtual_key',
  upstream_credential_ref TEXT,
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

INSERT INTO openai_gateway_ledger_new (
  id, virtual_key_id, owner_user_id, business_id, session_id, prompt_id, request_id,
  openai_response_id, model, credential_source, upstream_credential_ref, lifecycle_status,
  estimated_cost_usd_micros, reserved_cost_usd_micros, actual_cost_usd_micros,
  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
  settlement_source, unresolved_reason, raw_usage_json, created_at, updated_at, settled_at
)
SELECT
  id, virtual_key_id, owner_user_id, business_id, session_id, prompt_id, request_id,
  openai_response_id, model, 'managed_virtual_key', virtual_key_id, lifecycle_status,
  estimated_cost_usd_micros, reserved_cost_usd_micros, actual_cost_usd_micros,
  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
  settlement_source, unresolved_reason, raw_usage_json, created_at, updated_at, settled_at
FROM openai_gateway_ledger;

DROP TABLE openai_gateway_ledger;
ALTER TABLE openai_gateway_ledger_new RENAME TO openai_gateway_ledger;

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_virtual_key_created
  ON openai_gateway_ledger(virtual_key_id, created_at);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_session
  ON openai_gateway_ledger(session_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_status
  ON openai_gateway_ledger(lifecycle_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_owner_created
  ON openai_gateway_ledger(owner_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_owner_source_created
  ON openai_gateway_ledger(owner_user_id, credential_source, created_at);
