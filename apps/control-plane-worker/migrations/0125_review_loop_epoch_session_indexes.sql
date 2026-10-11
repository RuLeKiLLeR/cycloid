-- Perf-only, append-only indexes for pr_review_response_epochs hot paths.
-- No data or schema-shape change; behavior is identical, queries just stop full-scanning.

-- Session-scoped lookups all lead with (session_id, pr_url[, head_sha]):
-- hasReviewLoopEpochForHead, getLatestReviewLoopEpochForPr, getMaxEpochWaveForSession,
-- selectLatestEpochForHead, countConsecutiveCiFixEpochsForPr, hasCiAttemptCapEscalationForHead,
-- and the head-change stale sweep. The existing indexes lead with status / owner_user_id, so these
-- session-scoped reads full-scan today. An index leading with session_id serves them all.
CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_session
  ON pr_review_response_epochs(session_id, pr_url, head_sha);

-- listCollectingReviewLoopEpochs runs on every reconcile tick:
--   WHERE status = 'collecting' AND fallback_after_at > ?
--   ORDER BY updated_at ASC, fallback_after_at ASC, id ASC
-- The (status, fallback_after_at) index serves the WHERE but cannot satisfy the ORDER BY (it leads
-- with updated_at), forcing a filesort. This index matches the WHERE-equality + full ORDER BY so the
-- collecting-poll path is served from the index without materialize-and-sort. Ordering is unchanged.
CREATE INDEX IF NOT EXISTS idx_pr_review_response_epochs_collecting_poll
  ON pr_review_response_epochs(status, updated_at, fallback_after_at, id);
