-- Add sound_enabled column for notification sounds.
-- Defaults to 1 (true) so users who have notifications enabled also get sounds by default.
ALTER TABLE user_settings ADD COLUMN sound_enabled INTEGER NOT NULL DEFAULT 1;
