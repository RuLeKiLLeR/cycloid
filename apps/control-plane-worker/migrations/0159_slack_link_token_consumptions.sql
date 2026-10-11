-- One-time consumption ledger for Slack magic-link identity-binding tokens.
-- Each link token carries a random `jti`; binding inserts the jti here inside
-- the same atomic batch that writes the identity link, so a replayed or
-- double-submitted token is rejected by the primary key (the real single-use
-- serialization point). Timestamps are INTEGER Unix milliseconds. Rows past
-- `expires_at` are dead weight and pruned opportunistically.
CREATE TABLE IF NOT EXISTS slack_link_token_consumptions (
  jti TEXT PRIMARY KEY,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  consumed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_link_consumptions_expires ON slack_link_token_consumptions(expires_at);
