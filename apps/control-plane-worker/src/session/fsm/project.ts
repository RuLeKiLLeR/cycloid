// ARC-1330 (PR 28): the `project(record)` skeleton + the `phase` surface (design §12).
//
// One pure `project(record) → { phase, … }` is the SINGLE source the FE/labels/stage-copy read
// (design §12: "FE reads the same record"; cron reconciles GitHub/FE to it idempotently). It reads
// the typed record fields — `(state, verdict, blocked_reason, prompt_intends_change, …)`, never
// `state` alone (F40) — and is TOTAL over every state incl. `ARCHIVED` (N8) and the closed
// `blocked_reason` enum (D14/SF10).
//
// PR 28 landed the skeleton + the `phase` surface; PR 29 added `labels`; PR 30 added `stageSection`;
// PR 31 adds `feChip`. The remaining surfaces are stacked atomic follow-ups that each add one field to
// `Projection`:
//   • PR 29 — `labels[]`        (existing `verification-*` + `review-loop:done` + the net-new constants)
//   • PR 30 — `stageSection`     (the PR stage copy) + exposes a pure `stageOf(record)` for the timeline
//   • PR 31 — `feChip`           (the session-view/websocket sidebar-pill wire field)
//   • PR 32 — `cycloidDone`     (re-express `deriveCycloidDoneStatus` as a pure record projection)
//
// `phase` is a pure function of `state` alone: every §12 row's Phase depends only on the spine state
// (the `ANSWERED_NO_PR`/`REVIEW` sub-cases that split the *copy* still share one Phase). The design's
// conceptual `QA` state is `VERIFYING` here and maps to the EXISTING `review_listening` Phase — no new
// Phase member is introduced (the only `Phase` value with no spine source is the pre-session `idle`).

import { BLOCKED_REASON_COPY } from "../../../../../shared/session/lifecycle-chip.js";
import type { UiLifecycleStage } from "../../../../../shared/session/lifecycle-stage.js";
import type {
  CycloidDoneReason,
  CycloidDoneStatus,
  Phase,
  ReviewLoopDoneState,
  VerificationState,
} from "../../../../../shared/session/phase.js";
import { ARCANIST_DONE_REASON_ORDER } from "../../../../../shared/session/phase.js";
import {
  CI_FIX_EXHAUSTED_LABEL,
  INTERNAL_ERROR_LABEL,
  OWNER_APPROVAL_LABEL,
  REVIEW_STUCK_LABEL,
} from "../../constants/pr-labels";
import { MAX_VERIFICATION_RUNS_PER_PR } from "../../constants/verification";
import { projectAnsweredNoPr } from "./answered-projection";
import { type BlockedReason, FSM_STATES, type FsmRecord, type FsmState, type Verdict } from "./types";

/**
 * The user-facing "what stage" copy (design §12 "Stage copy" column). A pure projection of the record,
 * total over every state. Reused as the coarse dwell axis by the timeline query (PR 27A, design §18.3:
 * `stage_section` IS the stage taxonomy — no parallel enum). Typed as `string` (the analog of
 * `labelsOf`'s `readonly string[]`); the per-state literals are pinned by the projection test.
 */
export type StageSection = string;

/**
 * The collapsed session-view sidebar-pill value (design §12 `fe_chip`) — the websocket-wire status
 * chip the FE renders. It is the SAME vocabulary the FE derives today via `flattenStatus(phase)`
 * (`apps/ui/src/utils/status-display.ts`): the canonical `Phase` collapsed into the user-facing pill
 * states (`running`/`finalizing → working`, `blocked → failed`). This projection computes it
 * server-side so the FE reads the record (§12) instead of re-deriving it client-side.
 *
 * Typed as the FE's `DisplayStatus` union so the wire field is consumed directly with no re-mapping.
 * The spine never emits `idle` (the pre-session-only chip, the one `Phase`/chip value with no spine
 * source — mirrors the `phaseOf` note); it stays in the union purely for FE wire-compatibility.
 */
export type FeChip =
  | "working"
  | "waiting_for_input"
  | "review_listening"
  | "completed"
  | "superseded"
  | "failed"
  | "idle"
  | "stopped"
  | "archived";

/**
 * The aggregate projection record surface (design §12). Grows one field per stacked PR (29–32);
 * `phase` (PR 28), `labels` (PR 29), `stageSection` (PR 30) and `feChip` (PR 31) are the surfaces
 * landed so far.
 */
