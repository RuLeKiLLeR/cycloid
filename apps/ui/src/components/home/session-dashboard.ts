import {
  type FsmState,
  LIFECYCLE_CHIP,
  type LifecycleChip,
  lifecycleChipDetail,
} from "../../../../../shared/session/lifecycle-chip";
import type { SessionMetadata } from "../../types";
import { parseTimestamp } from "../../utils/time";

// Operational dashboard buckets for the Home control room. Sessions collapse
// into three columns the user acts on: work that needs them, work in flight,
// and work that just landed. This is a projection for display only — the FSM /
// `flattenStatus` remain the source of truth for the underlying phase.
export type DashboardBucket = "attention" | "running" | "completed";

export const DASHBOARD_BUCKET_LABEL: Record<DashboardBucket, string> = {
  attention: "Needs attention",
  running: "Running",
  completed: "Recently completed",
};

/** True when a session is paused on a question and cannot progress without the user. */
export function isNeedsInput(session: SessionMetadata): boolean {
  return session.displayStatus === "waiting_for_input";
}

/** True when Cycloid settled its automated work but flagged the head for a human. */
function needsHumanAttention(session: SessionMetadata): boolean {
  return session.cycloidDoneState === "done" && session.cycloidDoneOutcome === "needs_attention";
}

/**
 * FSM state → dashboard bucket, exhaustive over the 17-state union so a new
 * `FsmState` fails tsc here until it is bucketed. `ARCHIVED` maps to `completed`
 * for totality, but `groupDashboardSessions` drops archived rows before this
 * runs (the sidebar owns that history), so the value is never surfaced.
 */
const FSM_BUCKET: Record<FsmState, DashboardBucket> = {
  NEEDS_YOU: "attention",
  FAILED: "attention",
  AWAITING_INPUT: "attention",
  CREATED: "running",
  PROVISIONING: "running",
  GENERATING: "running",
  FINALIZING: "running",
  PUBLISHING: "running",
  REVIEW: "running",
  VERIFYING: "running",
  MERGE_READY: "completed",
  MERGED: "completed",
  CLOSED: "completed",
  ANSWERED_NO_PR: "completed",
  STOPPED: "completed",
  SUPERSEDED: "completed",
  ARCHIVED: "completed",
};

/**
 * Bucket a session for the control-room columns. FSM-first: when the control
 * plane threads an `fsmState`, the exhaustive `FSM_BUCKET` map is authoritative;
 * otherwise (optimistic / legacy rows) fall back to the `displayStatus` logic.
 *
 * - `attention`: waiting on the user, failed/blocked, or Cycloid flagged the
 *   PR (CI red / verification exhausted) as needing a human.
 * - `running`: an in-flight prompt or finalizing/publishing.
 * - `completed`: everything else terminal (completed, stopped, idle, closed).
 */
export function bucketSession(session: SessionMetadata): DashboardBucket {
  if (session.fsmState) return FSM_BUCKET[session.fsmState];
  const status = session.displayStatus;
  if (status === "waiting_for_input" || status === "failed") return "attention";
  if (needsHumanAttention(session)) return "attention";
  if (status === "working") return "running";
  return "completed";
}

/**
 * FSM-derived chip + per-row detail for a session, or `null` when there is no
 * `fsmState` (or the state is chip-less, i.e. ARCHIVED) — in which case the
 * caller falls back to the legacy `sessionChipStatus` path. The chip label/tone
 * and detail copy both come from the shared `lifecycle-chip` source of truth, so
 * the UI can never drift from the FSM projection.
 */
export function sessionLifecycleChip(session: SessionMetadata): { chip: LifecycleChip; detail: string | null } | null {
  if (!session.fsmState) return null;
  const chip = LIFECYCLE_CHIP[session.fsmState];
  if (!chip) return null;
  return { chip, detail: lifecycleChipDetail(session.fsmState, session.blockedReason, session.failureReason) };
}

/**
 * Map a session onto the `StatusChip` union. More granular than the bucket so a
 * row reads at a glance: a finalizing session shows "Verifying", a shipped PR
 * with a needs-attention flag shows "Checks failing".
 */
export function sessionChipStatus(session: SessionMetadata) {
  const status = session.displayStatus;
  if (status === "waiting_for_input") return "waiting";
  if (status === "failed") return "failed";
  if (status === "working") return session.phase === "finalizing" ? "verifying" : "running";
  if (needsHumanAttention(session)) return "checks-failing";
  if (session.prUrl) return "pr-open";
  return "done";
}

export type DashboardGroups = {
  attention: SessionMetadata[];
  running: SessionMetadata[];
  completed: SessionMetadata[];
  /**
   * Sessions beyond the render cap for each capped bucket. The UI leads with a
   * summary count instead of rendering a wall of rows, so the count communicates
   * urgency (e.g. "39 needs attention") without flooding the dashboard.
   */
  attentionOverflow: number;
  completedOverflow: number;
};

function sortByCreatedDesc(a: SessionMetadata, b: SessionMetadata): number {
  return (parseTimestamp(b.createdAt) ?? 0) - (parseTimestamp(a.createdAt) ?? 0);
}

/**
 * Group active sessions into the three control-room columns, newest first
 * within each. Archived sessions are dropped (the sidebar owns that history).
 * `attentionLimit` and `completedLimit` cap their columns so the dashboard stays
 * scannable — the overflow is surfaced as a count instead of extra rows. The
 * `running` column is in-flight work and is never truncated.
 */
export function groupDashboardSessions(
  sessions: SessionMetadata[],
  completedLimit = 6,
  attentionLimit = 6,
): DashboardGroups {
  const attention: SessionMetadata[] = [];
  const running: SessionMetadata[] = [];
  const completed: SessionMetadata[] = [];
  for (const session of sessions) {
    if (session.fsmState === "ARCHIVED" || session.displayStatus === "archived") continue;
    const bucket = bucketSession(session);
    if (bucket === "attention") attention.push(session);
    else if (bucket === "running") running.push(session);
    else completed.push(session);
  }
  attention.sort(sortByCreatedDesc);
  running.sort(sortByCreatedDesc);
  completed.sort(sortByCreatedDesc);
  return {
    attention: attention.slice(0, attentionLimit),
    running,
    completed: completed.slice(0, completedLimit),
    attentionOverflow: Math.max(0, attention.length - attentionLimit),
    completedOverflow: Math.max(0, completed.length - completedLimit),
  };
}

/** Sessions waiting on the user, newest first — powers the right-rail shortcut list. */
export function needsInputSessions(sessions: SessionMetadata[]): SessionMetadata[] {
  return sessions.filter(isNeedsInput).sort(sortByCreatedDesc);
}
