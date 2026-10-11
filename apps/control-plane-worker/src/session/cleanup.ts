import { ARCHIVABLE_STALE_TERMINAL_PHASES_ARRAY, TERMINAL_PHASES_ARRAY } from "../../../../shared/session/phase.js";
import { getE2BRuntimeCleanupBatchLimit, getE2BRuntimeLiveLeaseMs } from "../constants/e2b-cleanup";
import { SESSION_AUTO_ARCHIVE_MIN_AGE_MS } from "../constants/session-cleanup";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { baseControlPlaneMetricTags } from "../observability/metric-tags";
import { type CountMetricSeries, postCountMetricSeries } from "../observability/pr-metrics";
import { KNOWN_RUNTIME_PROVIDERS, parsePersistedRuntimeBackend, type RuntimeBackend } from "../sandbox/runtime-backend";
import type { Env } from "../types";
import { deleteOrphanedWebhookRefs } from "../webhooks/db";
import { deleteOrphanedSessionIndex } from "./db";
import type {
  E2BRuntimeCleanupReason,
  E2BRuntimeCleanupRunRequest,
  E2BRuntimeCleanupRunResponse,
  SessionPhaseReaperAction,
  SessionPhaseReaperReason,
  SessionPhaseReaperRequest,
  SessionPhaseReaperResponse,
} from "./internal-routes";
import { SESSION_BEARER_INTERNAL_ROUTES, SESSION_INTERNAL_ORIGIN } from "./internal-routes";
import { getSessionStub } from "./state";

const log = createLogger({ bindings: { component: "session-cleanup" } });
const REVIEW_LISTENING_MAX_MONITORING_MS = 7 * 24 * 60 * 60 * 1_000;
// Grace before a terminal-but-`active` session (never archived, so the archived-row GC never
// reclaimed it) is auto-archived by the reaper. Mirrors the review-listening TTL. ARC-1455.
const TERMINAL_STALE_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

// Cron cleanup selects candidates for every managed runtime provider. Derived from
// KNOWN_RUNTIME_PROVIDERS (compile-time constants; no injection surface) so a new
// provider is picked up here in lockstep. A NULL/legacy `runtime_provider` stays
// excluded — a cleared row or a session that never had a managed runtime has no VM
// to pause/retire, and the DO's computeE2BCleanupDecision would skip it anyway.
const MANAGED_RUNTIME_PROVIDER_IN_LIST = KNOWN_RUNTIME_PROVIDERS.map((provider) => `'${provider}'`).join(", ");

// Grace before a `killed`-state row's VM is swept by the cron. The DO can mark a
// runtime `killed` on a transient disconnect while the VM is still alive/building
// (ARC-1248 alive-while-killed churn), so wait this long past the kill timestamp
// (`runtime_state_expires_at`, set to the kill `nowMs` by every killed-setter)
// before reclaiming. Exported because PR 3's Freestyle audit imports the SAME
// constant so the sweep and the leak alert never drift.
export const KILLED_RUNTIME_REAP_GRACE_MS = 60 * 60 * 1000; // 1h

export async function cleanupOrphanedSession(db: D1Database, sessionId: string, logger: Logger = log): Promise<void> {
  try {
    await Promise.all([deleteOrphanedSessionIndex(db, sessionId), deleteOrphanedWebhookRefs(db, sessionId)]);
    logger.info({ sessionId }, "Orphaned session cleaned up from D1");
  } catch (err) {
    logger.error({ sessionId, error: String(err) }, "Failed to clean up orphaned session from D1");
  }
}

// ---------------------------------------------------------------------------
// Session phase cleanup
// ---------------------------------------------------------------------------

interface SessionPhaseReaperCandidate {
  sessionId: string;
  action: SessionPhaseReaperAction;
  reason: SessionPhaseReaperReason;
}

