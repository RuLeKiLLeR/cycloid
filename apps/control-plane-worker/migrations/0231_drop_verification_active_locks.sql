-- ARC-1330 Wave 11 D-51: drop the per-PR verification lock (ARC-1173).
-- The single-verifier admission boundary is now the FSM-native spawn idempotency
-- anchor (W11-V4: the committed pr_coordination row + stampVerificationChildId's
-- `verification_child_id IS NULL` first-writer-wins claim), so verification_active_locks
-- and its DAO (verification-lock-db.ts + the verification-gate.ts lock wrappers) are dead.
-- This also removes the ARC-1273 expired-lock death signal; the VERIFYING dwell deadline
-- (#6373) is the accepted backstop (see the E1 liveness gap, ARC-1273 -> ARC-1337).
-- All code references were removed before this destructive migration.
DROP TABLE IF EXISTS verification_active_locks;
