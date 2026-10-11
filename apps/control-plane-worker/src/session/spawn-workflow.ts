/**
 * Stable DO-storage key builders for the resumable cold-spawn workflow
 * (ARC-1042).
 *
 * Every key is scoped by `(sessionId, spawnAttemptId)`, so:
 *   - a stale attempt's state can never satisfy a newer attempt's checks, and
 *   - one prefix (`spawnAttemptPrefix`) clears an entire attempt's steps via
 *     `clearDurableStepsByPrefix`.
 *
 * The create step, bridge-start phases, and runtime-attach phase all live under
 * the same `session_attempt:{sessionId}:{spawnAttemptId}` prefix so a single
 * cleanup call covers the whole attempt. Bootstrap material (sandbox id + auth
 * token) is a plain stored value (not a `durableStep`), so it lives under its
 * own key and is deleted explicitly during cleanup.
 */

import { computeSha256Hex } from "../crypto";
import type { Logger } from "../logger";
import { isKnownRuntimeProvider } from "../sandbox/runtime-backend";
import { durableStep, hasDurableStep } from "./durable-step";

/** Replay-stable per-attempt sandbox bootstrap material. */
export type SpawnBootstrap = {
  sandboxId: string;
  authToken: string;
  sandboxAuthTokenHash: string;
};

/** Mint bootstrap material for one cold-spawn attempt. */
export async function buildSpawnBootstrapMaterial(spawnAttemptId?: string): Promise<SpawnBootstrap> {
  const authToken = crypto.randomUUID();
  return {
    sandboxId: spawnAttemptId ?? crypto.randomUUID(),
    authToken,
    sandboxAuthTokenHash: await computeSha256Hex(authToken),
  };
}

/** Fixed phase names for the cold-spawn workflow steps. */
export const SPAWN_PHASE = {
  // Replay-stable sandbox id + auth token, memoized so a resumed attempt reuses
  // the credentials the running bridge was started with.
  bootstrap: "bootstrap",
  // Intent marker written BEFORE `start-bridge.sh` so a replay always knows a
  // start may have happened and takes the health-probe recovery branch.
  bridgeStartInitiated: "bridge_start_initiated",
  // Single-flight wrapper around the first-run start command.
  bridgeStarted: "bridge_started",
  // Single-flight wrapper around a recovery re-issue of the start command.
  bridgeReissue: "bridge_reissue",
  runtimeAttached: "runtime_attached",
} as const;

/**
 * Whether a compensation-path capacity release should run for this attempt
 * (ARC-1045). Capacity admission is session-keyed and a newer current attempt
 * re-acquires the same session row via idempotent upsert, so a superseded
 * attempt must NOT release — it would free the live runtime's capacity. With no
 * attempt id (non-resumable spawn) there is no successor to protect, so release.
 *
 * Load-bearing direction: release only when current. The inverted form (skip
 * when current) reproduces the clobber, because `abortIfStaleSpawnAttempt` only
 * fires its `onStale` callback after the attempt is already not-current.
 */
export function shouldReleaseSupersededCapacity(
  spawnAttemptId: string | undefined,
  isCurrentAttempt: boolean,
): boolean {
  if (!spawnAttemptId) return true;
  return isCurrentAttempt;
}

/**
 * Whether a resume should converge to success because a running E2B runtime
 * already exists for the session (ARC-1045). A successful resume flips
 * runtimeState to "running" but does NOT set `status='ready'`, so a replay after
 * attach must short-circuit here rather than fall through `spawnSandbox` to a
 * cold create and start a duplicate runtime.
 */
export function shouldConvergeResumeToRunning(
  sandbox: { runtimeProvider?: string | null; runtimeState?: string | null; runtimeSandboxId?: string | null } | null,
): boolean {
  return (
    sandbox != null &&
    isKnownRuntimeProvider(sandbox.runtimeProvider) &&
    sandbox.runtimeState === "running" &&
    Boolean(sandbox.runtimeSandboxId)
  );
}

/**
 * Whether `tryResumeE2BRuntimeForSpawn` should converge to success on replay
 * (ARC-1045). All three must hold:
 *   - a resumable attempt id (the marker is attempt-scoped), AND
 *   - a running E2B runtime row, AND
 *   - THIS attempt's `runtimeAttached` durable step is present.
 *
 * The marker is the load-bearing guard: it is written together with the local
 * sandbox_state 'running' write in the same DO-storage commit, so it is present
 * iff this attempt genuinely attached. A bare running row WITHOUT the marker is a
 * stale runtime (e.g. a sandbox reaped by `discardStaleSandboxTransport`, which
 * leaves `runtimeState='running'` uncleared): it must NOT converge, or the spawn
 * would exit leaving the admitted prompt with no live bridge.
 */
export function shouldConvergeResumeReplay(args: {
  sandbox: { runtimeProvider?: string | null; runtimeState?: string | null; runtimeSandboxId?: string | null } | null;
  hasAttemptId: boolean;
  hasRuntimeAttachedMarker: boolean;
}): boolean {
  return args.hasAttemptId && shouldConvergeResumeToRunning(args.sandbox) && args.hasRuntimeAttachedMarker;
}

/** Prefix covering every durable step for one spawn attempt. */
export function spawnAttemptPrefix(sessionId: string, spawnAttemptId: string): string {
  return `session_attempt:${sessionId}:${spawnAttemptId}`;
}

/** Step name for a fixed-phase workflow step. */
export function spawnAttemptStepName(sessionId: string, spawnAttemptId: string, phase: string): string {
  return `${spawnAttemptPrefix(sessionId, spawnAttemptId)}:${phase}`;
}

/** Step name for the Nth E2B create retry within an attempt. */
export function spawnCreateStepName(sessionId: string, spawnAttemptId: string, attempt: number): string {
  return spawnAttemptStepName(sessionId, spawnAttemptId, `create_attempt_${attempt}`);
}

