CREATE INDEX IF NOT EXISTS idx_session_index_owner_created
  ON session_index(owner_user_id, created_at DESC, session_id DESC);

CREATE INDEX IF NOT EXISTS idx_session_index_business_created
  ON session_index(business_id, created_at DESC, session_id DESC);

CREATE INDEX IF NOT EXISTS idx_session_index_status_created
  ON session_index(status, created_at DESC, session_id DESC);
