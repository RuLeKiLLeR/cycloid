// ARC-1330 W11-G1 — post-flip parity checker (the NON-TAUTOLOGICAL soak instrument).
//
// WHY THIS EXISTS (and why it is NOT the divergence sampler). Post-flip, `project()` writes the legacy
// mirror columns FROM the spine, so `arcanist.fsm.divergence` (steady-state / dormant samplers) degrades
// toward self-agreement — a "clean" reading there is a tautology, not evidence (#6359 body, note 3). This
// checker compares the spine's terminal/stage state against ground truth that is INDEPENDENT of the spine
// AND of the legacy mirrors: the GitHub PR's own merged/open/closed state (read via the KEEP'd merge/close
// poll surface `getPrMergeStatus`), and — when a caller supplies it — the verifier CHILD session's actual
// outcome. Neither source is written by `project()`, so agreement here is real evidence the projection is
// honest.
//
// This is the reusable MECHANISM. W11-G3 runs {@link runParityBatch} in BATCH mode over TERMINAL sessions
// (the samplers only ever observe `review_listening`, so a MERGED/CLOSED ground-truth pass has no existing
// comparator) to classify every mismatch regression/improvement/benign. It is dependency-injected end to
// end (the ground-truth reader is a param) so the pure classifier is unit-testable without GitHub, and G3
// can plug a batch-optimised (token-cached) reader in without a second comparator.

import { getPrMergeStatus } from "../../github/pr";
import { postStructuredEventToDd } from "../../observability/events-exporter";
import type { Env } from "../../types";
import { getPrCoordination, listPrCoordinationTerminalCohortForParity } from "../pr-coordination-db";
import type { FsmDdEmit } from "./apply-event";
import { FSM_STATES, type FsmState, type Verdict } from "./types";

/** Default GitHub-read bound for a single terminal-cohort parity batch (the admin trigger's `limit`). */
export const DEFAULT_PARITY_LIMIT = 100;

/**
 * The three arms every parity comparison lands in. `no_ground_truth` is DELIBERATELY DISTINCT from
 * `agree`: an absent/unreadable external source must NEVER count as agreement, or an empty checker read
 * would masquerade as a clean gate (the empty-metric-reads-as-GO trap the whole soak instrument exists to
 * avoid).
 */
export type ParityResult = "agree" | "diverge" | "no_ground_truth";

/** A resolved GitHub PR terminal/lifecycle state — the primary independent ground truth. */
export type PrGroundState = "merged" | "open" | "closed";

/** The observed-side tag on a parity row: the PR state, or `absent` when there is no readable PR. */
export type ObservedPrState = PrGroundState | "absent";

/** An independent verifier CHILD-session outcome (secondary ground truth; undefined = not consulted). */
export type VerifierChildOutcome = "pass" | "fail" | "inconclusive" | null;

/**
 * The legacy-INDEPENDENT ground truth for one session, resolved by a {@link GroundTruthReader}. `hasPrUrl`
 * distinguishes "session never published a PR" from "PR read returned null" (deleted / auth lost) so the
 * `no_ground_truth` reason is honest. `verifierChildOutcome` is the optional secondary source — the default
 * GitHub reader leaves it `undefined`; a caller that loads verifier children can populate it.
 */
export interface ExternalGroundTruth {
  hasPrUrl: boolean;
  prState: PrGroundState | null;
  verifierChildOutcome?: VerifierChildOutcome;
}

/** One per-session comparison result — the batch output rows G3 collects and classifies. */
export interface ParityRow {
  sessionId: string;
  businessId: string | null;
  spineState: FsmState;
  /** Spine row `version` — lets G3 hold out backfilled-untouched (`version === 0`) rows if it wants. */
  spineVersion: number;
  result: ParityResult;
  /** Which independent source drove the result (bounded metric tag). */
  source: "github_pr" | "verifier_child" | "none";
  /** Bounded taxonomy: agreement / the mismatch shape / why there was no ground truth. */
  reason: string;
  /** The PR states consistent with `spineState`; `null` when the spine makes no checkable PR claim. */
  expectedPrStates: PrGroundState[] | null;
  observedPrState: ObservedPrState;
}

/**
 * Which observed GitHub PR states are CONSISTENT with a given spine state. `null` = the spine makes no
 * checkable PR claim (pre-publish, or a no-PR terminal), so the session is `no_ground_truth`, never a
 * divergence. TOTAL over `FsmState` (a missing/stray state is a `tsc` break in `src/`), matching the
 * projection tables in `project.ts`.
 *
 *   • MERGED  → the PR is merged.                         (the G3 MERGED ground-truth case)
 *   • CLOSED  → the PR is closed (unmerged).              (the G3 CLOSED ground-truth case)
 *   • MERGE_READY / REVIEW / VERIFYING / NEEDS_YOU → an OPEN PR awaiting human/CI/verifier action; a PR
 *     already merged or closed under these states is a real projection lag (the safety-critical class).
 *   • SUPERSEDED (ARC-1389) → benign publish-supersede terminal; any RESOLVED PR (closed/merged/open, the
 *     head moved on) is consistent — permissive so it never manufactures false divergence.
 *   • pre-publish (CREATED..PUBLISHING) + no-PR terminals (ANSWERED_NO_PR/FAILED/STOPPED/ARCHIVED) → no
 *     checkable PR claim.
 */
