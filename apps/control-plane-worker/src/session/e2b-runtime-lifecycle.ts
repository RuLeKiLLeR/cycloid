import type { SandboxRuntimeProvider } from "../../../../shared/types/sandbox.js";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import type { SandboxTerminateReason } from "../sandbox/e2b-client";
import { parsePersistedRuntimeBackendOrNull, type RuntimeBackend } from "../sandbox/runtime-backend";
import { syncRuntimeProjection, syncRuntimeProjectionChecked } from "../services/session-projection";
import type { Env } from "../types";
import type { RuntimeProjectionState } from "./db";
import * as doDb from "./do-db";

export const CLEARED_RUNTIME_PROJECTION_STATE: RuntimeProjectionState = {
  runtimeProvider: null,
  runtimeBackend: null,
  runtimeState: null,
  runtimeSandboxId: null,
  runtimeTemplateId: null,
  runtimeStateExpiresAt: null,
  runtimeLiveLeaseExpiresAt: null,
  runtimePreviewUrl: null,
  runtimeCreatedAt: null,
  runtimeLastResumedAt: null,
  runtimeLastPausedAt: null,
  runtimeLastProviderRefreshedAt: null,
  runtimeProviderTtlExpiresAt: null,
};

interface AbortIfStaleSpawnAttemptOptions {
  sessionId: string;
  spawnAttemptId?: string;
  runtimeSandboxId?: string | null;
  logger: Pick<Logger, "info">;
  message?: string;
  extraLogFields?: Record<string, unknown>;
  isCurrentSpawnAttempt: (spawnAttemptId: string) => Promise<boolean>;
  onStale?: () => Promise<void> | void;
}

export async function abortIfStaleSpawnAttempt(options: AbortIfStaleSpawnAttemptOptions): Promise<boolean> {
  if (!options.spawnAttemptId) return false;
  if (await options.isCurrentSpawnAttempt(options.spawnAttemptId)) return false;

  await options.onStale?.();
  if (options.message) {
    options.logger.info(
      {
        sessionId: options.sessionId,
        spawnAttemptId: options.spawnAttemptId,
        ...(options.runtimeSandboxId ? { runtimeSandboxId: options.runtimeSandboxId } : {}),
        ...(options.extraLogFields ?? {}),
      },
      options.message,
    );
  }
  return true;
}

/** Outcome of a runtime kill, as attributed to Datadog. `error` = the underlying
 *  `terminateSandbox` threw (distinct from the swallowed-404 `missing`). */
export type RuntimeTerminateOutcome = "killed" | "missing" | "error";

/**
 * Coarse, low-cardinality facet derived from the fine-grained terminate reason.
 * Lets a Datadog read group kills by originating subsystem without enumerating
 * every reason. The exhaustive switch (no `default`) makes adding a new
 * `SandboxTerminateReason` a compile error until it is mapped here.
 */
export function runtimeTerminateSource(reason: SandboxTerminateReason): string {
  switch (reason) {
    case "orphan_reaper":
      return "reaper";
    case "runtime_cleanup":
      return "cleanup";
    case "session_terminal":
      // R4: the FSM-driven final-terminal VM reclaim — a distinct source bucket so DD can split
      // lifecycle-close terminates from the cron's idle/retention cleanup sweeps.
      return "lifecycle";
    case "duplicate_spawn_retry":
    case "superseded_runtime":
    case "cold_create_unusable":
    case "bridge_start_failed":
    case "stale_spawn_after_bridge":
      return "spawn";
    case "resume_stale_cleanup":
    case "resume_failure_cleanup":
      return "resume";
    case "sandbox_layer_smoke":
      return "layer";
    case "business_offboarding":
      return "offboarding";
  }
}

interface EmitRuntimeTerminateEventOptions {
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  /** Null for session-less kills (layer smoke, true orphans). */
  sessionId: string | null;
  runtimeSandboxId: string;
  reason: SandboxTerminateReason;
  terminateOutcome: RuntimeTerminateOutcome;
  extraFields?: Record<string, unknown>;
}

