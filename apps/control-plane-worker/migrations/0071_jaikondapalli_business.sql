-- Create the jaikondapalli business ahead of adding jaikondapalli to auth constants.
-- Must exist before jaikondapalli logs in (FK constraint on users.business_id).
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-jaikondapalli', 'jaikondapalli', 1, unixepoch() * 1000, unixepoch() * 1000);
