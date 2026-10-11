// ARC-1330 (W11-T2) — SPINE-DRIVEN PR merge/close reconcile (the D17 backstop, re-homed onto the spine).
//
// WHY THIS EXISTS. The ONLY existing cron source of a `pr.merged`/`pr.closed` spine terminal is the review-
// loop sweep's merge/close poll (`shadowEmitCronPrTerminal`), whose working set is the LEGACY review-
// listening enumeration — it DROPS sessions legacy has already closed out or that sit in a loud terminal
// (`NEEDS_YOU`/`STOPPED`). Ground truth (W11-G3, 47/78 terminal-cohort divergences) showed the exact wedge:
// a spine row stuck in `NEEDS_YOU`/`MERGE_READY` while the GitHub PR is merged/closed — e.g. a user manually
// fixes + merges a `NEEDS_YOU` PR and the spine never learns. The `pull_request.closed` WEBHOOK producer
// (W11-T2 part 1) covers the live delivery; THIS pass is the dropped-webhook backstop, enumerating the
// SPINE'S OWN open-PR rows so no non-final post-publish row can be stranded past a missed webhook.
//
// SHAPE. Bounded, cursor-rotated (`runCronSweep` over `cron_sweep_cursors`) so GitHub cost is capped per
// tick and a row is re-polled only after the cursor wraps the cohort — the dormant-sampler pacing. Per-row
// best-effort (a thrown read/token/emit is tallied, NEVER propagated) so one dead installation cannot wedge
// the cursor or abort the batch. Wired OFF the webhook hot path into the
// `*/5` sweep tail alongside the divergence samplers. SOUNDNESS: only an OBSERVED merged/closed PR (read via
// the KEEP'd `getPrMergeStatus` surface, injected as a `GroundTruthReader`) mints a terminal — never a
// legacy field or a timeout — and every emit lands the same §10 POST_PUBLISH edge (idempotent no-op in a
// final terminal). Dependency-injected end to end so it is unit-testable without a Session DO or GitHub.

import { type CronSweepPage, runCronSweep } from "../../cron/sweep-runner";
import type { Logger } from "../../logger";
import type { Env } from "../../types";
import { listPrCoordinationOpenPrReconcilePage } from "../pr-coordination-db";
import type { ApplyEventResult } from "./apply-event";
import { type CronPrTerminal, emitObservedPrTerminal } from "./cron-producer";
import type { GroundTruthReader } from "./parity-check";

/** The cron_sweep_cursors job key for the spine-driven reconcile rotation. */
export const SPINE_TERMINAL_RECONCILE_JOB = "fsm-spine-terminal-reconcile";

/** Default per-tick GitHub-read bound (rows polled per sweep tick before the cursor parks). */
export const DEFAULT_SPINE_RECONCILE_TICK_LIMIT = 40;

/** Default keyset page size within a tick. */
export const DEFAULT_SPINE_RECONCILE_PAGE_LIMIT = 40;

/** Sequential-ish GitHub polling — gentle on installation rate limits while keeping tick latency bounded. */
export const DEFAULT_SPINE_RECONCILE_CONCURRENCY = 4;

/** One session in the reconcile cohort: id + its spine `pr_url` (the ground-truth reader parses it). */
export interface SpineReconcileItem {
  sessionId: string;
  prUrl: string | null;
}

/** The per-tick tally (mutated by the per-row processor; returned to the sweep for logging). */
export interface SpineTerminalReconcileReport {
  /** Rows fetched + considered this tick. */
  scanned: number;
  /** Rows whose PR was observed merged and the spine transitioned to MERGED. */
  reconciledMerged: number;
  /** Rows whose PR was observed closed and the spine transitioned to CLOSED. */
  reconciledClosed: number;
  /** Rows whose PR is still open — no terminal minted. */
  stillOpen: number;
  /** Rows with no readable ground truth (unparseable/null pr_url, null token, unreadable PR). */
  noGroundTruth: number;
  /** Rows where the terminal emit ran but the §10 edge no-oped (already final / lost race / unbound). */
  noop: number;
  /** Rows whose read/emit threw — isolated per-row so the batch continues (expected ~0). */
  failed: number;
}

function emptyReport(): SpineTerminalReconcileReport {
  return {
    scanned: 0,
    reconciledMerged: 0,
    reconciledClosed: 0,
    stillOpen: 0,
    noGroundTruth: 0,
    noop: 0,
    failed: 0,
  };
}

/**
 * The emit seam: mint the observed terminal onto the spine, attributed to the `cron` actor (this pass IS a
 * cron poll). Defaults to {@link emitObservedPrTerminal}; injectable so the pure pass is testable without
 * the applyEvent wiring.
 */
