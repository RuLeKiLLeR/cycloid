-- ARC-1012: lease-based self-heal for warm_sandbox_pool_entries claims.
--
-- Before: a crash between `claimReadyWarmSandboxPoolEntry` (status='claimed')
-- and the session DO attaching the runtime left the row claimed forever,
-- draining the pool.
--
-- After: every claim sets claim_expires_at; every subsequent claim attempt
-- first reclaims expired rows back to 'ready'. Successful attach + explicit
-- failure-marking clear the column.
ALTER TABLE warm_sandbox_pool_entries ADD COLUMN claim_expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_warm_sandbox_pool_entries_claim_expires_at
  ON warm_sandbox_pool_entries(status, claim_expires_at)
  WHERE status = 'claimed' AND claim_expires_at IS NOT NULL;
