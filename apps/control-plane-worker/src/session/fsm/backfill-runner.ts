// ARC-1330 lifecycle FSM (PR 35A wiring) — the one-shot BACKFILL RUNNER.
//
// PR 35A shipped the materialization PRIMITIVES (`backfillSessions` + the pure record builder) but left
// the "enumerate every in-flight legacy session and feed it here" job as a deferred operational step.
// This runner IS that job, invoked once (post-shadow-deploy) from an admin route: it enumerates the active
// session fleet, maps each session's legacy signals into a `BackfillInput`, and drives the idempotent,
// per-session-isolated batch insert. Materializing these rows is the flip precondition (no in-flight
// session freezes at the writer flip) AND the reason the divergence dashboard is empty today — the
// steady-state sampler no-ops on every active review-listening session because none has a `pr_coordination`
// row yet (genesis only creates rows for sessions born after shadow turned on).
//
// ADDITIVE + idempotent: `backfillSessions` uses a SELECT guard (never a clobber). DEPENDENCY-INJECTED
// (session loader / settings loader / enumerator) so the orchestration is unit-testable without a
// Session DO — only the D1 insert is real.

import type { CycloidDoneStatus, Phase } from "../../../../../shared/session/phase.js";
import { createLogger } from "../../logger";
import type { SessionState } from "../../types";
import { deletePrCoordinationVersion0, getPrCoordination } from "../pr-coordination-db";
import {
  type BackfillBatchResult,
  type BackfillInput,
  backfillSessions,
  buildBackfillRecord,
  isBackfillTargetState,
} from "./backfill";

const log = createLogger({ bindings: { component: "fsm-backfill-runner" } });

/**
 * `DEFAULT_BACKFILL_STALE_CUTOFF_MS` — the STALE-SESSION FENCE default (ARC-1330 PR 46, Jag's call
 * 2026-07-01): no activity in the last 12 hours = stale = deliberately FROZEN at the flip. A stale
 * in-flight session gets NO `pr_coordination` row, so post-flip it is perfectly inert: `applyEvent`
 * → `no_record` → no-op — no re-verification, no review-addressing, no alerts on days-old PRs
 * (labels/PRs untouched; the legacy decision paths are gated off in PR 47). Route escape hatch:
 * `staleCutoffHours: 0` (or `null`) disables the fence for a deliberate manual backfill of one
 * genuinely-revived old session.
 */
export const DEFAULT_BACKFILL_STALE_CUTOFF_MS = 12 * 60 * 60 * 1000;

/** The enumerated fleet row the runner drives: session id + its legacy `phase` (`session_index.rich_status`). */
export interface ActiveSessionRow {
  sessionId: string;
  /** `session_index.rich_status` — the projected legacy phase string. */
  phase: string;
  ownerUserId: number | null;
  /**
   * `session_index.updated_at` normalized to epoch ms, or null when unparseable. A COARSE activity
   * boundary (bumped on session events/projections) — exactly right for the stale fence's recency
   * question; NOT a liveness signal. Prod stores a mix of ISO-8601 strings (the common case) and
   * epoch-ms integers (pre-normalization rows), so the enumerator parses both.
   */
  updatedAt: number | null;
}

/**
 * The non-`idle` legacy phases the backfill maps (the `legacyAdapterRecord` switch domain). `idle` has no
 * spine state (pre-session) and is skipped; an unknown/empty `rich_status` is likewise not backfilled.
 */
const BACKFILLABLE_PHASES: ReadonlySet<string> = new Set<Exclude<Phase, "idle">>([
  "running",
  "waiting_for_input",
  "finalizing",
  "review_listening",
  "completed",
  "superseded",
  "blocked",
  "failed",
  "stopped",
  "archived",
]);

function isBackfillablePhase(phase: string): phase is Exclude<Phase, "idle"> {
  return BACKFILLABLE_PHASES.has(phase);
}

