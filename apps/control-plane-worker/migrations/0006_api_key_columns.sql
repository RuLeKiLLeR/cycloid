ALTER TABLE users ADD COLUMN anthropic_api_key TEXT;
ALTER TABLE users ADD COLUMN openai_api_key TEXT;
ALTER TABLE users ADD COLUMN linear_refresh_token TEXT;
ALTER TABLE users ADD COLUMN linear_token_expires_at INTEGER;
