-- Parent/child session relationship tracking for ARC-657.
-- Every child Arcanist session points back to its parent session and the
-- specific parent prompt that spawned it. spawn_depth is read on the parent
-- to enforce MAX_CHILD_SESSION_SPAWN_DEPTH.

ALTER TABLE session_index ADD COLUMN parent_session_id TEXT;
ALTER TABLE session_index ADD COLUMN parent_prompt_id TEXT;
ALTER TABLE session_index ADD COLUMN spawned_by_user_id INTEGER;
ALTER TABLE session_index ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_session_index_parent_session
  ON session_index(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_index_parent_prompt
  ON session_index(parent_session_id, parent_prompt_id)
  WHERE parent_session_id IS NOT NULL AND parent_prompt_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_index_spawned_by_user
  ON session_index(spawned_by_user_id, status)
  WHERE spawned_by_user_id IS NOT NULL;
