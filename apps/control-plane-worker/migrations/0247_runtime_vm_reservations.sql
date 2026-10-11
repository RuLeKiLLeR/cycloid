-- Pre-create VM reservation trace (ARC-1477). A row is INSERTed as 'pending'
-- BEFORE every provider vms.create call in the spawn path, then resolved to
-- 'created' (with the provider VM id) once the create response lands, or to
-- 'failed' / 'possible_orphan' when the create throws. A 'possible_orphan'
-- row — or a 'pending' row that never resolved (DO death mid-create) — is the
-- only durable evidence of a VM whose create response was lost: Freestyle's
-- vms.list() carries no metadata, so an id-less VM is otherwise unrecoverable
-- and leaks forever on the shared account.
--
-- One row per attempted create call (synthetic PK), NOT one per session or
-- spawn attempt: a DO crash-replay that re-runs a create gets a fresh row,
-- and the abandoned row remains as evidence of the earlier in-flight VM.
--
-- Consumed by the alert-only Freestyle VM audit (freestyle-vm-audit.ts).
-- Never feeds a kill path — deleting unregistered VMs is gated on ARC-1399
-- env isolation. After manually deleting a flagged VM in the Freestyle
-- dashboard, silence its row by setting outcome = 'reconciled'.
CREATE TABLE IF NOT EXISTS runtime_vm_reservations (
  reservation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  spawn_attempt_id TEXT,
  attempt INTEGER,
  runtime_backend TEXT NOT NULL,
  vm_name TEXT,
  runtime_sandbox_id TEXT,
  -- 'pending' | 'created' | 'failed' | 'possible_orphan' | 'reconciled'
  outcome TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_vm_reservations_backend_outcome
  ON runtime_vm_reservations (runtime_backend, outcome, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_vm_reservations_session
  ON runtime_vm_reservations (session_id);
