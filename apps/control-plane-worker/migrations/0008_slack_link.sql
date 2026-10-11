ALTER TABLE users ADD COLUMN slack_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_slack_user_id ON users(slack_user_id);
