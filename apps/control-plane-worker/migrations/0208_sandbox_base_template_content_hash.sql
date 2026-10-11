-- Content hash of the rendered E2B base-template build payload. NULL means the
-- row predates hash-aware registration or was registered by an older deploy workflow.
ALTER TABLE sandbox_base_templates ADD COLUMN content_hash TEXT;
