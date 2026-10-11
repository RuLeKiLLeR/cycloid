-- ARC-1271 re-land (replaces reverted #5265 comment table): one "PR progress" stage region per pull
-- request, rendered as a managed region in the PR BODY (not a comment). Keyed per-PR (pr_url); a single
-- region is shared across every session that touches the PR. `owning_session_id` is the publishing
-- session whose state the region is rendered from. The row is seeded ONLY by the publish path (a PR
-- Arcanist opens) — the sweep/verification hooks are update-only — so the region never backfills onto
-- pre-existing or foreign PRs (the bug that reverted #5265). The region itself is located by HTML-comment
-- markers in the body; this table only tracks ownership + the last rendered region hash.
CREATE TABLE IF NOT EXISTS pr_stage_regions (
  pr_url TEXT PRIMARY KEY,
  owning_session_id TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  last_rendered_body_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
