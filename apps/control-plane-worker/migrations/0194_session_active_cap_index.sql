-- Supporting index for the per-business active-session cap enforced at
-- `POST /api/sessions` admission (A2). The cap counts active (non-closed,
-- non-archived) sessions for a business:
--
--   SELECT COUNT(*) FROM session_index
--   WHERE business_id = ? AND status NOT IN ('closed', 'archived')
--
-- The existing idx_session_index_business_updated (business_id, updated_at, ...)
-- can satisfy the business_id prefix but not the status filter, forcing a scan of
-- every session a business has ever created. This index lets the admission count
-- resolve from the (business_id, status) prefix on the hot create path.
CREATE INDEX IF NOT EXISTS idx_session_index_business_status
  ON session_index(business_id, status);
