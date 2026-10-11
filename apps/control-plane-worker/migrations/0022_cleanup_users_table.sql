-- Drop indexes on columns being removed
DROP INDEX IF EXISTS idx_users_slack_user_id;

-- Drop legacy credential columns from users (now in user_integrations).
-- Using ALTER TABLE DROP COLUMN (SQLite 3.35+) to avoid FK constraint issues
-- with the DROP TABLE + RENAME approach.
ALTER TABLE users DROP COLUMN github_token;
ALTER TABLE users DROP COLUMN linear_access_token;
ALTER TABLE users DROP COLUMN linear_refresh_token;
ALTER TABLE users DROP COLUMN linear_token_expires_at;
ALTER TABLE users DROP COLUMN anthropic_api_key;
ALTER TABLE users DROP COLUMN openai_api_key;
ALTER TABLE users DROP COLUMN slack_user_id;
ALTER TABLE users DROP COLUMN grafana_url;
ALTER TABLE users DROP COLUMN grafana_service_account_token;
