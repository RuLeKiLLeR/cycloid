CREATE TABLE IF NOT EXISTS cli_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cli_tokens_user ON cli_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_hash ON cli_tokens(token_hash);
