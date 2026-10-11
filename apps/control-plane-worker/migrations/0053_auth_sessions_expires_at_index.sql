-- Support efficient scheduled pruning of expired auth sessions.
-- auth_sessions is heavily queried, so expired-row cleanup should avoid full table scans.
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
