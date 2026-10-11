-- Append-only evidence for scheduled user-scoped integration confidence checks.
-- Secrets and raw provider payloads must not be stored here.
CREATE TABLE IF NOT EXISTS user_integration_health_checks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  integration_id TEXT NOT NULL,
  check_kind TEXT NOT NULL CHECK(check_kind IN ('basic', 'synthetic_session')),
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'skipped')),
  operation TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  diagnostic TEXT NOT NULL,
  failure_reason TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_user_integration_health_latest
  ON user_integration_health_checks (user_id, integration_id, check_kind, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_integration_health_schedule
  ON user_integration_health_checks (integration_id, check_kind, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_integration_health_retention
  ON user_integration_health_checks (created_at);
