// ARC-1330 lifecycle FSM — persistence for the single per-session `pr_coordination`
// record (migration 0214). Pure DAO: insert, read, and the single-writer
// compare-and-swap primitive. NO transition logic lives here — the spine
// (`applyEvent`, a later wave) computes decisions and rides `casUpdatePrCoordination`.
//
// CAS shape mirrors the closest existing idiom: `casDisarmLifecycleWatchdog`
// (do-db.ts — version/condition-guarded UPDATE, rows-changed read).
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
// The verification-named fields below map from the design's conceptual `qa_*`
// vocabulary; the verification→qa rename is the QA owner's job (out of scope).

import { D1_RETRY_SAFE_MARKER } from "../db/errors";

export const SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX = "pr-coord:";

/**
 * In-memory shape of one `pr_coordination` row. Enum-ish fields (`state`,
 * `verdict`, `blockedReason`, …) are typed loosely as strings here because this
 * module is pure persistence; the precise FSM closed-enum types are layered on
 * top in `fsm/types.ts` (`FsmRecord`), which refines this record. Booleans are
 * stored as 0/1 in SQLite and surfaced as `boolean` here.
 */
export interface PrCoordinationRecord {
  sessionId: string;
  version: number;
  state: string;
  prUrl: string | null;
  headSha: string | null;
  verdict: string | null;
  verdictHeadSha: string | null;
  verificationRunHead: string | null;
  verificationRunId: number;
  verificationChildId: string | null;
  verificationRunCount: number;
  ciFixRounds: number;
  inFlightEpochId: string | null;
  codeChangedSinceVerification: boolean;
  promptIntendsChange: boolean | null;
  mergeReadyReopenCount: number;
  blockedReason: string | null;
  failureReason: string | null;
  stopMode: string | null;
  preStopState: string | null;
  updateBranchQueuedAt: number | null;
  deadlineAt: number | null;
  stateEnteredAt: number | null;
}

/** Fields a CAS write may set (everything except the key and the CAS-owned `version`). */
export type PrCoordinationUpdate = Partial<Omit<PrCoordinationRecord, "sessionId" | "version">>;

/** Raw column shape as it comes back from SQLite (snake_case; booleans as 0/1). */
interface PrCoordinationRow {
  session_id: string;
  version: number;
  state: string;
  pr_url: string | null;
  head_sha: string | null;
  verdict: string | null;
  verdict_head_sha: string | null;
  verification_run_head: string | null;
  verification_run_id: number;
  verification_child_id: string | null;
  verification_run_count: number;
  ci_fix_rounds: number;
  in_flight_epoch_id: string | null;
  code_changed_since_verification: number;
  prompt_intends_change: number | null;
  merge_ready_reopen_count: number;
  blocked_reason: string | null;
  failure_reason: string | null;
  stop_mode: string | null;
  pre_stop_state: string | null;
  update_branch_queued_at: number | null;
  deadline_at: number | null;
  state_entered_at: number | null;
}

/**
 * Maps each updatable record field to its column. Used by `casUpdatePrCoordination`
 * to build the SET clause from an allowlist — column names are never taken from
 * caller input, only values are bound, so the dynamic SET cannot inject SQL.
 */
const COLUMN_BY_FIELD: Record<keyof PrCoordinationUpdate, string> = {
  state: "state",
  prUrl: "pr_url",
  headSha: "head_sha",
  verdict: "verdict",
  verdictHeadSha: "verdict_head_sha",
  verificationRunHead: "verification_run_head",
  verificationRunId: "verification_run_id",
  verificationChildId: "verification_child_id",
  verificationRunCount: "verification_run_count",
  ciFixRounds: "ci_fix_rounds",
  inFlightEpochId: "in_flight_epoch_id",
  codeChangedSinceVerification: "code_changed_since_verification",
  promptIntendsChange: "prompt_intends_change",
  mergeReadyReopenCount: "merge_ready_reopen_count",
  blockedReason: "blocked_reason",
  failureReason: "failure_reason",
  stopMode: "stop_mode",
  preStopState: "pre_stop_state",
  updateBranchQueuedAt: "update_branch_queued_at",
  deadlineAt: "deadline_at",
  stateEnteredAt: "state_entered_at",
};

const INSERT_FIELDS = [
  "sessionId",
  "version",
  "state",
  "prUrl",
  "headSha",
  "verdict",
  "verdictHeadSha",
  "verificationRunHead",
  "verificationRunId",
  "verificationChildId",
  "verificationRunCount",
  "ciFixRounds",
  "inFlightEpochId",
  "codeChangedSinceVerification",
  "promptIntendsChange",
  "mergeReadyReopenCount",
  "blockedReason",
  "failureReason",
  "stopMode",
  "preStopState",
  "updateBranchQueuedAt",
  "deadlineAt",
  "stateEnteredAt",
] as const satisfies readonly (keyof PrCoordinationRecord)[];

