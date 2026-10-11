// ARC-1330 lifecycle FSM (PR 35) — the LEGACY-ADAPTER record (design rollout PR2 / F47).
//
// Until the spine's `pr_coordination` row is POPULATED by the producers (PR 36–44), a session's live
// display must NOT be routed through an unpopulated FSM row (F47). The adapter bridges that gap: it maps
// a legacy session's already-computed status fields into an `FsmRecord` so the SAME pure `project()`
// (PR 28–33) the spine will eventually feed can render `phase` / `feChip` / `cycloidDone` / labels /
// stage copy from legacy state in the meantime. One projection code path, two record sources (legacy
// adapter now, spine row once populated).
//
// SHADOW: nothing consumes `project()` output yet — this is the parity substrate (the "adapter parity"
// test proves `project(legacyAdapterRecord(legacy))` reproduces the legacy session's user-facing
// `phase` + `cycloid_done` surface). It is a PURE function: legacy fields in, `FsmRecord` out.
//
// FIDELITY (stated honestly — the FSM is a DIFFERENT model, which is WHY it replaces legacy):
//   • `phase` parity holds for EVERY non-`idle` legacy phase (the primary F47 guarantee — the FE pill is
//     correct). `idle` is the one `Phase` with no spine state (pre-session); a created session is never
//     `idle`, so it is excluded from the input type.
//   • `cycloid_done` parity holds by construction for the phases where it is well-defined (`completed`,
//     `blocked`, and the pre-PR `working` phases): the adapter picks the FSM state + `blocked_reason`
//     whose `project().cycloidDone` reproduces the legacy aggregate.
//   • A legacy DEGRADED-but-still-listening session (`review_listening` with a `needs_attention` done
//     aggregate) is intentionally NOT reproduced as `needs_attention`: the FSM routes a degraded terminal
//     to `NEEDS_YOU` (a `blocked` phase), never to a listening state, so the adapter renders it `working`
//     (the FSM model's answer). This is a known, documented lossy edge, harmless in shadow.

import type {
  CycloidDoneReason,
  CycloidDoneStatus,
  Phase,
  ReviewLoopDoneState,
  VerificationResult,
  VerificationState,
} from "../../../../../shared/session/phase.js";
import type { BlockedReason, FsmRecord, FsmState, Verdict } from "./types";

/**
 * The legacy session fields the adapter reads — the canonical status axis (`phase`) plus the
 * verification / review-loop signals and the legacy-derived `cycloid_done` aggregate (the session's
 * persisted `cycloid_done_*` columns / `deriveCycloidDoneStatus` output). `idle` is excluded: it has
 * no spine state and never describes a created session.
 */
export interface LegacyAdapterInput {
  sessionId: string;
  phase: Exclude<Phase, "idle">;
  prUrl: string | null;
  headSha: string | null;
  verificationState: VerificationState | null;
  verificationResult: VerificationResult | null;
  reviewLoopDoneState: ReviewLoopDoneState | null;
  /** The legacy-derived done aggregate (`deriveCycloidDoneStatus`) threaded on the session. */
  cycloidDone: CycloidDoneStatus;
}

/**
 * The canonical `blocked_reason` chosen for each legacy `cycloid_done` `needs_attention` reason — the
 * inverse of `BLOCKED_REASON_TO_CYCLOID_DONE_REASON` (project.ts), picking ONE representative where the
 * forward map is many-to-one (`ci_red ← ci_fix_exhausted|ci_flapping`,
 * `verification_exhausted ← verification_noconverge|verification_run_limit`). Compile-time TOTAL over the
 * closed `CycloidDoneReason` enum so a new legacy reason is a `tsc` break here, not a silent default.
 */
const CYCLOID_DONE_REASON_TO_BLOCKED_REASON: Record<CycloidDoneReason, BlockedReason> = {
  ci_red: "ci_fix_exhausted",
  verification_exhausted: "verification_noconverge",
  verification_stopped: "verification_stopped",
  verification_inconclusive: "verification_unresolved",
};

