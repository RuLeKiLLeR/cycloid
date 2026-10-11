-- Store full analyzer suggestions (with rationale) in memory_pr_tracking.
-- Retains maximal data for learning/tuning even as the PR body format changes.
ALTER TABLE memory_pr_tracking ADD COLUMN suggestions_json TEXT;
