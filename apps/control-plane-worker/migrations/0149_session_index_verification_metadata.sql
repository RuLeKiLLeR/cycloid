ALTER TABLE session_index ADD COLUMN agent_role TEXT;
ALTER TABLE session_index ADD COLUMN target_pr_url TEXT;
CREATE INDEX IF NOT EXISTS idx_session_index_verification_target_pr
  ON session_index(agent_role, target_pr_url)
  WHERE agent_role = 'verification' AND target_pr_url IS NOT NULL;