/** Prefix covering only the create retry steps within an attempt. */
export function spawnCreateStepPrefix(sessionId: string, spawnAttemptId: string): string {
  return `${spawnAttemptPrefix(sessionId, spawnAttemptId)}:create_attempt_`;
}

/** Which spawn path served the session. Always a cold create. */
export type SpawnPath = "cold";

/**
 * Per-spawn timing breadcrumbs captured during `spawnSandbox` and read back in
 * the `ready` handler (which runs in a separate async flow when the bridge
 * connects) to enrich the `spawn_info` telemetry. Ephemeral: written at
 * attach/claim time, deleted once consumed.
 */
export interface SpawnInstrumentation {
  spawnPath: SpawnPath;
  /** E2B `Sandbox.create` duration. */
  e2bCreateMs: number | null;
  /** Resolved runtime backend (e.g. `e2b_cloud`), for backend-segmented queries. */
  runtimeBackend: string;
  /** `Date.now()` when the runtime was attached / bridge start was issued. */
  attachedAtMs: number;
}

/** DO-storage key holding the ephemeral spawn instrumentation for a session. */
export function spawnInstrumentationKey(sessionId: string): string {
  return `spawn_instr:${sessionId}`;
}

/**
 * Load the attempt's bootstrap material, or mint + persist it on first run.
 * Replay-stable: a resumed attempt reuses the stored sandbox id + auth token so
 * the already-running bridge can still authenticate. Routed through
 * `durableStep` so the mint is memoized AND single-flight (concurrent callers
 * for the same attempt share one mint rather than racing to write different
 * tokens). Without a step name (no attempt id) the spawn is not resumable and we
 * always mint fresh. For resumable cold spawns, the sandbox id is the spawn
 * attempt id; only the no-attempt-id path mints an independent sandbox id.
 */
export async function loadOrCreateSpawnBootstrap(
  storage: DurableObjectStorage,
  stepName: string | null,
  generate: () => Promise<SpawnBootstrap>,
  logger?: Logger,
): Promise<SpawnBootstrap> {
  if (!stepName) return generate();
  return durableStep(storage, stepName, generate, logger);
}

interface ResumableBridgeStartDeps {
  storage: DurableObjectStorage;
  sessionId: string;
  spawnAttemptId: string | undefined;
  runtimeSandboxId: string;
  /** Issues `bash /app/start-bridge.sh` against the runtime. */
  startBridge: () => Promise<unknown>;
  /** True iff a live bridge is connected for `runtimeSandboxId` as of `sinceMs`. */
  probeBridgeHealth: (sessionId: string, runtimeSandboxId: string, sinceMs: number) => Promise<boolean>;
  logger?: Logger;
}

/**
 * Start the sandbox bridge as a resumable phase (ARC-1042).
 *
 * `start-bridge.sh` is NOT idempotent and `durableStep` is memoize-on-success,
 * so the crash window between `startCommand` resolving and its marker landing
 * would otherwise re-issue the command on replay with no safety. We close it by
 * writing an intent marker BEFORE the side effect: on any replay where a start
 * may have happened, probe live bridge health (fresh `sinceMs`, because the
 * in-memory health map is never cleared on disconnect) and only re-issue when
 * the bridge is provably not connected. The re-issue is itself a durable step so
 * overlapping recovery passes can't both start a bridge, and a re-issued bridge
 * that also dies is not retried in a storm (the spawn-connect timeout owns that).
 *
 * Both the first-run start and the recovery re-issue run inside `durableStep`s,
 * so the non-idempotent `startBridge` is single-flight and memoized. Correctness
 * also assumes a spawn attempt id is never recycled after a non-crash
 * `startBridge` failure without first clearing the attempt's workflow state; the
 * terminal-failure path does exactly that, so the intent marker never outlives a
 * failed attempt.
 */
export async function resumableBridgeStart(deps: ResumableBridgeStartDeps): Promise<void> {
  const { storage, sessionId, spawnAttemptId, runtimeSandboxId, startBridge, probeBridgeHealth, logger } = deps;
  if (!spawnAttemptId) {
    await startBridge();
    return;
  }
  const initiatedName = spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.bridgeStartInitiated);

  if (await hasDurableStep(storage, initiatedName)) {
    // Replay: a bridge start was already attempted. Prove the bridge is live NOW
    // before re-issuing the non-idempotent start script.
    const sinceMs = Date.now();
    const healthy = await probeBridgeHealth(sessionId, runtimeSandboxId, sinceMs);
    if (healthy) {
      logger?.info(
        { sessionId, spawnAttemptId, runtimeSandboxId, event: "bridge_recovery_skip_healthy" },
        "Resumed spawn: bridge already healthy, skipping start",
      );
      return;
    }
    await durableStep(
      storage,
      spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.bridgeReissue),
      async () => {
        logger?.warn(
          { sessionId, spawnAttemptId, runtimeSandboxId, event: "bridge_recovery_reissue_dead" },
          "Resumed spawn: bridge not healthy, re-issuing start",
        );
        await startBridge();
        return { reissued: true };
      },
      logger,
    );
    return;
  }

  // First run: persist the intent marker BEFORE the side effect (so any replay
  // sees the intent and probes instead of blindly re-issuing), then run the
  // start inside a durable step so it is single-flight and memoized.
  await durableStep(storage, initiatedName, async () => ({ runtimeSandboxId }), logger);
  await durableStep(
    storage,
    spawnAttemptStepName(sessionId, spawnAttemptId, SPAWN_PHASE.bridgeStarted),
    async () => {
      await startBridge();
      return { runtimeSandboxId };
    },
    logger,
  );
}
