import type { FeedDelta } from "../../../../shared/types/session-feed";
import { normalizeSessionMetadata, type RawSessionMetadata } from "../api/sessions";
import type { SessionMetadata } from "../types";
import { buildSessionStatusPatch } from "./sessionStatusPatch";

// Pure reducer for the per-business sidebar feed (ARC-1322). Layout wires this
// as `setSessions((prev) => applyFeedDelta(prev, delta))`. Kept free of React /
// WebSocket so the dispatch logic is unit-testable in isolation; the `now`
// parameter keeps freshness-marker stamping deterministic under test.
//
// Patches to an unknown session id are no-ops (the row isn't in this scope's
// list) — mirroring Layout's `patchSession`. A `session_upserted` inserts or
// replaces by id.

/**
 * Whether a feed delta should be applied given the sidebar's current scope.
 *
 * The business-scoped feed carries every repo-accessible session, including
 * teammates' in a shared business. The sidebar's PERSONAL scope, though, only
 * ever lists the user's own sessions (the server filters by owner), so a
 * teammate's `session_upserted` must not insert a row that scope would never
 * return. Patch deltas are self-guarding — `patchById` no-ops on a row that
 * isn't present — so only an insert (`session_upserted`) can add an out-of-scope
 * row, and only it needs this gate.
 */
export function feedDeltaMatchesScope(
  delta: FeedDelta,
  scope: "personal" | "business",
  currentUserId: string | undefined,
): boolean {
  if (delta.type !== "session_upserted") return true;
  if (scope !== "personal") return true;
  return delta.ownerUserId === currentUserId;
}

function patchById(sessions: SessionMetadata[], sessionId: string, patch: Partial<SessionMetadata>): SessionMetadata[] {
  const index = sessions.findIndex((session) => session.sessionId === sessionId);
  if (index === -1) return sessions;
  const next = sessions.slice();
  next[index] = { ...next[index], ...patch };
  return next;
}

export function applyFeedDelta(
  sessions: SessionMetadata[],
  delta: FeedDelta,
  now: number = Date.now(),
): SessionMetadata[] {
  switch (delta.type) {
    case "session_upserted": {
      // Normalize exactly as a fetched list row, so a feed row is identical to a
      // polled one (phase narrowing etc.). Stamp all freshness markers: an
      // upsert is live server-fresh data and must survive a stale in-flight poll
      // (and must not lose protection when it replaces a row that held a marker).
      const normalized = normalizeSessionMetadata(delta.session as unknown as RawSessionMetadata);
      const row: SessionMetadata = {
        ...normalized,
        lastLiveStatusPatchAt: now,
        lastLivePrPatchAt: now,
        lastLiveVerificationPatchAt: now,
      };
      const index = sessions.findIndex((session) => session.sessionId === row.sessionId);
      // A new session goes to the front (newest by createdAt); an upsert for an
      // existing row replaces it in place so it doesn't jump to the top of the
      // sidebar out of the server's sort order.
      if (index === -1) {
        return [row, ...sessions];
      }
      const next = sessions.slice();
      next[index] = row;
      return next;
    }
    case "session_status":
      return patchById(sessions, delta.sessionId, buildSessionStatusPatch(delta, now));
    case "pr":
      return patchById(sessions, delta.sessionId, {
        prUrl: delta.prUrl,
        ...(delta.prDraft != null ? { prDraft: delta.prDraft } : {}),
        ...(delta.prManualReviewReason !== undefined ? { prManualReviewReason: delta.prManualReviewReason } : {}),
        lastLivePrPatchAt: now,
      });
    // TODO(qa-rename, ARC-1330): keep this 'verification' name; the rename is the QA owner's job — delete after their refactor.
    case "verification":
      // Done-state rides its own marker so a separate phase-only session_status
      // delta can't shield these from a newer poll. If this delta also carries
      // phase/displayStatus, those fields ride the status marker.
      return patchById(sessions, delta.sessionId, {
        ...(delta.phase !== undefined ? { phase: delta.phase } : {}),
        ...(delta.displayStatus !== undefined ? { displayStatus: delta.displayStatus } : {}),
        ...(delta.reviewLoopDoneState !== undefined ? { reviewLoopDoneState: delta.reviewLoopDoneState } : {}),
        ...(delta.cycloidDoneState !== undefined ? { cycloidDoneState: delta.cycloidDoneState ?? "working" } : {}),
        ...(delta.cycloidDoneOutcome !== undefined ? { cycloidDoneOutcome: delta.cycloidDoneOutcome } : {}),
        ...(delta.cycloidDoneReasons !== undefined ? { cycloidDoneReasons: delta.cycloidDoneReasons ?? [] } : {}),
        ...(delta.verificationState !== undefined ? { verificationState: delta.verificationState } : {}),
        ...(delta.verificationResult !== undefined ? { verificationResult: delta.verificationResult } : {}),
        // When this delta also freshens phase/displayStatus, the un-carried FSM
        // fields go stale — clear them (they ride the status marker below) so
        // FSM-first rendering falls back to the fresh status until a full upsert.
        ...(delta.phase !== undefined || delta.displayStatus !== undefined
          ? { fsmState: null, blockedReason: null, failureReason: null, lastLiveStatusPatchAt: now }
          : {}),
        lastLiveVerificationPatchAt: now,
      });
    case "session_closed":
      // Stamp the status marker so a poll that was in flight before the close
      // can't resurrect the just-archived row.
      return patchById(sessions, delta.sessionId, {
        phase: delta.phase,
        ...(delta.displayStatus !== undefined ? { displayStatus: delta.displayStatus } : {}),
        closeReason: delta.closeReason ?? null,
        // Clear the now-stale FSM trio (see session_status) so a closing row
        // buckets on the fresh terminal phase, not a stale in-loop fsmState.
        fsmState: null,
        blockedReason: null,
        failureReason: null,
        lastLiveStatusPatchAt: now,
      });
    default:
      return sessions;
  }
}
