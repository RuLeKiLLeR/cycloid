-- Set the stored default model to gpt-5.4 for every user in the internal Arcanist
-- business (users.business_id = SEEDED_BUSINESS_IDS.arcanist). One-shot data backfill.

-- Update existing settings rows (clobbers any prior personal default by design).
UPDATE user_settings
SET default_model = 'gpt-5.4',
    updated_at = unixepoch() * 1000
WHERE user_id IN (
  SELECT id FROM users WHERE business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
);

-- Insert a settings row for Arcanist users who have none yet. Column values mirror
-- createUserSettingsIfMissing (settings/db.ts) exactly, overriding only default_model,
-- so this does not silently change unrelated settings via diverging column DEFAULTs
-- (e.g. notifications_enabled column DEFAULT is 1 but the app create-default is 0).
INSERT INTO user_settings (
  user_id, theme, notifications_enabled, sound_enabled, similar_sessions_enabled,
  pr_review_auto_response_enabled, auto_create_pr_enabled, self_hosted_sandboxes_opt_in,
  default_model, default_repo, created_at, updated_at
)
SELECT id, 'system', 0, 1, 0, 1, 1, 0, 'gpt-5.4', NULL, unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
  AND NOT EXISTS (SELECT 1 FROM user_settings WHERE user_settings.user_id = users.id);
