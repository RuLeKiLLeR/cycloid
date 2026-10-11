// ARC-1330 lifecycle FSM (PR 47, the 4b emitter rewire) — the LIVE guard-resolver matrix.
//
// THE ONE SHARED FACTORY every post-publish producer uses. In shadow each
// producer keeps its own HARD-FLOORED resolver (`caughtUpInputs → {count:1}`) — the
// floor IS the shadow no-MERGE_READY invariant and is deliberately untouched. At live that floor
// would make the flip unreachable: the `caught_up` recompute could never observe a genuinely-settled
// worklist, so cascade row 7 (the SOLE MERGE_READY emitter, D10) could never fire and no session would
// ever reach MERGE_READY. This resolver supplies the REAL reads:
//
//   • `caughtUpInputs` — the AUTHORITATIVE disposition count (`countUndispositionedActionable`) from D1,
//     plus `noInflightEpoch` from the committed record. ASYNC by contract (the `FsmGuardResolver` seam
//     widened in PR 47): `finishCommit` awaits it AFTER the bucket-a worklist commit, so a just-registered
//     item is durable before the snapshot is read (FG-5 / §6 ordering — pre-loading before `applyEvent`
//     would race the registration and could mint a premature MERGE_READY). A record with no `pr_url`
//     returns the conservative floor (nothing post-publish exists to settle).
//   • `guards()` — the FULL record-sourced bag, total over every post-publish edge INCLUDING the
//     re-entrant internal `caught_up` cascade (the same `applyEvent` deps serve the recompute, so the
//     bag must carry the cascade guards: `code_changed`, verification pass/fresh/caps, ci bucket).
//   • `ciBucket` / `resetContext.ciGreen` — HONEST CI sourcing, never fabricated. Two sources, in
//     order: (1) the caller's `ctx.ciBucket` when it holds a real read (the CI producer threads its
//     observed `reduceCiState` rollup; the verdict-return seam threads #6381's one-head read); (2) when
//     the caller supplies NONE (epoch-terminal, review-received and every other transition §6 trigger),
//     the `caughtUpInputs` snapshot below sources a bounded one-head `readSettleableHeadCiForRecord`
//     read (uncorroborated absent degrades to pending — the W11-T1 absent trap) AT the
//     moment the merge-ready conjunction completes — repairing the W11-T1 row-7 stall where a conjunction
//     completing via a non-verdict trigger with a pre-existing fresh verdict parked at `ci_pending`
//     forever (legacy stops feeding `ci.signal` once IT finishes the loop). Both sources map through
//     `classifyCi`, so a `pending`/absent-read/faulted read stays the conservative `ci_pending` (row-5
//     WAIT — NEVER a fabricated green): a false green mints a false MERGE_READY on untested code. The
//     mutable `resolvedCiBucket` is read by BOTH `guards()` and `resetContext()`; the `caughtUpInputs`
//     read runs BEFORE the re-entrant internal `caught_up` cascade's `guards()` call (`finishCommit`
//     awaits the snapshot first), so the cascade's row 5-vs-7 decision reads the honest value. The outer
//     trigger event's own `guards()` (run before the snapshot) keeps `ci_pending` — harmless, since
//     MERGE_READY is minted ONLY by the `caught_up` cascade (D10), never a non-`caught_up` edge.
//     `resetContext.ciGreen` follows the same mutable source and is conservatively deferred — never
//     falsely fired — elsewhere.
//   • `newEpochId` — the legacy-created epoch id when the caller holds one (`ctx.legacyEpochId`, the
//     review ingest threads it: legacy CREATES the epoch, the FSM RECORDS its real id, and the live
//     sink's `dispatch_epoch` exists-check anchors on it — closing PR 46's dispatch_epoch deferral);
//     else the synthetic version-keyed id (`epoch-<sid>-<version>`) the producers already mint, so
//     `requireNewEpochId` can never throw under live (PR 46 review uncertainty #3) and a redelivered
//     event re-derives the same id (§17-B idempotency).
//   • `deadlineMs` — the REAL `deadlineClassMs` map (DE-3): every live commit arms the resulting
//     state's true backstop window; the deadline producer's alarm fire then routes `deadline_exceeded`.
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import type { Env } from "../../types";
import { countUndispositionedActionable } from "../pr-review-item-disposition-db";
import { getSessionState } from "../state";
import type { FsmCaughtUpInputs, FsmGuardResolver } from "./apply-event";
import { deadlineClassMs } from "./deadline-producer";
import {
  type CiBucket,
  classifyCi,
  underCiFixCap,
  underMergeReadyReopenCap,
  underVerificationCap,
  verificationFresh as verificationFreshGuard,
  verificationPass as verificationPassGuard,
} from "./guards";
import { readSettleableHeadCiForRecord } from "./honest-ci-read";

