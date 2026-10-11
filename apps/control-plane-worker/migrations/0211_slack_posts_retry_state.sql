ALTER TABLE slack_posts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE slack_posts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_posts ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE slack_posts ADD COLUMN last_error TEXT;
ALTER TABLE slack_posts ADD COLUMN lease_owner TEXT;
ALTER TABLE slack_posts ADD COLUMN lease_expires_at INTEGER;

UPDATE slack_posts
SET status = 'delivered'
WHERE message_ts IS NOT NULL;

UPDATE slack_posts
SET next_attempt_at = created_at
WHERE status = 'pending' AND next_attempt_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_slack_posts_due
  ON slack_posts(status, next_attempt_at);
