ALTER TABLE user_settings
ADD COLUMN plan_mode_setting TEXT NOT NULL DEFAULT 'off'
CHECK (plan_mode_setting IN ('off', 'on', 'auto'));

UPDATE user_settings
SET plan_mode_setting = CASE plan_mode
  WHEN 0 THEN 'off'
  WHEN 1 THEN 'on'
  WHEN 2 THEN 'auto'
  ELSE '__invalid_plan_mode__'
END;

CREATE TRIGGER user_settings_plan_mode_to_setting_insert
AFTER INSERT ON user_settings
WHEN NEW.plan_mode != 0 AND NEW.plan_mode_setting = 'off'
BEGIN
  UPDATE user_settings SET plan_mode_setting = CASE NEW.plan_mode
    WHEN 0 THEN 'off' WHEN 1 THEN 'on' WHEN 2 THEN 'auto'
    ELSE '__invalid_plan_mode__' END
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_settings_plan_mode_setting_to_mode_insert
AFTER INSERT ON user_settings
WHEN NEW.plan_mode = 0 AND NEW.plan_mode_setting != 'off'
BEGIN
  UPDATE user_settings SET plan_mode = CASE NEW.plan_mode_setting
    WHEN 'off' THEN 0 WHEN 'on' THEN 1 WHEN 'auto' THEN 2 END
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_settings_plan_mode_to_setting_update
AFTER UPDATE OF plan_mode ON user_settings
WHEN NEW.plan_mode_setting != CASE NEW.plan_mode
  WHEN 0 THEN 'off' WHEN 1 THEN 'on' WHEN 2 THEN 'auto'
  ELSE '__invalid_plan_mode__' END
BEGIN
  UPDATE user_settings SET plan_mode_setting = CASE NEW.plan_mode
    WHEN 0 THEN 'off' WHEN 1 THEN 'on' WHEN 2 THEN 'auto'
    ELSE '__invalid_plan_mode__' END
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER user_settings_plan_mode_setting_to_mode_update
AFTER UPDATE OF plan_mode_setting ON user_settings
WHEN NEW.plan_mode != CASE NEW.plan_mode_setting
  WHEN 'off' THEN 0 WHEN 'on' THEN 1 WHEN 'auto' THEN 2 END
BEGIN
  UPDATE user_settings SET plan_mode = CASE NEW.plan_mode_setting
    WHEN 'off' THEN 0 WHEN 'on' THEN 1 WHEN 'auto' THEN 2 END
  WHERE user_id = NEW.user_id;
END;

-- Set plan mode to auto (2) for every current member of the internal Arcanist
-- business. business_members is the membership source of truth.

UPDATE user_settings
SET plan_mode = 2,
    updated_at = unixepoch() * 1000
WHERE user_id IN (
  SELECT user_id
  FROM business_members
  WHERE business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
);

-- Create settings for members who have none. These values mirror
-- createUserSettingsIfMissing (settings/db.ts), overriding only plan_mode.
INSERT INTO user_settings (
  user_id, default_pr_draft, auto_verify_enabled, automatic_reviews_enabled,
  plan_mode, use_codex_subscription, default_model, default_repo, created_at, updated_at
)
SELECT users.id, 0, 0, 0, 2, 0, NULL, NULL, unixepoch() * 1000, unixepoch() * 1000
FROM business_members
INNER JOIN users ON users.id = business_members.user_id
WHERE business_members.business_id = '295d2abc-d10b-4662-b84d-7bfa66242882'
  AND NOT EXISTS (
    SELECT 1 FROM user_settings WHERE user_settings.user_id = business_members.user_id
  );
