CREATE INDEX IF NOT EXISTS idx_business_integration_health_retention
  ON business_integration_health_checks (created_at);
