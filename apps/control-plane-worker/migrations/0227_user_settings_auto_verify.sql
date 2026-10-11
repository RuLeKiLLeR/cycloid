-- Per-user default for whether new implementation sessions run Arcanist verification.
-- Default 1 (on) preserves existing behavior; users can opt out for faster sessions.
ALTER TABLE user_settings
  ADD COLUMN auto_verify_enabled INTEGER NOT NULL DEFAULT 1;
