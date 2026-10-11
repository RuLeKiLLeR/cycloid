-- business_members: membership + roles (replaces implicit users.business_id membership)
CREATE TABLE IF NOT EXISTS business_members (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (business_id, user_id),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_business_members_user ON business_members(user_id);

-- user_integrations: all integration credentials in one table (extracted from users)
CREATE TABLE IF NOT EXISTS user_integrations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  integration_id TEXT NOT NULL CHECK(integration_id IN ('github', 'linear', 'slack', 'grafana', 'anthropic', 'openai')),
  oauth_access_token TEXT,
  oauth_refresh_token TEXT,
  oauth_expires_at INTEGER,
  api_key TEXT,
  external_user_id TEXT,
  service_url TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, integration_id)
);
CREATE INDEX IF NOT EXISTS idx_user_integrations_integration ON user_integrations(integration_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_integrations_external_user
  ON user_integrations(integration_id, external_user_id)
  WHERE external_user_id IS NOT NULL;

-- business_integrations: admin-controlled integration visibility per business
CREATE TABLE IF NOT EXISTS business_integrations (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT NOT NULL CHECK(integration_id IN ('linear', 'slack', 'grafana', 'anthropic', 'openai')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (business_id, integration_id)
);

-- Add updated_at to businesses (nullable because ALTER TABLE ADD COLUMN can't have expression defaults)
ALTER TABLE businesses ADD COLUMN updated_at INTEGER;
UPDATE businesses SET updated_at = created_at WHERE updated_at IS NULL;