function doneStatusFromBackfillSignals(phase: Exclude<Phase, "idle">, session: SessionState): CycloidDoneStatus {
  if (
    phase === "completed" &&
    (session.reviewListeningPrUrl ?? session.targetPrUrl) &&
    session.verificationState === "verification-done" &&
    session.verificationResult === "merge-ready"
  ) {
    return { state: "done", outcome: "success", reasons: [] };
  }
  return { state: "working", outcome: null, reasons: [] };
}

/**
 * Map ONE loaded session (its DO-resident legacy signals) + its enumerated `phase` into a `BackfillInput`.
 * PURE. Returns `null` when the phase is `idle`/unknown (no spine state to materialize). The legacy →
 * FSM state mapping itself lives in `legacyAdapterRecord` (via `buildBackfillRecord`); this only gathers
 * the input fields. `prUrl`/`headSha` come from the review-listening projection (the only phase that
 * carries a live PR/head on `SessionState`; pre-PR phases are legitimately null). Done-state inputs avoid
 * the deleted DO mirror columns: completed merge-ready PRs use the settled verification result as the
 * direct success signal, and every other cohort seeds neutral values.
 */
export function buildBackfillInputFromSession(
  sessionId: string,
  phase: string,
  session: SessionState,
): BackfillInput | null {
  if (!isBackfillablePhase(phase)) {
    return null;
  }
  return {
    sessionId,
    phase,
    prUrl: session.reviewListeningPrUrl ?? session.targetPrUrl ?? null,
    headSha: session.reviewListeningHeadSha ?? null,
    verificationState: session.verificationState ?? null,
    verificationResult: session.verificationResult ?? null,
    // The ARC-1243 settle anchor: lets the seed keep a provably-verified-at-this-head session
    // settled (cascade row 7) instead of forcing a re-verify the scheduler would skip anyway.
    verificationVerdictHeadSha: session.verificationVerdictHeadSha ?? null,
    reviewLoopDoneState: null,
    cycloidDone: doneStatusFromBackfillSignals(phase, session),
    verificationRunCount: session.verificationAttemptCount ?? 0,
    ciFixRounds: 0,
    businessId: session.businessId ?? null,
  };
}

export interface FsmBackfillRunnerDeps {
  db: D1Database;
  /** Clock seam (deterministic in tests). */
  now: () => number;
  /** Enumerate the active session fleet (`session_index` rows) — see {@link listActiveSessionsForBackfill}. */
  listActiveSessions: () => Promise<ActiveSessionRow[]>;
  /** Load one session's DO-resident state (the verification / review-loop / done signals). */
  loadSession: (sessionId: string) => Promise<SessionState | null>;
}

/** The batch tally plus enumeration bookkeeping (observe-only; the route logs/returns it). */
export interface FsmBackfillReport extends BackfillBatchResult {
  /** Total sessions enumerated from `session_index`. */
  enumerated: number;
  /** Sessions that produced a `BackfillInput` (loaded + non-idle phase). */
  eligible: number;
  /** Sessions whose DO lookup returned null (gone mid-run) — isolated, never fatal. */
  missingSession: number;
  /** Sessions skipped for an `idle`/unknown phase (no spine state). */
  skippedIdle: number;
  /** Stale-fence skips: no recent activity → deliberately left frozen (no row written). */
  skippedStale: number;
  /** Stale-fence prunes (rebaseline mode): a stale session's version-0 seed row DELETED. */
  removedStale: number;
  dryRun: boolean;
}