/**
 * Direct-post a `runtime.terminate` attribution event to Datadog. This is the
 * kill-path READ CHANNEL for the sandbox-loss diagnosis (arm 3): plain
 * `logger.*` never reaches Datadog (Workers Logs is not exported, ARC-1196), so
 * every kill lane must direct-post to be queryable. It is joined against the
 * `sandbox_disconnect_crosscheck_summary{signal:absent_from_all_backends}` reads
 * to split H3 (a Cycloid lane killed the VM upstream — the `reason`/`source`
 * names it) from H1 (no Cycloid kill found -> genuine E2B drop).
 *
 * Returns a promise that NEVER rejects: a Datadog outage must not fail or slow a
 * terminate. Hand it to `ctx.waitUntil` from a DO, or `await` it from a cron /
 * queue handler that lacks a waitUntil (kills are never a hot path).
 *
 * Log hygiene (docs/security.md): emits only ids, the reason/source facets, and
 * the outcome — never raw provider responses or other sessions' sandbox lists.
 */
export function emitRuntimeTerminateEvent(options: EmitRuntimeTerminateEventOptions): Promise<void> {
  return postStructuredEventToDd(options.env, {
    event: "runtime.terminate",
    sessionId: options.sessionId,
    runtimeSandboxId: options.runtimeSandboxId,
    reason: options.reason,
    source: runtimeTerminateSource(options.reason),
    terminateOutcome: options.terminateOutcome,
    ...(options.extraFields ?? {}),
  }).then(
    () => {},
    () => {
      // Observability-only; the local logger line already captured the kill.
    },
  );
}

/**
 * Builds the direct-posted payload for a resume connect-failure clear decision.
 * Control-plane app logs are not shipped to Datadog, so the `info`/`warn` lines
 * at the decision site are invisible; this event is the only queryable signal,
 * e.g. for alerting on a frequent `skip_live` (false-negative liveness probe
 * wrongly holding a dead VM).
 */
export function buildResumeFailureClearDecisionEvent(fields: {
  sessionId: string;
  runtimeSandboxId: string;
  decision: ResumeFailureClearDecision;
  liveness: "alive" | "dead" | "unknown";
  stillOurs: boolean;
}): Record<string, unknown> {
  return {
    event: "resume_failure_clear_decision",
    sessionId: fields.sessionId,
    // camelCase to match the sibling `runtime.terminate` event's `runtimeSandboxId`
    // so a single Datadog facet on the sandbox id correlates across all three of
    // this file's runtime events without switching naming conventions mid-query.
    runtimeSandboxId: fields.runtimeSandboxId,
    decision: fields.decision,
    liveness: fields.liveness,
    stillOurs: fields.stillOurs,
  };
}

export function buildSandboxResumeWallEvent(fields: {
  sessionId: string;
  runtimeSandboxId: string;
  runtimeBackend: RuntimeBackend;
  operation: string;
  resumeWallMs: number;
  outcome: "resumed" | "failed";
  errorClass: string | null;
}): Record<string, unknown> {
  return {
    event: "sandbox.resume_wall",
    sessionId: fields.sessionId,
    runtimeSandboxId: fields.runtimeSandboxId,
    runtime_backend: fields.runtimeBackend,
    operation: fields.operation,
    resume_wall_ms: Math.max(0, Math.round(fields.resumeWallMs)),
    outcome: fields.outcome,
    ...(fields.errorClass !== null ? { error_class: fields.errorClass } : {}),
  };
}

export type BridgeStartupDiagnosticsOutcome = "collected" | "skipped" | "failed";

/**
 * Builds the direct-posted payload for a bridge-startup-diagnostics outcome.
 * Reuses the EXISTING `sandbox.bridge_startup_diagnostics` event name (the local
 * diagnostics already log under it) and adds an `outcome`/`status` facet so the
 * deadline-time capture is queryable in Datadog, where the app log is not shipped.
 */
