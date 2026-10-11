CREATE TABLE IF NOT EXISTS user_pr_review_bot_settings (
  user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  expected_bots_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_owner, repo_name)
);

CREATE INDEX IF NOT EXISTS idx_user_pr_review_bot_settings_repo
  ON user_pr_review_bot_settings(repo_owner, repo_name, user_id);

CREATE TABLE IF NOT EXISTS pr_review_response_epochs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  wave INTEGER NOT NULL DEFAULT 1,
  expected_bots_hash TEXT NOT NULL,
  expected_bots_json TEXT NOT NULL,
  expected_bot_keys_json TEXT NOT NULL,
  observed_terminal_bots_json TEXT NOT NULL DEFAULT '[]',
  observed_terminal_bot_keys_json TEXT NOT NULL DEFAULT '[]',
  observed_terminal_bot_count INTEGER NOT NULL DEFAULT 0,
  handled_source_ids_json TEXT NOT NULL DEFAULT '[]',
  triggering_source_ids_json TEXT NOT NULL DEFAULT '[]',
  terminal_evidence_json TEXT NOT NULL DEFAULT '[]',
  timed_out_bot_keys_json TEXT NOT NULL DEFAULT '[]',
  uncertain_source_ids_json TEXT NOT NULL DEFAULT '[]',
  first_activity_at INTEGER NOT NULL,
  fallback_after_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  worklist_hash TEXT,
  last_prompt_id TEXT,
  blocked_reason TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  reservation_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  transient_failure_count INTEGER NOT NULL DEFAULT 0,
  contention_deferral_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_response_epochs_unique
  ON pr_review_response_epochs(owner_user_id, session_id, pr_url, head_sha, expected_bots_hash, wave);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_fallback
  ON pr_review_response_epochs(status, fallback_after_at);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_lease
  ON pr_review_response_epochs(status, lease_expires_at);
