ALTER TABLE session_index ADD COLUMN qa_testing_state TEXT;
ALTER TABLE session_index ADD COLUMN qa_testing_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_index ADD COLUMN qa_testing_max_attempts INTEGER NOT NULL DEFAULT 3;

UPDATE session_index
SET qa_testing_state = CASE verification_state
  WHEN 'verification-pending' THEN 'qa-pending'
  WHEN 'verification-in-progress' THEN 'qa-in-progress'
  WHEN 'verification-done' THEN 'qa-done'
  WHEN 'verification-skipped' THEN 'qa-skipped'
  WHEN 'verification-stopped' THEN 'qa-stopped'
  WHEN 'verification-exhausted' THEN 'qa-exhausted'
  ELSE qa_testing_state
END
WHERE qa_testing_state IS NULL AND verification_state IS NOT NULL;

UPDATE session_index
SET qa_testing_attempt_count = verification_attempt_count
WHERE verification_attempt_count IS NOT NULL;

UPDATE session_index
SET qa_testing_max_attempts = verification_max_attempts
WHERE verification_max_attempts IS NOT NULL;
