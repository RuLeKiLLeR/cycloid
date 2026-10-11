-- Add missing indexes identified by D1 schema audit (ARC-267).
-- Each index covers a WHERE/ORDER BY pattern that was doing full table scans.

-- session_index: WHERE status = ? ORDER BY updated_at DESC  (session list filtered by status)
CREATE INDEX IF NOT EXISTS idx_session_index_status_updated ON session_index(status, updated_at DESC);

-- users: WHERE business_id = ?  (business member lookups, observability subquery)
CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id);

-- users: WHERE login = ?  (user-by-login lookup in member management)
CREATE INDEX IF NOT EXISTS idx_users_login ON users(login);

-- repo_images: WHERE status = ? AND created_at < ?  (stale build + failed image cleanup)
CREATE INDEX IF NOT EXISTS idx_repo_images_status_created ON repo_images(status, created_at);
