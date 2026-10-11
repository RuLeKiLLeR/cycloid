-- ARC-1330 Wave 11 D-52: drop the per-head auto-verification claim table
-- (verification_session_requests, migration 0140) and its 2 indexes.
-- The single-verifier admission boundary is now the FSM-native spawn idempotency
-- anchor (W11-V4: the committed pr_coordination row + stampVerificationChildId's
-- `verification_child_id IS NULL` first-writer-wins claim). D-51 already removed the
-- per-PR verification lock; this removes the last legacy dedup belt, so the scheduler
-- (verification-spawn.ts) and its DAO (verification-scheduler-db.ts) no longer touch
-- this table. ACCEPTED COST: the anchor's pre-spawn read is a non-atomic fast-path, so
-- a truly-concurrent spawn window can create a SECOND verifier session — single
-- recorded verdict (the loser fails run-scoped freshness once the record leaves
-- VERIFYING), no cap burn, extra session parks per #6310.
-- All code references were removed before this destructive migration.
DROP INDEX IF EXISTS idx_verification_session_requests_session;
DROP INDEX IF EXISTS idx_verification_session_requests_parent;
DROP TABLE IF EXISTS verification_session_requests;
