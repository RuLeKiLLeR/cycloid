-- Per-PR mergeability handling attempts for the review-loop reconcile path, keyed by
-- (session_id, pr_url, head_sha). Drives the update-branch cooldown (last_attempt_at) and the
-- attempt cap for repeated behind/dirty/null mergeable states. The epoch attempt_count is per
-- claimed epoch and unreachable from reconcile (which has no claimed epoch), so this is tracked
-- separately. Timestamps are Unix milliseconds.
CREATE TABLE IF NOT EXISTS pr_mergeability_attempts (
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url, head_sha)
);
