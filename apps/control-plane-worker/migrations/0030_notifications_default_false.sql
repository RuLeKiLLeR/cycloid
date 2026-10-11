-- Fix notifications_enabled default from 1 (true) to 0 (false).
-- The opt-in flow requires users to explicitly enable notifications,
-- so the default should be off.

-- Reset all existing rows (no users have opted in yet since UI didn't exist)
UPDATE user_settings SET notifications_enabled = 0 WHERE notifications_enabled = 1;
