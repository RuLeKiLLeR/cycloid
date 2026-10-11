// Canonical repo-session phase contract. Single source of truth for worker, CLI,
// UI, evals. The on-disk `session_index.rich_status` column now stores the phase
// string directly (the legacy alias values `sandbox_creating` and
// `stopped_resumable` no longer appear; substate lives in `sandboxSubstate` /
// `stopMode` columns on the DO). `richStatusFromPhase` is the projection helper.

import type { PublishStatus } from "../types/publish.js";
import type { VerificationAgentVerdict } from "../types/sandbox.js";

// Canonical all-phases runtime array. Derive every validity set / iteration
// from this — never hand-roll a phase list (two shipped regressions came from
// duplicated lists drifting: `superseded` and `review_listening` were each
// missing from the CLI's VALID_PHASES copy).
export const PHASES = [
  "idle",
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
] as const;

export type Phase = (typeof PHASES)[number];

// Review-loop "caught up" claim threaded onto the session and rendered as a
// dot/badge. `working` = still listening/processing; `done` = caught up (the loop
// did all it could; the CI verdict at settle time is no longer distinguished in
// this value — CI status is visible on the PR itself). The persisted/threaded
// value is `ReviewLoopDoneState | null` (null = no claim / render nothing).
export type ReviewLoopDoneState = "working" | "done";

// Coerce an untrusted/persisted review-loop done-state value into the canonical
// union or null (the no-claim sentinel). The legacy strings `done_green` and
// `done_exhausted` (persisted before the state collapse) map to `done`; any other
// value clears to null. This is the single normalization helper — every read,
// wire-input, and projection site must use it (do not re-implement the mapping).
export function normalizeReviewLoopDoneState(value: unknown): ReviewLoopDoneState | null {
  if (value === "working") return "working";
  if (value === "done" || value === "done_green" || value === "done_exhausted") return "done";
  return null;
}

// Pull-request verification state tracked separately from the verification
// session phase. The state value intentionally matches the public PR label.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type VerificationState =
  | "verification-pending"
  | "verification-in-progress"
  | "verification-done"
  | "verification-skipped"
  | "verification-stopped"
  | "verification-exhausted";

export type QaTestingState = "qa-pending" | "qa-in-progress" | "qa-done" | "qa-skipped" | "qa-stopped" | "qa-exhausted";

const VERIFICATION_TO_QA_TESTING_STATE = {
  "verification-pending": "qa-pending",
  "verification-in-progress": "qa-in-progress",
  "verification-done": "qa-done",
  "verification-skipped": "qa-skipped",
  "verification-stopped": "qa-stopped",
  "verification-exhausted": "qa-exhausted",
} as const satisfies Record<VerificationState, QaTestingState>;

const QA_TESTING_TO_VERIFICATION_STATE = {
  "qa-pending": "verification-pending",
  "qa-in-progress": "verification-in-progress",
  "qa-done": "verification-done",
  "qa-skipped": "verification-skipped",
  "qa-stopped": "verification-stopped",
  "qa-exhausted": "verification-exhausted",
} as const satisfies Record<QaTestingState, VerificationState>;

export function qaTestingStateFromVerificationState(
  value: VerificationState | null | undefined,
): QaTestingState | null {
  return value ? VERIFICATION_TO_QA_TESTING_STATE[value] : null;
}

export function verificationStateFromQaTestingState(value: unknown): VerificationState | null {
  return typeof value === "string" && value in QA_TESTING_TO_VERIFICATION_STATE
    ? QA_TESTING_TO_VERIFICATION_STATE[value as QaTestingState]
    : null;
}

// Internal QA Tester agent terminal result. This records the outcome of the
// QTA run separately from the public PR-label lifecycle above.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export type VerificationResult = "needs-work" | "merge-ready";

export function verificationResultFromAgentVerdict(verdict: VerificationAgentVerdict): VerificationResult {
  return verdict === "CONCLUSIVE" ? "merge-ready" : "needs-work";
}

// Internal aggregate for "Cycloid has no more automated post-PR work left on
// this head." It is intentionally broader than the public review-loop:done label:
// `done/needs_attention` still means all CGA/RLA/QTA automation settled or
// exhausted, but the human should look because one or more terminal signals was
// degraded.
export type CycloidDoneState = "working" | "done";
export type CycloidDoneOutcome = "success" | "needs_attention";
export type CycloidDoneReason =
  "ci_red" | "verification_exhausted" | "verification_stopped" | "verification_inconclusive";

export interface CycloidDoneStatus {
  state: CycloidDoneState;
  outcome: CycloidDoneOutcome | null;
  reasons: CycloidDoneReason[];
}

