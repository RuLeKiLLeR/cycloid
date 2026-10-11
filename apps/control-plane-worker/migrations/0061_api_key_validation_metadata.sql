ALTER TABLE user_integrations ADD COLUMN last_validated_at INTEGER;
ALTER TABLE user_integrations ADD COLUMN last_validation_status TEXT;
ALTER TABLE user_integrations ADD COLUMN last_validation_reason_code TEXT;
ALTER TABLE business_integration_credentials ADD COLUMN last_validated_at INTEGER;
ALTER TABLE business_integration_credentials ADD COLUMN last_validation_status TEXT;
ALTER TABLE business_integration_credentials ADD COLUMN last_validation_reason_code TEXT;
