-- Tracks that Arcanist has already left a skip-notice comment on a Jira issue
-- for a given skip reason. Webhook retries or label re-adds can produce fresh
-- deliveries, so this marker guarantees at most one comment per (issue, reason).
CREATE TABLE IF NOT EXISTS jira_issue_skip_notices (
  jira_issue_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (jira_issue_id, reason)
);
