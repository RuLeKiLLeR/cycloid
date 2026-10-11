-- ARC-1330 lifecycle FSM — append-only transition log for the per-session
-- `pr_coordination` record (migration 0212). One row per committed transition,
-- keyed by (session_id, version) so the CAS version that committed the
-- transition is the log offset. Pure substrate: no code reads or writes this
-- table yet (shadow, additive — FSM_MODE wiring lands in a later wave).
-- Observability-only; the spine never reads this to decide a transition.
--
-- TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
-- The `actor` value 'verification' is a kept verification-vocabulary site; it
-- maps from the design's conceptual `qa_*` vocabulary and the verification→qa
-- rename is out of scope here.
CREATE TABLE IF NOT EXISTS pr_coordination_events (
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  metadata TEXT,
  dwell_ms INTEGER,
  settle_dedup_key TEXT,
  PRIMARY KEY (session_id, version)
);