const REBASELINE_FIELDS = Object.keys(COLUMN_BY_FIELD) as Array<keyof PrCoordinationUpdate>;

/** Fields stored as a 0/1 INTEGER in SQLite. */
const BOOL_FIELDS = new Set<keyof PrCoordinationUpdate>(["codeChangedSinceVerification", "promptIntendsChange"]);

function decodeBool(value: number): boolean {
  return value === 1;
}

function decodeNullableBool(value: number | null): boolean | null {
  return value == null ? null : value === 1;
}

function encodeFieldValue(field: keyof PrCoordinationUpdate, value: unknown): unknown {
  if (value == null) return null;
  if (BOOL_FIELDS.has(field)) return value ? 1 : 0;
  return value;
}

function encodeRecordFieldValue(record: PrCoordinationRecord, field: keyof PrCoordinationRecord): unknown {
  if (field === "sessionId") return record.sessionId;
  if (field === "version") return record.version;
  return encodeFieldValue(field, record[field]);
}

function rowToRecord(row: PrCoordinationRow): PrCoordinationRecord {
  return {
    sessionId: row.session_id,
    version: row.version,
    state: row.state,
    prUrl: row.pr_url,
    headSha: row.head_sha,
    verdict: row.verdict,
    verdictHeadSha: row.verdict_head_sha,
    verificationRunHead: row.verification_run_head,
    verificationRunId: row.verification_run_id,
    verificationChildId: row.verification_child_id,
    verificationRunCount: row.verification_run_count,
    ciFixRounds: row.ci_fix_rounds,
    inFlightEpochId: row.in_flight_epoch_id,
    codeChangedSinceVerification: decodeBool(row.code_changed_since_verification),
    promptIntendsChange: decodeNullableBool(row.prompt_intends_change),
    mergeReadyReopenCount: row.merge_ready_reopen_count,
    blockedReason: row.blocked_reason,
    failureReason: row.failure_reason,
    stopMode: row.stop_mode,
    preStopState: row.pre_stop_state,
    updateBranchQueuedAt: row.update_branch_queued_at,
    deadlineAt: row.deadline_at,
    stateEnteredAt: row.state_entered_at,
  };
}

export function syntheticPrCoordinatorSessionId(prUrl: string): string {
  const normalized = normalizeSyntheticPrUrl(prUrl);
  return `${SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX}${encodeURIComponent(normalized)}`;
}

function normalizeSyntheticPrUrl(prUrl: string): string {
  const trimmed = prUrl.trim();
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function isSyntheticPrCoordinatorSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX);
}

const NON_SYNTHETIC_PR_COORDINATOR_PREDICATE = "session_id NOT LIKE ?";
const NON_SYNTHETIC_PR_COORDINATOR_BIND = `${SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX}%`;
const NON_SYNTHETIC_PR_COORDINATOR_PREDICATE_FOR_PC = "pc.session_id NOT LIKE ?";

/** Read the coordination record for a session, or null if none exists yet. */
export async function getPrCoordination(db: D1Database, sessionId: string): Promise<PrCoordinationRecord | null> {
  const row = await db
    .prepare(`SELECT * FROM pr_coordination WHERE session_id = ?`)
    .bind(sessionId)
    .first<PrCoordinationRow>();
  return row ? rowToRecord(row) : null;
}

