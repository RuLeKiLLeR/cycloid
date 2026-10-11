// ARC-1330 (W11-T1) — the one-shot ROW-7 REPAIR runner.
//
// #6381 + #6403 stop NEW sessions from parking at cascade row-5 `ci_pending` when the merge-ready door
// completes but the honest CI signal was never re-read. This runner repairs the STANDING STOCK those
// fixes cannot reach retroactively — the rows already parked (and, via the REVIEW deadline, already
// drained into `NEEDS_YOU(review_stuck)`) before the fixes landed:
//
//   • target `review`     (part 2): enumerate `REVIEW` rows that hold the post-decouple `caught_up` door
//     EXCEPT CI (0 undispositioned actionable items, no in-flight epoch) and re-emit an HONEST `ci.signal`
//     from a one-head read — the normal §6.4 edge settles row 7. NO state is hand-written (the cascade
//     owns the MERGE_READY decision + its effects).
//   • target `needs_you`  (part 3): the same qualifying set but already drained to `NEEDS_YOU(review_stuck)`.
//     Those rows have NO signal re-entry (`NEEDS_YOU` handles only `review.received`; `caught_up`/`ci.signal`
//     are unhandled), so the repair is the backfill-rebaseline idiom, JOURNALED (keystone FIX 3): CAS the
//     stuck row back to `REVIEW` at its exact version, append the matching `pr_coordination_events` row in
//     the same commit sequence (CAS → journal → telemetry, mirroring `finishCommit`'s ordering — the §18/D17
//     reconstruction never sees a version gap), emit the `fsm.transition`-shaped telemetry event
//     (`fsm_event: admin.row7_repair_reopen`), then re-emit the honest `ci.signal` so the cascade settles it
//     through the SAME normal edge. MERGE_READY is still minted by the cascade, never hand-written. The
//     reopen stamps `state_entered_at := now` + the REVIEW-class `deadline_at` — exactly the shape a spine
//     commit writes; no per-session DO alarm is armed, deliberately: the re-emitted `ci.signal` drives the
//     row back through the normal cascade, and a row that wedges again is re-surfaced by this same
//     admin-triggered repair path. Admin-triggered, NEVER auto-fired
//     (Jag's call — see the PR's Jag-decision section).
//
// SOUNDNESS (ARC-1330 CI-ladder cut + the keystone FIX 1 absent trap): verification is decoupled from the
// merge-ready gate, so the qualifying door reads NO verification predicate; the re-emitted `ci.signal`
// drives the cascade's CI rows — never a verification dispatch — so `verification_run_count` is NEVER
// incremented and no `record_verification` (hence no `verdict_head_sha` stamp) ever runs. Honest CI is
// never fabricated: a `pending`/faulted read leaves the row exactly where it is, and a SINGLE `absent`
// read is NOT settleable (checks-not-yet-registered
// / GitHub-aged-out check runs on old parked stock read `absent` — the exact false-green #6403 debounces
// against). An `absent` read settles ONLY when corroborated by a prior journaled `ci.signal(absent)`
// (`isAbsentCiCorroborated` — see honest-ci-read.ts's absent trap); uncorroborated absents are tallied
// `ciAbsentUnconfirmed` and skipped. DRY-RUN FIRST: `dryRun` reads + classifies (including the CI poll, for
// an accurate would-settle report) but writes/emits NOTHING; only a non-dry-run pass emits.
// Idempotent: a second pass re-reads current state, so an already-settled row no longer qualifies
// (REVIEW → MERGE_READY) or is no longer in the stuck cohort, and is skipped.
//
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.

import type { ReviewLoopCiState } from "../../services/review-loop-rollup";
import {
  casUpdatePrCoordination,
  getPrCoordination,
  listPrCoordinationByStateForRepair,
  type PrCoordinationRecord,
} from "../pr-coordination-db";
import { appendPrCoordinationEvent } from "../pr-coordination-events-db";
import { countUndispositionedActionable } from "../pr-review-item-disposition-db";
import { deadlineClassMs } from "./deadline-producer";
import { stageOf } from "./project";
import type { FsmRecord } from "./types";

