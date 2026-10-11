-- Replace `enabled` column on business_integrations with `scope` column.
-- SQLite doesn't support ALTER COLUMN, so we recreate the table (same pattern as 0023).

-- Step 1: Backup
CREATE TABLE IF NOT EXISTS _bak_business_integrations AS SELECT * FROM business_integrations;

-- Step 2: Drop original
DROP TABLE IF EXISTS business_integrations;

-- Step 3: Recreate with `scope` replacing `enabled`
CREATE TABLE IF NOT EXISTS business_integrations (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT NOT NULL CHECK(integration_id IN ('linear', 'slack', 'grafana', 'anthropic', 'openai')),
  scope TEXT NOT NULL DEFAULT 'user' CHECK(scope IN ('disabled', 'user', 'business')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (business_id, integration_id)
);

-- Step 4: Restore data with backfill (enabled=0 -> disabled, enabled=1 -> user)
INSERT INTO business_integrations (business_id, integration_id, scope, created_at, updated_at)
  SELECT business_id, integration_id,
    CASE WHEN enabled = 0 THEN 'disabled' ELSE 'user' END,
    created_at, updated_at
  FROM _bak_business_integrations;

-- Step 5: Cleanup backup
DROP TABLE IF EXISTS _bak_business_integrations;

-- New table: business-wide integration credentials
CREATE TABLE IF NOT EXISTS business_integration_credentials (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT NOT NULL CHECK(integration_id IN ('linear', 'slack', 'grafana', 'anthropic', 'openai')),
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
