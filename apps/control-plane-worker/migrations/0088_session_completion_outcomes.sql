ALTER TABLE session_completions ADD COLUMN pr_outcome TEXT;
ALTER TABLE session_completions ADD COLUMN pr_outcome_at INTEGER;
ALTER TABLE session_completions ADD COLUMN first_pass_passed INTEGER;
ALTER TABLE session_completions ADD COLUMN review_thread_count INTEGER;
ALTER TABLE session_completions ADD COLUMN followup_commit_count INTEGER;
ALTER TABLE session_completions ADD COLUMN ci_first_run_status TEXT;
