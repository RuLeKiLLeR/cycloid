-- Durable, self-contained capture log of the GitHub PR conversation for PRs
-- Arcanist tracks. One append-only row per received webhook event (comment,
-- review, inline review comment, PR title/body + state change). Lets the full
-- post-deploy history of a tracked PR be reconstructed from D1 alone after we
-- lose access to the customer's repo/PR (app uninstall, offboarding, deleted
-- repo, revoked scopes) -- when the live GitHub fetch path returns nothing.
--
-- Written at the webhook ingest seam (src/webhooks/pr-activity-capture.ts),
-- BEFORE the review-loop allow-list/actionable filters, gated on an existing
-- pr_coordination row for the pr_url (Arcanist tracks the PR) -- so it never
-- stores content for PRs Arcanist has nothing to do with.
--
-- Ownership/offboarding: session_id is the canonical coordinating session; the
-- table registers in OFFBOARDING_SESSION_ID_TABLES (offboarding-tables.ts) like
-- the rest of the PR-lifecycle family (pr_coordination, pr_review_item_dispositions,
-- session_pr_metadata). Unlike managed_pr_comments (SKIPPED_TABLES, hash-only),
-- this table holds user-content bodies, so it MUST be offboarded, not skipped.
--
-- Two identities per row: actor_* is the ACTION actor (payload.sender -- who
-- edited/deleted/dismissed/submitted), subject_author_* is the CONTENT author
-- (comment.user / review.user / PR author). Edits/deletes land as their own
-- append-only rows (distinct delivery_id) -- not last-write-wins.
--
-- All timestamps are unix-ms integers (docs/database.md). github_created_at /
-- github_updated_at are Date.parse(iso); occurred_at is the action-time used for
-- ordering; the raw ISO strings are preserved inside raw_json. body / diff_hunk /
-- raw_json are secret-redacted and size-capped by the builder. event_type /
-- action / review_state / actor_* stay code-validated with NO CHECK constraints
-- (SQLite constraint changes force full-table rebuilds; keep evolvable enum
-- columns constraint-free).
CREATE TABLE IF NOT EXISTS pr_activity_events (
  id INTEGER PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_url TEXT NOT NULL,
  installation_id INTEGER,
  event_type TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  in_reply_to_id TEXT,
  review_state TEXT,
  actor_login TEXT,
  actor_type TEXT,
  actor_class TEXT,
  subject_author_login TEXT,
  subject_author_type TEXT,
  body TEXT,
  file_path TEXT,
  line INTEGER,
  side TEXT,
  diff_hunk TEXT,
  head_sha TEXT,
  github_created_at INTEGER,
  github_updated_at INTEGER,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL
);

-- Idempotency anchor: one row per GitHub delivery. Redelivery (auto-retry after a
-- transient failure) is a no-op via INSERT ... ON CONFLICT(delivery_id) DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_activity_events_delivery
ON pr_activity_events (delivery_id);

-- Serves the list-by-PR reconstruction query (ORDER BY occurred_at, id).
CREATE INDEX IF NOT EXISTS idx_pr_activity_events_pr
ON pr_activity_events (repo_owner, repo_name, pr_number, occurred_at, id);

-- Serves the offboarding delete/export cascade (by session_id).
CREATE INDEX IF NOT EXISTS idx_pr_activity_events_session
ON pr_activity_events (session_id);
