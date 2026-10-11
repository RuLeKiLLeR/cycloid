-- session_kind was benchmark-only; every session is now "repo". The [1/7]-[7/7]
-- benchmark-deprecation stack removed all readers and writers of this D1 column
-- (DAO in db.ts, observability.ts, phase-metrics.ts) and dropped the matching
-- SessionDO SQLite columns, but the D1 session_index column was left behind.
-- Drop the dead column now that no deployed code reads or writes it. The column
-- is not indexed. session_outcomes.session_kind is intentionally retained as
-- historical outcome metadata and is out of scope here.
ALTER TABLE session_index DROP COLUMN session_kind;
