-- Server-side sandbox termination reason (SandboxTerminateReason) attributed to the
-- session at the close convergence point. Distinct from failure_cause (an ErrorCode):
-- kill reasons like 'orphan_reaper' / 'runtime_cleanup' are NOT ErrorCodes, so they get
-- their own column instead of being overloaded onto failure_cause/close_reason.
-- NULL for historical/backfill rows and until the server-side producer threads a reason
-- into the close boundary. ADD COLUMN is not idempotent in SQLite; the migration runner
-- skips duplicate-column errors, so keep this as a single add-column statement.
ALTER TABLE session_outcomes ADD COLUMN termination_reason TEXT;
