-- Covering index for child-session lookups by parent.
-- getChildSessionIdsForParent, LIST_CHILDREN_SQL, and LIST_CHILDREN_WITH_PR_URL_SQL
-- all filter `parent_session_id = ? AND business_id IS ?` and sort `created_at DESC`.
-- The pre-existing partial index idx_session_index_parent_session seeks on
-- parent_session_id but forces a temp b-tree sort for ORDER BY and post-filters
-- business_id. This composite index serves the full WHERE + ORDER BY in one seek;
-- trailing session_id makes the session_id-only query fully covering (session_id is
-- a TEXT PRIMARY KEY, not a rowid alias, so it does not otherwise ride along).
-- Partial on `parent_session_id IS NOT NULL`: every caller filters
-- `parent_session_id = ?` (never matches NULL), so root-session rows can never be
-- served by this index; excluding them keeps it trimmed. SQLite still uses the
-- index for `parent_session_id = ?` (which implies NOT NULL) and stays covering.
CREATE INDEX IF NOT EXISTS idx_session_index_parent_business_created
  ON session_index(parent_session_id, business_id, created_at DESC, session_id)
  WHERE parent_session_id IS NOT NULL;