/** The per-producer event context the shared live resolver folds into the record-sourced bag. */
export interface LiveResolverContext {
  /**
   * The producer's HONEST live CI read for the cascade's `¬code_changed` branch (rows 3-7) and the
   * FG-2 `resetContext.ciGreen`. Supplied ONLY by the CI producer (the observed `reduceCiState`
   * rollup riding its own `ci.signal`); every other producer omits it and defaults to `ci_pending` —
   * the row-5 WAIT (an honest "unknown", never a fabricated green: a false `ci_pending` delays the
   * cascade one `ci.signal`/re-poll, a fabricated green could mint a false MERGE_READY).
   */
  ciBucket?: CiBucket;
  /**
   * The disposition-store source id of the review this event carries (`register_review` stamps it).
   * Threaded by the review producer; absent elsewhere (no edge without it registers).
   */
  reviewSourceId?: string;
  /**
   * The LEGACY-created review-loop epoch id, when the emitting seam holds one (the review ingest's
   * `result.epoch.id`). Legacy keeps epoch-creation authority in this slice (PR 46 scope), so when a
   * dispatching edge stamps `in_flight_epoch_id` the record anchors to the REAL epoch row — the live
   * sink's `dispatch_epoch` exists-check then resolves to a clean idempotent no-op instead of the
   * `epoch_row_not_materialized_until_pr47` skip. Absent → the synthetic version-keyed id.
   */
  legacyEpochId?: string;
  /**
   * ARC-1445 / ARC-1556: the undispositioned actionable source ids NOT covered by a LIVE
   * (non-terminal) epoch, traced by the SAME-HEAD epoch-terminal producer
   * (`listUndispositionedActionable` − `listLiveEpochCoveredSourceIds`). The `epoch.settled`,
   * `epoch.replied`, and `epoch.declined` REVIEW edges arm the drain when this is non-empty. Threaded
   * ONLY by those same-head terminals (which also OMIT `legacyEpochId` so `newEpochId` is a fresh
   * synthetic id, never the settling/replying epoch's own → the executor creates rather than
   * re-observing the terminal row). Default [] elsewhere.
   */
  uncoveredActionableSourceIds?: readonly string[];
  /**
   * A4: whether the just-committed review epoch dispositioned ≥1 QA-sourced item (`known:cycloid-qa`). The
   * epoch producer traces the committed epoch's owned source ids against the QA `qa-verdict:` namespace and
   * threads the result ONLY on `epoch.committed`. Drives the REVIEW re-run arm (with `record.verdict` +
   * head-advanced + run-cap, all record-sourced in `guards()`). Absent → false (no re-run).
   */
  committedEpochDispositionedQaFinding?: boolean;
}

/**
 * Build the shared LIVE `FsmGuardResolver` (see the file header for the matrix). One instance serves
 * both the producer's own event AND the re-entrant internal `caught_up` recompute, so the returned
 * bag is total over the post-publish edge set — every value record-sourced except the per-producer
 * `ctx` threads above.
 */
