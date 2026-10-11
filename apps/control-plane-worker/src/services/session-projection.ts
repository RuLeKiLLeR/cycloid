import type { Phase } from "../../../../shared/session/phase.js";
import { CHILD_SLOT_RELEASE_PHASES } from "../../../../shared/session/phase.js";
import type { SandboxRuntimeBackend } from "../../../../shared/types/sandbox.js";
import { recordAutomationExecutionOutcome } from "../automation/execution-outcome";
import { createLogger, type Logger } from "../logger";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import { reportSwallowedFailure } from "../observability/swallowed-failure";
import { getChildSessionRow, releaseChildSessionConcurrentReservation } from "../session/child-session-db";
import {
  buildProjectCycloidDoneStatusStatement,
  buildProjectDisplayColumnsStatement,
  buildProjectReviewLoopDoneStateStatement,
  buildProjectVerificationStateStatement,
  buildSyncRichStatusStatement,
  buildUpdateSessionPublishStateStatement,
  buildUpdateSessionRuntimeBackendStatement,
  buildUpdateSessionRuntimeStateStatement,
  buildUpdateSessionSnapshotImageIdStatement,
  buildUpsertReplayMetadataStatement,
  buildUpsertSessionIndexStatement,
  type ParentSessionContext,
  type PublishProjectionState,
  runSessionProjectionStatements,
  type RuntimeProjectionState,
  type SessionProjectionOperation,
  type SessionProjectionStatement,
} from "../session/db";
import type { DisplayColumnProjection, MirrorColumnProjection } from "../session/fsm/project";
import type { Env, ReplayState, SessionState } from "../types";

const log = createLogger({ bindings: { component: "session-projection" } });

/**
 * Thrown when an awaited rich_status projection write affects zero rows. The
 * write itself succeeded against D1 but no session_index row matched, so the
 * "projection persisted before broadcast" guarantee would be false if we
 * silently no-opped. Callers that take the lifecycle blocking path
 * (`syncRichStatusProjection`) surface this so the awaited broadcast can fail
 * closed.
 */
