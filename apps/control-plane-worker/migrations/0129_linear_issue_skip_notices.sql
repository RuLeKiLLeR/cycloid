-- Tracks that Arcanist has already left a skip-notice comment on a Linear issue
-- for a given skip reason. A single label-add fires several webhook deliveries,
-- so this marker guarantees at most one comment per (issue, reason).
CREATE TABLE IF NOT EXISTS linear_issue_skip_notices (
  linear_issue_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (linear_issue_id, reason)
);
