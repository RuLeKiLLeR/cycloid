import { D1_RETRY_SAFE_MARKER, d1Changed } from "../db/errors";
import { FREESTYLE_RUNTIME_BACKEND, providerForRuntimeBackend, type RuntimeBackend } from "./runtime-backend";

/**
 * DAO for the `runtime_vm_reservations` pre-create trace table (migration
 * 0247, ARC-1477). One row per attempted provider `vms.create` call: INSERTed
 * 'pending' before the call, resolved to 'created' with the provider VM id on
 * success, or 'failed' / 'possible_orphan' on throw. Unresolved rows are the
 * only durable evidence of a VM whose create response was lost (Freestyle's
 * vms.list() has no metadata to recover it from). Consumed by the alert-only
 * Freestyle VM audit; nothing here may feed a kill path (ARC-1399 gate).
 */

export type VmReservationOutcome = "pending" | "created" | "failed" | "possible_orphan" | "reconciled";

export interface VmReservationRow {
  reservationId: string;
  sessionId: string;
  spawnAttemptId: string | null;
  attempt: number | null;
  runtimeBackend: string;
  vmName: string | null;
  runtimeSandboxId: string | null;
  outcome: VmReservationOutcome;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawVmReservationRow {
  reservation_id: string;
  session_id: string;
  spawn_attempt_id: string | null;
  attempt: number | null;
  runtime_backend: string;
  vm_name: string | null;
  runtime_sandbox_id: string | null;
  outcome: string;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: RawVmReservationRow): VmReservationRow {
  return {
    reservationId: String(row.reservation_id),
    sessionId: String(row.session_id),
    spawnAttemptId: row.spawn_attempt_id === null ? null : String(row.spawn_attempt_id),
    attempt: row.attempt === null ? null : Number(row.attempt),
    runtimeBackend: String(row.runtime_backend),
    vmName: row.vm_name === null ? null : String(row.vm_name),
    runtimeSandboxId: row.runtime_sandbox_id === null ? null : String(row.runtime_sandbox_id),
    outcome: (row.outcome as VmReservationOutcome) ?? "pending",
    errorCode: row.error_code === null ? null : String(row.error_code),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Write the pre-create trace row. Idempotent on the synthetic PK, so a D1
 * transient-error retry of the same insert is a no-op instead of a duplicate.
 */
export async function insertVmReservation(
  db: D1Database,
  params: {
    reservationId: string;
    sessionId: string;
    spawnAttemptId: string | null;
    attempt: number | null;
    runtimeBackend: RuntimeBackend;
    vmName: string | null;
    nowMs: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} INSERT INTO runtime_vm_reservations (
         reservation_id, session_id, spawn_attempt_id, attempt, runtime_backend,
         vm_name, runtime_sandbox_id, outcome, error_code, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)
       ON CONFLICT(reservation_id) DO NOTHING`,
    )
    .bind(
      params.reservationId,
      params.sessionId,
      params.spawnAttemptId,
      params.attempt,
      params.runtimeBackend,
      params.vmName,
      params.nowMs,
      params.nowMs,
    )
    .run();
  return d1Changed(result);
}

/**
 * CAS the pending row to 'created' with the provider VM id. Only transitions
 * a still-'pending' row, so a replayed update cannot clobber a later state.
 */
export async function markVmReservationCreated(
  db: D1Database,
  params: { reservationId: string; runtimeSandboxId: string; nowMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} UPDATE runtime_vm_reservations
       SET runtime_sandbox_id = ?, outcome = 'created', updated_at = ?
       WHERE reservation_id = ? AND outcome = 'pending'`,
    )
    .bind(params.runtimeSandboxId, params.nowMs, params.reservationId)
    .run();
  return d1Changed(result);
}

/**
 * CAS the pending row to a create-failure outcome: 'failed' when the provider
 * provably created no VM, 'possible_orphan' when a VM may exist server-side
 * with an id nobody received (the ARC-1477 leak evidence).
 */
export async function markVmReservationFailed(
  db: D1Database,
  params: {
    reservationId: string;
    outcome: "failed" | "possible_orphan";
    errorCode: string | null;
    nowMs: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} UPDATE runtime_vm_reservations
       SET outcome = ?, error_code = ?, updated_at = ?
       WHERE reservation_id = ? AND outcome = 'pending'`,
    )
    .bind(params.outcome, params.errorCode, params.nowMs, params.reservationId)
    .run();
  return d1Changed(result);
}

/**
 * Every provider VM id this environment has ever recorded creating for the
 * backend — the registry half of the audit's "unregistered VM" diff.
 */
export async function listReservedVmIdsForBackend(db: D1Database, backend: RuntimeBackend): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT runtime_sandbox_id FROM runtime_vm_reservations
       WHERE runtime_backend = ? AND runtime_sandbox_id IS NOT NULL`,
    )
    .bind(backend)
    .all<{ runtime_sandbox_id: string }>();
  return (rows.results ?? []).map((row) => String(row.runtime_sandbox_id));
}

/**
 * Belt-and-braces registry leg: current session_index projections for the
 * backend. Covers VMs created before the reservation table existed (a
 * reservation-only registry would flag every pre-migration live VM). Keys on
 * runtime_backend — the single source of truth — OR the derived
 * runtime_provider, so legacy pre-derive rows (runtime_provider='e2b' with
 * runtime_backend='freestyle') still register their live VMs instead of the
 * audit false-flagging them as unregistered.
 */
export async function listSessionIndexVmIdsForBackend(db: D1Database, backend: RuntimeBackend): Promise<string[]> {
  const provider = providerForRuntimeBackend(backend);
  const rows = await db
    .prepare(
      `SELECT DISTINCT runtime_sandbox_id FROM session_index
       WHERE (runtime_backend = ? OR runtime_provider = ?) AND runtime_sandbox_id IS NOT NULL`,
    )
    .bind(backend, provider)
    .all<{ runtime_sandbox_id: string }>();
  return (rows.results ?? []).map((row) => String(row.runtime_sandbox_id));
}

/**
 * Freestyle reservations that never resolved to a VM id: explicit
 * 'possible_orphan' rows plus 'pending' rows older than the cutoff (a DO that
 * died mid-create never runs the failure CAS). Excludes 'reconciled' rows so
 * a manually cleaned-up orphan stops alerting.
 */
export async function listUnresolvedFreestyleReservations(
  db: D1Database,
  params: { pendingBeforeMs: number; limit: number },
): Promise<VmReservationRow[]> {
  const rows = await db
    .prepare(
      `SELECT reservation_id, session_id, spawn_attempt_id, attempt, runtime_backend,
              vm_name, runtime_sandbox_id, outcome, error_code, created_at, updated_at
       FROM runtime_vm_reservations
       WHERE runtime_backend = ?
         AND (outcome = 'possible_orphan' OR (outcome = 'pending' AND created_at < ?))
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(FREESTYLE_RUNTIME_BACKEND, params.pendingBeforeMs, params.limit)
    .all<RawVmReservationRow>();
  return (rows.results ?? []).map(mapRow);
}

// Max VM ids bound into one IN (...) statement. D1 caps bind parameters at 100
// per statement; 80 leaves headroom for the non-id binds. Callers' id sets are
// bounded by the live fleet size, so the chunk loop stays small.
const MAX_AUDIT_VM_ID_BINDINGS = 80;

/**
 * A 'created' reservation whose session projection moved on, cleared, or
 * vanished — the VM id no sweep can see. The reservation still holds the
 * provider VM id, but `session_index` either no longer projects it (a later
 * attempt overwrote the id), projects NULL (the row was cleared), or is gone
 * entirely; either way no `session_index`-driven sweep can find that VM. LEFT
 * JOIN so cleared/missing projections classify too.
 *
 * Driven FROM the caller's live VM id set (`vmIds` — the account's non-deleted
 * VMs): dead 'created' reservations whose VM is already terminated accumulate
 * forever (nothing reconciles them on terminate), so a reservation-side row
 * LIMIT would eventually fill with dead rows and false-zero a real leak. The
 * IN-list inversion makes the result exact by construction, bounded by fleet
 * size. `createdBeforeMs` excludes brand-new reservations: a sweep can land
 * between markVmReservationCreated and the projection attach on a healthy
 * spawn. Alert-only consumer.
 */
export async function listSupersededCreatedReservations(
  db: D1Database,
  backend: RuntimeBackend,
  params: { vmIds: string[]; createdBeforeMs: number },
): Promise<VmReservationRow[]> {
  const uniqueIds = [...new Set(params.vmIds)].filter((id) => id.length > 0);
  const out: VmReservationRow[] = [];
  for (let index = 0; index < uniqueIds.length; index += MAX_AUDIT_VM_ID_BINDINGS) {
    const chunk = uniqueIds.slice(index, index + MAX_AUDIT_VM_ID_BINDINGS);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT r.reservation_id, r.session_id, r.spawn_attempt_id, r.attempt, r.runtime_backend,
                r.vm_name, r.runtime_sandbox_id, r.outcome, r.error_code, r.created_at, r.updated_at
         FROM runtime_vm_reservations r
         LEFT JOIN session_index s ON s.session_id = r.session_id
         WHERE r.runtime_backend = ?
           AND r.outcome = 'created'
           AND r.runtime_sandbox_id IN (${placeholders})
           AND r.created_at < ?
           AND (s.session_id IS NULL OR s.runtime_sandbox_id IS NULL OR s.runtime_sandbox_id <> r.runtime_sandbox_id)
         ORDER BY r.created_at ASC`,
      )
      .bind(backend, ...chunk, params.createdBeforeMs)
      .all<RawVmReservationRow>();
    out.push(...(rows.results ?? []).map(mapRow));
  }
  return out;
}

