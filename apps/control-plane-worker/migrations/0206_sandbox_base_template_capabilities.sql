-- Records which agent runtime backends (codex/claude_code/opencode) a registered
-- E2B base template image advertises. NULL = legacy row registered before this column
-- existed; such rows are treated as advertising no opt-in backends, so the opencode
-- spawn preflight fails closed against them.
ALTER TABLE sandbox_base_templates ADD COLUMN capabilities TEXT;