/** Which parked cohort to repair. `review` = part 2 (row-5 parked); `needs_you` = part 3 (deadline-drained). */
export type Row7RepairTarget = "review" | "needs_you";

/** The `NEEDS_YOU` block reason the REVIEW state-deadline stamps (`transition.ts` REVIEW `deadline_exceeded`). */
export const REVIEW_STUCK_BLOCKED_REASON = "review_stuck";

/** The journal/telemetry event name the needs_you reopen writes (an out-of-band admin repair, honestly named). */
export const ROW7_REPAIR_REOPEN_EVENT = "admin.row7_repair_reopen";

/**
 * The external I/O + clock seams (injected so a unit test drives the runner with a real migrated D1 for the
 * DAO reads/writes but deterministic CI verdicts + a spy `ci.signal` emit — the backfill-runner idiom).
 */
export interface Row7RepairDeps {
  db: D1Database;
  /** Clock seam (deterministic in tests). */
  now: () => number;
  /** Honest one-head CI read — real: `(prUrl, headSha) => readHeadCiForRecord(env, prUrl, headSha)` (raw). */
  readHeadCi: (prUrl: string, headSha: string) => Promise<ReviewLoopCiState | undefined>;
  /**
   * Whether an `absent` read is corroborated by a prior journaled `ci.signal(absent)` — real:
   * `(sid) => isAbsentCiCorroborated(db, sid)`. The runner keeps this separate from the read (instead of
   * consuming `readSettleableHeadCiForRecord`) so uncorroborated absents get their own distinct tally.
   */
  isAbsentCorroborated: (sessionId: string) => Promise<boolean>;
  /** Feed the honest `ci.signal` into the spine — real: `(sid, ci) => shadowEmitCiSignal(env, sid, ci, log, waitUntil)`. */
  emitCiSignal: (sessionId: string, ciState: ReviewLoopCiState) => Promise<void>;
  /**
   * Best-effort `fsm.transition`-shaped telemetry emit for the needs_you reopen (FIX 3) — real:
   * `(event) => postStructuredEventToDd(env, event)`. Optional: absent = no emit (tests/off-DD).
   */
  emitRepairTelemetry?: (event: Record<string, unknown>) => Promise<unknown>;
}

/** The batch tally (observe-only; the route logs + returns it). See the field comments for what each means. */
export interface Row7RepairReport {
  target: Row7RepairTarget;
  dryRun: boolean;
  /** Rows returned by the state enumerator. */
  enumerated: number;
  /** Rows whose conjunction-except-CI held at the per-row re-read (the repairable set). */
  qualified: number;
  /** Rows that raced out of the target cohort (state/reason changed, or vanished) between enum + re-read. */
  skippedStateChanged: number;
  /** Rows with no PR url / head (nothing to poll). */
  skippedNoPr: number;
  /** Rows still in the target state whose conjunction-except-CI did NOT hold. */
  skippedNotQualified: number;
  /** Qualified rows whose honest CI read was green (or CORROBORATED absent) → would settle / settled MERGE_READY. */
  ciGreen: number;
  /** Qualified rows whose honest CI read was failing → would drive (dryRun) / drove (live) the ciFix row. */
  ciRed: number;
  /** Qualified rows whose honest CI read was pending → left waiting (no emit, no reopen). */
  ciPending: number;
  /** Qualified rows whose CI read faulted/undefined → left as-is (conservative). */
  ciUnknown: number;
  /**
   * Qualified rows whose read was `absent` WITHOUT a prior journaled `ci.signal(absent)` (the FIX-1 absent
   * trap: checks-not-yet-registered / aged-out check runs) → left as-is, never settled on a single absent.
   */
  ciAbsentUnconfirmed: number;
  /** (needs_you) rows CAS-reopened NEEDS_YOU→REVIEW with a matching journal row (0 in dryRun / non-live). */
  reopened: number;
  /** `ci.signal`s actually emitted into the spine (0 in dryRun / non-live). */
  emitted: number;
  /** Per-session isolation: a read/write/emit fault for one row (never fatal to the batch). */
  failed: number;
}

