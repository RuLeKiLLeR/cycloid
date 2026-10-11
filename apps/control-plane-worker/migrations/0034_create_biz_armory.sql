-- Create the Armory business ahead of adding Armory users to auth constants.
-- Must exist before any Armory user logs in (FK constraint on users.business_id).
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES ('biz-armory', 'Armory', 1, unixepoch() * 1000, unixepoch() * 1000);