export async function cleanupStaleSessionPhases(
  env: Env,
  nowMs = Date.now(),
): Promise<{
  scanned: number;
  archived: number;
  reviewListeningExited: number;
  skipped: number;
  errors: number;
}> {
  const logger = createLogger({ bindings: { component: "session-phase-reaper" } });
  const batchLimit = getE2BRuntimeCleanupBatchLimit(env);
  const runtimeCutoffMs = nowMs - getE2BRuntimeLiveLeaseMs(env);
  const autoArchiveCutoffMs = nowMs - SESSION_AUTO_ARCHIVE_MIN_AGE_MS;
  const reviewListeningCutoffMs = nowMs - REVIEW_LISTENING_MAX_MONITORING_MS;
  const terminalStaleCutoffMs = nowMs - TERMINAL_STALE_GRACE_MS;
  const terminalPlaceholders = TERMINAL_PHASES_ARRAY.map(() => "?").join(", ");
  const archivablePlaceholders = ARCHIVABLE_STALE_TERMINAL_PHASES_ARRAY.map(() => "?").join(", ");

  const rows = await env.DB.prepare(
    `SELECT session_id,
            CASE
              WHEN rich_status = 'review_listening' THEN 'exit_review_listening'
              ELSE 'archive'
            END AS action,
            CASE
              WHEN rich_status = 'review_listening' THEN 'review_listening_ttl'
              WHEN rich_status IN (${archivablePlaceholders}) THEN 'terminal_stale'
              WHEN runtime_state = 'killed' THEN 'runtime_killed'
              WHEN runtime_state IS NULL THEN 'runtime_missing_ttl'
              ELSE 'live_lease_expired'
            END AS reason
     FROM session_index
     WHERE status = 'active'
       AND (
         rich_status = 'review_listening'
         OR CASE
              WHEN typeof(created_at) = 'text' THEN unixepoch(created_at) * 1000
              ELSE created_at
            END <= ?
       )
       AND (
         -- Terminal-but-active sessions that were never archived: reclaim once past the grace so
         -- the archived-row GC can drop them and the reconciler stops sweeping them. ARC-1455.
         (rich_status IN (${archivablePlaceholders}) AND updated_at < ?)
         OR (
           -- Non-terminal stale sessions: review-listening past its TTL, or a dead runtime.
           (rich_status IS NULL OR rich_status NOT IN (${terminalPlaceholders}))
           AND (
             (rich_status = 'review_listening' AND updated_at < ?)
             OR (
               (rich_status IS NULL OR rich_status != 'review_listening')
               AND COALESCE(plan_approval_pending, 0) = 0
               AND (
                 runtime_state = 'killed'
                 OR (runtime_state IS NULL AND updated_at < ?)
                 OR (
                   runtime_state = 'running'
                   AND runtime_live_lease_expires_at IS NOT NULL
                   AND runtime_live_lease_expires_at < ?
                 )
               )
             )
           )
         )
       )
     ORDER BY updated_at ASC, session_id ASC
     LIMIT ?`,
  )
    .bind(
      ...ARCHIVABLE_STALE_TERMINAL_PHASES_ARRAY,
      autoArchiveCutoffMs,
      ...ARCHIVABLE_STALE_TERMINAL_PHASES_ARRAY,
      terminalStaleCutoffMs,
      ...TERMINAL_PHASES_ARRAY,
      reviewListeningCutoffMs,
      runtimeCutoffMs,
      nowMs,
      batchLimit,
    )
    .all<{ session_id: string; action: SessionPhaseReaperAction; reason: SessionPhaseReaperReason }>();

  const candidates: SessionPhaseReaperCandidate[] = (rows.results ?? []).map((row) => ({
    sessionId: row.session_id,
    action: row.action,
    reason: row.reason,
  }));

  let scanned = 0;
  let archived = 0;
  let reviewListeningExited = 0;
  let skipped = 0;
  let errors = 0;

  for (const candidate of candidates) {
    scanned++;
    try {
      const result = await reapSessionPhaseViaSessionDO(env, { ...candidate, nowMs });
      if (!result.terminalized) {
        skipped++;
        await recordSessionPhaseReaperMetric(env, { outcome: "skipped", reason: result.reason }, logger);
        continue;
      }
      if (result.action === "archive") archived++;
      else reviewListeningExited++;
      await recordSessionPhaseReaperMetric(env, { outcome: "terminalized", reason: result.reason }, logger);
    } catch (err) {
      errors++;
      await recordSessionPhaseReaperMetric(env, { outcome: "error", reason: candidate.reason }, logger);
      logger.error(
        { sessionId: candidate.sessionId, reason: candidate.reason, error: String(err) },
        "Session phase reaper failed",
      );
    }
  }

  return { scanned, archived, reviewListeningExited, skipped, errors };
}