export type SpineTerminalEmit = (sessionId: string, terminal: CronPrTerminal) => Promise<ApplyEventResult | null>;

export interface SpineTerminalReconcileDeps {
  env: Env;
  logger: Logger;
  /** The legacy-INDEPENDENT ground-truth reader (the sweep wires the GitHub `getPrMergeStatus` reader). */
  readGroundTruth: GroundTruthReader;
  /** Override the terminal emit (tests); defaults to the `cron`-actor {@link emitObservedPrTerminal}. */
  emitTerminal?: SpineTerminalEmit;
  /** Fire-and-forget dispatcher threaded into the emit's side-effect execution. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Per-tick GitHub-read bound (default {@link DEFAULT_SPINE_RECONCILE_TICK_LIMIT}). */
  tickLimit?: number;
  /** Keyset page size within a tick (default {@link DEFAULT_SPINE_RECONCILE_PAGE_LIMIT}). */
  pageLimit?: number;
  /** Poll concurrency (default {@link DEFAULT_SPINE_RECONCILE_CONCURRENCY}). */
  concurrency?: number;
}

/**
 * Poll one spine-cohort row's PR ground truth and, on an OBSERVED terminal, mint the matching spine event.
 * Best-effort: every failure path is caught and tallied (NEVER thrown) so `runCronSweep` sees success and
 * always advances the cursor — a persistently-unreadable row can never wedge the rotation.
 */
async function reconcileOne(
  deps: SpineTerminalReconcileDeps,
  emit: SpineTerminalEmit,
  report: SpineTerminalReconcileReport,
  item: SpineReconcileItem,
): Promise<void> {
  report.scanned += 1;
  try {
    const truth = await deps.readGroundTruth({
      sessionId: item.sessionId,
      businessId: null,
      prUrl: item.prUrl,
    });
    // No readable PR state (no url / bad parse / null token / unreadable) — NEVER inferred as a terminal.
    if (!truth.hasPrUrl || truth.prState === null) {
      report.noGroundTruth += 1;
      return;
    }
    if (truth.prState === "open") {
      report.stillOpen += 1;
      return;
    }
    const terminal: CronPrTerminal = truth.prState; // "merged" | "closed"
    const result = await emit(item.sessionId, terminal);
    if (result?.outcome === "handled") {
      if (terminal === "merged") report.reconciledMerged += 1;
      else report.reconciledClosed += 1;
    } else {
      // Emit ran but the §10 edge did not commit a transition (row already final, a lost CAS race, or an
      // unbound/off env) — the terminal is idempotent, so this is a benign no-op, not a failure.
      report.noop += 1;
    }
  } catch (error) {
    report.failed += 1;
    deps.logger.warn(
      { sessionId: item.sessionId, error: String(error) },
      "ARC-1330 spine terminal reconcile row failed (ignored, best-effort)",
    );
  }
}

/**
 * Run ONE tick of the spine-driven merge/close reconcile. Cursor-rotated + read-
 * bounded via {@link runCronSweep}; per-row best-effort. Returns the per-tick tally. The pass NEVER writes
 * `pr_coordination` directly — every terminal rides `applyEvent`'s §10 edge through the injected emit.
 */
export async function reconcileSpineOpenPrTerminals(
  deps: SpineTerminalReconcileDeps,
): Promise<SpineTerminalReconcileReport> {
  const report = emptyReport();

  const emit: SpineTerminalEmit =
    deps.emitTerminal ??
    ((sessionId, terminal) =>
      emitObservedPrTerminal(deps.env, sessionId, terminal, "cron", deps.logger, deps.waitUntil));

  const pageLimit = deps.pageLimit ?? DEFAULT_SPINE_RECONCILE_PAGE_LIMIT;

  await runCronSweep<SpineReconcileItem>(deps.env, deps.logger, {
    name: SPINE_TERMINAL_RECONCILE_JOB,
    tickLimit: deps.tickLimit ?? DEFAULT_SPINE_RECONCILE_TICK_LIMIT,
    concurrency: deps.concurrency ?? DEFAULT_SPINE_RECONCILE_CONCURRENCY,
    fetchPage: async (db, cursor, limit): Promise<CronSweepPage<SpineReconcileItem>> => {
      const rows = await listPrCoordinationOpenPrReconcilePage(db, {
        cursor,
        limit: Math.max(1, Math.min(limit, pageLimit)),
      });
      const items = rows.map((r) => ({ sessionId: r.sessionId, prUrl: r.prUrl }));
      // Keyset on the unique session_id PK; an empty page resets the cursor (runCronSweep) → next rotation.
      return { items, nextCursor: items.length === 0 ? null : items[items.length - 1].sessionId };
    },
    processItem: (item) => reconcileOne(deps, emit, report, item),
  });

  return report;
}
