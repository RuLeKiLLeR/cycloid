-- Flip the repo-level default from opt-in to opt-out for existing saved rows.
-- The setting is stored explicitly on each user/repo row, so without this
-- backfill older rows would stay effectively disabled forever.
UPDATE user_pr_review_bot_settings
SET merge_conflict_resolution_enabled = 1
WHERE merge_conflict_resolution_enabled = 0;