export interface KilledRowVm {
  sessionId: string;
  runtimeSandboxId: string;
  runtimeStateExpiresAt: number | null;
}

interface RawKilledRowVm {
  session_id: string;
  runtime_sandbox_id: string;
  runtime_state_expires_at: number | null;
}

/**
 * `session_index` rows still parked in `runtime_state='killed'` past the kill
 * grace window, with a live VM id the R2 cleanup sweep should have reclaimed.
 * Backend-OR-provider skew tolerance mirrors `listSessionIndexVmIdsForBackend`
 * so a legacy pre-derive row (runtime_provider='e2b' with
 * runtime_backend='freestyle') still classifies. Driven FROM the caller's live
 * VM id set (`vmIds`) so the result is exact by construction, bounded by fleet
 * size. `killedBeforeMs` is bound to the SAME grace the R2 sweep graces
 * (KILLED_RUNTIME_REAP_GRACE_MS), so the audit never alerts on the
 * alive-while-killed churn window R2 deliberately ignores; the grace compares
 * `COALESCE(runtime_state_expires_at, updated_at)` — mirroring the sweep — so
 * a killed row that never got its kill timestamp stamped is not invisible.
 * Alert-only consumer.
 */
export async function listKilledRowVms(
  db: D1Database,
  backend: RuntimeBackend,
  params: { vmIds: string[]; killedBeforeMs: number },
): Promise<KilledRowVm[]> {
  const provider = providerForRuntimeBackend(backend);
  const uniqueIds = [...new Set(params.vmIds)].filter((id) => id.length > 0);
  const out: KilledRowVm[] = [];
  for (let index = 0; index < uniqueIds.length; index += MAX_AUDIT_VM_ID_BINDINGS) {
    const chunk = uniqueIds.slice(index, index + MAX_AUDIT_VM_ID_BINDINGS);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT session_id, runtime_sandbox_id, runtime_state_expires_at
         FROM session_index
         WHERE (runtime_backend = ? OR runtime_provider = ?)
           AND runtime_state = 'killed'
           AND runtime_sandbox_id IN (${placeholders})
           AND COALESCE(runtime_state_expires_at, updated_at) < ?
         ORDER BY COALESCE(runtime_state_expires_at, updated_at) ASC`,
      )
      .bind(backend, provider, ...chunk, params.killedBeforeMs)
      .all<RawKilledRowVm>();
    out.push(
      ...(rows.results ?? []).map((row) => ({
        sessionId: String(row.session_id),
        runtimeSandboxId: String(row.runtime_sandbox_id),
        runtimeStateExpiresAt: row.runtime_state_expires_at === null ? null : Number(row.runtime_state_expires_at),
      })),
    );
  }
  return out;
}
