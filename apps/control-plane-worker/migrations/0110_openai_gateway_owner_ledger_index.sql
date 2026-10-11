CREATE INDEX IF NOT EXISTS idx_openai_gateway_ledger_owner_created
  ON openai_gateway_ledger(owner_user_id, created_at);