/**
 * The verification `verdict` the adapter stamps so REVIEW's `verification-needs-work` label (and the
 * stage copy) is faithful. Only the settled `verification-done` verdict carries a `pass`/`app_breaks`
 * signal; the non-terminal / cleared states project no verdict-driven label.
 */
function verdictFromLegacy(state: VerificationState | null, result: VerificationResult | null): Verdict | null {
  if (state === "verification-done") {
    return result === "needs-work" ? "app_breaks" : "pass";
  }
  if (state === "verification-skipped") return "skipped";
  return null;
}

/**
 * Pick the representative `FsmState` (+ the `blocked_reason` for `NEEDS_YOU`) whose `project()` surface
 * reproduces the legacy session's `phase` + `cycloid_done`. The ambiguous legacy phases (`completed`,
 * `blocked`, `review_listening`) disambiguate from the secondary signals so parity holds by construction.
 */
function adaptStateAndReason(input: LegacyAdapterInput): { state: FsmState; blockedReason: BlockedReason | null } {
  switch (input.phase) {
    case "running":
      return { state: "GENERATING", blockedReason: null };
    case "waiting_for_input":
      return { state: "AWAITING_INPUT", blockedReason: null };
    case "finalizing":
      return { state: "FINALIZING", blockedReason: null };
    case "review_listening":
      // The post-PR listening window splits into the spine's `VERIFYING` (a verification run owns the
      // head) vs `REVIEW` (addressing reviews / fixing CI); both project the `review_listening` phase.
      return {
        state: input.verificationState === "verification-in-progress" ? "VERIFYING" : "REVIEW",
        blockedReason: null,
      };
    case "completed": {
      // `done/success` = the loop settled clean → `MERGE_READY`; a PR that closed/merged without a
      // clean done-claim → `MERGED` (projects `working`, like legacy); no PR → `ANSWERED_NO_PR`.
      if (input.cycloidDone.state === "done" && input.cycloidDone.outcome === "success") {
        return { state: "MERGE_READY", blockedReason: null };
      }
      return { state: input.prUrl ? "MERGED" : "ANSWERED_NO_PR", blockedReason: null };
    }
    case "superseded":
      // Legacy `superseded` (publishStatus superseded — the publish was benignly overtaken: head moved or
      // the session moved on) maps to its own neutral terminal (ARC-1389; replaces the former lossy
      // `CLOSED` stopgap). Phase parity round-trips: `SUPERSEDED` projects the `superseded` phase.
      return { state: "SUPERSEDED", blockedReason: null };
    case "blocked": {
      // A degraded terminal (`done/needs_attention`) carries the legacy reason → the inverse-mapped
      // `blocked_reason` (so `cycloidDoneOf` reproduces it); a human-action block (no done reason, e.g.
      // owner-approval) maps to `owner_approval` (projects `working`, parity with legacy's non-done block).
      const legacyReason = input.cycloidDone.reasons[0];
      const blockedReason =
        input.cycloidDone.outcome === "needs_attention" && legacyReason
          ? CYCLOID_DONE_REASON_TO_BLOCKED_REASON[legacyReason]
          : "owner_approval";
      return { state: "NEEDS_YOU", blockedReason };
    }
    case "failed":
      return { state: "FAILED", blockedReason: null };
    case "stopped":
      return { state: "STOPPED", blockedReason: null };
    case "archived":
      return { state: "ARCHIVED", blockedReason: null };
  }
}

/**
 * Map a legacy session into the `FsmRecord` that feeds `project()` until the spine row is populated
 * (F47). PURE. The record is a transient PROJECTION input, not a persisted spine row — the CAS/dwell
 * bookkeeping fields (`version`, `state_entered_at`, …) carry inert defaults `project()` never reads.
 */
export function legacyAdapterRecord(input: LegacyAdapterInput): FsmRecord {
  const { state, blockedReason } = adaptStateAndReason(input);
  return {
    sessionId: input.sessionId,
    version: 0,
    state,
    prUrl: input.prUrl,
    headSha: input.headSha,
    verdict: verdictFromLegacy(input.verificationState, input.verificationResult),
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: null,
    mergeReadyReopenCount: 0,
    blockedReason,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: null,
  };
}
