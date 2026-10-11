CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  target_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_token_hash ON impersonation_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_actor ON impersonation_sessions(actor_user_id);
CREATE INDEX IF NOT EXISTS idx_impersonation_sessions_expires_at ON impersonation_sessions(expires_at);
