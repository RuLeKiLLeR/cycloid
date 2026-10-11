-- Dedupe for the PR-merged Slack thread reply. `notifySlackPrMerged` posts with
-- no claim and has three unreconciled triggers (GitHub `pull_request closed`
-- webhook, review-loop cron sweep, self-induced redelivery), so the merge notice
-- could double-post. Completion/failure notices already dedupe via `slack_posts`,
-- but that table's `prompt_id` is NOT NULL and PR-merge is PR-scoped, not
-- prompt-scoped: there is no natural prompt_id to key on. Key on the PR instead.
--
-- Claim-before-post: insert the marker, post only when the insert won the
-- UNIQUE(session_id, pr_url) race, and delete the marker on a Slack-post failure
-- so one transient error does not permanently suppress the notice (mirrors the
-- completion/failure delete-marker-before-retry path). Timestamps are INTEGER
-- Unix milliseconds.
CREATE TABLE IF NOT EXISTS slack_pr_merged_posts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  pr_url TEXT NOT NULL,
  channel TEXT,
  message_ts TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, pr_url)
);
