-- Create the detail-dev business ahead of adding drob to auth constants.
-- Must exist before drob logs in (FK constraint on users.business_id).
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-detail-dev', 'detail-dev', 1, unixepoch() * 1000, unixepoch() * 1000);