/**
 * The `caught_up`-door-EXCEPT-CI predicate — a row that, given a green CI read, settles cascade row 7 (D10).
 * PURE. Post the ARC-1330 CI-ladder cut the merge-ready door is a PURE CI LADDER: verification runs off-gate
 * (spawned at publish, recorded as bookkeeping), so the `caught_up` conjunction is just `no_inflight_epoch ∧
 * 0 undispositioned` (guards.ts `caughtUp`). This predicate matches that door — it reads NO verification
 * verdict / freshness / code-changed signal — plus a live head to poll. A never-verified row (`verdict:null`)
 * qualifies exactly like any other; verification is not consulted.
 *
 * PR-A2 (waitset-deletion) already removed the former `settled: boolean` parameter (reviewer first-contact
 * settle is gone from `caught_up`); PR-E2 removes the residual verification reads to finish aligning the
 * runner's qualification with the live pure-CI door.
 */
export function qualifiesForRow7Settle(rec: PrCoordinationRecord, undispositioned: number): boolean {
  return rec.headSha !== null && rec.inFlightEpochId === null && undispositioned === 0;
}

/** Whether a re-read record is still in the runner's target cohort (skip stale rows that raced out). */
function inTargetCohort(target: Row7RepairTarget, rec: PrCoordinationRecord): boolean {
  return target === "review"
    ? rec.state === "REVIEW"
    : rec.state === "NEEDS_YOU" && rec.blockedReason === REVIEW_STUCK_BLOCKED_REASON;
}

/**
 * Enumerate the target cohort → re-qualify each row against the live disposition store + an honest CI read →
 * (live, non-dryRun) re-emit the honest `ci.signal`, first CAS-reopening a `NEEDS_YOU(review_stuck)` row to
 * `REVIEW`. Best-effort per row (a fault is tallied `failed`, never thrown). `limit` caps processed rows.
 */
