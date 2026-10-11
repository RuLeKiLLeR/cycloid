CREATE TABLE IF NOT EXISTS managed_user_provider_credentials (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('anthropic', 'openai')),
  api_key TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 1 CHECK(encrypted IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  budget_limit_cents INTEGER,
  provider_project_id TEXT,
  provider_key_label TEXT,
  assigned_by_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  last_validated_at INTEGER,
  last_validation_status TEXT CHECK(last_validation_status IS NULL OR last_validation_status IN ('validated', 'saved_unverified', 'invalid')),
  last_validation_reason_code TEXT CHECK(last_validation_reason_code IS NULL OR last_validation_reason_code IN (
    'none',
    'credentials_missing',
    'credentials_present',
    'credentials_invalid',
    'integration_disabled',
    'business_managed',
    'network_validation_skipped',
    'github_logged_in',
    'github_not_logged_in',
    'github_business_authorized',
    'github_business_not_authorized',
    'github_app_installed',
    'github_app_not_installed',
    'github_app_install_pending_webhook_sync',
    'github_app_suspended',
    'github_repo_not_selected',
    'github_repo_access_verified',
    'github_repo_access_denied',
    'github_repo_access_check_failed',
    'oauth_connected',
    'oauth_not_connected',
    'oauth_token_expired',
    'oauth_no_refresh_token',
    'db_lookup_failed'
  )),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_managed_user_provider_credentials_user_status
  ON managed_user_provider_credentials(user_id, provider, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_user_provider_credentials_active_unique
  ON managed_user_provider_credentials(user_id, provider)
  WHERE status = 'active';