/**
 * Enumerate the active fleet → build a `BackfillInput` per session → drive the idempotent batch insert.
 * Best-effort per session (a null DO lookup is tallied `missingSession`, never thrown). `dryRun` classifies
 * would-be outcomes (target vs terminal vs off) WITHOUT writing. `limit` caps how many enumerated sessions
 * are processed (staged rollout / smoke), while still reporting the full `enumerated` count.
 *
 * `rebaseline` (PR 46): repair mode for the prod cohort an EARLIER runner deployment seeded with the
 * pre-fix shape — a row still at `version = 0` is rewritten in place from current legacy state (see
 * `backfillInFlightSession`); `version >= 1` rows are never touched. Idempotent and dryRun-aware: a
 * rebaseline dry run READS the existing rows (never writes) so it can classify precisely
 * (`inserted` = would insert, `rebaselined` = would rewrite a v0 row, `exists` = producer-advanced).
 *
 * `staleActivityCutoffMs` (PR 46, the STALE-SESSION FENCE — Jag's call, 2026-07-01): a session whose
 * last activity (`session_index.updated_at`) is older than the cutoff is deliberately FROZEN at the
 * flip — no row is materialized (`skipped_stale`), so `applyEvent` no-ops on it forever: no
 * re-verification, no review-addressing, no alerts on days-old PRs; labels/PRs stay untouched. With
 * `rebaseline: true` the fence also PRUNES a stale session's already-seeded `version = 0` row
 * (`removed_stale` — seed-only content, so deleting it restores the frozen no-record posture; a
 * producer racing to advance the row wins and it reports `exists`). Frozen sessions have no row, so
 * the divergence samplers skip them (`noSpineRow`) and they leave the cohort cleanly. A
 * genuinely-revived old session is handled MANUALLY: stop/archive it, or run a targeted backfill
 * with the fence disabled (`null`/`0` = no fence).
 */
export async function runFsmBackfill(
  deps: FsmBackfillRunnerDeps,
  opts: { dryRun?: boolean; limit?: number; rebaseline?: boolean; staleActivityCutoffMs: number | null },
): Promise<FsmBackfillReport> {
  const rows = await deps.listActiveSessions();
  const enumerated = rows.length;
  const toProcess = typeof opts.limit === "number" ? rows.slice(0, Math.max(opts.limit, 0)) : rows;

  const fenceCutoffMs =
    typeof opts.staleActivityCutoffMs === "number" && opts.staleActivityCutoffMs > 0
      ? opts.staleActivityCutoffMs
      : null;
  const staleBefore = fenceCutoffMs === null ? null : deps.now() - fenceCutoffMs;

  const inputs: BackfillInput[] = [];
  let missingSession = 0;
  let skippedIdle = 0;
  let skippedStale = 0;
  let removedStale = 0;
  let staleExists = 0;
  let staleFailed = 0;

  for (const row of toProcess) {
    // ── The stale-session fence (checked BEFORE the DO load — a frozen session costs nothing). ──
    // An unparseable `updated_at` (updatedAt === null) counts as stale: recency can't be proven, and
    // the fence fails closed — freezing is recoverable (targeted backfill, fence off), resurrecting
    // a dead session's PR with alerts is not.
    if (staleBefore !== null && (row.updatedAt === null || row.updatedAt < staleBefore)) {
      if (opts.rebaseline !== true) {
        skippedStale += 1;
        continue;
      }
      // Rebaseline pass: prune the stale session's seed row so it returns to frozen no-record.
      try {
        const existing = await getPrCoordination(deps.db, row.sessionId);
        if (existing === null) {
          skippedStale += 1; // already frozen — nothing to remove, nothing to write
        } else if (existing.version >= 1) {
          staleExists += 1; // real spine history — never touched (stale or not)
        } else if (opts.dryRun) {
          removedStale += 1; // would delete
        } else {
          const changes = await deletePrCoordinationVersion0(deps.db, row.sessionId);
          if (changes === 1) {
            removedStale += 1;
          } else {
            staleExists += 1; // lost the version-0 race — a producer advanced it mid-flight
          }
        }
      } catch (err) {
        staleFailed += 1; // per-session isolation, mirroring backfillSessions
        log.warn({ sessionId: row.sessionId, error: String(err) }, "fsm backfill: stale prune failed (isolated)");
      }
      continue;
    }

    const session = await deps.loadSession(row.sessionId);
    if (!session) {
      missingSession += 1;
      continue;
    }
    const input = buildBackfillInputFromSession(row.sessionId, row.phase, session);
    if (!input) {
      skippedIdle += 1;
      continue;
    }
    inputs.push(input);
  }

  const base: FsmBackfillReport = {
    skippedTerminal: 0,
    inserted: 0,
    exists: staleExists,
    rebaselined: 0,
    failed: staleFailed,
    enumerated,
    eligible: inputs.length,
    missingSession,
    skippedIdle,
    skippedStale,
    removedStale,
    dryRun: Boolean(opts.dryRun),
  };

  if (opts.dryRun) {
    for (const input of inputs) {
      // Classify against the SAME target-state guard the writer uses; `inserted` here means "would insert"
      // (the plain dry run does not consult the idempotency SELECT, so it cannot distinguish an existing
      // row). A REBASELINE dry run additionally READS the existing row (read-only — still no writes) so
      // the report distinguishes would-insert / would-rebaseline (v0) / producer-advanced (`exists`).
      const state = buildBackfillRecord(input, deps.now()).state;
      if (!isBackfillTargetState(state)) {
        base.skippedTerminal += 1;
        continue;
      }
      if (opts.rebaseline === true) {
        const existing = await getPrCoordination(deps.db, input.sessionId);
        if (existing === null) {
          base.inserted += 1;
        } else if (existing.version === 0) {
          base.rebaselined += 1;
        } else {
          base.exists += 1;
        }
        continue;
      }
      base.inserted += 1;
    }
    return base;
  }

  const tally = await backfillSessions({ db: deps.db, now: deps.now, rebaseline: opts.rebaseline === true }, inputs);
  // Additive merge: the stale fence tallied its own exists/failed contributions into `base`
  // before the batch ran, so the batch tally must ADD to them, not overwrite.
  return {
    ...base,
    skippedTerminal: base.skippedTerminal + tally.skippedTerminal,
    inserted: base.inserted + tally.inserted,
    exists: base.exists + tally.exists,
    rebaselined: base.rebaselined + tally.rebaselined,
    failed: base.failed + tally.failed,
  };
}

