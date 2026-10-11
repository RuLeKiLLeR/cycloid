-- last_used_at was write-only dead data; the per-request UPDATE inflated D1 p95.
-- Code references were removed before this destructive migration. The column is not indexed.
ALTER TABLE impersonation_sessions DROP COLUMN last_used_at;
