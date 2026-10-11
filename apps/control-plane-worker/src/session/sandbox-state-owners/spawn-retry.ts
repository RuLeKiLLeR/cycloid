import * as doDb from "../do-db";

const SPAWN_RETRY_CAP = 2;

export interface SpawnRetryDecision {
  retryCount: number;
  retryCapReached: boolean;
}

interface PeekOpts {
  sql: SqlStorage;
  sessionId: string;
}

interface CommitOpts {
  sql: SqlStorage;
  sessionId: string;
  decision: SpawnRetryDecision;
}

interface ResetOpts {
  sql: SqlStorage;
  sessionId: string;
}

/**
 * Reads the current spawn-retry count and decides whether the cap has been
 * reached. Pure read; no write. `retryCount` is the pre-attempt value --
 * callers display it as "attempt N+1 of cap+1". Pair with
 * `commitSpawnTimeoutRetryDecision` once any subsequent async work
 * (durable-event appends, status broadcasts) has succeeded; if the handler
 * crashes between peek and commit, the alarm re-fires and reads the
 * unchanged counter -- the prompt does not lose retries to a partial
 * handler.
 */
export function peekSpawnTimeoutRetryDecision(opts: PeekOpts): SpawnRetryDecision {
  const row = doDb.getSandboxState(opts.sql, opts.sessionId);
  const current = row?.spawnRetryCount ?? 0;
  return { retryCount: current, retryCapReached: current >= SPAWN_RETRY_CAP };
}

/**
 * Commits a previously-peeked decision: increments to retryCount+1 in the
 * non-cap branch, resets to 0 in the cap-reached branch. Must run in the
 * same DO request handler as the peek -- DO SQLite is single-writer per DO,
 * so no other writer can have advanced the counter in between.
 */
export function commitSpawnTimeoutRetryDecision(opts: CommitOpts): void {
  const next = opts.decision.retryCapReached ? 0 : opts.decision.retryCount + 1;
  doDb.updateSandboxState(opts.sql, opts.sessionId, { spawnRetryCount: next });
}

/**
 * Resets spawnRetryCount to 0. Used by sandbox-connect success paths and by
 * unrecoverable spawn-failure cleanup. Idempotent.
 */
export function resetSpawnRetryOnSuccess(opts: ResetOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, { spawnRetryCount: 0 });
}

interface MarkSpawnStartedOpts {
  sql: SqlStorage;
  sessionId: string;
  at: number;
}

/**
 * Records the wall-clock time the current spawn began. Read back by the
 * spawn-watchdog path to compute overshoot and by the ready transition to
 * compute spawn duration.
 */
export function markSpawnStarted(opts: MarkSpawnStartedOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, { spawnStartedAt: opts.at });
}

/**
 * Clears spawnStartedAt. Called on the ready transition once spawn duration
 * has been computed and on spawn-attempt cleanup. Idempotent.
 */
export function clearSpawnStarted(opts: ResetOpts): void {
  doDb.updateSandboxState(opts.sql, opts.sessionId, { spawnStartedAt: null });
}