export async function getSyntheticPrCoordinationByPrUrl(
  db: D1Database,
  prUrl: string,
): Promise<PrCoordinationRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE session_id = ?`,
    )
    .bind(syntheticPrCoordinatorSessionId(prUrl))
    .first<PrCoordinationRow>();
  return row ? rowToRecord(row) : null;
}

/**
 * The canonical REAL coordinating session for a PR — the offboarding-safe ownership
 * key the PR-activity capture tap gates on. Returns null when the PR has no real
 * Cycloid session (untracked, or only a synthetic coordinator).
 *
 * Synthetic coordinators (`pr-coord:<url>`) are excluded on purpose: they have no
 * `session_index` row, so they escape the session-id offboarding cascade
 * (business/offboarding-tables.ts). Capturing their PR content would leave
 * un-deletable customer data, so a synthetic-only PR is not captured. Newest
 * coordinator wins; all real coordinators for a PR share the repo/business, so the
 * choice is offboarding-equivalent.
 */
export async function getTrackingSessionIdForPrUrl(db: D1Database, prUrl: string): Promise<string | null> {
  const trimmed = prUrl.trim();
  if (!trimmed) return null;
  const row = await db
    .prepare(
      `SELECT session_id FROM pr_coordination
       WHERE pr_url = ?
         AND session_id NOT LIKE ?
         AND state NOT IN ('MERGED', 'CLOSED', 'SUPERSEDED', 'ARCHIVED')
       ORDER BY COALESCE(state_entered_at, 0) DESC, session_id DESC
       LIMIT 1`,
    )
    .bind(trimmed, `${SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX}%`)
    .first<{ session_id: string }>();
  return row?.session_id ?? null;
}

export async function getVerificationRunCountForPrCoordination(
  db: D1Database,
  input: { prUrl: string; parentSessionId?: string | null },
): Promise<number | null> {
  const parentSessionId = input.parentSessionId?.trim();
  if (parentSessionId) {
    const row = await db
      .prepare(`SELECT verification_run_count FROM pr_coordination WHERE session_id = ?`)
      .bind(parentSessionId)
      .first<{ verification_run_count: number }>();
    if (row) return Number(row.verification_run_count);
  }

  const prUrl = input.prUrl.trim();
  if (!prUrl) return null;
  const syntheticRow = await getSyntheticPrCoordinationByPrUrl(db, prUrl);
  if (syntheticRow) return syntheticRow.verificationRunCount;
  const row = await db
    .prepare(
      `SELECT verification_run_count FROM pr_coordination
       WHERE pr_url = ?
       ORDER BY COALESCE(state_entered_at, 0) DESC, session_id DESC
       LIMIT 1`,
    )
    .bind(prUrl)
    .first<{ verification_run_count: number }>();
  return row ? Number(row.verification_run_count) : null;
}

/**
 * Compatibility-only read for rows written before the intent-observer removal.
 * The column is intentionally excluded from the live record shape so new FSM
 * transitions cannot depend on it, but terminal projection still reaps any
 * legacy child that was already stamped before the removal deployed.
 */
export async function getLegacyIntentChildId(db: D1Database, sessionId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT intent_child_id FROM pr_coordination WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ intent_child_id: string | null }>();
  return row?.intent_child_id ?? null;
}

/**
 * State-derived D17 TRANSIENT repair candidates (keystone-review split). This deliberately is NOT an
 * outbox: the current `pr_coordination` row is the source of truth, and callers re-derive owed
 * effects from committed state. This scan covers ONLY the transient classes — VERIFYING spawn repair
 * and the in-flight-epoch (report-only) class. Terminal states NEVER appear here: they accumulate
 * forever (NEEDS_YOU/FAILED re-open only by manual retrigger), so an oldest-first window that
 * included them would fill permanently and starve a freshly-stranded VERIFYING row — the exact
 * silent-stall class this repair exists for. Terminals ride the separate recency-bounded lister
 * below — including via the epoch arm: a terminal row with a lingering `in_flight_epoch_id` must not
 * re-enter this window (Greptile review), so the epoch predicate is state-scoped too. (`pr_coordination` holds hundreds of rows, not millions — a scan predicate needs no
 * dedicated index, per docs/database.md.)
 */
export async function listPrCoordinationTransientRepairCandidates(
  db: D1Database,
  input: { limit: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE}
         AND (
           state = 'VERIFYING'
           OR (in_flight_epoch_id IS NOT NULL AND state IN ('REVIEW', 'VERIFYING'))
         )
       ORDER BY COALESCE(state_entered_at, 0) ASC, session_id ASC
       LIMIT ?`,
    )
    .bind(NON_SYNTHETIC_PR_COORDINATOR_BIND, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/**
 * ARC-1445 self-heal candidates: REVIEW rows with NO in-flight epoch that STILL hold undispositioned
 * actionable items (`disposition='none'`). This is the wedge the forward `epoch.settled` arm-the-drain fix
 * cannot reach retroactively — a row whose terminal fired before the fix, or whose items were left by a
 * now-terminal epoch that no live epoch covers, so `caught_up` freezes at undispositioned ≥ 1. Deliberately
 * a SEPARATE lister from {@link listPrCoordinationTransientRepairCandidates} (which excludes null-inflight
 * REVIEW rows so the standing REVIEW stock never starves its VERIFYING/in-flight window). The `EXISTS`
 * undispositioned predicate keeps it narrow (most healthy REVIEW rows carry none); the caller further
 * filters by "no live/ready epoch covers them" (`hasPendingReviewLoopWork`) before firing.
 */
export async function listReviewRowsWithUndispositionedNoInflight(
  db: D1Database,
  input: { limit: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT pc.* FROM pr_coordination pc
       WHERE ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE_FOR_PC}
         AND pc.state = 'REVIEW' AND pc.in_flight_epoch_id IS NULL
         AND EXISTS (
           SELECT 1 FROM pr_review_item_dispositions d
           WHERE d.session_id = pc.session_id AND d.pr_url = pc.pr_url AND d.disposition = 'none'
         )
       ORDER BY COALESCE(pc.state_entered_at, 0) ASC, pc.session_id ASC
       LIMIT ?`,
    )
    .bind(NON_SYNTHETIC_PR_COORDINATOR_BIND, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/**
 * State-derived D17 TERMINAL redelivery candidates — loud/settle re-delivery for rows that JUST
 * entered a terminal (keystone-review split). HARD RECENCY BOUND: only rows whose terminal entry is
 * within `enteredSinceMs` are eligible. Two failure classes this structurally prevents (both found by
 * the flip keystone review): (1) at the first LIVE sweep, shadow-era terminals — whose loud() never
 * ran because the shadow sink is a no-op, and whose legacy DM used a DIFFERENT dedup key
 * (`blocked-dm:<sid>:<kind>:<headSha>` vs the FSM's `…:fsm:loud:…`) — would all be re-actioned,
 * re-DMing users about long-settled PRs; (2) rows older than the loud KV dedup TTL (24h) would
 * re-fire on every TTL rollover. The recency window (not the KV TTL) is the structural guard: rows
 * age out of this scan long before the TTL can roll.
 */
export async function listPrCoordinationTerminalRedeliveryCandidates(
  db: D1Database,
  input: { limit: number; enteredSinceMs: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE state IN ('NEEDS_YOU', 'FAILED', 'MERGE_READY')
         AND ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE}
         AND COALESCE(state_entered_at, 0) >= ?
       ORDER BY COALESCE(state_entered_at, 0) ASC, session_id ASC
       LIMIT ?`,
    )
    .bind(NON_SYNTHETIC_PR_COORDINATOR_BIND, input.enteredSinceMs, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/**
 * Dwelt-past-deadline REVIEW spine rows, oldest-dwell first — the candidate set for the sweep's
 * dormant-REVIEW `review_stuck` give-up backstop (A3). Under spawn-at-publish the row stays in REVIEW
 * while a verifier child runs; a parent whose row entered REVIEW but whose DO went dormant (never
 * re-ticks its state-deadline alarm) would otherwise dwell past `REVIEW_STUCK_DEADLINE_MS` with no
 * give-up fire. This cross-DO sweep re-derives the due fire from committed state. VERIFYING rows are
 * intentionally NOT selected here — their (now run-scoped, non-blocking) backstop is the
 * `listVerificationBackstopCandidates` path.
 */
export async function listReviewStuckPrCoordinationCandidates(
  db: D1Database,
  input: { limit: number; reviewEnteredBeforeMs: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE state = 'REVIEW'
         AND ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE}
         AND COALESCE(state_entered_at, 0) <= ?
       ORDER BY COALESCE(state_entered_at, 0) ASC, session_id ASC
       LIMIT ?`,
    )
    .bind(NON_SYNTHETIC_PR_COORDINATOR_BIND, input.reviewEnteredBeforeMs, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/**
 * A3 run-scoped verification backstop candidate set: spine rows that have a stamped verifier child but
 * NO fresh verdict for the current run, whose active QA binding was last enqueued (`updated_at` = the
 * run's spawn time) before the cutoff (now − 1h). Real parent sessions are only meaningful here while
 * still in `REVIEW`, but synthetic PR-coordinator rows intentionally remain in `VERIFYING` after
 * `requestCoordinatedVerification` schedules and stamps the child, so they must remain eligible too.
 * Run-scoped: `qa_loop_session_bindings.updated_at` is bumped on every run's prompt enqueue
 * (`markQaLoopBindingPromptEnqueued`), so a fresh respawn resets the clock. "No fresh verdict" =
 * `verdict_head_sha` is null or differs from `verification_run_head` (a recorded run verdict stamps
 * `verdict_head_sha := verification_run_head`, so it drops out here).
 */
export async function listVerificationBackstopCandidates(
  db: D1Database,
  input: { limit: number; spawnedBeforeMs: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT c.* FROM pr_coordination c
       JOIN qa_loop_session_bindings b
         ON b.automated_lifecycle_id = c.session_id
        AND b.pr_url = c.pr_url
        AND b.status = 'active'
       WHERE c.verification_child_id IS NOT NULL
         AND (
           c.state = 'REVIEW'
           OR (c.state = 'VERIFYING' AND c.session_id LIKE ?)
         )
         AND (c.verdict_head_sha IS NULL OR c.verdict_head_sha <> c.verification_run_head)
         AND b.updated_at <= ?
       ORDER BY b.updated_at ASC, c.session_id ASC
       LIMIT ?`,
    )
    .bind(`${SYNTHETIC_PR_COORDINATOR_SESSION_ID_PREFIX}%`, input.spawnedBeforeMs, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

export interface StateDwellAggregateRow {
  state: string;
  count: number;
  oldestEnteredAt: number;
  // Sessions in this state whose anchor is at/older than the stall cutoff — the
  // ONLY ones past the stall threshold. Distinct from `count` (all still-in-state):
  // 4 sessions that just entered FINALIZING alongside 1 wedged one is stalledCount=1.
  stalledCount: number;
}

/**
 * Per-state dwell aggregate for the live session-stall sweep (services/session-stall-sweep.ts): for each
 * requested state, the number of rows currently in it, the OLDEST `state_entered_at` among them, and how
 * many are past the stall cutoff (`state_entered_at <= stalledBeforeMs`, i.e. `now - threshold`). The
 * caller turns `now - oldestEnteredAt` into the age of the oldest still-in-state session — the live-stall
 * signal `arcanist.fsm.stage_dwell_ms` cannot give (that only records dwell once a session TRANSITIONS
 * out, so a wedged session emits nothing). Rows with a null/0 anchor (shadow/legacy-adapter rows that never
 * stamped `state_entered_at`) and archived sessions are excluded so closed sessions cannot masquerade as
 * live stalls. The `session_index` filter is a LEFT JOIN with a null-safe archived check: a `pr_coordination`
 * row with no index row (or a null status) still counts, so a missing/lagging index row fails OPEN — the
 * stall monitor keeps paging rather than going blind on a genuine wedge. One GROUP BY over a few-hundred-row
 * table (docs/database.md: pr_coordination needs no dedicated index for a full scan).
 */
export async function readActiveStateDwell(
  db: D1Database,
  states: readonly string[],
  nowMs: number,
  stalledBeforeMs: number,
): Promise<StateDwellAggregateRow[]> {
  if (states.length === 0) return [];
  const placeholders = states.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT pc.state AS state, COUNT(*) AS count, MIN(pc.state_entered_at) AS oldestEnteredAt,
              SUM(CASE WHEN pc.state_entered_at <= ? THEN 1 ELSE 0 END) AS stalledCount
       FROM pr_coordination pc
       LEFT JOIN session_index s ON s.session_id = pc.session_id
       WHERE pc.state IN (${placeholders})
         AND ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE_FOR_PC}
         AND pc.state_entered_at IS NOT NULL
         AND pc.state_entered_at > 0
         AND pc.state_entered_at <= ?
         AND (s.status IS NULL OR s.status != 'archived')
       GROUP BY pc.state`,
    )
    .bind(stalledBeforeMs, ...states, NON_SYNTHETIC_PR_COORDINATOR_BIND, nowMs)
    .all<{ state: string; count: number; oldestEnteredAt: number; stalledCount: number }>();
  return (result.results ?? []).map((row) => ({
    state: row.state,
    count: Number(row.count),
    oldestEnteredAt: Number(row.oldestEnteredAt),
    stalledCount: Number(row.stalledCount),
  }));
}

export interface StalledPrePublishCandidate {
  sessionId: string;
  state: string;
  stateEnteredAt: number;
}

/**
 * Enumerate a bounded mutation cohort for the pre-publish stall backstop.
 * Unlike the monitoring aggregate above, this fails closed: only an explicit
 * active session-index row that is not parked for plan approval may be acted on.
 * The owning DO re-reads the FSM row and rechecks runtime liveness before any
 * transition, so this list is only a candidate snapshot.
 */
export async function listStalledPrePublishCandidates(
  db: D1Database,
  states: readonly string[],
  stalledBeforeMs: number,
  requestedLimit: number,
): Promise<StalledPrePublishCandidate[]> {
  if (states.length === 0) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit)));
  const placeholders = states.map(() => "?").join(",");
  const result = await db
    .prepare(
      `SELECT pc.session_id AS sessionId, pc.state AS state, pc.state_entered_at AS stateEnteredAt
       FROM pr_coordination pc
       INNER JOIN session_index s ON s.session_id = pc.session_id
       WHERE pc.state IN (${placeholders})
         AND ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE_FOR_PC}
         AND pc.state_entered_at IS NOT NULL
         AND pc.state_entered_at > 0
         AND pc.state_entered_at <= ?
         AND s.status = 'active'
         AND COALESCE(s.plan_approval_pending, 0) = 0
       ORDER BY pc.state_entered_at ASC, pc.session_id ASC
       LIMIT ?`,
    )
    .bind(...states, NON_SYNTHETIC_PR_COORDINATOR_BIND, stalledBeforeMs, limit)
    .all<{ sessionId: string; state: string; stateEnteredAt: number }>();
  return (result.results ?? []).map((row) => ({
    sessionId: row.sessionId,
    state: row.state,
    stateEnteredAt: Number(row.stateEnteredAt),
  }));
}

/**
 * Enumerate spine rows in a given `state` (optionally filtered by `blocked_reason`) for the W11-T1 one-shot
 * row-7 repair passes: `REVIEW` rows parked at `ci_pending`, and `NEEDS_YOU` rows the REVIEW deadline
 * drained (`blocked_reason = 'review_stuck'`). Oldest-dwell first + bounded (`pr_coordination` holds
 * hundreds of rows, not millions — a scan predicate needs no dedicated index, per docs/database.md). The
 * repair runner re-qualifies each row against the live disposition store + an honest CI read before acting,
 * so a row that raced out of `state` between this enumeration and the per-row check is simply skipped.
 */
export async function listPrCoordinationByStateForRepair(
  db: D1Database,
  input: { state: string; blockedReason?: string; limit: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(2000, Math.floor(input.limit)));
  const conditions = ["state = ?", NON_SYNTHETIC_PR_COORDINATOR_PREDICATE];
  const binds: unknown[] = [input.state, NON_SYNTHETIC_PR_COORDINATOR_BIND];
  if (input.blockedReason !== undefined) {
    conditions.push("blocked_reason = ?");
    binds.push(input.blockedReason);
  }
  const result = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE ${conditions.join(" AND ")}
       ORDER BY COALESCE(state_entered_at, 0) ASC, session_id ASC
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/**
 * Enumerate the TERMINAL-COHORT spine rows the W11-G1 parity checker observes (ARC-1330 W11-G3 trigger).
 * The steady-state / dormant divergence samplers only ever pin `review_listening`, so post-flip terminals
 * have NO comparator — a "clean" divergence reading degrades toward self-agreement (`project()` writes the
 * legacy mirrors FROM the spine). This lister sources the cohort the non-tautological checker needs:
 *   • `MERGED` / `CLOSED` — the settled terminals whose GitHub ground truth is a merged/closed PR.
 *   • `MERGE_READY` / `NEEDS_YOU` — the "still-open PR" stages where a PR that already merged/closed under
 *     the stage is a safety-critical projection lag (the class the terminal-blind samplers cannot catch).
 * Most-recently-entered first (a bounded soak sample wants the freshest terminals, whose projection health
 * is what the gate asks about) + bounded (`pr_coordination` holds hundreds of rows, not millions — a scan
 * predicate needs no dedicated index, per docs/database.md). READ-ONLY.
 */
export async function listPrCoordinationTerminalCohortForParity(
  db: D1Database,
  input: { limit: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(2000, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE state IN ('MERGED', 'CLOSED', 'MERGE_READY', 'NEEDS_YOU')
         AND ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE}
       ORDER BY COALESCE(state_entered_at, 0) DESC, session_id ASC
       LIMIT ?`,
    )
    .bind(NON_SYNTHETIC_PR_COORDINATOR_BIND, limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/**
 * Enumerate ONE keyset page of the SPINE-DRIVEN merge/close reconcile cohort (ARC-1330 W11-T2): spine rows
 * in a NON-FINAL post-publish state (`REVIEW`/`VERIFYING`/`MERGE_READY`/`NEEDS_YOU`/`STOPPED`) that carry a
 * `pr_url`. This is the D17 backstop the sweep enumerates FROM THE SPINE (not the legacy review-listening
 * working set, which drops sessions legacy closed out or that sit in loud terminals like `NEEDS_YOU` — the
 * exact wedge class where the GitHub PR is already merged/closed but the spine never learned). The reconcile
 * pass polls each page's PRs and mints the terminal on an OBSERVED merged/closed.
 *
 * Keyset-paginated on the unique `session_id` PK (`> cursor`, empty string = the whole cohort) so the sweep
 * ROTATES a bounded batch across ticks (the `cron_sweep_cursors` pacing) — GitHub cost is capped per tick
 * and a row is re-polled only after the cursor wraps the cohort. READ-ONLY. (`pr_coordination` holds
 * hundreds of rows, not millions — a scan predicate needs no dedicated index, per docs/database.md.)
 */
export async function listPrCoordinationOpenPrReconcilePage(
  db: D1Database,
  input: { cursor: string | null; limit: number },
): Promise<PrCoordinationRecord[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
  const result = await db
    .prepare(
      `SELECT * FROM pr_coordination
       WHERE state IN ('REVIEW', 'VERIFYING', 'MERGE_READY', 'NEEDS_YOU', 'STOPPED')
         AND ${NON_SYNTHETIC_PR_COORDINATOR_PREDICATE}
         AND pr_url IS NOT NULL
         AND session_id > ?
       ORDER BY session_id ASC
       LIMIT ?`,
    )
    .bind(NON_SYNTHETIC_PR_COORDINATOR_BIND, input.cursor ?? "", limit)
    .all<PrCoordinationRow>();
  return (result.results ?? []).map(rowToRecord);
}

/** Insert a full coordination record. Genesis writes the `CREATED` row here. */
export async function insertPrCoordination(db: D1Database, record: PrCoordinationRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pr_coordination (
        session_id, version, state, pr_url, head_sha, verdict, verdict_head_sha,
        verification_run_head, verification_run_id, verification_child_id, verification_run_count,
        ci_fix_rounds, in_flight_epoch_id, code_changed_since_verification, prompt_intends_change,
        merge_ready_reopen_count, blocked_reason, failure_reason, stop_mode, pre_stop_state,
        update_branch_queued_at, deadline_at, state_entered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(...INSERT_FIELDS.map((field) => encodeRecordFieldValue(record, field)))
    .run();
}

/**
 * Re-baseline a still-untouched backfilled row IN PLACE (ARC-1330 PR 46 — the version-0
 * re-baseline). Rewrites every seed column from `record` ONLY where the row's `version` is
 * still 0 (no producer has ever CASed it, so the seed is the row's only content) and KEEPS
 * `version = 0` — the row stays in the `backfilledNotClean` divergence cohort and a later
 * producer CAS still starts from 0. The `version = 0` predicate is the atomic guard: a
 * producer racing this UPDATE bumps the version first and the re-baseline cleanly loses
 * (returns 0 changes). NEVER touches a `version >= 1` row — that is real spine history.
 * Returns rows changed (1 = re-baselined, 0 = row missing or already advanced).
 */
export async function rebaselinePrCoordinationVersion0(db: D1Database, record: PrCoordinationRecord): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE pr_coordination SET
        state = ?, pr_url = ?, head_sha = ?, verdict = ?, verdict_head_sha = ?,
        verification_run_head = ?, verification_run_id = ?, verification_child_id = ?, verification_run_count = ?,
        ci_fix_rounds = ?, in_flight_epoch_id = ?, code_changed_since_verification = ?, prompt_intends_change = ?,
        merge_ready_reopen_count = ?, blocked_reason = ?, failure_reason = ?, stop_mode = ?, pre_stop_state = ?,
        update_branch_queued_at = ?, deadline_at = ?, state_entered_at = ?
      WHERE session_id = ? AND version = 0`,
    )
    .bind(...REBASELINE_FIELDS.map((field) => encodeFieldValue(field, record[field])), record.sessionId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * Delete a still-untouched backfilled seed row (ARC-1330 PR 46 — the stale-session fence's
 * re-baseline prune). A `version = 0` row is SEED-ONLY content: no producer has ever CASed it,
 * so deleting it loses nothing — it restores the session to the intentional frozen no-record
 * posture (`applyEvent` → `no_record` → no-op; the samplers skip it as `noSpineRow`). Mirrors
 * `rebaselinePrCoordinationVersion0`'s race safety: the `version = 0` predicate rides the
 * DELETE itself, so a producer racing to bump the version wins and the delete no-ops — a
 * `version >= 1` row (real spine history) is NEVER deleted. Returns rows changed
 * (1 = deleted, 0 = row missing or already producer-advanced).
 */
export async function deletePrCoordinationVersion0(db: D1Database, sessionId: string): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM pr_coordination WHERE session_id = ? AND version = 0`)
    .bind(sessionId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * Single-writer compare-and-swap. Applies `fields` and bumps `version` only if
 * the row's current `version` equals `expectedVersion`. Returns the number of
 * rows changed: 1 = this writer won; 0 = a concurrent writer already bumped the
 * version, so the caller must re-read and retry. An empty `fields` still bumps
 * the version (a handled no-op self-loop in the spine).
 */
export async function casUpdatePrCoordination(
  db: D1Database,
  sessionId: string,
  expectedVersion: number,
  fields: PrCoordinationUpdate,
): Promise<number> {
  // Skip present-but-`undefined` fields: a Partial caller that conditionally builds `fields`
  // can legally produce `{col: undefined}`, which would otherwise encode to `SET col = NULL`
  // (throwing on NOT NULL columns, or silently clearing nullable ones). An explicit `null`
  // is preserved — it is the only way to request a clear (reserve null for explicit clears).
  const entries = (Object.entries(fields) as Array<[keyof PrCoordinationUpdate, unknown]>).filter(
    ([key, value]) => key in COLUMN_BY_FIELD && value !== undefined,
  );

  const setClauses = entries.map(([key]) => `${COLUMN_BY_FIELD[key]} = ?`);
  setClauses.push("version = version + 1");
  const bindValues = entries.map(([key, value]) => encodeFieldValue(key, value));

  // Built into a local (not an inline `.prepare(`…`)` template) so the dynamic
  // SET clause stays out of the static schema-validation scanner: every column
  // here comes from the COLUMN_BY_FIELD allowlist (so it is always a real
  // column), and the round-trip/CAS DAO tests exercise the actual writes.
  const sql = `UPDATE pr_coordination SET ${setClauses.join(", ")} WHERE session_id = ? AND version = ?`;
  const result = await db
    .prepare(sql)
    .bind(...bindValues, sessionId, expectedVersion)
    .run();

  return Number(result.meta?.changes ?? 0);
}

/**
 * Stamp the spawned verifier CHILD handle onto the spine (ARC-1330 W11-V1). This is the ONE
 * post-commit write of `verification_child_id` — design §17-A: "the killable child handle ... is set
 * by the spawn side-effect" — the child id is not known until AFTER the post-commit spawn runs, so it
 * cannot ride the VERIFYING transition's CAS.
 *
 * NOT an `applyEvent` write, on purpose (the "stamp path cannot mint a transition" contract): it does
 * NOT bump `version` and appends NO `pr_coordination_events` row, so it never desyncs the
 * version↔event-log sequence, never re-evaluates guards, and never invalidates a concurrent
 * `applyEvent` CAS. It is a conditional (CAS-style) write predicated on RUN IDENTITY, not on
 * `version` (A3: no phase gate — the spawn now rides the `publish.pr_opened → REVIEW` edge, so the
 * claim must land on the REVIEW row): it lands ONLY while `verification_run_id` matches and the slot
 * is still `NULL`. A run superseded by `redispatch_verification` (run id advanced) or an already-claimed
 * slot no-ops (0 rows) — so a late stamp can never overwrite a NEWER run's handle nor re-claim a filled
 * slot. `verification_run_id` is monotonic (§17-A ABA closure), so the run-id guard is ABA-safe.
 *
 * SINGLE-WRITER SAFE (§15 inv 1): `verification_child_id` is NEVER read by any `transition()` guard
 * predicate — only by the `kill_verification` side-effect resolvers to name the child to tear down — so
 * a second writer to this handle cannot cause a torn/stale guard read (the F1/F19 single-writer CAS
 * protects STATE and guard fields; this post-commit handle is explicitly carved out to the spawn
 * side-effect). Run-id-guarded rather than version-guarded because a version guard would no-op the
 * stamp on any benign in-VERIFYING self-loop (`review.received`/`ci.signal`/`head.noop_changed`), which
 * do NOT supersede the run — leaving the kill toothless exactly on busy sessions.
 *
 * FIRST-WRITER-WINS CLAIM (W11-V4 — the atomic double-spawn boundary): the `verification_child_id IS
 * NULL` guard makes this an atomic winner-take-all claim on the run's spawn slot. `request_verification`
 * / `redispatch_verification` reset the handle to NULL when they mint the run (actions.ts), so exactly
 * ONE stamp per run flips NULL→child; a SECOND concurrent spawn's stamp finds the slot already claimed
 * and no-ops (0 rows) rather than clobbering the winner's handle (which would re-point `kill_verification`
 * at the loser and leave the winner un-killable). This — together with the pre-spawn anchor read in
 * `spawnVerificationChildExecutor` — is what lets D-51 drop the per-PR verification lock: the committed
 * spine row, not `verification_active_locks`, is now the atomic single-child-per-run boundary. Returns
 * rows changed (1 = claimed, 0 = superseded (run id advanced) / already-claimed by a concurrent spawn /
 * row absent).
 */
export async function stampVerificationChildId(
  db: D1Database,
  sessionId: string,
  verificationRunId: number,
  childSessionId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE pr_coordination SET verification_child_id = ?
       WHERE session_id = ? AND verification_run_id = ?
         AND verification_child_id IS NULL`,
    )
    .bind(childSessionId, sessionId, verificationRunId)
    .run();
  return Number(result.meta?.changes ?? 0);
}

/**
 * Stamp ARC-1302's "our server-side update-branch queued" marker onto the FSM spine. This is
 * intentionally a narrow post-commit marker write, not an `applyEvent` transition: it does NOT bump
 * `version` and does not append a `pr_coordination_events` row. The marker is scoped to the current
 * PR/head so a stale value from an earlier base-merge cannot prove ownership of a later foreign push.
 *
 * This is the SOLE store for the marker: D-54 dropped the legacy `pr_mergeability_attempts` row, so
 * the review-loop sweep writes it here and the head-change carry-forward gate reads it here (SF22).
 */
export async function markPrCoordinationUpdateBranchQueued(
  db: D1Database,
  input: { sessionId: string; prUrl: string; headSha: string; nowMs: number },
): Promise<number> {
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} UPDATE pr_coordination
       SET update_branch_queued_at = ?
       WHERE session_id = ? AND pr_url = ? AND head_sha = ?`,
    )
    .bind(input.nowMs, input.sessionId, input.prUrl, input.headSha)
    .run();
  return Number(result.meta?.changes ?? 0);
}
