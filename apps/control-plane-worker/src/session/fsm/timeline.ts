// ARC-1330 lifecycle FSM — `getSessionTimeline` read query (PR 27A, design §18.5).
//
// A THIN, read-only reader over the append-only `pr_coordination_events` log (PR 3):
// `getSessionTimeline(sessionId) → { currentStage, events[], stageDurations }`. Each
// logged transition's `from_state` is the stage the session DWELT in for that event's
// `dwell_ms` (= now − state_entered_at at the transition, design §18.1), so summing
// `dwell_ms` grouped by `stageOf(from_state)` yields total time-in-stage — the substrate
// of the future "enter a session_id → current stage + per-stage durations" dashboard.
//
// Reconstruction, not a parallel taxonomy: the stage axis is the SAME pure `stageOf(record)`
// the live stage copy uses (PR 30, design §18.3). `stageOf` reads more than `state` — the
// single `REVIEW` state splits into "Fixing CI" / "Fixing verification findings" /
// "Addressing reviews" from record fields, `ANSWERED_NO_PR` from `prompt_intends_change`,
// `NEEDS_YOU` from `blocked_reason`. The event log alone does not snapshot those fields, so
// this query FOLDS them forward from each event's typed `EventMetadata` (the §18.2 contract):
// `verdict` from the `verification.*` payload, the active-ciFix proxy from `epoch.*`
// `epochTrigger` (reset on a `ci.signal` green — mirroring the reviewStage comment that
// `ci_fix_rounds > 0` IS "the active/last epoch is a ciFix"), `prompt_intends_change` from
// `postexec.done`, and `blocked_reason` from `epoch.blocked`. This is a best-effort
// observability reconstruction — the authoritative record is `pr_coordination`; here we
// reproduce the per-version sub-stage context purely from the logged metadata. Reconstruction
// fidelity for the canonical multi-cycle session is proven by the lossless-contract test.
//
// Read-only: no guard reads this (Invariant O1), no spine state changes.

import type { PrCoordinationEvent } from "../pr-coordination-events-db";
import { listPrCoordinationEvents } from "../pr-coordination-events-db";
import { FSM_STATES, stageOf, type StageSection } from "./project";
import type { BlockedReason, FsmRecord, FsmState, Verdict } from "./types";

/** One logged transition, annotated with the stage its `from_state` dwell belongs to. */
export interface TimelineEvent {
  version: number;
  fromState: FsmState;
  toState: FsmState;
  event: string;
  at: number;
  actor: string;
  /** Time spent in `fromState` before this transition (design §18.1); null when unrecorded. */
  dwellMs: number | null;
  /** `stageOf` of the record while it dwelt in `fromState` — the per-stage dwell axis. */
  stage: StageSection;
}

/** The §18.5 read shape: current stage, the annotated ordered log, and Σ dwell per stage. */
export interface SessionTimeline {
  /** `stageOf` of the latest event's `to_state` (the session's present stage); null on an empty log. */
  currentStage: StageSection | null;
  /** The transition log in version order, each annotated with its `from_state` stage. */
  events: TimelineEvent[];
  /** Σ `dwell_ms` grouped by stage (events with a null `dwell_ms` contribute nothing). */
  stageDurations: Record<string, number>;
}

const FSM_STATE_SET: ReadonlySet<string> = new Set(FSM_STATES);

function asFsmState(value: string): FsmState {
  // Event rows store the state as TEXT; every writer persists a real `FsmState`. Guard the
  // cast so a corrupt/legacy row can't silently feed `stageOf` an unknown state.
  if (!FSM_STATE_SET.has(value)) {
    throw new Error(`pr_coordination_events: unknown FSM state ${JSON.stringify(value)}`);
  }
  return value as FsmState;
}

/**
 * The sub-stage context folded forward from event metadata — exactly the fields `stageOf`
 * reads beyond `state`. Defaults are the "fresh PR" baseline (no verdict, no active ciFix,
 * not blocked, no recorded change intent).
 */
interface SubStageContext {
  verdict: Verdict | null;
  ciFixActive: boolean;
  promptIntendsChange: boolean | null;
  blockedReason: BlockedReason | null;
}

function freshContext(): SubStageContext {
  return { verdict: null, ciFixActive: false, promptIntendsChange: null, blockedReason: null };
}

/**
 * Build the full `FsmRecord` `stageOf` consumes from a `from_state`/`to_state` plus the folded
 * sub-stage context. Only the five fields `stageOf` reads (`state`, `ciFixRounds`, `verdict`,
 * `promptIntendsChange`, `blockedReason`) are load-bearing; the rest carry inert defaults so the
 * call is fully type-checked rather than an unsafe partial cast.
 */
function synthesizeRecord(state: FsmState, ctx: SubStageContext): FsmRecord {
  return {
    sessionId: "",
    version: 0,
    state,
    prUrl: null,
    headSha: null,
    verdict: ctx.verdict,
    verdictHeadSha: null,
    verificationRunHead: null,
    verificationRunId: 0,
    verificationChildId: null,
    verificationRunCount: 0,
    ciFixRounds: ctx.ciFixActive ? 1 : 0,
    inFlightEpochId: null,
    codeChangedSinceVerification: false,
    promptIntendsChange: ctx.promptIntendsChange,
    mergeReadyReopenCount: 0,
    blockedReason: ctx.blockedReason,
    failureReason: null,
    stopMode: null,
    preStopState: null,
    updateBranchQueuedAt: null,
    deadlineAt: null,
    stateEnteredAt: null,
  };
}

