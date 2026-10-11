-- Add pr_url to session_completions so similar session context can link to the PR.
ALTER TABLE session_completions ADD COLUMN pr_url TEXT;