export interface Projection {
  /** The canonical session `Phase` (the FE/`session_index.rich_status` axis), total over every state. */
  phase: Phase;
  /**
   * The GitHub PR labels this record projects to (design §12 "Key labels"). A pure projection of
   * `(state, verdict, …)` — the cron reconciles GitHub to this set idempotently. EXISTING
   * `verification-*` / `review-loop:done` labels plus the net-new `verification-needs-work`
   * (design `qa-needs-work`). `NEEDS_YOU` projects the single label of its `blocked_reason` via the
   * §12 total map (PR 33, `blockedReasonDisplay`); `[]` if the reason is absent.
   */
  labels: readonly string[];
  /**
   * The user-facing "what stage" copy (design §12 "Stage copy"). A pure projection of the FULL record
   * (F40): `ANSWERED_NO_PR` reads `prompt_intends_change`, `REVIEW` reads `ci_fix_rounds`/`verdict` to
   * split its three sub-stages. `NEEDS_YOU` is "Blocked — needs you: <reason>" — the per-
   * `blocked_reason` copy via the §12 total map (PR 33, `blockedReasonDisplay`, mirrors `labels`);
   * generic "Blocked — needs you" if the reason is absent. Also the coarse dwell axis for the timeline
   * query (PR 27A) via the exposed `stageOf` (design §18.3).
   */
  stageSection: StageSection;
  /**
   * The session-view sidebar-pill chip (design §12 `fe_chip`). The canonical `Phase` collapsed into
   * the FE's `DisplayStatus` pill vocabulary — the same mapping the FE applies today via
   * `flattenStatus(phase)`, computed here so the chip rides the record/websocket wire (§12: "FE reads
   * the same record"). A pure projection of `state` (it collapses `phaseOf`, which is itself
   * state-only); total over every state incl. `ARCHIVED` (N8).
   */
  feChip: FeChip;
  /**
   * The internal "Cycloid has no more automated post-PR work left on this head" aggregate (design §12
   * `cycloid_done`) — a record re-expression of the legacy `deriveCycloidDoneStatus`
   * (`shared/session/phase.ts`). `done/success` = the loop settled clean (`MERGE_READY`);
   * `done/needs_attention` = the loop settled but a terminal ci/verification signal degraded
   * (`NEEDS_YOU` with a ci/verification `blocked_reason`); `working` = still listening / mid-loop
   * (incl. a `NEEDS_YOU` that is merely waiting on a human, e.g. `owner_approval`). A pure projection of
   * `(state, blocked_reason)`; total over every state and the closed `blocked_reason` enum (D14/SF10).
   */
  cycloidDone: CycloidDoneStatus;
  uiLifecycleStage: UiLifecycleStage;
}

/**
 * state → `Phase` (design §12). Compile-time TOTAL: a `Record<FsmState, Phase>` makes a missing or
 * stray state a `tsc --noEmit` break in `src/` (the real completeness proof — `tests/` is not
 * typechecked), in lockstep with the 16-state `FSM_STATES` union.
 *
 * `VERIFYING` (design `QA`) → `review_listening`: QA runs are still part of the post-PR listening
 * window from the user's view, so they reuse the existing Phase — no new member (SF: §12).
 */
const STATE_TO_PHASE: Record<FsmState, Phase> = {
  CREATED: "running",
  PROVISIONING: "running",
  GENERATING: "running",
  AWAITING_INPUT: "waiting_for_input",
  FINALIZING: "finalizing",
  PUBLISHING: "finalizing",
  ANSWERED_NO_PR: "completed",
  REVIEW: "review_listening",
  VERIFYING: "review_listening",
  MERGE_READY: "completed",
  NEEDS_YOU: "blocked",
  FAILED: "failed",
  STOPPED: "stopped",
  MERGED: "completed",
  CLOSED: "completed",
  // ARC-1389: the benign publish-supersede terminal keeps its OWN phase (the neutral pill main shipped),
  // never `completed` — the whole point of the distinct state (the CLOSED stopgap projected `completed`).
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
};

/**
 * Pure state → `Phase` mapping, total over the 16-state `FsmState` union (incl. `ARCHIVED`, N8).
 * Exposed (mirroring PR 30's `stageOf`) so the totality proof targets the mapping directly.
 */
export function phaseOf(state: FsmState): Phase {
  return STATE_TO_PHASE[state];
}

/**
 * state → FE sidebar-pill chip (design §12 `fe_chip`). Compile-time TOTAL via `Record<FsmState, FeChip>`
 * (a missing/stray state is a `tsc --noEmit` break in `src/`), in lockstep with `STATE_TO_PHASE`. Each
 * value is exactly `flattenStatus(STATE_TO_PHASE[state])` — the FE's existing phase→pill collapse
 * (`apps/ui/src/utils/status-display.ts`): `running`/`finalizing → working`, `blocked → failed`, the
 * rest pass through. Pinned as an explicit table (not computed) so this stays an independent compile-
 * proof of the collapse and the projection test is a true oracle. The spine never produces `idle`.
 */
const STATE_TO_FE_CHIP: Record<FsmState, FeChip> = {
  CREATED: "working",
  PROVISIONING: "working",
  GENERATING: "working",
  AWAITING_INPUT: "waiting_for_input",
  FINALIZING: "working",
  PUBLISHING: "working",
  ANSWERED_NO_PR: "completed",
  REVIEW: "review_listening",
  VERIFYING: "review_listening",
  MERGE_READY: "completed",
  NEEDS_YOU: "failed",
  FAILED: "failed",
  STOPPED: "stopped",
  MERGED: "completed",
  CLOSED: "completed",
  // ARC-1389: `flattenStatus("superseded")` passes through on the FE (`status-display.ts`), so the chip
  // mirrors the phase — the pinned `feChip === flattenStatus(phase)` parity holds.
  SUPERSEDED: "superseded",
  ARCHIVED: "archived",
};

