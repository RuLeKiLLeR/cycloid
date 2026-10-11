-- Review-listening sweep rotation watermark: the reconcile sweep pages refs
-- least-recently-swept first and bumps this on every visit, so refs the sweep
-- can never act on cannot pin the queue head and starve newer sessions out of
-- the per-tick budget.
ALTER TABLE session_webhook_refs ADD COLUMN review_loop_swept_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_session_webhook_refs_review_loop_sweep
  ON session_webhook_refs(source, review_loop_swept_at);
