-- Widen pr_review_response_epochs.source_kind CHECK to include 'verification'.
-- SQLite cannot alter a CHECK constraint in place; rebuild the table (same pattern as 0122).
-- Verification-intake epochs (RLA v2) carry the VA needs-work verdict into the review loop and
-- need source_kind = 'verification'. Includes prompted_source_ids_json added by 0126.
CREATE TABLE pr_review_response_epochs_new (
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
  updated_at INTEGER NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'bot' CHECK (source_kind IN ('bot', 'human', 'mixed', 'ci', 'verification')),
  prompted_source_ids_json TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO pr_review_response_epochs_new
  (id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
   expected_bots_hash, expected_bots_json, expected_bot_keys_json,
   observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
   handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
   timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
   status, worklist_hash, last_prompt_id, blocked_reason, lease_owner, lease_expires_at,
   reservation_token, attempt_count, transient_failure_count, contention_deferral_count,
   last_error, created_at, updated_at, source_kind, prompted_source_ids_json)
SELECT id, session_id, owner_user_id, repo_owner, repo_name, pr_number, pr_url, head_sha, wave,
       expected_bots_hash, expected_bots_json, expected_bot_keys_json,
       observed_terminal_bots_json, observed_terminal_bot_keys_json, observed_terminal_bot_count,
       handled_source_ids_json, triggering_source_ids_json, terminal_evidence_json,
       timed_out_bot_keys_json, uncertain_source_ids_json, first_activity_at, fallback_after_at,
       status, worklist_hash, last_prompt_id, blocked_reason, lease_owner, lease_expires_at,
       reservation_token, attempt_count, transient_failure_count, contention_deferral_count,
       last_error, created_at, updated_at, source_kind, prompted_source_ids_json
FROM pr_review_response_epochs;

DROP TABLE pr_review_response_epochs;
ALTER TABLE pr_review_response_epochs_new RENAME TO pr_review_response_epochs;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_review_response_epochs_unique
  ON pr_review_response_epochs(owner_user_id, session_id, pr_url, head_sha, expected_bots_hash, wave);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_fallback
  ON pr_review_response_epochs(status, fallback_after_at);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_lease
  ON pr_review_response_epochs(status, lease_expires_at);

CREATE INDEX IF NOT EXISTS pr_review_response_epochs_source_kind_idx
  ON pr_review_response_epochs (source_kind);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_session
  ON pr_review_response_epochs(session_id, pr_url, head_sha);

CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_collecting_poll
  ON pr_review_response_epochs(status, updated_at, fallback_after_at, id);
