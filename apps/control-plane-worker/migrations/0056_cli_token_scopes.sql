ALTER TABLE cli_tokens
ADD COLUMN scope TEXT NOT NULL DEFAULT 'read' CHECK(scope IN ('read', 'write'));