const SPINE_STATE_EXPECTED_PR: Record<FsmState, PrGroundState[] | null> = {
  CREATED: null,
  PROVISIONING: null,
  GENERATING: null,
  AWAITING_INPUT: null,
  FINALIZING: null,
  PUBLISHING: null,
  ANSWERED_NO_PR: null,
  REVIEW: ["open"],
  VERIFYING: ["open"],
  MERGE_READY: ["open"],
  NEEDS_YOU: ["open"],
  FAILED: null,
  STOPPED: null,
  MERGED: ["merged"],
  CLOSED: ["closed"],
  SUPERSEDED: ["closed", "merged", "open"],
  ARCHIVED: null,
};

function isFsmState(value: string): value is FsmState {
  return (FSM_STATES as readonly string[]).includes(value);
}

/**
 * Does the spine's recorded verdict agree with an independent verifier-child outcome? Only `pass`/
 * `app_breaks` make a checkable claim; `skipped`/`none` (and a missing outcome) make none — return `true`
 * (no contradiction) so the secondary check never manufactures divergence on a session that made no
 * verification claim. PURE.
 */
export function verdictAgreesWithChild(verdict: Verdict, outcome: VerifierChildOutcome): boolean {
  if (outcome == null || outcome === "inconclusive") return true;
  if (verdict === "pass") return outcome === "pass";
  if (verdict === "app_breaks") return outcome === "fail";
  return true;
}

/**
 * Compare one spine state (+ verdict) against independent ground truth. PURE and TOTAL. The PR state is the
 * PRIMARY signal; the verifier-child outcome is a SECONDARY check that can only DOWNGRADE a PR-agreement to
 * a divergence (spine recorded a verdict the independent child contradicts — exactly the unrecorded/mis-
 * recorded verification class). It never upgrades a PR divergence away.
 */
export function classifyParity(
  spineStateRaw: string,
  spineVerdict: Verdict,
  groundTruth: ExternalGroundTruth,
): Pick<ParityRow, "result" | "source" | "reason" | "expectedPrStates" | "observedPrState"> {
  const observedPrState: ObservedPrState = groundTruth.prState ?? "absent";

  // A stray/unknown state (should be impossible on a migrated row) is not comparable — surface it rather
  // than crash the batch.
  if (!isFsmState(spineStateRaw)) {
    return {
      result: "no_ground_truth",
      source: "none",
      reason: "unknown_spine_state",
      expectedPrStates: null,
      observedPrState,
    };
  }
  const spineState = spineStateRaw;
  const expectedPrStates = SPINE_STATE_EXPECTED_PR[spineState];

  // ── Primary: GitHub PR state ────────────────────────────────────────────────
  let prArm: ParityResult;
  let prReason: string;
  if (expectedPrStates === null) {
    prArm = "no_ground_truth";
    prReason = "no_pr_claim";
  } else if (!groundTruth.hasPrUrl) {
    prArm = "no_ground_truth";
    prReason = "no_pr_url";
  } else if (groundTruth.prState === null) {
    prArm = "no_ground_truth";
    prReason = "pr_unreadable";
  } else if (expectedPrStates.includes(groundTruth.prState)) {
    prArm = "agree";
    prReason = "pr_state_consistent";
  } else {
    prArm = "diverge";
    prReason = `spine_${spineState}_pr_${groundTruth.prState}`;
  }

  if (prArm === "diverge") {
    return { result: "diverge", source: "github_pr", reason: prReason, expectedPrStates, observedPrState };
  }

  // ── Secondary: verifier-child outcome (only when supplied AND the spine claimed a verdict) ──────────
  // MERGE_READY no longer implies a fresh verifier verdict (post the ARC-1330 CI-ladder cut, QA runs
  // off-gate as a parallel comment signal and the pure-CI door mints MERGE_READY while the recorded
  // verdict may be stale/absent), so a contradicting child outcome cannot downgrade a MERGE_READY
  // PR-agreement to divergence. The in-loop states (REVIEW/VERIFYING/NEEDS_YOU) still honour the check.
  if (
    spineState !== "MERGE_READY" &&
    groundTruth.verifierChildOutcome !== undefined &&
    !verdictAgreesWithChild(spineVerdict, groundTruth.verifierChildOutcome)
  ) {
    return {
      result: "diverge",
      source: "verifier_child",
      reason: `spine_verdict_${spineVerdict}_child_${groundTruth.verifierChildOutcome}`,
      expectedPrStates,
      observedPrState,
    };
  }

  return {
    result: prArm,
    source: prArm === "agree" ? "github_pr" : "none",
    reason: prReason,
    expectedPrStates,
    observedPrState,
  };
}

