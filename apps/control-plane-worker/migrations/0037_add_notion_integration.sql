-- Drop integration_id CHECK constraints from all 3 integration tables.
-- The shared integration registry in shared/constants/integrations.ts is the
-- single source of truth. Removing the DB-level CHECK means future
-- integrations require zero migration work.

-- =====================================================================
-- user_integrations: remove CHECK on integration_id
-- =====================================================================

CREATE TABLE IF NOT EXISTS _bak_user_integrations AS SELECT * FROM user_integrations;

DROP INDEX IF EXISTS idx_user_integrations_integration;
DROP INDEX IF EXISTS idx_user_integrations_external_user;
DROP TABLE IF EXISTS user_integrations;

CREATE TABLE IF NOT EXISTS user_integrations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  integration_id TEXT NOT NULL,
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

INSERT INTO user_integrations SELECT * FROM _bak_user_integrations;
DROP TABLE IF EXISTS _bak_user_integrations;

-- =====================================================================
-- business_integrations: remove CHECK on integration_id
-- =====================================================================

CREATE TABLE IF NOT EXISTS _bak_business_integrations AS SELECT * FROM business_integrations;

DROP TABLE IF EXISTS business_integrations;

CREATE TABLE IF NOT EXISTS business_integrations (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user' CHECK(scope IN ('disabled', 'user', 'business')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (business_id, integration_id)
);

INSERT INTO business_integrations SELECT * FROM _bak_business_integrations;
DROP TABLE IF EXISTS _bak_business_integrations;

-- =====================================================================
-- business_integration_credentials: remove CHECK on integration_id
-- =====================================================================

CREATE TABLE IF NOT EXISTS _bak_business_integration_credentials AS SELECT * FROM business_integration_credentials;

DROP TABLE IF EXISTS business_integration_credentials;

CREATE TABLE IF NOT EXISTS business_integration_credentials (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT NOT NULL,
  oauth_access_token TEXT,
  oauth_refresh_token TEXT,
  oauth_expires_at INTEGER,
  api_key TEXT,
  service_url TEXT,
  encrypted INTEGER NOT NULL DEFAULT 0,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (business_id, integration_id)
);

INSERT INTO business_integration_credentials SELECT * FROM _bak_business_integration_credentials;
DROP TABLE IF EXISTS _bak_business_integration_credentials;
