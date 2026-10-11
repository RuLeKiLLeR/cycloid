-- ARC-1330 lifecycle FSM — the single per-session coordination record.
-- One row per session (PK session_id), created at genesis and carried through
-- the whole post-PR lifecycle. `version` is the single-writer CAS token
-- (every applyEvent CAS bumps it). Pure substrate: no code reads or writes this
-- table yet (shadow, additive — FSM_MODE wiring lands in a later wave).
--
-- TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
-- The verification-named columns below (verdict, verdict_head_sha,
-- verification_run_head, verification_run_id, verification_child_id,
-- verification_run_count, code_changed_since_verification) map from the design's
-- conceptual `qa_*` vocabulary; the verification→qa rename is out of scope here.
CREATE TABLE IF NOT EXISTS pr_coordination (
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
