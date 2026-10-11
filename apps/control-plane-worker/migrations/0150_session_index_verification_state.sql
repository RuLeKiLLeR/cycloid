ALTER TABLE session_index ADD COLUMN verification_state TEXT;
ALTER TABLE session_index ADD COLUMN verification_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_index ADD COLUMN verification_max_attempts INTEGER NOT NULL DEFAULT 3;