export function buildLiveGuardResolver(env: Env, sessionId: string, ctx: LiveResolverContext = {}): FsmGuardResolver {
  // MUTABLE (W11-T1): the caller's read wins when supplied; otherwise the `caughtUpInputs` snapshot
  // fills it with an honest one-head read the moment the merge-ready conjunction completes (see the file
  // header). `guards()` + `resetContext()` read this live `let`, so the value the snapshot resolves is
  // observed by the re-entrant `caught_up` cascade's guard read that follows it in `finishCommit`.
  const callerSuppliedCi = ctx.ciBucket !== undefined;
  let resolvedCiBucket: CiBucket = ctx.ciBucket ?? "ci_pending";
  // MUTABLE, same seam as `resolvedCiBucket`: the per-user/session auto-verify opt-out (#6395). The
  // `caughtUpInputs` snapshot resolves it from the owning session's DO state the moment the merge-ready
  // conjunction completes (the only moment the cascade's verification columns are consulted). Default
  // false: the trigger event's own `guards()` (run before the snapshot) reads the un-waived gate —
  // harmless, since the waiver is only consulted by the `caught_up` cascade (D10), which runs AFTER the
  // snapshot resolves. A failed session read stays false — fail-safe toward the full verification gate,
  // never toward a false waive.
  let resolvedAutoVerifyDisabled = false;
  return {
    guards: (rec) => ({
      // No transport edge is served here (transport stays shadow-posture, Wave-10 scope), but the
      // bag stays well-formed for the cross-cutting edges that read it.
      sandboxAlive: true,
      blockedReason: rec.blockedReason,
      // ── epoch/dispatch guards (§17-B) ──
      noInflightEpoch: rec.inFlightEpochId == null,
      newEpochId: ctx.legacyEpochId ?? `epoch-${sessionId}-${rec.version}`,
      underCiFixCap: underCiFixCap(rec.ciFixRounds),
      ciFixRounds: rec.ciFixRounds,
      underMergeReadyReopenCap: underMergeReadyReopenCap(rec.mergeReadyReopenCount),
      mergeReadyReopenCount: rec.mergeReadyReopenCount,
      // Legacy keeps epoch WORKLIST-construction authority in this slice: the FSM's own CI-settled
      // epoch-1 trigger stays unarmed (`epoch1Fired`/`actionableExists` false — the review ingest
      // drives real dispatch), exactly the PR 46 scope decision.
      ciSettled: true,
      epoch1Fired: false,
      actionableExists: false,
      // ── cascade guards (§9 rows 1-8) — record-sourced ──
      codeChangedSinceVerification: rec.codeChangedSinceVerification,
      ciBucket: resolvedCiBucket,
      autoVerifyDisabled: resolvedAutoVerifyDisabled,
      verificationPass: verificationPassGuard(rec.verdict),
      verificationFresh: verificationFreshGuard(rec.verdictHeadSha, rec.headSha),
      underVerificationCap: underVerificationCap(rec.verificationRunCount),
      verificationRunCount: rec.verificationRunCount,
      verificationRunId: rec.verificationRunId,
      headSha: rec.headSha,
      // ── VERIFYING run handles (FG-1) ──
      // The ACTIVE run's child, stamped post-commit by the spawn side-effect (W11-V1): the run-scoped
      // `kill_verification` on every real VERIFYING exit / the head.changed supersede tears it down.
      verificationChildId: rec.verificationChildId,
      // The GHOST-discard target MUST NOT be the active child (FG-1: never touch the live run). The
      // record carries only the ACTIVE run's handle, and a superseded run's child was already killed at
      // supersession (the head.changed redispatch kills-before-spawn), so the ghost kill is a redundant
      // re-kill with no recoverable handle → `null` (a safe no-op). Sourcing it from `verificationChildId`
      // would kill the LIVE run once W11-V1 populates that handle — the exact FG-1 violation.
      verdictVerificationChildId: null,
      // ── worklist registration threads ──
      reviewSourceId: ctx.reviewSourceId,
      uncoveredActionableSourceIds: ctx.uncoveredActionableSourceIds ?? [],
      // ── A4 QA re-run arm (REVIEW epoch.committed) — verdict/heads record-sourced; QA-finding via ctx ──
      recordedVerdict: rec.verdict,
      verdictHeadSha: rec.verdictHeadSha,
      currentHeadSha: rec.headSha,
      // Re-entrancy fence: a run already REQUESTED at the live head blocks a redelivered `epoch.committed`
      // from spawning a duplicate verifier / burning a second run at the same head (verdictHeadSha lags).
      verificationRunHead: rec.verificationRunHead,
      committedEpochDispositionedQaFinding: ctx.committedEpochDispositionedQaFinding ?? false,
      // ── resume guards (§10) — record-sourced so a STOPPED row resumes faithfully ──
      stopMode: rec.stopMode ?? undefined,
      preStopState: rec.preStopState ?? undefined,
    }),
    // FG-2 reset context: `ciGreen` follows the SAME honest source as the cascade bucket (real for
    // the CI producer, conservatively false elsewhere — a deferred reset is repaired by the next
    // green `ci.signal` self-loop's own reset field-write; a false green would erase a live budget).
    resetContext: (rec) => ({ ciGreen: resolvedCiBucket === "ci_green", noInflightEpoch: rec.inFlightEpochId == null }),
    // The REAL post-worklist-commit snapshot (FG-5). Async: finishCommit awaits it only when the
    // committed transition is a §6 recompute trigger.
    caughtUpInputs: async (rec): Promise<FsmCaughtUpInputs> => {
      if (!rec.prUrl) {
        // Pre-publish / no-PR rows have no worklist to settle — the conservative floor (parity with
        // the shadow resolvers; a caught_up can never fire for a row that has no PR).
        return {
          noInflightEpoch: rec.inFlightEpochId == null,
          store: { countUndispositionedActionable: () => 1 },
        };
      }
      const undispositioned = await countUndispositionedActionable(env.DB, sessionId, rec.prUrl);
      // W11-T1 row-7 completion: when the caller supplied NO CI read (every §6 trigger except the CI
      // producer + the verdict-return seam), source an honest one-head read at the moment the merge-ready
      // conjunction actually completes — so a row parked at row-5 `ci_pending` by an epoch-terminal /
      // review-received / re-open recompute settles MERGE_READY through the SAME cascade instead of
      // waiting for a green `ci.signal` that legacy has stopped feeding. Gated on the collapsed merge-ready
      // door (`state===REVIEW ∧ noInflightEpoch ∧ 0 undispositioned`) so the GitHub poll is paid ONLY when a
      // `caught_up{head}` is about to emit (rows that will not settle skip the read). NEVER fabricates
      // green: `classifyCi` maps a genuine green/absent → `ci_green`, failing → `ci_red`, and
      // pending/faulted (undefined) leaves the conservative `ci_pending` untouched (row-5 WAIT).
      if (rec.state === "REVIEW" && rec.inFlightEpochId == null && undispositioned === 0) {
        // The merge-ready conjunction holds — a `caught_up{head}` is about to emit, so this is the
        // one moment the cascade's verification columns get consulted. Resolve the per-user/session
        // auto-verify opt-out (#6395) from the owning session's DO state here (bounded: paid only
        // when a caught_up will actually fire, like the GitHub poll below). A failed read stays false
        // — fail-safe toward the full gate.
        const session = await getSessionState(env, sessionId).catch(() => null);
        resolvedAutoVerifyDisabled = session?.autoVerifyDisabled ?? false;
        // W11-T1 honest one-head CI read (see the block doc above). Gated ONLY on the merge-ready door
        // (state===REVIEW ∧ noInflightEpoch ∧ 0 undispositioned) — the verification conjuncts are dropped
        // so the poll is paid whenever a `caught_up{head}` is about to emit. Gating it on pass ∧ fresh ∧
        // ¬code_changed (or the auto-verify waiver) would starve the no-CI / auto-verify-ON cohort at the
        // conservative `ci_pending` forever (row-5 WAIT → the 4h review_stuck backstop). NEVER fabricates
        // green: the read itself still maps a genuine green/absent → `ci_green` through `classifyCi`.
        if (!callerSuppliedCi) {
          const honest = await readSettleableHeadCiForRecord(env, sessionId, rec.prUrl, rec.headSha);
          if (honest !== undefined) resolvedCiBucket = classifyCi(honest);
        }
      }
      return {
        noInflightEpoch: rec.inFlightEpochId == null,
        store: { countUndispositionedActionable: () => undispositioned },
      };
    },
    // DE-3: every live commit arms the resulting state's REAL backstop window.
    deadlineMs: (state) => deadlineClassMs(state),
  };
}