// ── Ground-truth reader (INJECTED) ─────────────────────────────────────────────

/** The input one ground-truth read gets — everything a reader needs off the spine row. */
export interface ParityReaderInput {
  sessionId: string;
  businessId: string | null;
  prUrl: string | null;
}

/** Resolve the legacy-INDEPENDENT ground truth for a session. Injected so the pure path stays testable. */
export type GroundTruthReader = (input: ParityReaderInput) => Promise<ExternalGroundTruth>;

export interface ParsedGithubPrUrl {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Parse a canonical `https://github.com/<owner>/<repo>/pull/<n>` URL; `null` on any other shape. */
export function parseGithubPrUrl(prUrl: string): ParsedGithubPrUrl | null {
  try {
    const url = new URL(prUrl);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 4 || parts[2] !== "pull") return null;
    const prNumber = Number(parts[3]);
    if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
    return { owner: parts[0], repo: parts[1], prNumber };
  } catch {
    return null;
  }
}

/**
 * The default ground-truth reader: reads the PR's own state from GitHub via the KEEP'd `getPrMergeStatus`
 * poll surface. Token/installation resolution is INJECTED (`resolveToken`) — the batch consumer (W11-G3)
 * owns per-repo token caching, so this module never re-implements installation-token plumbing. A PR with
 * no url → `hasPrUrl:false`; an unresolvable token / unreadable PR (`getPrMergeStatus` returns `state:null`
 * on a non-auth error) → `prState:null` (surfaces as `pr_unreadable`, NEVER as agreement). `getPrMergeStatus`
 * THROWS on 401/403; this wrapper isolates that as unreadable so one dead installation can't abort the batch.
 */
export function buildGithubGroundTruthReader(deps: {
  resolveToken: (input: ParityReaderInput & ParsedGithubPrUrl) => Promise<string | null>;
}): GroundTruthReader {
  return async (input) => {
    if (!input.prUrl) return { hasPrUrl: false, prState: null };
    const parsed = parseGithubPrUrl(input.prUrl);
    if (!parsed) return { hasPrUrl: false, prState: null };
    try {
      const token = await deps.resolveToken({ ...input, ...parsed });
      if (!token) return { hasPrUrl: true, prState: null };
      const status = await getPrMergeStatus(token, parsed.owner, parsed.repo, parsed.prNumber);
      return { hasPrUrl: true, prState: status.state };
    } catch {
      // 401/403 (auth lost) or any read throw → unreadable, not agreement.
      return { hasPrUrl: true, prState: null };
    }
  };
}

// ── The emit (best-effort) ─────────────────────────────────────────────────────

export interface ParityEmitDeps {
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  /** Defaults to {@link postStructuredEventToDd}; overridable for the emit-isolation test. */
  emit?: FsmDdEmit;
}

/**
 * Emit ONE `fsm.parity` DD event for a comparison row. Metric-shaped fields (`result`, `spine_state`,
 * `observed_pr_state`, `source`, `reason`) are BOUNDED enums safe to group in the Terraform log-metric;
 * `expected_pr_states` + `business_id` are log-only drill-down. BEST-EFFORT: a DD failure is swallowed so
 * a checker pass never throws on telemetry.
 */
export async function emitParityMetric(deps: ParityEmitDeps, row: ParityRow): Promise<void> {
  const emit = deps.emit ?? postStructuredEventToDd;
  try {
    await emit(deps.env, {
      event: "fsm.parity",
      session_id: row.sessionId,
      business_id: row.businessId,
      result: row.result,
      spine_state: row.spineState,
      observed_pr_state: row.observedPrState,
      source: row.source,
      reason: row.reason,
      // Log-only (a list cannot fan out a metric group_by).
      expected_pr_states: row.expectedPrStates,
      spine_version: row.spineVersion,
    });
  } catch (err) {
    console.warn("[fsm.parity] metric emit failed (ignored, best-effort):", err);
  }
}

// ── Per-session check + batch runner ───────────────────────────────────────────

/** One session to check: id + owner (for the ground-truth reader's token resolution). */
export interface ParitySessionRef {
  sessionId: string;
}

export interface ParityCheckDeps {
  db: D1Database;
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  readGroundTruth: GroundTruthReader;
  /** Overridable DD emit for tests; defaults (via {@link emitParityMetric}) to the real exporter. */
  emit?: FsmDdEmit;
}

