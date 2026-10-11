import type { Logger } from "../logger";
import type { E2BCreateSandboxResponse } from "./e2b-client";
import type { RuntimeBackend } from "./runtime-backend";
import { insertVmReservation, markVmReservationCreated, markVmReservationFailed } from "./vm-reservations-db";

/**
 * Pre-create VM reservation tracing (ARC-1477). Wraps a provider
 * `createSandbox` call so that every attempted create leaves a durable D1
 * trace row even when the HTTP response is lost: without one, a Freestyle VM
 * created server-side under a lost response has an id known to nobody and can
 * never be found again (vms.list() carries no metadata). Tracing is strictly
 * best-effort — a D1 failure here must never fail or delay a spawn beyond the
 * write itself, so every DAO call is caught and logged.
 */

/**
 * Error codes that prove the provider rejected the create without making a
 * VM. Everything else — timeout, network, unknown, killed, or a non-runtime
 * error — leaves the server-side outcome unknowable, so it classifies as
 * 'possible_orphan': for an alert-only trace a false positive costs a manual
 * look, a false negative costs a permanent leak.
 */
const NO_VM_CREATED_CODES: ReadonlySet<string> = new Set([
  "missing_config",
  "auth",
  "quota",
  "rate_limit",
  "missing_template",
  "missing_sandbox",
  "network_policy",
]);

export function classifyCreateFailureOutcome(err: unknown): {
  outcome: "failed" | "possible_orphan";
  errorCode: string | null;
} {
  // Match on `name` rather than instanceof, mirroring the spawn retry
  // classifier (durable-object.ts) — bundling can split class identity.
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "E2BSandboxRuntimeError") {
    const code = String((err as { code?: unknown }).code ?? "unknown");
    const requestSent = (err as { requestSent?: unknown }).requestSent;
    if (requestSent === false || NO_VM_CREATED_CODES.has(code)) {
      return { outcome: "failed", errorCode: code };
    }
    return { outcome: "possible_orphan", errorCode: code };
  }
  return { outcome: "possible_orphan", errorCode: null };
}

export interface VmReservationTraceContext {
  sessionId: string;
  spawnAttemptId: string | null;
  attempt: number | null;
  runtimeBackend: RuntimeBackend;
  vmName: string | null;
  operation: string;
}

export async function createSandboxWithReservationTrace(options: {
  db: D1Database | undefined;
  create: () => Promise<E2BCreateSandboxResponse>;
  context: VmReservationTraceContext;
  logger: Logger;
  /**
   * Fired (fire-and-forget) when a create failure classifies as
   * 'possible_orphan' — the caller posts the structured event so the signal
   * reaches Datadog even before the hourly audit runs.
   */
  onPossibleOrphan?: (fields: Record<string, unknown>) => void;
}): Promise<E2BCreateSandboxResponse> {
  const { db, create, context, logger } = options;
  const reservationId = crypto.randomUUID();

  // True once the insert returns WITHOUT throwing — deliberately NOT the
  // insert's changes>0 result: under the D1_RETRY_SAFE contract a transient
  // retry of a committed INSERT reports changes=0, and gating the resolves on
  // that would strand the committed row at 'pending' (a permanent
  // false-positive orphan alert). The resolves are pending-guarded CAS
  // no-ops, so firing them against a row the insert didn't create is safe.
  let reserved = false;
  if (db) {
    try {
      await insertVmReservation(db, {
        reservationId,
        sessionId: context.sessionId,
        spawnAttemptId: context.spawnAttemptId,
        attempt: context.attempt,
        runtimeBackend: context.runtimeBackend,
        vmName: context.vmName,
        nowMs: Date.now(),
      });
      reserved = true;
    } catch (err) {
      logger.warn(
        { reservationId, sessionId: context.sessionId, operation: context.operation, error: String(err) },
        "Failed to write VM reservation trace before create",
      );
    }
  }

  try {
    const result = await create();
    if (reserved) {
      try {
        await markVmReservationCreated(db as D1Database, {
          reservationId,
          runtimeSandboxId: result.runtimeSandboxId,
          nowMs: Date.now(),
        });
      } catch (err) {
        logger.warn(
          {
            reservationId,
            sessionId: context.sessionId,
            runtimeSandboxId: result.runtimeSandboxId,
            error: String(err),
          },
          "Failed to resolve VM reservation trace after create",
        );
      }
    }
    return result;
  } catch (createErr) {
    const { outcome, errorCode } = classifyCreateFailureOutcome(createErr);
    if (reserved) {
      try {
        await markVmReservationFailed(db as D1Database, { reservationId, outcome, errorCode, nowMs: Date.now() });
      } catch (err) {
        logger.warn(
          { reservationId, sessionId: context.sessionId, outcome, error: String(err) },
          "Failed to resolve VM reservation trace after create failure",
        );
      }
    }
    if (outcome === "possible_orphan") {
      options.onPossibleOrphan?.({
        reservationId,
        sessionId: context.sessionId,
        spawnAttemptId: context.spawnAttemptId,
        attempt: context.attempt,
        runtimeBackend: context.runtimeBackend,
        vmName: context.vmName,
        operation: context.operation,
        errorCode,
      });
    }
    throw createErr;
  }
}