/**
 * Pure state → FE chip mapping, total over the 16-state `FsmState` union (incl. `ARCHIVED`, N8).
 * Exposed (mirroring `phaseOf`) so the totality/parity proof targets the mapping directly. It is the
 * collapse of `phaseOf` into the FE's `DisplayStatus` pill vocabulary (§12).
 */
export function feChipOf(state: FsmState): FeChip {
  return STATE_TO_FE_CHIP[state];
}

const STATE_TO_UI_LIFECYCLE_STAGE: Record<FsmState, UiLifecycleStage> = {
  CREATED: null,
  PROVISIONING: null,
  GENERATING: null,
  AWAITING_INPUT: null,
  FINALIZING: null,
  PUBLISHING: null,
  ANSWERED_NO_PR: null,
  REVIEW: null,
  VERIFYING: "verifying",
  MERGE_READY: "merge_ready",
  NEEDS_YOU: null,
  FAILED: null,
  STOPPED: null,
  MERGED: "merged",
  CLOSED: "closed",
  SUPERSEDED: "superseded",
  ARCHIVED: null,
};

export function uiLifecycleStageOf(state: FsmState): UiLifecycleStage {
  return STATE_TO_UI_LIFECYCLE_STAGE[state];
}

/**
 * Phase → FE sidebar-pill chip — the PHASE-domain form of the `feChipOf` collapse (design §12 `fe_chip`),
 * the SERVER mirror of the FE's client-side `flattenStatus` (`apps/ui/src/utils/status-display.ts`).
 * Where `feChipOf` collapses an FSM *state*, this collapses a raw *phase* string — e.g. the legacy-written
 * `session_index.rich_status` the FE pill actually reads — so a legacy pill can be reduced to the same vocabulary as the spine chip. Pinned
 * to the SAME mapping as `flattenStatus` (running/finalizing → working, blocked → failed, the rest pass
 * through; unknown → idle); the projection test asserts `feChipFromPhase(phaseOf(state)) === feChipOf(state)`
 * for every state, so the two collapses can never silently drift. Accepts an arbitrary string because the
 * persisted `rich_status` column is untyped; total.
 */