/**
 * Check ONE session's spine state against independent ground truth, emit the metric, and return the row.
 * Returns `null` when the session has no spine row yet (backfill lag) — distinguished from a comparison so
 * the batch can tally it. Best-effort emit inside {@link emitParityMetric}.
 */
export async function checkSessionParity(deps: ParityCheckDeps, ref: ParitySessionRef): Promise<ParityRow | null> {
  const record = await getPrCoordination(deps.db, ref.sessionId);
  if (!record) return null;

  const groundTruth = await deps.readGroundTruth({
    sessionId: ref.sessionId,
    businessId: null,
    prUrl: record.prUrl,
  });
  const verdict = (record.verdict ?? "none") as Verdict;
  const classified = classifyParity(record.state, verdict, groundTruth);
  const row: ParityRow = {
    sessionId: ref.sessionId,
    businessId: null,
    spineState: (isFsmState(record.state) ? record.state : "CREATED") as FsmState,
    spineVersion: record.version,
    ...classified,
  };
  await emitParityMetric({ env: deps.env, emit: deps.emit }, row);
  return row;
}

/** Batch summary — the counts G3 checks alongside the returned {@link ParityRow}s. */
export interface ParityBatchReport {
  /** Sessions that produced a comparison row (had a spine row). */
  checked: number;
  agree: number;
  diverge: number;
  noGroundTruth: number;
  /** Sessions with no spine row yet (backfill lag) — distinguishes lag from an empty cohort. */
  noSpineRow: number;
  /** Sessions whose load/emit threw — isolated per-session so the batch continues. */
  failed: number;
}

/**
 * Run the parity check over a batch of sessions (the W11-G3 consumer entry point). Best-effort PER SESSION:
 * a thrown load/read/emit is tallied in `failed` and the batch continues, never aborting the remainder.
 * Returns the summary report + every {@link ParityRow} (G3 classifies the rows regression/improvement/
 * benign and allowlists the benign shapes). Sequential — one GitHub read per session; the caller bounds the
 * batch size / paginates.
 */
export async function runParityBatch(
  deps: ParityCheckDeps,
  refs: ParitySessionRef[],
): Promise<{ report: ParityBatchReport; rows: ParityRow[] }> {
  const report: ParityBatchReport = {
    checked: 0,
    agree: 0,
    diverge: 0,
    noGroundTruth: 0,
    noSpineRow: 0,
    failed: 0,
  };
  const rows: ParityRow[] = [];
  for (const ref of refs) {
    try {
      const row = await checkSessionParity(deps, ref);
      if (!row) {
        report.noSpineRow += 1;
        continue;
      }
      report.checked += 1;
      if (row.result === "agree") report.agree += 1;
      else if (row.result === "diverge") report.diverge += 1;
      else report.noGroundTruth += 1;
      rows.push(row);
    } catch {
      report.failed += 1;
    }
  }
  return { report, rows };
}

// ── The terminal-cohort trigger (W11-G3 entry point) ────────────────────────────

/** Deps for {@link runTerminalCohortParity}: the DB + env + the INJECTED legacy-independent reader. */
export interface TerminalCohortParityDeps {
  db: D1Database;
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">;
  /** The legacy-independent ground-truth reader (the route wires the GitHub reader + its token plumbing). */
  readGroundTruth: GroundTruthReader;
  /** Overridable DD emit for tests; defaults (via {@link emitParityMetric}) to the real exporter. */
  emit?: FsmDdEmit;
}

/**
 * The W11-G3 batch entry point (the missing trigger for the W11-G1 checker): enumerate the TERMINAL cohort —
 * `MERGED`/`CLOSED`/`MERGE_READY`/`NEEDS_YOU`, the states the `review_listening`-pinned samplers never
 * observe — and run the non-tautological parity check over it against INJECTED legacy-independent ground
 * truth (the GitHub PR's own merged/open/closed state; never a `session_index` mirror). READ-ONLY: no spine
 * writes. `limit` bounds BOTH the enumeration AND the per-row GitHub reads (one read per row); defaults to
 * {@link DEFAULT_PARITY_LIMIT}. Returns the batch report (the `{agree, diverge, no_ground_truth}` tallies)
 * + every {@link ParityRow}. Emits one `fsm.parity` DD event per checked session (best-effort, inside
 * {@link emitParityMetric}).
 */
export async function runTerminalCohortParity(
  deps: TerminalCohortParityDeps,
  opts: { limit?: number } = {},
): Promise<{ report: ParityBatchReport; rows: ParityRow[] }> {
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : DEFAULT_PARITY_LIMIT;
  const cohort = await listPrCoordinationTerminalCohortForParity(deps.db, { limit });
  const refs: ParitySessionRef[] = cohort.map((rec) => ({ sessionId: rec.sessionId }));
  return runParityBatch(deps, refs);
}
