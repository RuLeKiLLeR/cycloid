-- ARC-1226: carry budget-dropped review-loop worklist items forward instead of losing them.
-- getPrReviewLoopWorklist drops feedback items past the 64KB total body budget; those sourceIds were
-- previously discarded (only counted), so the epoch settled `completed` with reviewer feedback never
-- shown to the agent and the rollup could reach review-loop:done. This column records the dropped,
-- still-un-prompted sourceIds a dispatch owes the agent. While it is non-empty the settle paths
-- re-drive the epoch to `ready` (instead of `completed`) so the next sweep dispatches the carried tail
-- once the already-prompted items free up budget; the rollup keeps the epoch in flight, so
-- auto-verification cannot start on unaddressed feedback. Cleared (back to '[]') once the tail drains.
ALTER TABLE pr_review_response_epochs
  ADD COLUMN carried_forward_source_ids_json TEXT NOT NULL DEFAULT '[]';
