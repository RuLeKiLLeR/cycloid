-- Track which review-loop source ids were actually included in a sent prompt.
-- Carry-forward invariant: a source id is "done" only once it has been prompted. Ids that were
-- ingested into an epoch but never prompted -- a late human review folded into an epoch whose
-- prompt was already in flight, or an epoch blocked by a head change before it ever dispatched --
-- are NOT done and must flow into the next epoch instead of being silently stranded as "handled".
-- listKnownReviewLoopSourceIds keys off this column (plus the triggering ids of still-live epochs)
-- so unprompted feedback on a blocked epoch re-triggers a fresh epoch on the current head.
ALTER TABLE pr_review_response_epochs
  ADD COLUMN prompted_source_ids_json TEXT NOT NULL DEFAULT '[]';

-- Backfill prompted ids for pre-existing BLOCKED rows that had already dispatched a prompt
-- (last_prompt_id set, e.g. an epoch later blocked by a head change). Without this, the new
-- listKnownReviewLoopSourceIds — which counts only prompted ids for blocked rows — would forget
-- that their feedback was already addressed and let head reconciliation reopen it as new work.
-- triggering and handled are written together and stay identical, so triggering is the addressed
-- set. Blocked rows with NO prompt (last_prompt_id IS NULL) are intentionally left empty: they were
-- never put in front of the agent, so they SHOULD carry forward (the bug this migration fixes).
UPDATE pr_review_response_epochs
   SET prompted_source_ids_json = triggering_source_ids_json
 WHERE status = 'blocked' AND last_prompt_id IS NOT NULL;
