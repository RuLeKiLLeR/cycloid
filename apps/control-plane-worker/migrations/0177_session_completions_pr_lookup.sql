CREATE INDEX IF NOT EXISTS idx_session_completions_pr_lookup ON session_completions (session_id, completed_at DESC) WHERE pr_url IS NOT NULL;
