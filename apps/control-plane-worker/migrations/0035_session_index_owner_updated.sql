-- Speed up session list queries by indexing owner + sort order
CREATE INDEX IF NOT EXISTS idx_session_index_owner_updated
  ON session_index(owner_user_id, updated_at DESC);