async function reapSessionPhaseViaSessionDO(
  env: Env,
  request: SessionPhaseReaperRequest,
): Promise<SessionPhaseReaperResponse> {
  const route = SESSION_BEARER_INTERNAL_ROUTES.sessionPhaseReap;
  const response = await getSessionStub(env, request.sessionId).fetch(
    new URL(route.path, SESSION_INTERNAL_ORIGIN).href,
    {
      method: route.method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.SANDBOX_RUNTIME_CLEANUP_SECRET}`,
        "x-session-id": request.sessionId,
      },
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    throw new Error(`Session phase reaper DO call failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as SessionPhaseReaperResponse;
}

async function recordSessionPhaseReaperMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { outcome: "terminalized" | "skipped" | "error"; reason: string },
  logger: Logger,
): Promise<void> {
  try {
    await emitSessionPhaseReaperMetric(env, tags);
  } catch (err) {
    logger.warn(
      { error: String(err), outcome: tags.outcome, reason: tags.reason },
      "Session phase reaper metric failed",
    );
  }
}

async function emitSessionPhaseReaperMetric(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  tags: { outcome: "terminalized" | "skipped" | "error"; reason: string },
): Promise<void> {
  if (!env.DD_API_KEY) return;
  const series: CountMetricSeries[] = [
    {
      metric: "arcanist.session.phase_reaper",
      tags: [...baseControlPlaneMetricTags(env), `outcome:${tags.outcome}`, `reason:${tags.reason}`],
      value: 1,
    },
  ];
  await postCountMetricSeries(env.DD_API_KEY, series, "session-phase-reaper");
}

// ---------------------------------------------------------------------------
// E2B runtime cleanup
// ---------------------------------------------------------------------------

interface E2BCleanupCandidate {
  sessionId: string;
  runtimeSandboxId: string;
  runtimeBackend: RuntimeBackend;
  reason: E2BRuntimeCleanupReason;
  candidateAt: number;
}

// Row shapes for the candidate-select batch. `db.batch()` carries a single row
// generic, so each positional result is cast to its branch shape below.
interface E2BCleanupCandidateRow {
  session_id: string;
  runtime_sandbox_id: string;
  runtime_backend: string | null;
  candidate_at: number;
}

interface E2BCleanupRunningCandidateRow extends E2BCleanupCandidateRow {
  // Query CASE expression: 1 when the live lease is NULL (aged candidate), else 0.
  lease_was_null: number;
}