/**
 * The real fleet enumerator: every ACTIVE `session_index` row with its projected phase (`rich_status`).
 * We enumerate broadly and let `backfillInFlightSession`'s own `isBackfillTargetState` guard filter the
 * FSM-final states (CREATED / MERGED / CLOSED / ARCHIVED) — so legacy-terminal ≠ FSM-terminal never has
 * to be re-encoded as a SQL phase list (a re-openable legacy `blocked`/`failed`/`stopped`/`completed`
 * session maps to a NON-final FSM state and IS a backfill target).
 */
export async function listActiveSessionsForBackfill(
  db: D1Database,
  opts: { phase?: string } = {},
): Promise<ActiveSessionRow[]> {
  // Optional `phase` scope (matched against `rich_status`): the full fleet can be thousands of sessions
  // (dominated by inert `stopped` ones) — too many to load sequentially in one Worker invocation. Scoping
  // to `review_listening` targets the divergence-soak cohort (a small, actively-churning set) so a single
  // run completes; the broad, all-phase run is the flip-time freeze-insurance pass (batched/async).
  const conditions = ["status = 'active'"];
  const binds: unknown[] = [];
  if (opts.phase) {
    conditions.push("rich_status = ?");
    binds.push(opts.phase);
  }
  const statement = db.prepare(
    `SELECT session_id, rich_status, owner_user_id, updated_at FROM session_index WHERE ${conditions.join(" AND ")}`,
  );
  const bound = binds.length > 0 ? statement.bind(...binds) : statement;
  const result = await bound.all<{
    session_id: string;
    rich_status: string | null;
    owner_user_id: number | null;
    updated_at: number | string | null;
  }>();
  return (result.results ?? []).map((row) => ({
    sessionId: row.session_id,
    phase: row.rich_status ?? "idle",
    ownerUserId: row.owner_user_id,
    updatedAt: normalizeSessionIndexTimestamp(row.updated_at),
  }));
}

/**
 * Normalize a `session_index.updated_at` value to epoch ms. The column has INTEGER affinity but prod
 * stores a MIX: ISO-8601 strings (the DO projection binds `SessionState.updatedAt`, a string) and
 * epoch-ms integers (the 0021-normalization era). Unparseable → null (the fence fails closed on it).
 */
export function normalizeSessionIndexTimestamp(value: number | string | null): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
