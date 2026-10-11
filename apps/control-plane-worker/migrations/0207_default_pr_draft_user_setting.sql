-- Per-user toggle for opening Arcanist-authored code PRs as drafts by default.
-- Default 0 (off) preserves today's behavior: PRs open ready for review. When
-- 1, the publish path forwards `draft: true` to GitHub's create-PR call.
ALTER TABLE user_settings
  ADD COLUMN default_pr_draft INTEGER NOT NULL DEFAULT 0;
