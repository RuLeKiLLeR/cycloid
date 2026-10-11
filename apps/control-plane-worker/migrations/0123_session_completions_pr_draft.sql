-- Track whether the PR opened for a completion is a draft, so the session list
-- can render a "Draft" pill instead of the green "PR" pill.
ALTER TABLE session_completions ADD COLUMN pr_draft INTEGER;
