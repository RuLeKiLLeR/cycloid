import type { SandboxRuntimeProvider } from "../../../../../shared/types/sandbox.js";
import { postStructuredEventToDd } from "../../observability/events-exporter";
import type { Env } from "../../types";
import type { RuntimeProjectionState } from "../db";
import * as doDb from "../do-db";
import { writeRunningRuntimeState } from "../e2b-runtime-lifecycle";

export type RuntimeIdentityRejection =
  | {
      accepted: false;
      reason: "sandbox_id_mismatch";
      expectedSandboxId: string | null;
      observedSandboxId: string | null;
    }
  | {
      accepted: false;
      reason: "provider_mismatch";
      expectedProvider: SandboxRuntimeProvider | null;
      observedProvider: SandboxRuntimeProvider | null;
    };

export type RuntimeIdentityResult = { accepted: true } | RuntimeIdentityRejection;

interface RuntimeIdentityLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

interface AttachOpts {
  sql: SqlStorage;
  env: Env;
  sessionId: string;
  sandboxState: Partial<doDb.SandboxStateRow>;
  runtimeState: RuntimeProjectionState;
  syncProjection?: boolean;
}

interface RefreshLeaseOpts extends AttachOpts {
  expectedSandboxId: string;
  expectedProvider?: SandboxRuntimeProvider | null;
  logger?: RuntimeIdentityLogger;
  waitUntil?: (promise: Promise<unknown>) => void;
}

function emitRefusalEvent(
  opts: Pick<RefreshLeaseOpts, "env" | "logger" | "waitUntil">,
  payload: Record<string, unknown>,
  message: string,
): void {
  opts.logger?.info(payload, message);
  const postPromise = postStructuredEventToDd(opts.env, payload);
  if (opts.waitUntil) {
    opts.waitUntil(postPromise);
  } else {
    console.warn("[runtime-identity] postStructuredEventToDd called without waitUntil; event may be dropped");
    void postPromise;
  }
}

function sandboxStatePatchMatchesObserved(
  observed: doDb.SandboxStateRow | null,
  patch: Partial<doDb.SandboxStateRow>,
): boolean {
  if (!observed) return false;
  return (Object.entries(patch) as Array<[keyof doDb.SandboxStateRow, unknown]>).every(
    ([key, value]) => observed[key] === value,
  );
}

/**
 * Single owner for the running-runtime row patch on `sandbox_state`. Used by
 * the cold-spawn and resume-after-bridge-health paths; staleness against
 * other concurrent spawns is enforced upstream by `abortIfStaleSpawnAttempt`,
 * so this entry point does not re-check.
 */
export async function attachRuntime(opts: AttachOpts): Promise<void> {
  await writeRunningRuntimeState({
    sql: opts.sql,
    env: opts.env,
    sessionId: opts.sessionId,
    sandboxState: opts.sandboxState,
    runtimeState: opts.runtimeState,
    syncProjection: opts.syncProjection,
  });
}

/**
 * Refreshes the live-lease expiry on an already-attached runtime. Rejects
 * the write when the row has a different `runtimeSandboxId` than the caller
 * expects -- prevents an orphaned heartbeat from extending the lease on a
 * sandbox that another path has already released.
 *
 * Projection sync defaults to `syncProjection: false` (callers opt in for
 * cases where lease drift would affect rich_status). When the projection
 * sync runs without an explicit opt-in, the existing writeRunningRuntimeState
 * default (sync) is used.
 */
export async function refreshLease(opts: RefreshLeaseOpts): Promise<RuntimeIdentityResult> {
  const observed = doDb.getSandboxState(opts.sql, opts.sessionId);
  const observedSandboxId = observed?.runtimeSandboxId ?? null;
  if (observedSandboxId !== opts.expectedSandboxId) {
    emitRefusalEvent(
      opts,
      {
        event: "runtime_lease_refresh_refused",
        sessionId: opts.sessionId,
        expectedSandboxId: opts.expectedSandboxId,
        observedSandboxId,
        reason: "sandbox_id_mismatch",
      },
      "runtime lease refresh refused (sandbox id mismatch)",
    );
    return {
      accepted: false,
      reason: "sandbox_id_mismatch",
      expectedSandboxId: opts.expectedSandboxId,
      observedSandboxId,
    };
  }
  if (opts.expectedProvider !== undefined && observed?.runtimeProvider !== opts.expectedProvider) {
    const observedProvider = observed?.runtimeProvider ?? null;
    emitRefusalEvent(
      opts,
      {
        event: "runtime_lease_refresh_refused",
        sessionId: opts.sessionId,
        expectedProvider: opts.expectedProvider,
        observedProvider,
        reason: "provider_mismatch",
      },
      "runtime lease refresh refused (provider mismatch)",
    );
    return {
      accepted: false,
      reason: "provider_mismatch",
      expectedProvider: opts.expectedProvider,
      observedProvider,
    };
  }
  if (!opts.syncProjection && sandboxStatePatchMatchesObserved(observed, opts.sandboxState)) {
    return { accepted: true };
  }
  await writeRunningRuntimeState({
    sql: opts.sql,
    env: opts.env,
    sessionId: opts.sessionId,
    sandboxState: opts.sandboxState,
    runtimeState: opts.runtimeState,
    syncProjection: opts.syncProjection ?? false,
  });
  return { accepted: true };
}

interface ApplyRuntimePatchOpts {
  sql: SqlStorage;
  sessionId: string;
  patch: Partial<doDb.SandboxStateRow>;
}

/**
 * Single chokepoint for runtime-identity column writes that are not covered
 * by `attachRuntime` or `refreshLease` -- e.g. the reaper, idle-pause, kill,
 * and onboarding-backend paths. The patch may include non-runtime columns
 * (status, stopReason, intentionalPauseReason); those flow through unchanged
 * but the call routes here so the ownership static guard can see every
 * runtime-column write originate from this owner file.
 */
export function applyRuntimePatch(opts: ApplyRuntimePatchOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, opts.patch);
}