export async function runRow7Repair(
  deps: Row7RepairDeps,
  opts: { target: Row7RepairTarget; dryRun: boolean; limit?: number },
): Promise<Row7RepairReport> {
  const willAct = !opts.dryRun;
  const state = opts.target === "review" ? "REVIEW" : "NEEDS_YOU";
  const blockedReason = opts.target === "needs_you" ? REVIEW_STUCK_BLOCKED_REASON : undefined;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : 2000;

  const candidates = await listPrCoordinationByStateForRepair(deps.db, { state, blockedReason, limit });

  const report: Row7RepairReport = {
    target: opts.target,
    dryRun: opts.dryRun,
    enumerated: candidates.length,
    qualified: 0,
    skippedStateChanged: 0,
    skippedNoPr: 0,
    skippedNotQualified: 0,
    ciGreen: 0,
    ciRed: 0,
    ciPending: 0,
    ciUnknown: 0,
    ciAbsentUnconfirmed: 0,
    reopened: 0,
    emitted: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      // Re-read: act on CURRENT state (a row may have settled or moved since the enumeration), and get the
      // exact version the NEEDS_YOU→REVIEW CAS must guard on.
      const rec = await getPrCoordination(deps.db, candidate.sessionId);
      if (!rec || !inTargetCohort(opts.target, rec)) {
        report.skippedStateChanged += 1;
        continue;
      }
      if (!rec.prUrl || !rec.headSha) {
        report.skippedNoPr += 1;
        continue;
      }
      const undispositioned = await countUndispositionedActionable(deps.db, rec.sessionId, rec.prUrl);
      if (!qualifiesForRow7Settle(rec, undispositioned)) {
        report.skippedNotQualified += 1;
        continue;
      }
      report.qualified += 1;

      const ci = await deps.readHeadCi(rec.prUrl, rec.headSha);
      if (ci === undefined) {
        report.ciUnknown += 1;
        continue;
      }
      if (ci === "pending") {
        report.ciPending += 1; // still running — leave parked/stuck (honest wait, never a false settle)
        continue;
      }
      if (ci === "absent" && !(await deps.isAbsentCorroborated(rec.sessionId))) {
        // FIX 1 (the absent trap): a SINGLE absent read is what checks-not-yet-registered and GitHub-
        // aged-out check runs look like — on aged parked stock it would mint a false MERGE_READY on a PR
        // that never had a green observation. Settle on absent ONLY with a prior journaled
        // `ci.signal(absent)` (the #6403 debounce / the sweep's re-poll already saw it); else leave as-is.
        report.ciAbsentUnconfirmed += 1;
        continue;
      }
      if (ci === "failing") report.ciRed += 1;
      else report.ciGreen += 1; // green | corroborated absent → the settleable bucket

      // Classification is complete; the remaining steps WRITE, so only under live + non-dryRun.
      if (!willAct) continue;

      if (opts.target === "needs_you") {
        // Rebaseline the stuck row back into the loop at its exact version, then let the ci.signal settle it
        // through the normal cascade edge. A lost CAS (version raced) means a producer already advanced it.
        const reviewDeadlineMs = deadlineClassMs("REVIEW");
        const now = deps.now();
        const reopenedVersion = rec.version + 1;
        const changed = await casUpdatePrCoordination(deps.db, rec.sessionId, rec.version, {
          state: "REVIEW",
          blockedReason: null,
          // The exact shape a spine REVIEW-entry commit writes. No per-session DO alarm is armed —
          // deliberately: the sweep's dwell backstop (`deadlineWouldFire` reads `state_entered_at` + the
          // class window, not the alarm) re-drains the row if it wedges again.
          deadlineAt: reviewDeadlineMs === null ? null : now + reviewDeadlineMs,
          stateEnteredAt: now,
        });
        if (changed !== 1) {
          report.skippedStateChanged += 1;
          continue;
        }
        // FIX 3 — journal-first, mirroring `finishCommit` (CAS → journal → telemetry): the committed
        // reopened version gets its matching `pr_coordination_events` row so the §18/D17 reconstruction
        // never sees a version gap, honestly named as the out-of-band admin repair it is. A journal fault
        // throws to the per-row catch (tallied `failed`, no `reopened`/`ci.signal` double-count); the
        // reopened row is then covered by a later `target=review` pass + the sweep dwell backstop.
        await appendPrCoordinationEvent(deps.db, {
          sessionId: rec.sessionId,
          version: reopenedVersion,
          fromState: "NEEDS_YOU",
          toState: "REVIEW",
          event: ROW7_REPAIR_REOPEN_EVENT,
          at: now,
          actor: "internal",
          metadata: { type: ROW7_REPAIR_REOPEN_EVENT, ciState: ci, clearedBlockedReason: REVIEW_STUCK_BLOCKED_REASON },
          dwellMs: rec.stateEnteredAt === null ? null : now - rec.stateEnteredAt,
        });
        report.reopened += 1;

        // Best-effort `fsm.transition`-shaped telemetry (the same shape `emitTransitionEvent` posts), so
        // the reopen is visible on the transition timeline/dashboards. Never blocks the repair.
        if (deps.emitRepairTelemetry) {
          try {
            await deps.emitRepairTelemetry({
              event: "fsm.transition",
              session_id: rec.sessionId,
              version: reopenedVersion,
              from: "NEEDS_YOU",
              to: "REVIEW",
              fsm_event: ROW7_REPAIR_REOPEN_EVENT,
              dwell_ms: rec.stateEnteredAt === null ? null : now - rec.stateEnteredAt,
              stage_from: stageOf(rec as FsmRecord),
              stage_to: stageOf({ ...rec, state: "REVIEW", blockedReason: null } as FsmRecord),
              stage: stageOf(rec as FsmRecord),
            });
          } catch {
            // observability-only (O2) — never blocks the repair
          }
        }
      }

      await deps.emitCiSignal(rec.sessionId, ci);
      report.emitted += 1;
    } catch {
      report.failed += 1;
    }
  }

  return report;
}