export class MissingSessionIndexRowError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session_index row missing for session_id=${sessionId}`);
    this.name = "MissingSessionIndexRowError";
    this.sessionId = sessionId;
  }
}

interface SyncSessionProjectionOptions {
  db: D1Database;
  reportEnv?: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  sessionId: string;
  session?: SessionState;
  replay?: ReplayState | null;
  richStatus?: string | null;
  publishState?: PublishProjectionState | null;
  snapshotImageId?: string | null;
  runtimeState?: RuntimeProjectionState | null;
  /**
   * Parent/child orchestration metadata (ARC-657). Set on the initial child
   * session upsert to record the spawning parent. Subsequent upserts for the
   * same session must NOT pass parentContext — the SQL leaves these columns
   * untouched on UPDATE so the original values are preserved.
   */
  parentContext?: ParentSessionContext | null;
  /**
   * ARC-1330 W11-P1 → D-59c — the FSM-sourced mirror-column write. When present, `project()`'s
   * `review_loop_done_state` / `verification_state` / `cycloid_done_*` values are written UNCONDITIONALLY
   * through the projection statement builders (see db.ts). D-59c deleted the blind `mirror*ToIndex` fns +
   * the DO persist/recompute setters, so `project()` is now the SOLE writer of these mirror columns.
   */
  fsmMirror?: MirrorColumnProjection | null;
  /**
   * ARC-1330 W11-P3 → D-59c — the FSM-sourced DISPLAY-column write. When present, `project()`'s
   * `rich_status` (the status-pill phase) is written UNCONDITIONALLY through the projection statement
   * builder (see db.ts), making `project()` the sole authoritative `rich_status` writer for ACTIVE
   * post-publish states. `feChip` is derived by the FE from `rich_status` and never persisted.
   */
  fsmDisplay?: DisplayColumnProjection | null;
  /** Authoritative terminal metadata from the lifecycle FSM, when available. */
  automationExecution?: { reason: string | null; completedAt: number } | null;
  logger?: Logger;
  source?: string;
  requestId?: string | null;
  userId?: string | null;
}

const ZERO_ROW_REPORTED_OPERATIONS = new Set<SessionProjectionOperation>([
  "updateSessionPublishState",
  "updateSessionSnapshotImageId",
  "updateSessionRuntimeBackend",
  "updateSessionRuntimeState",
]);

export function computeRichStatusProjectionValue(
  legacyRichStatus: string | null | undefined,
  fsmDisplay: Pick<DisplayColumnProjection, "richStatus"> | null | undefined,
): string | null {
  return fsmDisplay?.richStatus ?? legacyRichStatus ?? null;
}

function projectionStatementChanges(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const meta = "meta" in result ? (result as { meta?: unknown }).meta : null;
  if (!meta || typeof meta !== "object") return null;
  const changes = "changes" in meta ? (meta as { changes?: unknown }).changes : null;
  return typeof changes === "number" ? changes : null;
}

async function reportZeroRowProjectionWrite(options: {
  reportEnv?: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  logger: Logger;
  sessionId: string;
  operation: SessionProjectionOperation;
  source?: string;
}): Promise<void> {
  options.logger.warn(
    {
      event: "session_projection.zero_row",
      sessionId: options.sessionId,
      operation: options.operation,
      source: options.source,
    },
    "Session projection update matched zero rows",
  );
  if (!options.reportEnv) return;
  await reportSwallowedFailure(options.reportEnv, {
    surface: "session_projection",
    operation: options.operation,
    sessionId: options.sessionId,
    reason: "zero_rows",
    errorClass: "MissingSessionIndexRow",
    errorMessage: "session_index update matched zero rows",
  });
}

async function buildProjectionStatements(options: SyncSessionProjectionOptions): Promise<SessionProjectionStatement[]> {
  const statements: SessionProjectionStatement[] = [];
  const richStatus = computeRichStatusProjectionValue(options.richStatus, options.fsmDisplay);

  if (options.session) {
    statements.push(
      await buildUpsertSessionIndexStatement(options.db, options.session, richStatus, options.parentContext ?? null),
    );
  } else if (options.richStatus !== undefined && options.richStatus !== null) {
    statements.push(buildSyncRichStatusStatement(options.db, options.sessionId, richStatus!));
  }

  if (options.replay) {
    statements.push(buildUpsertReplayMetadataStatement(options.db, options.replay));
  }

  if (options.publishState) {
    statements.push(buildUpdateSessionPublishStateStatement(options.db, options.sessionId, options.publishState));
  }

  if (options.snapshotImageId !== undefined) {
    statements.push(buildUpdateSessionSnapshotImageIdStatement(options.db, options.sessionId, options.snapshotImageId));
  }

  if (options.runtimeState !== undefined) {
    statements.push(buildUpdateSessionRuntimeStateStatement(options.db, options.sessionId, options.runtimeState ?? {}));
  }

  if (options.fsmMirror) {
    statements.push(
      buildProjectReviewLoopDoneStateStatement(options.db, options.sessionId, options.fsmMirror.reviewLoopDoneState),
      buildProjectVerificationStateStatement(options.db, options.sessionId, options.fsmMirror.verificationState),
      buildProjectCycloidDoneStatusStatement(options.db, options.sessionId, options.fsmMirror.cycloidDone),
    );
  }

  if (options.fsmDisplay) {
    statements.push(
      buildProjectDisplayColumnsStatement(
        options.db,
        options.sessionId,
        computeRichStatusProjectionValue(null, options.fsmDisplay)!,
        options.fsmDisplay.uiLifecycleStage,
      ),
    );
  }

  return statements;
}

function logProjectionSyncFailure(
  logger: Logger,
  sessionId: string,
  operations: SessionProjectionOperation[],
  error: unknown,
  options: SyncSessionProjectionOptions,
): void {
  const operation = operations.length === 1 ? operations[0] : null;
  logger.error(
    {
      sessionId,
      ...(operation ? { operation } : { operations }),
      ...(options.source ? { source: options.source } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.userId ? { userId: options.userId } : {}),
      error: String(error),
    },
    "Session projection sync failed",
  );
}

interface ChildSlotReleaseContext {
  db: D1Database;
  sessionId: string;
  richStatus?: string | null;
  sessionStatus?: string | null;
  parentContext?: unknown;
  logger: Logger;
  source?: string;
  requestId?: string | null;
}

async function isChildSession(ctx: ChildSlotReleaseContext): Promise<boolean> {
  if (ctx.parentContext) return true;
  const childRow = await getChildSessionRow(ctx.db, ctx.sessionId);
  return !!childRow?.parent_session_id;
}

/**
 * Free a child session's per-user concurrency slot when it reaches a terminal
 * state. Called from BOTH rich_status writers (`syncSessionProjection` and the
 * lifecycle-blocking `syncRichStatusProjection`) because a finished child's
 * dominant terminal transition is persisted by whichever writer the caller used;
 * wiring it into only one leaks the slot on the other path.
 *
 * `stopped` does not release (see `CHILD_SLOT_RELEASE_PHASES`): it is resumable,
 * so it keeps its slot. Best-effort: lookup or release failures are logged,
 * never thrown, so they cannot mask the projection write. Release is idempotent
 * (COALESCE in the DAO), so a re-projected terminal status is a no-op.
 */
async function releaseChildSlotIfTerminal(ctx: ChildSlotReleaseContext): Promise<void> {
  const isTerminal =
    ctx.sessionStatus === "archived" ||
    (ctx.richStatus != null && (CHILD_SLOT_RELEASE_PHASES as ReadonlySet<string>).has(ctx.richStatus));
  if (!isTerminal) return;

  try {
    if (!(await isChildSession(ctx))) return;
    await releaseChildSessionConcurrentReservation(ctx.db, ctx.sessionId, Date.now());
  } catch (error) {
    ctx.logger.error(
      {
        sessionId: ctx.sessionId,
        ...(ctx.source ? { source: ctx.source } : {}),
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        error: String(error),
      },
      "Child session terminal concurrency release attempt failed after projection sync",
    );
  }
}

async function recordAutomationOutcomeIfTerminal(ctx: {
  db: D1Database;
  sessionId: string;
  richStatus: string | null | undefined;
  logger: Logger;
  reason?: string | null;
  completedAt?: number;
}): Promise<void> {
  if (!ctx.richStatus) return;
  try {
    const result = await recordAutomationExecutionOutcome(ctx.db, {
      sessionId: ctx.sessionId,
      phase: ctx.richStatus as Phase,
      reason: ctx.reason ?? null,
      completedAt: ctx.completedAt ?? Date.now(),
    });
    if (result === "ambiguous") {
      ctx.logger.error(
        { event: "automation_execution_outcome.ambiguous", sessionId: ctx.sessionId },
        "Automation session matched multiple jobs",
      );
    }
  } catch (error) {
    ctx.logger.error(
      { event: "automation_execution_outcome.failed", sessionId: ctx.sessionId, error: String(error) },
      "Automation outcome recording failed after projection",
    );
  }
}

export async function syncSessionProjection(options: SyncSessionProjectionOptions): Promise<void> {
  const logger = options.logger ?? log;
  let operations: SessionProjectionOperation[] = [];

  try {
    const statements = await buildProjectionStatements(options);
    if (statements.length === 0) return;
    operations = statements.map(({ operation }) => operation);

    const results = await runSessionProjectionStatements(options.db, statements);
    await Promise.all(
      statements.map(async ({ operation }, index) => {
        if (!ZERO_ROW_REPORTED_OPERATIONS.has(operation)) return;
        if (projectionStatementChanges(results[index]) !== 0) return;
        await reportZeroRowProjectionWrite({
          reportEnv: options.reportEnv,
          logger,
          sessionId: options.sessionId,
          operation,
          source: options.source,
        });
      }),
    );
    await releaseChildSlotIfTerminal({
      db: options.db,
      sessionId: options.sessionId,
      richStatus: computeRichStatusProjectionValue(options.richStatus, options.fsmDisplay),
      sessionStatus: options.session?.status,
      parentContext: options.parentContext,
      logger,
      source: options.source,
      requestId: options.requestId,
    });
    await recordAutomationOutcomeIfTerminal({
      db: options.db,
      sessionId: options.sessionId,
      richStatus: computeRichStatusProjectionValue(options.richStatus, options.fsmDisplay),
      logger,
      reason: options.automationExecution?.reason,
      completedAt: options.automationExecution?.completedAt,
    });
  } catch (error) {
    logProjectionSyncFailure(logger, options.sessionId, operations, error, options);
    throw error;
  }
}

export function scheduleSessionProjectionSync(
  options: SyncSessionProjectionOptions & { waitUntil: (promise: Promise<unknown>) => void },
): void {
  const { waitUntil, ...syncOptions } = options;
  waitUntil(runWithSentryTag("session-projection-sync", () => syncSessionProjection(syncOptions), syncOptions.logger));
}

/**
 * Lifecycle-blocking rich_status projection write. Unlike `syncSessionProjection`,
 * which silently no-ops if the UPDATE affects zero rows, this helper throws
 * `MissingSessionIndexRowError` in that case so the awaited DO broadcast path
 * fails closed instead of letting a non-existent row hide the consistency gap.
 *
 * Non-lifecycle projection traffic stays on `scheduleSessionProjectionSync`.
 */
export async function syncRichStatusProjection(options: {
  db: D1Database;
  sessionId: string;
  richStatus: string;
  // Omitted (undefined) keeps the projection SQL byte-identical to the
  // pre-plan-gate statement so a dormant session (no plan row) is unchanged;
  // an explicit boolean writes the `plan_approval_pending` column (1 while a
  // plan is pending, 0 after approve/supersede).
  planApprovalPending?: boolean;
  logger?: Logger;
  source?: string;
  requestId?: string | null;
  userId?: string | null;
}): Promise<void> {
  const logger = options.logger ?? log;
  const richStatus = options.richStatus;
  const { statement, operation } = buildSyncRichStatusStatement(
    options.db,
    options.sessionId,
    richStatus,
    options.planApprovalPending,
  );
  try {
    const result = (await statement.run()) as { meta?: { changes?: number } };
    if (result.meta?.changes === 0) {
      throw new MissingSessionIndexRowError(options.sessionId);
    }
  } catch (error) {
    // MissingSessionIndexRowError is an intentional surfaced condition (the
    // awaited DO broadcast path will warn + Sentry-tag it). Don't double-log
    // through the unexpected-D1-error pipeline.
    if (!(error instanceof MissingSessionIndexRowError)) {
      logProjectionSyncFailure(logger, options.sessionId, [operation], error, { ...options, logger });
    }
    throw error;
  }

  // Reached only after a successful UPDATE. This is the dominant writer for a
  // child's terminal rich_status (lifecycle path: persistAndBroadcastSessionStatus
  // -> persistRichStatusToD1), so the slot release must also run here, not just
  // in `syncSessionProjection`. Best-effort and idempotent.
  await releaseChildSlotIfTerminal({
    db: options.db,
    sessionId: options.sessionId,
    richStatus,
    logger,
    source: options.source,
    requestId: options.requestId,
  });
  await recordAutomationOutcomeIfTerminal({ db: options.db, sessionId: options.sessionId, richStatus, logger });
}

export async function syncRuntimeProjection(
  env: Env,
  sessionId: string,
  runtimeState: RuntimeProjectionState,
): Promise<void> {
  await syncSessionProjection({
    db: env.DB,
    reportEnv: env,
    sessionId,
    runtimeState,
    source: "runtime-projection",
  });
}

// Runtime-attach projection repair: the verified `sandbox_disconnected`
// healthy-kill root cause is a runtime projection UPDATE that matches zero
// `session_index` rows because the create-time upsert has not landed yet at
// attach time (a cross-context timing race). `syncSessionProjection` silently
// no-ops on zero rows, leaving the live VM unreferenced -> orphan-reaper bait.
// These retries give the create upsert a short window to land.
const RUNTIME_PROJECTION_REPAIR_ATTEMPTS = 3;
const RUNTIME_PROJECTION_REPAIR_DELAY_MS = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RuntimeProjectionCheckedOutcome = "applied" | "repaired" | "missing_row";

/**
 * Runtime-projection write that fails LOUD (never silent) on a zero-row match,
 * but NEVER throws on the zero-row case so the cold-spawn attach
 * catch cannot terminate the just-attached healthy sandbox over a projection
 * gap (durable-object.ts spawn catch). A real D1 error still throws,
 * preserving existing behavior. Scoped to the runtime projection only — do NOT
 * route other projection traffic through here; `syncSessionProjection`'s
 * zero-row no-op is intentional for other callers.
 *
 * On a zero-row match it retries a bounded number of times (the create-time
 * `session_index` upsert may still be landing), then, if the row never
 * appears, logs loud and returns `missing_row` without throwing. The
 * orphan-reaper owner-guard is the backstop that protects the live VM while
 * the row is absent.
 */
export async function syncRuntimeProjectionChecked(
  env: Env,
  sessionId: string,
  runtimeState: RuntimeProjectionState,
  options: {
    logger?: Logger;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    delayMs?: number;
  } = {},
): Promise<RuntimeProjectionCheckedOutcome> {
  const logger = options.logger ?? log;
  const attempts = options.attempts ?? RUNTIME_PROJECTION_REPAIR_ATTEMPTS;
  const delayMs = options.delayMs ?? RUNTIME_PROJECTION_REPAIR_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { statement } = buildUpdateSessionRuntimeStateStatement(env.DB, sessionId, runtimeState);
    let changes: number | undefined;
    try {
      const result = (await statement.run()) as { meta?: { changes?: number } };
      changes = result.meta?.changes;
    } catch (error) {
      logProjectionSyncFailure(logger, sessionId, ["updateSessionRuntimeState"], error, {
        db: env.DB,
        sessionId,
        source: "runtime-projection-checked",
        logger,
      });
      throw error;
    }
    // `changes === undefined` (driver omitted meta) is treated as applied: do
    // not loop or alarm on an unknown count.
    if (changes !== 0) {
      return attempt === 1 ? "applied" : "repaired";
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  logger.error(
    {
      event: "runtime_projection_missing_row",
      sessionId,
      source: "runtime-projection-checked",
      runtimeSandboxId: runtimeState.runtimeSandboxId ?? null,
      runtimeBackend: runtimeState.runtimeBackend ?? null,
      attempts,
    },
    "Runtime projection matched no session_index row after retries; live runtime is unreferenced (owner-guard backstop)",
  );
  return "missing_row";
}

export async function syncRuntimeBackendProjection(
  env: Env,
  sessionId: string,
  runtimeBackend: SandboxRuntimeBackend,
  options: {
    logger?: Logger;
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    delayMs?: number;
  } = {},
): Promise<RuntimeProjectionCheckedOutcome> {
  const logger = options.logger ?? log;
  const attempts = options.attempts ?? RUNTIME_PROJECTION_REPAIR_ATTEMPTS;
  const delayMs = options.delayMs ?? RUNTIME_PROJECTION_REPAIR_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const operation = "updateSessionRuntimeBackend";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let changes: number | null;
    try {
      const results = await runSessionProjectionStatements(env.DB, [
        buildUpdateSessionRuntimeBackendStatement(env.DB, sessionId, runtimeBackend),
      ]);
      changes = projectionStatementChanges(results[0]);
    } catch (error) {
      logProjectionSyncFailure(logger, sessionId, [operation], error, {
        db: env.DB,
        sessionId,
        source: "runtime-backend-projection",
        logger,
      });
      throw error;
    }

    // `changes === null` (driver omitted meta) is treated as applied: do not
    // loop or alarm on an unknown count.
    if (changes !== 0) {
      return attempt === 1 ? "applied" : "repaired";
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  await reportZeroRowProjectionWrite({
    reportEnv: env,
    logger,
    sessionId,
    operation,
    source: "runtime-backend-projection",
  });
  return "missing_row";
}