export const ARCANIST_DONE_REASON_ORDER = [
  "ci_red",
  "verification_exhausted",
  "verification_stopped",
  "verification_inconclusive",
] as const satisfies ReadonlyArray<CycloidDoneReason>;

export function normalizeCycloidDoneState(value: unknown): CycloidDoneState {
  return value === "done" ? "done" : "working";
}

export function normalizeCycloidDoneOutcome(value: unknown): CycloidDoneOutcome | null {
  return value === "success" || value === "needs_attention" ? value : null;
}

export function normalizeCycloidDoneReasons(value: unknown): CycloidDoneReason[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value) as unknown;
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  const set = new Set(raw);
  return ARCANIST_DONE_REASON_ORDER.filter((reason) => set.has(reason));
}

// Whether the PR still awaits a verification verdict given its current verification fields — i.e. no
// terminal verdict has settled (null / pending / in-progress), OR the verdict is a needs-work that
// re-engages the implementation loop (RLA follow-up fires on ANY needs-work verdict, #5005). A
// terminally-settled verdict (merge-ready, skipped, exhausted, stopped) is NOT awaiting.
//
// Pure state predicate (no env/policy). The control-plane gate `isAwaitingFirstVerificationVerdict`
// composes this with `verificationApplies`, and the auto-verification scheduler reuses it to suppress
// re-verifying a PR whose verdict is still present (a content no-op head advance preserves the
// verdict, so a preserved verdict means there is nothing new to verify). Single source of truth so
// those callers cannot drift.
// TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
export function isAwaitingVerificationVerdict(
  state: VerificationState | null | undefined,
  result: VerificationResult | null | undefined,
): boolean {
  if (state === "verification-exhausted" || state === "verification-stopped" || state === "verification-skipped") {
    return false;
  }
  if (state === "verification-done") {
    return result === "needs-work";
  }
  return true;
}

export function deriveCycloidDoneStatus(input: {
  reviewLoopDoneState: ReviewLoopDoneState | null | undefined;
  verificationState: VerificationState | null | undefined;
  verificationResult: VerificationResult | null | undefined;
  verificationApplies: boolean;
  ciRed?: boolean | null;
  currentReasons?: CycloidDoneReason[] | null;
}): CycloidDoneStatus {
  const reasons = new Set<CycloidDoneReason>();
  const currentReasons = normalizeCycloidDoneReasons(input.currentReasons ?? []);
  const hasCiRed = input.ciRed ?? currentReasons.includes("ci_red");
  if (hasCiRed) reasons.add("ci_red");

  const state = input.verificationState ?? null;
  const result = input.verificationResult ?? null;
  const awaitingVerification = input.verificationApplies ? isAwaitingVerificationVerdict(state, result) : false;

  if (input.reviewLoopDoneState !== "done" || awaitingVerification) {
    return { state: "working", outcome: null, reasons: orderCycloidDoneReasons(reasons) };
  }

  if (input.verificationApplies) {
    if (state === "verification-exhausted") reasons.add("verification_exhausted");
    else if (state === "verification-stopped") reasons.add("verification_stopped");
    else if (state === "verification-done" && result == null) reasons.add("verification_inconclusive");
  }

  const orderedReasons = orderCycloidDoneReasons(reasons);
  return {
    state: "done",
    outcome: orderedReasons.length > 0 ? "needs_attention" : "success",
    reasons: orderedReasons,
  };
}

function orderCycloidDoneReasons(reasons: ReadonlySet<CycloidDoneReason>): CycloidDoneReason[] {
  return ARCANIST_DONE_REASON_ORDER.filter((reason) => reasons.has(reason));
}

export type SandboxSubstate = "creating" | "reconnecting" | "stopping" | "none";
export type StopMode = "user" | "resumable" | "none";
export type FinalizingStep = "post_execution" | "publishing" | "none";

export interface PhaseInfo {
  phase: Phase;
  sandboxSubstate: SandboxSubstate;
  stopMode: StopMode;
  finalizingStep: FinalizingStep;
}

export interface PhaseInputs {
  sessionStatus: "active" | "archived" | "closed" | string | undefined;
  /** Retained for call-site compatibility; repo-only phase logic ignores it. */
  sessionKind?: string | null;
  sandboxStatus: string | undefined;
  activePromptId: string | null;
  stopReason?: string | null;
  activePromptHasPendingQuestion?: boolean;
  /** Additive wire seam: omitted by older producers and treated as false. */
  planApprovalPending?: boolean;
  /**
   * Live-idle user-stop marker (`stopSessionKeepAlive` — DO memory +
   * STOPPED_KEPT_ALIVE_AT storage, cleared at the next prompt admit). Additive
   * wire seam: omitted by producers without the authoritative flag and treated
   * as false.
   */
  userStopped?: boolean;
  publishStatus?: PublishStatus;
  postExecutionPending?: boolean;
  mostRecentPromptResultNoChanges?: boolean;
  reviewListeningActive?: boolean;
}

