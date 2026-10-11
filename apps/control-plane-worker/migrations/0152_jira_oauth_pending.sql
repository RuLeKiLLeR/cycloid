-- Server-side holding area for Jira OAuth tokens while a multi-site user picks
-- a site. Rows are single-use (deleted on finalize) and expire after 10 minutes.
-- token_payload is an encrypted JSON blob; sites_json is non-secret site metadata.

CREATE TABLE IF NOT EXISTS jira_oauth_pending (
  nonce TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  flow TEXT NOT NULL CHECK(flow IN ('user', 'business')),
  token_payload TEXT NOT NULL,
  sites_json TEXT NOT NULL,
  jira_account_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jira_oauth_pending_expires
  ON jira_oauth_pending(expires_at);
