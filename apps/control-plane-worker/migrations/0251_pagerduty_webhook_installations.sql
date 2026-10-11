-- PagerDuty dispatch bindings: one business-owned webhook target that maps
-- incident-open deliveries to a configured GitHub repository + optional model.
CREATE TABLE IF NOT EXISTS pagerduty_webhook_installations (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),
  installation_token TEXT NOT NULL,
  connected_by_user_id INTEGER NOT NULL REFERENCES users(id),
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  model_id TEXT,
  webhook_signing_secret_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pagerduty_webhook_installations_token_active
  ON pagerduty_webhook_installations(installation_token)
  WHERE status = 'active';
