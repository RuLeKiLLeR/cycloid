-- Internal-only selector for Codex subscription auth. The credential itself is
-- stored as an encrypted user_integrations row with integration_id
-- 'codex_subscription'.
ALTER TABLE user_settings ADD COLUMN use_codex_subscription INTEGER NOT NULL DEFAULT 0;
