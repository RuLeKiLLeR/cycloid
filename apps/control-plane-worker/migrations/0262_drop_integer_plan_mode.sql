DROP TRIGGER user_settings_plan_mode_to_setting_insert;
DROP TRIGGER user_settings_plan_mode_setting_to_mode_insert;
DROP TRIGGER user_settings_plan_mode_to_setting_update;
DROP TRIGGER user_settings_plan_mode_setting_to_mode_update;

CREATE TABLE user_settings_new (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  default_model TEXT,
  custom_instructions TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  default_repo TEXT,
  pr_review_auto_response_enabled INTEGER NOT NULL DEFAULT 0,
  self_hosted_sandboxes_opt_in INTEGER NOT NULL DEFAULT 0,
  use_codex_subscription INTEGER NOT NULL DEFAULT 0,
  default_pr_draft INTEGER NOT NULL DEFAULT 0,
  auto_verify_enabled INTEGER NOT NULL DEFAULT 0,
  automatic_reviews_enabled INTEGER NOT NULL DEFAULT 0,
  plan_mode_setting TEXT NOT NULL DEFAULT 'off'
    CHECK (plan_mode_setting IN ('off', 'on', 'auto'))
);

INSERT INTO user_settings_new (
  user_id, default_model, custom_instructions, created_at, updated_at,
  default_repo, pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
  use_codex_subscription, default_pr_draft, auto_verify_enabled,
  automatic_reviews_enabled, plan_mode_setting
)
SELECT
  user_id, default_model, custom_instructions, created_at, updated_at,
  default_repo, pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
  use_codex_subscription, default_pr_draft, auto_verify_enabled,
  automatic_reviews_enabled, plan_mode_setting
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_new RENAME TO user_settings;
