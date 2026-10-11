-- Copy GitHub tokens (currently unencrypted, encrypted=0)
INSERT OR IGNORE INTO user_integrations (user_id, integration_id, oauth_access_token, encrypted, connected_at, updated_at)
SELECT id, 'github', github_token, 0, updated_at, updated_at
FROM users WHERE github_token IS NOT NULL;

-- Copy Linear tokens (currently unencrypted, encrypted=0)
INSERT OR IGNORE INTO user_integrations (user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at, encrypted, connected_at, updated_at)
SELECT id, 'linear', linear_access_token, linear_refresh_token, linear_token_expires_at, 0, updated_at, updated_at
FROM users WHERE linear_access_token IS NOT NULL;

-- Copy Slack user IDs (no encryption needed)
INSERT OR IGNORE INTO user_integrations (user_id, integration_id, external_user_id, encrypted, connected_at, updated_at)
SELECT id, 'slack', slack_user_id, 0, updated_at, updated_at
FROM users WHERE slack_user_id IS NOT NULL;

-- Copy Grafana credentials (already encrypted)
INSERT OR IGNORE INTO user_integrations (user_id, integration_id, api_key, service_url, encrypted, connected_at, updated_at)
SELECT id, 'grafana', grafana_service_account_token, grafana_url, 1, updated_at, updated_at
FROM users WHERE grafana_service_account_token IS NOT NULL;

-- Copy Anthropic API keys (already encrypted)
INSERT OR IGNORE INTO user_integrations (user_id, integration_id, api_key, encrypted, connected_at, updated_at)
SELECT id, 'anthropic', anthropic_api_key, 1, updated_at, updated_at
FROM users WHERE anthropic_api_key IS NOT NULL;

-- Copy OpenAI API keys (already encrypted)
INSERT OR IGNORE INTO user_integrations (user_id, integration_id, api_key, encrypted, connected_at, updated_at)
SELECT id, 'openai', openai_api_key, 1, updated_at, updated_at
FROM users WHERE openai_api_key IS NOT NULL;

-- Backfill business_members from users.business_id (all existing members get role='member')
INSERT OR IGNORE INTO business_members (business_id, user_id, role, created_at, updated_at)
SELECT business_id, id, 'member', created_at, updated_at
FROM users WHERE business_id IS NOT NULL;
