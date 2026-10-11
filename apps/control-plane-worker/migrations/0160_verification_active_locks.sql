-- One active verifier per pull request (ARC-1173). Acquired atomically by every
-- verification entry point (auto-scheduler, API verify, GitHub PR-comment, Slack)
-- before a verifier session is created, so concurrent triggers cannot spawn two
-- verifiers for the same PR. pr_url is the canonical lock key (lowercased
-- owner/repo + PR number); see verification-lock-db.ts. expires_at is a crash
-- backstop: a verifier that dies without releasing self-heals after the TTL.
CREATE TABLE IF NOT EXISTS verification_active_locks (
  pr_url TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
