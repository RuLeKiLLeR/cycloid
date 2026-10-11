-- Track model and reasoning effort at the session level (instead of per-prompt)
ALTER TABLE session_index ADD COLUMN model TEXT;
ALTER TABLE session_index ADD COLUMN reasoning_effort TEXT;
