-- Per-repo review-loop controls:
--  * ci_response_enabled: opt-out for addressing CI failures (default on), independent of the bot checklist.
--  * review_timeout_minutes: collection-window timeout in minutes (default 10), governs the bot wait.
ALTER TABLE user_pr_review_bot_settings
  ADD COLUMN ci_response_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE user_pr_review_bot_settings
  ADD COLUMN review_timeout_minutes INTEGER NOT NULL DEFAULT 10;
