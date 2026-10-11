-- ARC-1271: one top-level "PR progress" status comment per pull request, listing the lifecycle
-- stages (PR opened -> CI -> verification -> addressing feedback -> ready to merge) with the current
-- stage marked. Keyed per-PR (pr_url) so a single comment is shared across every session that touches
-- the PR; `owning_session_id` is the publishing session whose state the comment is rendered from.
-- Mirrors pr_review_status_comments (migration 0120): github_comment_id + last_rendered_body_hash for
-- idempotent edits and posting_lease_until as the create-path lease (the review-loop table
-- also uses this column for the edit-path lease) that survives the cross-session
-- webhook fan-out without posting duplicates.
CREATE TABLE IF NOT EXISTS pr_stage_comments (
  pr_url TEXT PRIMARY KEY,
  owning_session_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  github_comment_id INTEGER,
  last_rendered_body_hash TEXT,
  posting_lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
