-- Let each user opt out of automatic similar-session context injection.
-- Defaults to enabled to preserve the existing session startup behavior.
ALTER TABLE user_settings ADD COLUMN similar_sessions_enabled INTEGER NOT NULL DEFAULT 1;