function readString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" ? value : null;
}

/**
 * Advance the sub-stage context by ONE event's metadata. Called AFTER the event's `from_state`
 * stage is recorded, so the dwell of `from_state` reflects the context established by prior
 * events (the transition INTO `from_state`), and this event's effect lands on the next dwell.
 */
function foldContext(ctx: SubStageContext, ev: PrCoordinationEvent): void {
  const meta = (ev.metadata ?? null) as Record<string, unknown> | null;

  switch (ev.event) {
    case "publish.pr_opened":
      // A freshly opened PR resets every settled sub-stage signal.
      ctx.verdict = null;
      ctx.ciFixActive = false;
      break;
    case "head.changed":
      // New head invalidates the prior verdict and any in-flight ciFix (clear_verification).
      ctx.verdict = null;
      ctx.ciFixActive = false;
      break;
    case "postexec.done": {
      const value = meta?.promptIntendsChange;
      if (typeof value === "boolean") ctx.promptIntendsChange = value;
      break;
    }
    case "ci.signal":
      // Green CI settles the ciFix sub-stage (the FG-2 reset proxy).
      if (readString(meta, "ciState") === "green") ctx.ciFixActive = false;
      break;
    case "epoch.committed":
    case "epoch.replied":
    case "epoch.declined":
    case "epoch.blocked": {
      const trigger = readString(meta, "epochTrigger");
      if (trigger === "ci_fix") ctx.ciFixActive = true;
      else if (trigger === "review") ctx.ciFixActive = false;
      if (ev.event === "epoch.blocked") {
        // The metadata carries the `EpochBlockReason` (owner_approval | response_failed), NOT the
        // NEEDS_YOU `blocked_reason` the record stores — map it before feeding `stageOf`, which indexes
        // `BLOCKED_REASON_DISPLAY[blockedReason]` and would throw on the un-mapped `response_failed`.
        // Mirrors transition.ts `mapEpochBlockReason`; an unknown/forward reason leaves it unchanged.
        const reason = readString(meta, "reason");
        if (reason === "owner_approval") ctx.blockedReason = "owner_approval";
        else if (reason === "response_failed") ctx.blockedReason = "review_response_failed";
      }
      break;
    }
    case "verification.pass":
    case "verification.app_breaks":
    case "verification.skipped":
    case "verification.stopped":
    case "verification.failed":
    case "verification.run_limit": {
      const verdict = readString(meta, "verdict");
      if (verdict != null) ctx.verdict = verdict as Verdict;
      ctx.ciFixActive = false;
      break;
    }
    default:
      break;
  }

  // `blocked_reason` is meaningful only while in `NEEDS_YOU`; clear it on any exit. Entries via
  // `epoch.blocked` keep the reason set above (its `to_state` is `NEEDS_YOU`); other `NEEDS_YOU`
  // entries have no reason in metadata and fall through to the generic "Blocked — needs you" copy.
  if (ev.toState !== "NEEDS_YOU") ctx.blockedReason = null;
}

/**
 * Pure reconstruction: a recorded `pr_coordination_events` log (version-ascending) → the §18.5
 * timeline. Folds the sub-stage context forward from each event's metadata, annotates every event
 * with its `from_state` stage, sums `dwell_ms` per stage, and reports the latest `to_state` stage.
 * Separated from the DB read so the lossless-contract test can replay a hand-recorded log directly.
 */
export function buildTimeline(events: readonly PrCoordinationEvent[]): SessionTimeline {
  const ctx = freshContext();
  const timelineEvents: TimelineEvent[] = [];
  const stageDurations: Record<string, number> = {};
  let currentStage: StageSection | null = null;

  for (const ev of events) {
    const fromState = asFsmState(ev.fromState);
    const toState = asFsmState(ev.toState);
    const stage = stageOf(synthesizeRecord(fromState, ctx));

    timelineEvents.push({
      version: ev.version,
      fromState,
      toState,
      event: ev.event,
      at: ev.at,
      actor: ev.actor,
      dwellMs: ev.dwellMs,
      stage,
    });

    if (ev.dwellMs != null) {
      stageDurations[stage] = (stageDurations[stage] ?? 0) + ev.dwellMs;
    }

    foldContext(ctx, ev);
    // After folding, `ctx` reflects this event's effect — the right context for the new state.
    currentStage = stageOf(synthesizeRecord(toState, ctx));
  }

  return { currentStage, events: timelineEvents, stageDurations };
}

/**
 * Read a session's transition log and reconstruct its §18.5 timeline. Read-only; no spine change.
 * Wraps the pure {@link buildTimeline} around the `listPrCoordinationEvents` DAO read.
 */
export async function getSessionTimeline(db: D1Database, sessionId: string): Promise<SessionTimeline> {
  const events = await listPrCoordinationEvents(db, sessionId);
  return buildTimeline(events);
}