export function buildBridgeStartupDiagnosticsEvent(fields: {
  outcome: BridgeStartupDiagnosticsOutcome;
  sessionId: string;
  runtimeSandboxId: string | null;
  reason: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}): Record<string, unknown> {
  return {
    event: "sandbox.bridge_startup_diagnostics",
    outcome: fields.outcome,
    // `status` intentionally mirrors `outcome` so both the generic Datadog `status`
    // facet and the event-specific `outcome` facet can filter these events.
    status: fields.outcome,
    sessionId: fields.sessionId,
    // camelCase to match the sibling `runtime.terminate`/`resume_failure_clear_decision`
    // events so one sandbox-id facet correlates across all three.
    runtimeSandboxId: fields.runtimeSandboxId,
    reason: fields.reason,
    exitCode: fields.exitCode,
    ...(fields.stdout !== undefined ? { stdout: fields.stdout } : {}),
    ...(fields.stderr !== undefined ? { stderr: fields.stderr } : {}),
  };
}

export interface TerminateRuntimeWithLogOptions {
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  /** Null for session-less kills (layer smoke, true orphans). */
  sessionId: string | null;
  runtimeSandboxId: string;
  /** Originating code path — forwarded to `terminate` and logged for attribution. */
  reason: SandboxTerminateReason;
  logger: Pick<Logger, "warn" | "info">;
  message: string;
  extraLogFields?: Record<string, unknown>;
  level?: "warn" | "info";
  terminate: (reason: SandboxTerminateReason) => Promise<{ status: "killed" | "missing" }>;
  /** DO callers pass `(p) => this.ctx.waitUntil(p)`; cron/queue callers omit it
   *  and the readable post is awaited inline. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function terminateRuntimeWithLog(
  options: TerminateRuntimeWithLogOptions,
): Promise<{ status: RuntimeTerminateOutcome }> {
  const emitReadable = async (terminateOutcome: RuntimeTerminateOutcome): Promise<void> => {
    const post = emitRuntimeTerminateEvent({
      env: options.env,
      sessionId: options.sessionId,
      runtimeSandboxId: options.runtimeSandboxId,
      reason: options.reason,
      terminateOutcome,
      extraFields: options.extraLogFields,
    });
    // With a waitUntil (DO callers) the post is registered and runs off the kill
    // path. Without one (cron/queue callers) it MUST be awaited inline, or a
    // Workers handler can drop the fire-and-forget promise on return and lose the
    // attribution event — the exact gap this is closing. `emitRuntimeTerminateEvent`
    // never rejects, so awaiting cannot fail the terminate.
    if (options.waitUntil) options.waitUntil(post);
    else await post;
  };
  try {
    const result = await options.terminate(options.reason);
    // Emit a session-tagged success log: the chokepoint log is keyed on
    // runtimeSandboxId only, so this is what makes a kill queryable by session.
    // `terminateSandbox` swallows a 404 as `{ status: "missing" }` rather than
    // throwing, so record the outcome — a session was-already-gone cleanup must
    // be distinguishable from a real kill in post-incident queries.
    options.logger.info(
      {
        event: "runtime.terminate",
        sessionId: options.sessionId,
        runtimeSandboxId: options.runtimeSandboxId,
        reason: options.reason,
        terminateOutcome: result.status,
        ...(options.extraLogFields ?? {}),
      },
      "Terminated sandbox runtime",
    );
    await emitReadable(result.status);
    return result;
  } catch (error) {
    options.logger[options.level ?? "warn"](
      {
        event: "runtime.terminate_failed",
        sessionId: options.sessionId,
        runtimeSandboxId: options.runtimeSandboxId,
        reason: options.reason,
        ...(options.extraLogFields ?? {}),
        error: String(error),
      },
      options.message,
    );
    await emitReadable("error");
    return { status: "error" };
  }
}

interface ClearRuntimeAndSyncProjectionOptions {
  sql: SqlStorage;
  env: Env;
  sessionId: string;
  expectedProvider?: SandboxRuntimeProvider | null;
  runtimeState?: RuntimeProjectionState;
}

export type ResumeFailureClearDecision = "clear" | "skip_superseded" | "skip_live";

/**
 * Decides whether a resume connect-failure (`missing_sandbox`/`killed`) may
 * clear the runtime row. The clear nulls runtime_sandbox_id in BOTH
 * sandbox_state and session_index, so an unguarded clear can orphan a live VM
 * (the orphan-reaper desync). Skip when:
 *   - `stillOurs` is false — a racing newer attempt attached a different
 *     sandbox to this session; clearing would orphan it.
 *   - `liveness` is `alive` — the connect error was spurious; the VM is up.
 * Otherwise clear (`dead`/`unknown` fail toward the existing behavior).
 */
export function decideResumeFailureClear(params: {
  stillOurs: boolean;
  liveness: "alive" | "dead" | "unknown";
}): ResumeFailureClearDecision {
  if (!params.stillOurs) return "skip_superseded";
  if (params.liveness === "alive") return "skip_live";
  return "clear";
}

export interface SupersededRuntimeTerminate {
  runtimeSandboxId: string;
  runtimeBackend: RuntimeBackend;
}

/**
 * Decides whether a cold attach must terminate the runtime it is about to
 * overwrite. `recordRunningE2BRuntimeForSpawn` column-patches the NEW
 * runtime_sandbox_id over the prior one with no read-before-write, so the moment
 * the attach lands the prior id is dropped from BOTH sandbox_state and
 * session_index — after which no sweep can ever find it again (a spawn attempt
 * abandoned above the `spawnSandbox` frame is today's zombie class). The prior
 * VM must therefore be terminated right at the overwrite point. Keyed off DO
 * state only — the reservations table must NOT feed a kill (ARC-1399 no-kill
 * gate).
 *
 * Returns the prior VM's id and its OWN persisted backend (terminate on the
 * VM's backend, cross-backend safe) when there is a distinct prior VM to
 * reclaim, or null (no-op) when:
 *   - the prior id is not a non-empty string (nothing attached to overwrite);
 *   - the prior id equals the next id (resume re-attach of the same VM — the
 *     resume-replay pin that the current attempt's own paused sandbox is never
 *     terminated);
 *   - the prior backend is unparseable — never guess which provider to kill
 *     against; the caller logs and skips. (A null/empty legacy backend parses to
 *     e2b_cloud and is terminated, not skipped.)
 */
export function decideSupersededRuntimeTerminate(params: {
  priorRuntimeSandboxId: unknown;
  priorRuntimeBackend: unknown;
  nextRuntimeSandboxId: string;
}): SupersededRuntimeTerminate | null {
  const priorId = params.priorRuntimeSandboxId;
  if (typeof priorId !== "string" || priorId === "") return null;
  if (priorId === params.nextRuntimeSandboxId) return null;
  const runtimeBackend = parsePersistedRuntimeBackendOrNull(params.priorRuntimeBackend);
  if (runtimeBackend === null) return null;
  return { runtimeSandboxId: priorId, runtimeBackend };
}

export async function clearRuntimeAndSyncProjection(options: ClearRuntimeAndSyncProjectionOptions): Promise<void> {
  doDb.clearRuntimeState(options.sql, options.sessionId, options.expectedProvider);
  if (options.env.DB) {
    await syncRuntimeProjection(
      options.env,
      options.sessionId,
      options.runtimeState ?? CLEARED_RUNTIME_PROJECTION_STATE,
    );
  }
}

interface WriteRunningRuntimeStateOptions {
  sql: SqlStorage;
  env: Env;
  sessionId: string;
  sandboxState: Partial<doDb.SandboxStateRow>;
  runtimeState: RuntimeProjectionState;
  syncProjection?: boolean;
  logger?: Logger;
}

export async function writeRunningRuntimeState(options: WriteRunningRuntimeStateOptions): Promise<void> {
  doDb.updateSandboxState(options.sql, options.sessionId, options.sandboxState);
  if (options.syncProjection !== false && options.env.DB) {
    // Use the checked variant: a zero-row runtime projection (session_index row
    // not yet landed at attach time) must NOT throw, because the cold-spawn
    // attach catches a thrown projection error as a spawn failure and would
    // terminate the just-attached HEALTHY sandbox. The checked variant retries
    // the missing row, then logs loud and returns without throwing. Real D1
    // errors still throw (existing behavior).
    await syncRuntimeProjectionChecked(options.env, options.sessionId, options.runtimeState, {
      logger: options.logger,
    });
  }
}
