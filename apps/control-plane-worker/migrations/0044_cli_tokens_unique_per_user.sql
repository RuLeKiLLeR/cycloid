-- Enforce at most one active (non-revoked) CLI token per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_tokens_user_active
  ON cli_tokens(user_id) WHERE revoked_at IS NULL;
