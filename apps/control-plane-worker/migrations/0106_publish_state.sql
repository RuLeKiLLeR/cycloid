ALTER TABLE session_index ADD COLUMN publish_status TEXT;
ALTER TABLE session_index ADD COLUMN publish_stage TEXT;
ALTER TABLE session_index ADD COLUMN publish_error TEXT;
ALTER TABLE session_index ADD COLUMN published_branch TEXT;
ALTER TABLE session_index ADD COLUMN publish_attempt INTEGER;
ALTER TABLE session_index ADD COLUMN publish_sequence INTEGER;
ALTER TABLE session_index ADD COLUMN pr_polish_status TEXT;
ALTER TABLE session_index ADD COLUMN pr_polish_error TEXT;
