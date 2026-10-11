-- Let each user opt in to Arcanist automatically acting on GitHub PR reviews
-- submitted against PRs tied to their sessions.
ALTER TABLE user_settings ADD COLUMN pr_review_auto_response_enabled INTEGER NOT NULL DEFAULT 0;
