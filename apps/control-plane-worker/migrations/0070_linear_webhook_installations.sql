CREATE TABLE IF NOT EXISTS linear_webhook_installations (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  linear_organization_id TEXT NOT NULL,
  linear_webhook_id TEXT,
  connected_by_user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  PRIMARY KEY (business_id, linear_organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_linear_webhook_installations_org_active
  ON linear_webhook_installations(linear_organization_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_linear_webhook_installations_webhook
  ON linear_webhook_installations(linear_webhook_id);
