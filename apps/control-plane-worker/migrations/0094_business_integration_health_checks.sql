-- Append-only evidence for scheduled integration confidence checks.
-- Secrets and raw provider payloads must not be stored here.
CREATE TABLE IF NOT EXISTS business_integration_health_checks (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  integration_id TEXT NOT NULL,
  check_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('passed', 'failed', 'skipped')),
  operation TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  diagnostic TEXT NOT NULL,
  failure_reason TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_business_integration_health_latest
  ON business_integration_health_checks (business_id, integration_id, check_kind, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_business_integration_health_schedule
  ON business_integration_health_checks (integration_id, check_kind, checked_at DESC);
