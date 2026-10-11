CREATE TABLE IF NOT EXISTS integration_lifecycle_events (
  id TEXT PRIMARY KEY,
  business_id TEXT,
  user_id INTEGER,
  session_id TEXT,
  integration_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  message TEXT,
  details_json TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_lifecycle_session
  ON integration_lifecycle_events (session_id, integration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_lifecycle_user
  ON integration_lifecycle_events (user_id, integration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_lifecycle_business
  ON integration_lifecycle_events (business_id, integration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_lifecycle_status
  ON integration_lifecycle_events (integration_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_integration_lifecycle_created_at
  ON integration_lifecycle_events (created_at DESC);
