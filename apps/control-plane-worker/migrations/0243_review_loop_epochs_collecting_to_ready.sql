-- Drain legacy 'collecting' review-loop epochs to 'ready'.
--
-- Number re-checked vs origin/main at merge time (0242 is held by the unmerged
-- auto-verify migration in the sibling stack).
--
-- Walltime removal (B-stack) deleted the 'collecting' due-selection/claim arms:
-- listDueReviewLoopEpochs and claimReviewLoopEpochForPrompt now only accept
-- status = 'ready' (or an expired 'reserving' lease). Fresh inserts already land
-- as 'ready' (statusForObserved returns 'ready' on insert), so no new
-- 'collecting' rows are created. But rows written as 'collecting' before the
-- B-stack are stranded: they are never selected as due and never claimable, and
-- only self-heal if a further webhook/poll happens to fold new activity in
-- (statusForObserved flips existing 'collecting' -> 'ready'). This one-shot data
-- fix drains the stranded rows so the next sweep dispatches them immediately.
--
-- fallback_after_at is intentionally left untouched: due-selection and the claim
-- CAS gate only on status, so status = 'ready' alone makes each row immediately
-- due and claimable.
UPDATE pr_review_response_epochs
SET status = 'ready'
WHERE status = 'collecting';
