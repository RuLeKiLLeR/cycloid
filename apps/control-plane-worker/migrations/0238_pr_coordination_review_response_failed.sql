-- ARC-1330: add the `review_response_failed` NEEDS_YOU blocked_reason. An epoch's fix/reply POST to
-- GitHub that fails past its retry cap (publish_failed / reply_failed) is an agent-execution give-up the
-- caught_up cascade cannot re-derive from ground truth, so it routes REVIEW → NEEDS_YOU immediately
-- (via epoch.blocked{response_failed}) instead of waiting out the 24h review_stuck deadline.
--
-- SQLite cannot ALTER a CHECK constraint in place, so this rebuilds the table with the widened
-- blocked_reason CHECK, copies every row, and renames it back. Append-only + data-preserving. The column
-- set / PK / defaults / other CHECKs are IDENTICAL to migration 0214 apart from the one added value.
-- pr_coordination has no secondary indexes (PK only), so none are recreated. blocked_reason mirrors
-- fsm/types.ts `BlockedReason` and fsm/project.ts's total blocked-reason maps.

CREATE TABLE pr_coordination_new (
  session_id TEXT NOT NULL PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  pr_url TEXT,
  head_sha TEXT,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'app_breaks', 'skipped', 'none')),
  verdict_head_sha TEXT,
  verification_run_head TEXT,
  verification_run_id INTEGER NOT NULL DEFAULT 0,
  verification_child_id TEXT,
  verification_run_count INTEGER NOT NULL DEFAULT 0,
  ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
  in_flight_epoch_id TEXT,
  code_changed_since_verification INTEGER NOT NULL DEFAULT 0,
  prompt_intends_change INTEGER,
  merge_ready_reopen_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT CHECK (
    blocked_reason IS NULL OR blocked_reason IN (
      'owner_approval',
      'verification_noconverge',
      'verification_unresolved',
      'verification_run_limit',
      'verification_stopped',
      'ci_fix_exhausted',
      'ci_flapping',
      'review_stuck',
      'review_response_failed',
      'internal_inconsistency'
    )
  ),
  failure_reason TEXT,
  stop_mode TEXT,
  pre_stop_state TEXT,
  update_branch_queued_at INTEGER,
  deadline_at INTEGER,
  state_entered_at INTEGER,
  intent_child_id TEXT
);

INSERT INTO pr_coordination_new (
  session_id, version, state, pr_url, head_sha, verdict, verdict_head_sha, verification_run_head,
  verification_run_id, verification_child_id, verification_run_count, ci_fix_rounds, in_flight_epoch_id,
  code_changed_since_verification, prompt_intends_change, merge_ready_reopen_count, blocked_reason,
  failure_reason, stop_mode, pre_stop_state, update_branch_queued_at, deadline_at, state_entered_at,
  intent_child_id
)
SELECT
  session_id, version, state, pr_url, head_sha, verdict, verdict_head_sha, verification_run_head,
  verification_run_id, verification_child_id, verification_run_count, ci_fix_rounds, in_flight_epoch_id,
  code_changed_since_verification, prompt_intends_change, merge_ready_reopen_count, blocked_reason,
  failure_reason, stop_mode, pre_stop_state, update_branch_queued_at, deadline_at, state_entered_at,
  intent_child_id
FROM pr_coordination;

DROP TABLE pr_coordination;

ALTER TABLE pr_coordination_new RENAME TO pr_coordination;
