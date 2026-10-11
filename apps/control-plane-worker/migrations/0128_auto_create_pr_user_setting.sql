-- Per-user toggle for automatic PR creation after a successful push.
-- Default 1 (on) preserves today's behavior for existing users. When 0, the
-- auto-create trigger is skipped and the user opens the PR via the existing
-- manual "Create PR" button; follow-up updates to an existing PR stay ungated.
ALTER TABLE user_settings
  ADD COLUMN auto_create_pr_enabled INTEGER NOT NULL DEFAULT 1;
