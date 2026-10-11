-- Unix-ms when our own server-side update-branch actually QUEUED for a (session_id, pr_url, head_sha),
-- or NULL if it never did. The review-loop head-change carry-forward gate keys on this column. See
-- reconcileReviewLoopEpochsForHeadChange (review-loop-head-change.ts) for why a bare attempt row is
-- not sufficient proof (ARC-1302).
ALTER TABLE pr_mergeability_attempts ADD COLUMN update_branch_queued_at INTEGER;
