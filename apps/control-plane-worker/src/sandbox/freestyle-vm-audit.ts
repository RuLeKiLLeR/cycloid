import { createLogger, type Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { KILLED_RUNTIME_REAP_GRACE_MS } from "../session/cleanup";
import type { Env } from "../types";
import { type FreestyleAuditVm, FreestyleSandboxClient } from "./freestyle-client";
import { FREESTYLE_RUNTIME_BACKEND } from "./runtime-backend";
import {
  listKilledRowVms,
  listReservedVmIdsForBackend,
  listSessionIndexVmIdsForBackend,
  listSupersededCreatedReservations,
  listUnresolvedFreestyleReservations,
} from "./vm-reservations-db";

/**
 * ALERT-ONLY Freestyle account VM audit (ARC-1477). Lists every VM on the
 * (shared) Freestyle account and diffs the ids against this environment's
 * registry — reservation-trace rows plus current session_index projections —
 * and reports (a) aged, non-deleted VMs the registry has never seen,
 * (b) reservations that never resolved to a VM id (the lost-create-response
 * evidence), (c) 'created' reservations whose session projection moved on,
 * cleared, or vanished but whose VM is still live on the account (R1
 * superseded-runtime survivors), and (d) `killed`-state rows past the reap
 * grace whose VM is still live (R2 killed-sweep survivors). It NEVER
 * terminates anything: on a shared account an unregistered id can be another
 * environment's live VM, so killing stays gated on ARC-1399 env isolation.
 * Humans reconcile flagged VMs in the Freestyle dashboard (VM names embed the
 * repo slug and an 8-char session-id prefix; `vm_reservations.vm_name` holds
 * each attempt's exact name) and silence handled reservation rows with
 * outcome = 'reconciled'.
 */

export const FREESTYLE_VM_AUDIT_EVENT = "freestyle_vm_audit.swept";

// A VM younger than this may be a spawn still in flight whose reservation is
// about to resolve; skip it rather than flag every mid-spawn create.
const MIN_UNREGISTERED_VM_AGE_MS = 30 * 60 * 1000;
// A 'pending' reservation older than this can no longer resolve (create calls
// time out in seconds; the DO died mid-create) — treat as possible orphan.
const STALE_PENDING_RESERVATION_AGE_MS = 30 * 60 * 1000;
const MAX_REPORTED_ITEMS = 50;
const LIST_REQUEST_TIMEOUT_MS = 30_000;
// A 'created' reservation younger than this is skipped by the superseded
// classification: an audit sweep can land between markVmReservationCreated and
// attachRuntime on a healthy spawn — the projection is briefly missing/stale
// and a brand-new live VM would false-flag as superseded. Mirrors
// MIN_UNREGISTERED_VM_AGE_MS.
const SUPERSEDED_MIN_RESERVATION_AGE_MS = 30 * 60 * 1000;

export interface FreestyleVmAuditResult {
  skipped: "not_production" | "missing_api_key" | null;
  listedTotal: number;
  activeCount: number;
  registeredCount: number;
  unregisteredCount: number;
  possibleOrphanCount: number;
  supersededCount: number;
  killedRowCount: number;
}

export async function runFreestyleVmAudit(
  env: Env,
  options: {
    logger?: Logger;
    nowMs?: number;
    /** Test seam: replaces the account-wide vms.list() call. */
    listVms?: () => Promise<FreestyleAuditVm[]>;
  } = {},
): Promise<FreestyleVmAuditResult> {
  const logger = options.logger ?? createLogger({ bindings: { component: "freestyle-vm-audit" } });
  const nowMs = options.nowMs ?? Date.now();
  const skippedResult = (reason: "not_production" | "missing_api_key"): FreestyleVmAuditResult => ({
    skipped: reason,
    listedTotal: 0,
    activeCount: 0,
    registeredCount: 0,
    unregisteredCount: 0,
    possibleOrphanCount: 0,
    supersededCount: 0,
    killedRowCount: 0,
  });

  // Single-runner pin: prod, QA, and local dev share ONE Freestyle account, so
  // every env running the audit would flag every other env's VMs. Prod owns
  // the signal; QA/local skip (strict compare — no normalize fallback, which
  // would default an unset WORKER_ENV to production on a local run).
  if (env.WORKER_ENV !== "production") return skippedResult("not_production");
  if (!env.FREESTYLE_API_KEY) return skippedResult("missing_api_key");

  const listVms =
    options.listVms ??
    (() =>
      new FreestyleSandboxClient({ apiKey: env.FREESTYLE_API_KEY, logger }).listAccountVmsForAudit({
        requestTimeoutMs: LIST_REQUEST_TIMEOUT_MS,
      }));

  const [listed, reservedIds, projectedIds, unresolvedReservations] = await Promise.all([
    listVms(),
    listReservedVmIdsForBackend(env.DB, FREESTYLE_RUNTIME_BACKEND),
    listSessionIndexVmIdsForBackend(env.DB, FREESTYLE_RUNTIME_BACKEND),
    listUnresolvedFreestyleReservations(env.DB, {
      pendingBeforeMs: nowMs - STALE_PENDING_RESERVATION_AGE_MS,
      limit: MAX_REPORTED_ITEMS,
    }),
  ]);

  const knownIds = new Set([...reservedIds, ...projectedIds]);
  const activeVms = listed.filter((vm) => !vm.deleted);
  const agedVms = activeVms.filter((vm) => {
    // A missing/unparseable createdAt cannot prove youth; include it — the
    // registry check still clears every VM this env created.
    const createdAtMs = vm.createdAt ? Date.parse(vm.createdAt) : Number.NaN;
    return Number.isNaN(createdAtMs) || nowMs - createdAtMs >= MIN_UNREGISTERED_VM_AGE_MS;
  });
  const unregisteredVms = agedVms.filter((vm) => !knownIds.has(vm.id));

  // Both leak classifications are driven FROM the live, non-deleted account VM
  // id set: the DAOs' IN-list IS the live intersection, so a reservation or
  // killed row whose VM is already gone never matches, dead rows can never
  // crowd out a real leak behind a row limit, and counts are exact by
  // construction (bounded by fleet size). Only the detail arrays are capped.
  const activeVmIds = activeVms.map((vm) => vm.id);
  const [supersededVms, killedRowVms] = await Promise.all([
    listSupersededCreatedReservations(env.DB, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: activeVmIds,
      createdBeforeMs: nowMs - SUPERSEDED_MIN_RESERVATION_AGE_MS,
    }),
    listKilledRowVms(env.DB, FREESTYLE_RUNTIME_BACKEND, {
      vmIds: activeVmIds,
      killedBeforeMs: nowMs - KILLED_RUNTIME_REAP_GRACE_MS,
    }),
  ]);

  const result: FreestyleVmAuditResult = {
    skipped: null,
    listedTotal: listed.length,
    activeCount: activeVms.length,
    registeredCount: activeVms.filter((vm) => knownIds.has(vm.id)).length,
    unregisteredCount: unregisteredVms.length,
    possibleOrphanCount: unresolvedReservations.length,
    supersededCount: supersededVms.length,
    killedRowCount: killedRowVms.length,
  };

  // logpush is off — direct-post the sweep (including the zero-finding case,
  // as a heartbeat) so the Terraform log-metrics + monitors can see it.
  await postStructuredEventToDd(env, {
    event: FREESTYLE_VM_AUDIT_EVENT,
    ...result,
    minUnregisteredVmAgeMs: MIN_UNREGISTERED_VM_AGE_MS,
    unregisteredVms: unregisteredVms.slice(0, MAX_REPORTED_ITEMS).map((vm) => ({
      id: vm.id,
      state: vm.state,
      createdAt: vm.createdAt,
    })),
    possibleOrphanReservations: unresolvedReservations.map((row) => ({
      sessionId: row.sessionId,
      spawnAttemptId: row.spawnAttemptId,
      attempt: row.attempt,
      vmName: row.vmName,
      outcome: row.outcome,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
    })),
    supersededVms: supersededVms.slice(0, MAX_REPORTED_ITEMS).map((row) => ({
      sessionId: row.sessionId,
      vmId: row.runtimeSandboxId,
      vmName: row.vmName,
      spawnAttemptId: row.spawnAttemptId,
      outcome: row.outcome,
      createdAt: row.createdAt,
    })),
    killedRowVms: killedRowVms.slice(0, MAX_REPORTED_ITEMS).map((row) => ({
      sessionId: row.sessionId,
      vmId: row.runtimeSandboxId,
      runtimeStateExpiresAt: row.runtimeStateExpiresAt,
    })),
  });

  if (
    result.unregisteredCount > 0 ||
    result.possibleOrphanCount > 0 ||
    result.supersededCount > 0 ||
    result.killedRowCount > 0
  ) {
    logger.warn({ ...result }, "Freestyle VM audit found unaccounted VMs");
  }

  return result;
}