// Input precedence, strongest first. Terminal/user-intent states beat
// waiting-for-input states; settled outcomes are never un-settled by a stop.
//   1. record archived (sessionStatus)
//   2. hard user stop (sandboxStatus=stopped + stopReason=user)
//   3. plan-approval park -> waiting_for_input — UNLESS userStopped: a
//      user-stopped session is not waiting on anyone
//   4. failed sandbox -> failed
//   5. non-user sandbox stop -> stopped/resumable (yields to review-listening
//      and completed terminals)
//   6. active prompt: pending question -> waiting_for_input — UNLESS
//      userStopped (the turn is aborting; stays running until finalize) —
//      else running (+ transport substate)
//   7. review listening (continues independently of a live-idle stop; the stop
//      boundary exits it server-side before reprojecting)
//   8. publish-driven terminals/finalizing (settled outcomes win over
//      userStopped: a shipped PR stays completed, a failed publish stays failed)
//   9. transport substates decorating running
//  10. idle (the live-idle user-stop landing; surfaces render it as stopped
//      via displayStatusFromPhase + the userStopped sidecar flag)
export function computePhase(inputs: PhaseInputs | undefined): PhaseInfo {
  if (!inputs) {
    return { phase: "archived", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }
  if (inputs.sessionStatus === "archived") {
    return { phase: "archived", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }

  const {
    sandboxStatus,
    activePromptId,
    stopReason,
    activePromptHasPendingQuestion,
    planApprovalPending,
    userStopped,
    publishStatus,
    postExecutionPending,
    mostRecentPromptResultNoChanges,
    reviewListeningActive,
  } = inputs;

  const reachedCompletedTerminal =
    !activePromptId &&
    (publishStatus === "published" ||
      publishStatus === "skipped" ||
      (publishStatus === "not_started" && mostRecentPromptResultNoChanges === true));

  if (sandboxStatus === "stopped" && stopReason === "user") {
    return { phase: "stopped", sandboxSubstate: "none", stopMode: "user", finalizingStep: "none" };
  }

  if (planApprovalPending && !userStopped) {
    return { phase: "waiting_for_input", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }

  if (sandboxStatus === "failed") {
    return { phase: "failed", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }

  if (sandboxStatus === "stopped" && !reviewListeningActive && !reachedCompletedTerminal) {
    return { phase: "stopped", sandboxSubstate: "none", stopMode: "resumable", finalizingStep: "none" };
  }

  if (activePromptId) {
    const substate: SandboxSubstate =
      sandboxStatus === "spawning"
        ? "creating"
        : sandboxStatus === "reconnecting"
          ? "reconnecting"
          : sandboxStatus === "stopping"
            ? "stopping"
            : "none";
    if (activePromptHasPendingQuestion && !userStopped) {
      return { phase: "waiting_for_input", sandboxSubstate: substate, stopMode: "none", finalizingStep: "none" };
    }
    return { phase: "running", sandboxSubstate: substate, stopMode: "none", finalizingStep: "none" };
  }

  // No active prompt. Review-listening represents a session that has shipped
  // its PR and is watching for review comments; it is its own dedicated state
  // and short-circuits publish-driven mapping. Transport substates still
  // decorate it as `running/<substate>` (matches the lifecycle reducer that
  // produces review_listening once the sandbox has settled).
  if (reviewListeningActive) {
    if (sandboxStatus === "spawning") {
      return { phase: "running", sandboxSubstate: "creating", stopMode: "none", finalizingStep: "none" };
    }
    if (sandboxStatus === "reconnecting") {
      return { phase: "running", sandboxSubstate: "reconnecting", stopMode: "none", finalizingStep: "none" };
    }
    if (sandboxStatus === "stopping") {
      return { phase: "running", sandboxSubstate: "stopping", stopMode: "none", finalizingStep: "none" };
    }
    return { phase: "review_listening", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }

  // Publish-driven phases take precedence over no-active-prompt sandbox
  // transport states: a session that already shipped (or is mid-publish, or
  // has post-exec pending) is not "running" just because the bridge websocket
  // happens to be reconnecting.
  if (publishStatus === "failed") {
    return { phase: "failed", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }
  if (publishStatus === "superseded") {
    return { phase: "superseded", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }
  // Stored-rows compat (ARC-1330 D-57): the writer and the `PublishStatus` union arm for
  // `blocked_by_verification` are deleted, but session_index rows persisted before this
  // change (~193 in prod as of 2026-07-03) still carry the literal. Keep the read-side
  // mapping so those sessions keep their `blocked` phase until the display cutover (D-59)
  // sources phase from the FSM spine or the rows age out; remove with D-60.
  if ((publishStatus as string | null | undefined) === "blocked_by_verification") {
    return { phase: "blocked", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }
  if (publishStatus === "published" || publishStatus === "skipped") {
    return { phase: "completed", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }
  if (publishStatus === "publishing") {
    return { phase: "finalizing", sandboxSubstate: "none", stopMode: "none", finalizingStep: "publishing" };
  }
  if (publishStatus === "not_started" && postExecutionPending) {
    return { phase: "finalizing", sandboxSubstate: "none", stopMode: "none", finalizingStep: "post_execution" };
  }
  if (publishStatus === "not_started" && mostRecentPromptResultNoChanges) {
    return { phase: "completed", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
  }

  // Sandbox transport state decorates running for sessions with no
  // publish-driven phase to settle on.
  if (sandboxStatus === "spawning") {
    return { phase: "running", sandboxSubstate: "creating", stopMode: "none", finalizingStep: "none" };
  }
  if (sandboxStatus === "reconnecting") {
    return { phase: "running", sandboxSubstate: "reconnecting", stopMode: "none", finalizingStep: "none" };
  }
  if (sandboxStatus === "stopping") {
    return { phase: "running", sandboxSubstate: "stopping", stopMode: "none", finalizingStep: "none" };
  }
  // Residual: brand-new repo session, or repo session that reset publishStatus
  // to not_started with no post-exec pending.
  // Semantically distinct from `finalizing` (no platform work in progress) and
  // from `completed` (no work was actually done). Action gating treats idle as
  // input-capable.
  return { phase: "idle", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
}

// Projects PhaseInfo to the string written to `session_index.rich_status`. After
// the phase-flip the column stores the phase value directly — substate is
// carried separately on the DO (`sandboxSubstate` / `stopMode`) and re-broadcast
// over the wire; the column is just for list filtering and child-summary
// terminality and does not need to differentiate `running+creating` from
// `running` or `stopped+user` from `stopped+resumable`.
export function richStatusFromPhase(info: PhaseInfo): string {
  return info.phase;
}

// Canonical terminal-phase set. Exported in both forms so D1 SQL binds get a
// readonly array (`...TERMINAL_PHASES_ARRAY`) without the consumer rebuilding
// the list. Any new phase added to the union must be considered here.
export const TERMINAL_PHASES_ARRAY = [
  "completed",
  "superseded",
  "blocked",
  "failed",
  "stopped",
  "archived",
] as const satisfies ReadonlyArray<Phase>;
export const TERMINAL_PHASES: ReadonlySet<Phase> = new Set(TERMINAL_PHASES_ARRAY);
export const TERMINAL_FOR_FALLBACK_POLLING_PHASES: ReadonlySet<Phase> = new Set(
  TERMINAL_PHASES_ARRAY.filter((phase) => phase !== "completed"),
);
// Terminal phases that should free a child session's per-user concurrency slot.
// `stopped` is deliberately excluded: a stopped child is resumable, so it keeps
// its slot. Releasing on `stopped` would let the resume path reacquire a slot
// and then immediately re-free it via the projected `stopped` rich_status,
// undercounting the cap (a resumed child could push the user past the limit).
export const CHILD_SLOT_RELEASE_PHASES: ReadonlySet<Phase> = new Set(
  TERMINAL_PHASES_ARRAY.filter((phase) => phase !== "stopped"),
);
// Terminal phases whose `session_index` rows should be reclaimed (archived) once they have sat
// `status='active'` past the stale grace, so the archived-row GC can drop them and the reconciler
// stops sweeping them (ARC-1455). Excludes: `archived` (already archived); `blocked` (may still be
// actionable); and `stopped` (a resumable state -- `isResumeAvailable` is true only for `stopped`,
// so archiving it flips the phase to `archived` and would permanently 409 the resume route). `idle`
// is not terminal and is already reaped via the runtime-missing branch.
export const ARCHIVABLE_STALE_TERMINAL_PHASES_ARRAY = TERMINAL_PHASES_ARRAY.filter(
  (phase) => phase !== "archived" && phase !== "blocked" && phase !== "stopped",
);

export function isTerminalPhase(phase: Phase, _sessionKind?: string | null): boolean {
  return TERMINAL_PHASES.has(phase);
}
