-- Drop the unused `name` column from cli_tokens.
-- The name field was removed from the UI and API in PR #1075.
ALTER TABLE cli_tokens DROP COLUMN name;