export function feChipFromPhase(phase: string | null | undefined): FeChip {
  switch (phase) {
    case "archived":
      return "archived";
    case "stopped":
      return "stopped";
    case "running":
    case "finalizing":
      return "working";
    case "waiting_for_input":
      return "waiting_for_input";
    case "completed":
      return "completed";
    case "review_listening":
      return "review_listening";
    case "superseded":
      return "superseded";
    case "blocked":
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}

/**
 * The `NEEDS_YOU` user-facing surface for a single `blocked_reason`: the GitHub PR label the cron
 * reconciles to, and the ": <reason>" stage-copy suffix (design §12 "Blocked — needs you: <reason>").
 */
export interface BlockedReasonDisplay {
  /** The GitHub PR label for this reason (cron-reconciled), in the code `verification-*`/`ci-*` vocabulary. */
  label: string;
  /** The human copy spliced after "Blocked — needs you: " in the §12 stage section. */
  copy: string;
}

/**
 * `blocked_reason` → label + copy (design §12 "NEEDS_YOU blocked_reason → label/copy" total map).
 * Compile-time TOTAL via `Record<BlockedReason, …>` — a new enum value is a `tsc --noEmit` break here
 * (a forced decision, not a silent fall-through), in lockstep with the closed `BlockedReason` union.
 *
 * Code vocabulary note (the design reads "QA"; the product voice is `verification`): the four
 * `verification_*` reasons all share the `verification-needs-work` label (design `qa-needs-work`) and
 * carry the `verification`-voiced copy. `ci_fix_exhausted` and the §17-D NET-NEW `ci_flapping`
 * (absent from the design table — distinct telemetry, one enum value) BOTH carry the
 * `ci-fix-exhausted` label: both are terminal red-CI degradations needing a human, parity with the
 * shared `cycloid_done` ci_red bucket (`BLOCKED_REASON_TO_CYCLOID_DONE_REASON`); only the copy
 * distinguishes them so the flap is still legible at the merge decision. The remaining three are the
 * blocked_reason-only labels: `owner-approval` (post-review human-action gate, the sole owner-approval
 * path, P1/D8), `review-stuck` (a stalled review timeout), and `internal-error` (the loud catch-all).
 */
// Copy threads the SHARED `BLOCKED_REASON_COPY` map (shared/session/lifecycle-chip.ts) —
// the same strings the UI renders as row detail — so PR-body stage text and UI
// rows cannot drift. Labels stay here: they are GitHub PR-label vocabulary.
const BLOCKED_REASON_DISPLAY: Record<BlockedReason, BlockedReasonDisplay> = {
  owner_approval: { label: OWNER_APPROVAL_LABEL, copy: BLOCKED_REASON_COPY.owner_approval },
  // PR-E1: for NEW sessions these four verification_* NEEDS_YOU reasons are unreachable — QA runs off-gate
  // (verdict edges emit non-blocking QA-issue DMs, never setBlockedReason). They still fire ONLY while
  // legacy VERIFYING stock drains (transition.ts run_limit / stopped terminals + the VERIFYING dwell
  // backstop): genuine "verifier stuck/exhausted — needs a human" terminals. The verification-* label axis
  // is scrapped, so there is no verification-specific label left to route to; the loud catch-all label is
  // the deliberate surface for these transient drain-only terminals (the stage copy still carries the
  // accurate reason). Kept total until Track CORE removes these enum members, at which point these four
  // entries delete outright (the `verification-needs-work` label they used to share is scrapped).
  verification_noconverge: { label: INTERNAL_ERROR_LABEL, copy: BLOCKED_REASON_COPY.verification_noconverge },
  verification_unresolved: { label: INTERNAL_ERROR_LABEL, copy: BLOCKED_REASON_COPY.verification_unresolved },
  verification_run_limit: { label: INTERNAL_ERROR_LABEL, copy: BLOCKED_REASON_COPY.verification_run_limit },
  verification_stopped: { label: INTERNAL_ERROR_LABEL, copy: BLOCKED_REASON_COPY.verification_stopped },
  ci_fix_exhausted: { label: CI_FIX_EXHAUSTED_LABEL, copy: BLOCKED_REASON_COPY.ci_fix_exhausted },
  ci_flapping: { label: CI_FIX_EXHAUSTED_LABEL, copy: BLOCKED_REASON_COPY.ci_flapping },
  review_stuck: { label: REVIEW_STUCK_LABEL, copy: BLOCKED_REASON_COPY.review_stuck },
  // Shares the review-stuck label (both are "review loop needs a human"); distinct copy. ARC-1330.
  review_response_failed: { label: REVIEW_STUCK_LABEL, copy: BLOCKED_REASON_COPY.review_response_failed },
  internal_inconsistency: { label: INTERNAL_ERROR_LABEL, copy: BLOCKED_REASON_COPY.internal_inconsistency },
};

/**
 * Pure `blocked_reason` → `{ label, copy }` lookup, total over the closed `BlockedReason` enum
 * (D14/SF10). Exposed (mirroring `phaseOf`/`labelsOf`/`stageOf`) so the totality proof targets the map
 * directly and the label/copy surfaces (`labelsOf`/`stageOf` `NEEDS_YOU` arms) thread the SAME map.
 */
export function blockedReasonDisplay(reason: BlockedReason): BlockedReasonDisplay {
  return BLOCKED_REASON_DISPLAY[reason];
}

/**
 * state → PR labels (design §12 "Key labels"). Compile-time TOTAL via `Record<FsmState, …>` (a
 * missing/stray state is a `tsc --noEmit` break in `src/`), mirroring `STATE_TO_PHASE`. Each entry
 * is a function of the FULL record (not `state` alone, F40): `REVIEW` reads `verdict`, `NEEDS_YOU`
 * reads `blocked_reason` (PR 33's total map). The states that project nothing return `[]`.
 *
 * Mapping (code `verification-*` vocabulary; design's conceptual `qa-*` names noted):
 *   • `REVIEW ∧ verdict=app_breaks` → `verification-needs-work` (design `qa-needs-work`); other
 *     `REVIEW` sub-cases (ciFix / addressing reviews) carry no label — the §12 stage copy, not a
 *     label, distinguishes them (PR 30).
 *   • `VERIFYING` (design `QA`)      → `verification-in-progress` (design `qa-in-progress`).
 *   • `MERGE_READY`                  → `review-loop:done` + `verification-done` (design `qa-done`).
 *   • `NEEDS_YOU`                    → the single `blocked_reason` label via the §12 total map (PR 33);
 *     `[]` if `blocked_reason` is absent (defensive — D14 sets it on every `→NEEDS_YOU` edge).
 *   • everything else (incl. `MERGED`/`CLOSED`/`ARCHIVED` "cleared") → [].
 */
const STATE_TO_LABELS: Record<FsmState, (record: FsmRecord) => readonly string[]> = {
  CREATED: () => [],
  PROVISIONING: () => [],
  GENERATING: () => [],
  AWAITING_INPUT: () => [],
  FINALIZING: () => [],
  PUBLISHING: () => [],
  ANSWERED_NO_PR: () => [],
  // PR-E1: QA is a parallel signal now, not a gating label. REVIEW/VERIFYING/MERGE_READY project no
  // managed label — the review-loop:done / verification-* labels are scrapped.
  REVIEW: () => [],
  VERIFYING: () => [],
  MERGE_READY: () => [],
  NEEDS_YOU: (record) => (record.blockedReason ? [BLOCKED_REASON_DISPLAY[record.blockedReason].label] : []),
  FAILED: () => [],
  STOPPED: () => [],
  MERGED: () => [],
  CLOSED: () => [],
  SUPERSEDED: () => [],
  ARCHIVED: () => [],
};

/**
 * Pure record → PR labels mapping, total over the 16-state union. Exposed (mirroring `phaseOf`) so
 * the labels totality test targets the mapping directly. Reads the FULL record (F40 — `REVIEW`
 * branches on `verdict`).
 */
export function labelsOf(record: FsmRecord): readonly string[] {
  return STATE_TO_LABELS[record.state](record);
}

/**
 * The single `REVIEW` state carries three §12 sub-stages distinguished by RECORD FIELDS (not distinct
 * states — the two review states are collapsed into one `REVIEW`, v7). Precedence follows the §12 table
 * order:
 *   1. active/last epoch = ciFix (`ci_fix_rounds > 0`)  → "Fixing CI"
 *   2. `verdict = app_breaks`                            → "Fixing verification findings" (design "Fixing QA findings")
 *   3. otherwise                                         → "Addressing reviews"
 *
 * `ci_fix_rounds > 0` is the sound persisted proxy for "the active/last epoch is a ciFix": it is bumped
 * only when a ciFix epoch dispatches (`inc_ci_fix_rounds`) and the FG-2 universal post-action zeroes it
 * the moment the REVIEW state settles to `ci_green ∧ no_inflight_epoch` — so a positive value means a
 * red-CI fix cycle is genuinely in progress, not a stale leftover (post-actions.ts inv 11).
 */
function reviewStage(record: FsmRecord): StageSection {
  if (record.ciFixRounds > 0) return "Fixing CI";
  if (record.verdict === "app_breaks") return "Fixing verification findings";
  return "Cycloid is working on the review";
}

/**
 * state → stage copy (design §12 "Stage copy"). Compile-time TOTAL via `Record<FsmState, …>` (a
 * missing/stray state is a `tsc --noEmit` break in `src/`), mirroring `STATE_TO_PHASE`/`STATE_TO_LABELS`.
 * Each entry is a function of the FULL record (F40), not `state` alone.
 *
 * Notes on the design's QA/verification vocabulary: the copy keeps the product's `verification` voice
 * (matching the `verification-*` labels) where design §12 reads "QA" — "Testing the app"/"Fixing
 * verification findings" rather than "Fixing QA findings". `NEEDS_YOU` splices the per-`blocked_reason`
 * copy after "Blocked — needs you: " via the §12 total map (PR 33), falling back to the generic
 * "Blocked — needs you" when `blocked_reason` is absent (defensive — D14 sets it on every edge).
 * `MERGED`/`CLOSED` are the §12 "—" cleared cells (no active stage on a resolved PR) → empty copy, the
 * single-string analog of `labelsOf` returning `[]` for those states.
 */
const STATE_TO_STAGE: Record<FsmState, (record: FsmRecord) => StageSection> = {
  CREATED: () => "Starting",
  PROVISIONING: () => "Starting",
  GENERATING: () => "Working",
  AWAITING_INPUT: () => "Needs your input",
  FINALIZING: () => "Finalizing / Opening PR",
  PUBLISHING: () => "Finalizing / Opening PR",
  ANSWERED_NO_PR: (record) => projectAnsweredNoPr(record),
  REVIEW: (record) => reviewStage(record),
  VERIFYING: () => "Testing the app",
  MERGE_READY: () => "Ready to merge — watching for reviews",
  NEEDS_YOU: (record) =>
    record.blockedReason
      ? `Blocked — needs you: ${BLOCKED_REASON_DISPLAY[record.blockedReason].copy}`
      : "Blocked — needs you",
  FAILED: () => "Session failed",
  STOPPED: () => "Stopped",
  MERGED: () => "",
  CLOSED: () => "",
  // §12 cleared cell like MERGED/CLOSED — a superseded PR has no active stage.
  SUPERSEDED: () => "",
  ARCHIVED: () => "Archived",
};

/**
 * Pure record → stage copy mapping, total over the 16-state union (design §12 / §18.3). Exposed
 * (mirroring `phaseOf`/`labelsOf`) so the timeline query (PR 27A) can map each event's `from_state` (+
 * the `verdict`/`ci_fix_rounds` at that version) through the SAME mapping the stage copy uses — the
 * coarse per-stage dwell axis, no parallel taxonomy. Reads the FULL record (F40).
 */
export function stageOf(record: FsmRecord): StageSection {
  return STATE_TO_STAGE[record.state](record);
}

/**
 * `blocked_reason` → the legacy `CycloidDoneReason` it re-expresses, or `null` when the block is not a
 * settled cycloid-done degradation (D14/SF10). Compile-time TOTAL via `Record<BlockedReason, …>` (a
 * new enum value is a `tsc --noEmit` break here — a forced decision, not a silent fall-through).
 *
 * Two buckets, matching the legacy `deriveCycloidDoneStatus` vocabulary (it has exactly these four
 * reasons, all terminal ci/verification degradations):
 *   • a **degraded terminal signal** (Cycloid gave up; the loop IS done) →
 *       `ci_fix_exhausted`/`ci_flapping`           → `ci_red`            (RLA gave up on a red CI)
 *       `verification_noconverge`/`verification_run_limit` → `verification_exhausted`
 *       `verification_stopped`                      → `verification_stopped`
 *       `verification_unresolved`                   → `verification_inconclusive`
 *   • a **mid-loop / human-action block** (NOT a done-claim — legacy never produced a done-state for
 *     these, so they project `working`) → `owner_approval`, `review_stuck`, `internal_inconsistency`
 *     map to `null`. (Their user-facing block copy/label is PR 33's `blocked_reason` total map, a
 *     DIFFERENT surface; the `feChip` already renders `NEEDS_YOU → failed`.)
 */
const BLOCKED_REASON_TO_CYCLOID_DONE_REASON: Record<BlockedReason, CycloidDoneReason | null> = {
  owner_approval: null,
  verification_noconverge: "verification_exhausted",
  verification_unresolved: "verification_inconclusive",
  verification_run_limit: "verification_exhausted",
  verification_stopped: "verification_stopped",
  ci_fix_exhausted: "ci_red",
  ci_flapping: "ci_red",
  review_stuck: null,
  // Mid-loop human-action block (the agent couldn't post) — no cycloid_done degradation, like
  // owner_approval / review_stuck. ARC-1330.
  review_response_failed: null,
  internal_inconsistency: null,
};

const WORKING_CYCLOID_DONE: CycloidDoneStatus = { state: "working", outcome: null, reasons: [] };

/**
 * Re-express the legacy `deriveCycloidDoneStatus` (`shared/session/phase.ts`) as a pure projection of
 * the FSM record (design §12 `cycloid_done`). Total over every state and the closed `blocked_reason`
 * enum; reads only `(state, blocked_reason)`.
 *
 *   • `MERGE_READY` → `done/success` — the `caught_up` cascade settled clean. (The cascade's sole
 *     `MERGE_READY` emitter requires `ci_green`, so a red-CI done-with-attention never reaches
 *     `MERGE_READY` — it re-opens to `REVIEW`/routes to `NEEDS_YOU{ci_fix_exhausted}`. So the legacy
 *     `done ∧ ci_red` combo surfaces here as the `NEEDS_YOU` arm, never as a `MERGE_READY` reason.)
 *   • `NEEDS_YOU` with a degraded ci/verification `blocked_reason` → `done/needs_attention` carrying the
 *     single mapped legacy reason. The FSM models a degraded terminal as exactly ONE `blocked_reason`,
 *     so the projection emits at most one reason — where legacy could stack `ci_red` atop a verification
 *     reason (it threaded CI independently), that multi-reason combo is not FSM-reachable.
 *   • everything else (`REVIEW`/`VERIFYING` still listening, the pre-PR working spine, a mid-loop or
 *     human-action `NEEDS_YOU`, and the session-terminal states) → `working` — no settled done-claim is
 *     readable from the record's current state (the stateless analog of legacy's pre-`done` `working`).
 */
export function cycloidDoneOf(record: FsmRecord): CycloidDoneStatus {
  if (record.state === "MERGE_READY") {
    return { state: "done", outcome: "success", reasons: [] };
  }
  if (record.state === "NEEDS_YOU") {
    const reason = record.blockedReason ? BLOCKED_REASON_TO_CYCLOID_DONE_REASON[record.blockedReason] : null;
    if (reason) {
      // Order through the canonical reason order (single-reason today, but keep the legacy ordering
      // contract so a future multi-reason record stays parity-faithful).
      const reasons = ARCANIST_DONE_REASON_ORDER.filter((r) => r === reason);
      return { state: "done", outcome: "needs_attention", reasons };
    }
    return WORKING_CYCLOID_DONE;
  }
  return WORKING_CYCLOID_DONE;
}

// ── The legacy session_index "mirror" columns as record projections (ARC-1330 W11-P1 → D-59c) ────────
//
// The three legacy mirror column groups — `review_loop_done_state` (0142), `verification_state` /
// `qa_testing_*` (0150), and `cycloid_done_*` (0199) — were WRITTEN by THREE INDEPENDENT hand-maintained
// DO setters (`persistReviewLoopDoneStateToD1` / `persistVerificationStateToD1` /
// `recomputeCycloidDoneStatus` → the blind `mirror*ToIndex` fns) with NO version/rank guard: the drift
// surface behind the "label says done / verdict says app_breaks" illegal states and the red-pill
// mislabels (§16 go/no-go bug list). D-59c DELETED all of those setters; these pure projections are now the
// SOLE source of the three mirror columns (written unconditionally via `syncSessionProjection`), so they are
// mutually consistent BY CONSTRUCTION (a single source cannot disagree with itself — the structural fix for
// the disagreeing-writers class). `cycloidDone` already exists on `project()` (`cycloidDoneOf`, PR 32);
// the two below complete the mirror set. Each is TOTAL over the closed `FsmState` union (compile-checked
// `Record` map, like `STATE_TO_PHASE`).

/**
 * The settled verdict → the legacy `VerificationState` mirror (verdict is cleared on head change, F40).
 *
 * PINNED COLLAPSE — legacy `verification-pending` has NO spine source (deliberate). Legacy stamps
 * `verification-pending` as a distinct queued stage between "loop settled" and "verifier running".
 * The FSM has no queued-verification state: the record stays `REVIEW` until the `caught_up` cascade
 * commits `VERIFYING` at the spawn dispatch. So the pending window projects `null` (the `REVIEW`-side
 * no-settled-verdict view), and once the spine commits `VERIFYING` it projects
 * `verification-in-progress` while legacy may briefly still read pending. Both pairs are the SAME
 * benign model difference — this pair was the `legacy_pending_collapse` divergence class the soak budgeted explicitly (the
 * divergence detector was removed at D-60). D-59's cutover makes the queued stage
 * simply disappear from the mirror.
 */
function verificationStateFromVerdict(verdict: Verdict | null): VerificationState | null {
  switch (verdict) {
    // `app_breaks` is a needs-work verdict; the RESULT axis (not this state) records the needs-work —
    // the legacy `verification_state` is `verification-done` for both a pass and a needs-work verdict.
    case "pass":
    case "app_breaks":
      return "verification-done";
    case "skipped":
      return "verification-skipped";
    case "none":
    case null:
    default:
      return null;
  }
}

/**
 * state → review-loop "caught up" claim (`ReviewLoopDoneState`). `working` = still addressing reviews /
 * fixing CI; `done` = the loop did all it could. TOTAL over `FsmState`.
 *   • `REVIEW`      → `working` (the loop is actively converging — not yet caught up).
 *   • `VERIFYING`   → `done` (the loop settled → the verification run was dispatched from `caught_up`;
 *                     legacy stamps `done` precisely to TRIGGER verification, DO done-state route).
 *   • `MERGE_READY` → `done` (settled clean).
 *   • `NEEDS_YOU`   → `done` when the block is a DEGRADED TERMINAL (Cycloid gave up — the loop IS done),
 *                     else `working` for a human-action / mid-loop block (`owner_approval`,
 *                     `review_stuck`, `internal_inconsistency`). This tracks
 *                     `BLOCKED_REASON_TO_CYCLOID_DONE_REASON` so `cycloid_done` stays SELF-CONSISTENT:
 *                     a `working` done-state can never carry a settled `cycloid_done` aggregate.
 *   • pre-publish + session-terminal states → `null` (no review-loop claim / §12 "cleared").
 */
const STATE_TO_REVIEW_LOOP_DONE_STATE: Record<FsmState, (record: FsmRecord) => ReviewLoopDoneState | null> = {
  CREATED: () => null,
  PROVISIONING: () => null,
  GENERATING: () => null,
  AWAITING_INPUT: () => null,
  FINALIZING: () => null,
  PUBLISHING: () => null,
  ANSWERED_NO_PR: () => null,
  REVIEW: () => "working",
  VERIFYING: () => "done",
  MERGE_READY: () => "done",
  NEEDS_YOU: (record) =>
    record.blockedReason && BLOCKED_REASON_TO_CYCLOID_DONE_REASON[record.blockedReason] !== null ? "done" : "working",
  FAILED: () => null,
  STOPPED: () => null,
  MERGED: () => null,
  CLOSED: () => null,
  SUPERSEDED: () => null,
  ARCHIVED: () => null,
};

/** Pure record → `review_loop_done_state` mirror, total over `FsmState`. Exposed for the parity test. */
export function reviewLoopDoneStateOf(record: FsmRecord): ReviewLoopDoneState | null {
  return STATE_TO_REVIEW_LOOP_DONE_STATE[record.state](record);
}

/**
 * state (+ verdict / blocked_reason) → the legacy `VerificationState` mirror. TOTAL over `FsmState`.
 *   • `VERIFYING`   → `verification-in-progress` (a run owns the head).
 *   • `MERGE_READY` → `verification-done` (the cascade's sole row-7 emitter requires a `pass` verdict —
 *                     the settled state IS a done verdict; D10).
 *   • `REVIEW` / `NEEDS_YOU` → the settled-verdict mirror, with `NEEDS_YOU`'s verification-specific
 *     terminal reasons taking precedence over the raw verdict:
 *       `verification_run_limit` / `verification_noconverge` → `verification-exhausted`
 *       `verification_stopped`                               → `verification-stopped`
 *       otherwise (and every `REVIEW`)                       → `verificationStateFromVerdict(verdict)`.
 *   • pre-publish + session-terminal states → `null`.
 */
const STATE_TO_VERIFICATION_STATE: Record<FsmState, (record: FsmRecord) => VerificationState | null> = {
  CREATED: () => null,
  PROVISIONING: () => null,
  GENERATING: () => null,
  AWAITING_INPUT: () => null,
  FINALIZING: () => null,
  PUBLISHING: () => null,
  ANSWERED_NO_PR: () => null,
  REVIEW: (record) => verificationStateFromVerdict(record.verdict),
  VERIFYING: () => "verification-in-progress",
  // The row-7 emitter requires a settled `pass`/`skipped` verdict (or none, when verification did not
  // apply), so the verdict IS the mirror — a skipped-verification MERGE_READY is `verification-skipped`,
  // a no-verification one is `null`, not a blanket `verification-done`.
  MERGE_READY: (record) => verificationStateFromVerdict(record.verdict),
  NEEDS_YOU: (record) => {
    switch (record.blockedReason) {
      case "verification_run_limit":
      case "verification_noconverge":
        return "verification-exhausted";
      case "verification_stopped":
        return "verification-stopped";
      // Unresolved `app_breaks` findings = a settled needs-work verdict (legacy `verification-done` with
      // a needs-work result); pinned explicitly so it does not depend on the record's `verdict` field.
      case "verification_unresolved":
        return "verification-done";
      default:
        return verificationStateFromVerdict(record.verdict);
    }
  },
  FAILED: () => null,
  STOPPED: () => null,
  MERGED: () => null,
  CLOSED: () => null,
  SUPERSEDED: () => null,
  ARCHIVED: () => null,
};

/** Pure record → `verification_state` mirror, total over `FsmState`. Exposed for the parity test. */
export function verificationStateOf(record: FsmRecord): VerificationState | null {
  return STATE_TO_VERIFICATION_STATE[record.state](record);
}

/**
 * The full legacy session_index mirror-column set, projected from the ONE `FsmRecord` (design §12,
 * ARC-1330 W11-P1 → D-59c). The single source the FSM sole-write feeds through `syncSessionProjection`
 * (D-59c deleted the three independent blind mirror fns). `verificationAttemptCount` is the spine's own
 * `verification_run_count` (B1 consecutive-failed semantics — this DIVERGES from the legacy PR-scoped
 * lifetime count for retried cohorts by design; see W11-V7, so it is NOT a divergence-compared field);
 * `verificationMaxAttempts` is the shared cap.
 */
export interface MirrorColumnProjection {
  reviewLoopDoneState: ReviewLoopDoneState | null;
  verificationState: VerificationState | null;
  verificationAttemptCount: number;
  verificationMaxAttempts: number;
  cycloidDone: CycloidDoneStatus;
}

export function projectMirrorColumns(record: FsmRecord): MirrorColumnProjection {
  return {
    reviewLoopDoneState: reviewLoopDoneStateOf(record),
    verificationState: verificationStateOf(record),
    verificationAttemptCount: record.verificationRunCount,
    verificationMaxAttempts: MAX_VERIFICATION_RUNS_PER_PR,
    cycloidDone: cycloidDoneOf(record),
  };
}

// ── The session_index DISPLAY columns as record projections (ARC-1330 W11-P3 → D-59c) ────────────────────────
//
// The status-PILL axis, distinct from the P1 mirror columns (the cycloid_done / review-loop /
// verification family). `richStatus` IS the canonical `Phase` written to `session_index.rich_status` — the
// value the FE pill reads and then collapses client-side via `flattenStatus`. `feChip` is that server-side
// collapse (`feChipOf`, given its FIRST consumer here — it was built as the server mirror of the client
// `flattenStatus` but had zero consumers). D-59c made `project()` the sole `rich_status` writer (the
// CONFIRM-ONLY path + divergence detector were retired — no independent legacy side survives to compare
// against). `feChip` is NOT a persisted column (the FE derives it from `rich_status`) — it is projected
// only for the display divergence comparison (steady-state-divergence.ts, W11-P3 scaffolding).

/** The session_index display surfaces projected from the ONE `FsmRecord`. */
export interface DisplayColumnProjection {
  /** `session_index.rich_status` — the canonical `Phase` (the status-pill axis). */
  richStatus: Phase;
  /** The collapsed FE pill (`feChipOf`) — compared, never persisted. */
  feChip: FeChip;
  /** Nullable FE lifecycle refinement for merge/review terminal labels. */
  uiLifecycleStage: UiLifecycleStage;
}

export function projectDisplayColumns(record: FsmRecord): DisplayColumnProjection {
  return {
    richStatus: phaseOf(record.state),
    feChip: feChipOf(record.state),
    uiLifecycleStage: uiLifecycleStageOf(record.state),
  };
}

/**
 * Project the read-surface record (design §12). Pure; reads only typed record fields. Populates the
 * `phase` + `labels` + `stageSection` + `feChip` + `cycloidDone` surfaces (PR 28–32 — the projection
 * surface set is now complete; PR 33 refines the `blocked_reason` → label/copy total map on the
 * `labels`/`stageSection` surfaces).
 */
export function project(record: FsmRecord): Projection {
  return {
    phase: phaseOf(record.state),
    labels: labelsOf(record),
    stageSection: stageOf(record),
    feChip: feChipOf(record.state),
    cycloidDone: cycloidDoneOf(record),
    uiLifecycleStage: uiLifecycleStageOf(record.state),
  };
}

/** Every spine state, exposed for the totality test (re-export of the closed `FSM_STATES` union). */
export { FSM_STATES };
