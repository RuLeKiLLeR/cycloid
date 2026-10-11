-- Per-prompt completion records for similar session search.
-- Each row captures the prompt, diff summary, and metadata when a prompt completes successfully.
-- Used to find prior approaches to similar tasks and inject them as agent context.
CREATE TABLE IF NOT EXISTS session_completions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  title TEXT,
  diff_summary TEXT,
  branch TEXT,
  commit_sha TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_completions_prompt
  ON session_completions (session_id, prompt_id);

CREATE INDEX IF NOT EXISTS idx_session_completions_repo
  ON session_completions (owner_user_id, repo_owner, repo_name, success, completed_at DESC);
