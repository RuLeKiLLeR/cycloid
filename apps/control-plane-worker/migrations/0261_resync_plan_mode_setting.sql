UPDATE user_settings
SET plan_mode_setting = CASE plan_mode
  WHEN 0 THEN 'off'
  WHEN 1 THEN 'on'
  WHEN 2 THEN 'auto'
  ELSE '__invalid_plan_mode__'
END;