export async function cleanupExpiredE2BRuntimes(
  env: Env,
  nowMs = Date.now(),
): Promise<{
  scanned: number;
  paused: number;
  killed: number;
  cleared: number;
  terminalDisabled: number;
  errors: number;
}> {
  const logger = createLogger({ bindings: { component: "e2b-runtime-cleanup" } });
  const batchLimit = getE2BRuntimeCleanupBatchLimit(env);
  // Minimum age before a NULL-lease running row is eligible. The lease-set leg
  // is already gated by its own expiry; a NULL-lease row has no expiry, so use
  // the live-lease window as an age cutoff (`runtime_created_at < now - lease`)
  // and not `now`, which would select every existing row and pause freshly
  // created runtimes before their lease would even have expired.
  const nullLeaseMaxCreatedAt = nowMs - getE2BRuntimeLiveLeaseMs(env);
  // A `killed` row is only swept once its kill timestamp (`runtime_state_expires_at`)
  // is older than the grace window, so a transiently-killed-but-alive VM converges
  // before we terminate it (see KILLED_RUNTIME_REAP_GRACE_MS).
  const killedReapCutoffMs = nowMs - KILLED_RUNTIME_REAP_GRACE_MS;

  // ---- 1. Query D1 for candidates across four branches ----
  // One round-trip via db.batch() (docs/database.md: never Promise.all for
  // independent D1 queries). Results are POSITIONAL — the destructure order below
  // MUST match the statement order in the batch array.

  const [pausedRows, runningRows, malformedRows, killedRows] = await env.DB.batch([
    // Paused retention branch
    env.DB.prepare(
      `SELECT session_id, runtime_sandbox_id, runtime_backend, runtime_state_expires_at AS candidate_at
       FROM session_index
       WHERE runtime_provider IN (${MANAGED_RUNTIME_PROVIDER_IN_LIST})
         AND runtime_state = 'paused'
         AND runtime_sandbox_id IS NOT NULL
         AND runtime_state_expires_at IS NOT NULL
         AND runtime_state_expires_at < ?`,
    ).bind(nowMs),
    // Running branch: a running row is a cleanup candidate when EITHER its live
    // lease is set and expired, OR (the common prod case) the lease is NULL and
    // the row was created before the live-lease window (so it has aged past the
    // point a lease would have expired). Without the NULL-lease leg a running row
    // with a null lease matches no branch and is never paused/killed; without the
    // age cutoff it would select fresh runtimes the DO decision would then pause
    // early (it has no created-at fallback). The DO decision handler remains the
    // authority and returns skip for fresh activity, so widening selection is safe.
    env.DB.prepare(
      `SELECT session_id, runtime_sandbox_id, runtime_backend,
              COALESCE(runtime_live_lease_expires_at, runtime_created_at) AS candidate_at,
              CASE WHEN runtime_live_lease_expires_at IS NULL THEN 1 ELSE 0 END AS lease_was_null
       FROM session_index
       WHERE runtime_provider IN (${MANAGED_RUNTIME_PROVIDER_IN_LIST})
         AND runtime_state = 'running'
         AND runtime_sandbox_id IS NOT NULL
         AND (
           (runtime_live_lease_expires_at IS NOT NULL AND runtime_live_lease_expires_at < ?)
           OR (runtime_live_lease_expires_at IS NULL AND runtime_created_at IS NOT NULL AND runtime_created_at < ?)
         )`,
    ).bind(nowMs, nullLeaseMaxCreatedAt),
    // Malformed projection repair branch
    env.DB.prepare(
      `SELECT session_id, runtime_sandbox_id, runtime_backend, runtime_created_at AS candidate_at
       FROM session_index
       WHERE runtime_provider IN (${MANAGED_RUNTIME_PROVIDER_IN_LIST})
         AND runtime_sandbox_id IS NOT NULL
         AND runtime_state IS NULL
         AND runtime_created_at IS NOT NULL
         AND runtime_created_at < ?`,
    ).bind(nowMs),
    // Killed sweep branch: a row the DO marked `killed` never reaches the
    // paused/running/malformed branches, so nothing else feeds its VM to the DO.
    // `runtime_state_expires_at` is the kill timestamp (every killed-setter sets it
    // to the kill `nowMs`); require it older than the grace window so the ARC-1248
    // alive-while-killed churn converges first. COALESCE to `updated_at`: a killed
    // row that somehow lacks the expiry stamp (drifted future setter, damaged row)
    // must not be invisible to the only sweep that reclaims killed rows — the row
    // timestamp anchors the same grace conservatively. The DO re-decides live and
    // its malformed/unknown-state fallthrough terminates the VM.
    env.DB.prepare(
      `SELECT session_id, runtime_sandbox_id, runtime_backend,
              COALESCE(runtime_state_expires_at, updated_at) AS candidate_at
       FROM session_index
       WHERE runtime_provider IN (${MANAGED_RUNTIME_PROVIDER_IN_LIST})
         AND runtime_state = 'killed'
         AND runtime_sandbox_id IS NOT NULL
         AND COALESCE(runtime_state_expires_at, updated_at) < ?`,
    ).bind(killedReapCutoffMs),
  ]);

  // ---- 2. Union, dedupe, sort, and take batch limit ----

  const allRows: E2BCleanupCandidate[] = [];
  const seen = new Set<string>();

  const addRows = <
    Row extends {
      session_id: string;
      runtime_sandbox_id: string;
      runtime_backend: string | null;
      candidate_at: number;
    },
  >(
    result: D1Result<Row>,
    reason: E2BRuntimeCleanupReason | ((row: Row) => E2BRuntimeCleanupReason),
  ) => {
    for (const row of result.results ?? []) {
      if (seen.has(row.session_id)) continue;
      let runtimeBackend: RuntimeBackend;
      try {
        runtimeBackend = parsePersistedRuntimeBackend(row.runtime_backend);
      } catch (error) {
        logger.error(
          { sessionId: row.session_id, runtimeBackend: row.runtime_backend, error: String(error) },
          "Skipping E2B cleanup candidate with invalid runtime backend",
        );
        continue;
      }
      seen.add(row.session_id);
      allRows.push({
        sessionId: row.session_id,
        runtimeSandboxId: row.runtime_sandbox_id,
        runtimeBackend,
        reason: typeof reason === "function" ? reason(row) : reason,
        candidateAt: row.candidate_at,
      });
    }
  };

  addRows(pausedRows as D1Result<E2BCleanupCandidateRow>, "paused_expired");
  // The running branch matches two legs: a set-and-expired lease keeps the
  // existing reason; a NULL lease aged past retention gets a distinct reason for
  // observability. lease_was_null is computed by the query CASE expression.
  addRows(runningRows as D1Result<E2BCleanupRunningCandidateRow>, (row) =>
    row.lease_was_null ? "running_null_lease_aged" : "live_lease_expired",
  );
  addRows(malformedRows as D1Result<E2BCleanupCandidateRow>, "malformed_projection");
  addRows(killedRows as D1Result<E2BCleanupCandidateRow>, "killed_stale");

  allRows.sort((a, b) => a.candidateAt - b.candidateAt || a.sessionId.localeCompare(b.sessionId));

  const candidates = allRows.slice(0, batchLimit);
  const backlog = allRows.length - candidates.length;

  if (backlog > 0) {
    logger.info({ backlog, batchLimit, total: allRows.length }, "E2B cleanup backlog exceeds batch limit");
  }

  // ---- 3. Process candidates ----

  let scanned = 0;
  let paused = 0;
  let killed = 0;
  let cleared = 0;
  let terminalDisabled = 0;
  let errors = 0;

  for (const candidate of candidates) {
    scanned++;
    try {
      // One call: the DO runs the whole checkpointed cleanup workflow (decide
      // -> terminate -> clear/pause, with bounded retry) and returns the
      // outcome. The worker no longer builds an E2B client or terminates
      // directly — provider lifecycle lives in the runtime owner.
      const result = await runE2BRuntimeCleanupViaSessionDO(env, {
        sessionId: candidate.sessionId,
        projectedRuntimeSandboxId: candidate.runtimeSandboxId,
        projectedRuntimeBackend: candidate.runtimeBackend,
        reason: candidate.reason,
        nowMs,
      });

      switch (result.outcome) {
        case "paused":
          paused++;
          break;
        case "cleared":
          // terminal_disabled clears without a provider terminate; everything
          // else reached clear via a terminate (killed or already-missing).
          if (result.reasonCode === "terminal_disabled") {
            terminalDisabled++;
          } else {
            killed++;
          }
          cleared++;
          break;
        case "retry_scheduled":
        case "terminal_failed":
          errors++;
          break;
        case "skipped":
        default:
          break;
      }
    } catch (err) {
      errors++;
      logger.error({ sessionId: candidate.sessionId, error: String(err) }, "E2B cleanup candidate processing failed");
    }
  }

  return { scanned, paused, killed, cleared, terminalDisabled, errors };
}

// ---------------------------------------------------------------------------
// DO call helper
// ---------------------------------------------------------------------------

// Exported for the FSM `terminate_runtime` executor (R4), which drives the SAME checkpointed DO
// cleanup-run workflow the cron uses — no parallel terminate path.
export async function runE2BRuntimeCleanupViaSessionDO(
  env: Env,
  request: E2BRuntimeCleanupRunRequest,
): Promise<E2BRuntimeCleanupRunResponse> {
  const stub = getSessionStub(env, request.sessionId);
  const response = await stub.fetch(new URL("/internal/runtime/e2b/cleanup-run", SESSION_INTERNAL_ORIGIN).href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SANDBOX_RUNTIME_CLEANUP_SECRET}`,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Cleanup run DO call failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as E2BRuntimeCleanupRunResponse;
}
