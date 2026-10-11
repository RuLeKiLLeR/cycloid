-- Per-user default for whether Arcanist automatically handles PR reviews.
-- Default 0 (off) makes manual review mode the product default: Arcanist works
-- CI-to-green and ignores reviews unless a user @arcanist-mentions a comment.
ALTER TABLE user_settings
  ADD COLUMN automatic_reviews_enabled INTEGER NOT NULL DEFAULT 0;
