-- Session-deduped outcome attribution (one row per session, the harm-truth layer).
-- Unlike prompt_runs (one noisy row per prompt-run, inflated by retries), this records
-- exactly ONE attributed outcome per session at the terminal close convergence point so
-- "did the session reach its intended terminal (PR/answer)?" is a single GROUP BY, not a
-- multi-turn investigation. PRIMARY KEY(session_id) makes the dedup structural.
CREATE TABLE IF NOT EXISTS session_outcomes (
  session_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  business_id TEXT,
  repo TEXT,
  session_kind TEXT,
  -- 'succeeded' | 'failed' | 'abandoned'. Only 'failed' counts as user harm; 'abandoned'
  -- (no work attempted / user walked away before any failure) is excluded from the denominator.
  outcome TEXT NOT NULL,
  -- 1 if the session reached a PR or a completed answer, else 0.
  reached_terminal INTEGER NOT NULL,
  -- pr_created | prompt_completed_no_pr | prompt_failed | queued_unprocessed | no_prompts
  terminal_stage TEXT NOT NULL,
  -- Single attributed ErrorCode (precedence-deduped across the session's prompts, falling
  -- back to the close reason). NULL unless outcome = 'failed'.
  failure_cause TEXT,
  close_reason TEXT,
  pr_created INTEGER NOT NULL,
  prompt_count INTEGER NOT NULL,
  completed_prompt_count INTEGER NOT NULL,
  failed_prompt_count INTEGER NOT NULL,
  -- Session created_at and close time, both unix epoch ms (matches prompt_runs).
  created_at INTEGER,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_outcomes_recorded ON session_outcomes(recorded_at);
CREATE INDEX IF NOT EXISTS idx_session_outcomes_outcome_cause ON session_outcomes(outcome, failure_cause);
CREATE INDEX IF NOT EXISTS idx_session_outcomes_business ON session_outcomes(business_id);
CREATE INDEX IF NOT EXISTS idx_session_outcomes_owner ON session_outcomes(owner_user_id);
