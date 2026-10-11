-- Flip user_settings.auto_verify_enabled default 1 -> 0 for NEW rows only.
-- Existing rows keep their stored value (NO backfill UPDATE): Arcanist QA verification
-- becomes opt-in per user; already-configured users are untouched.
-- SQLite/D1 default change via full table rebuild (create -> copy -> drop -> rename),
-- the same pattern as 0234. No BEGIN/COMMIT: `wrangler d1 migrations apply` wraps each file.

CREATE TABLE user_settings_new (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  theme TEXT DEFAULT 'system',
  default_model TEXT,
  custom_instructions TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  default_repo TEXT,
  pr_review_auto_response_enabled INTEGER NOT NULL DEFAULT 0,
  self_hosted_sandboxes_opt_in INTEGER NOT NULL DEFAULT 0,
  use_codex_subscription INTEGER NOT NULL DEFAULT 0,
  default_pr_draft INTEGER NOT NULL DEFAULT 0,
  auto_verify_enabled INTEGER NOT NULL DEFAULT 0
);

INSERT INTO user_settings_new (
  user_id, theme, default_model, custom_instructions, created_at, updated_at,
  default_repo, pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
  use_codex_subscription, default_pr_draft, auto_verify_enabled
)
SELECT
  user_id, theme, default_model, custom_instructions, created_at, updated_at,
  default_repo, pr_review_auto_response_enabled, self_hosted_sandboxes_opt_in,
  use_codex_subscription, default_pr_draft, auto_verify_enabled
FROM user_settings;

DROP TABLE user_settings;

ALTER TABLE user_settings_new RENAME TO user_settings;
