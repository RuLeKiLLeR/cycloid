import { describe, expect, it } from "vitest";

import { displayStatusFromPhase } from "../../../../shared/session/display-status";
import type { SessionMetadata } from "../types";
import { mergeSessionSnapshotWithLivePatches } from "./sessionSnapshotMerge";

const ISSUED_AT = 1000;
const FRESH = 2000; // patched after the poll was issued
const STALE = 500; // patched before the poll was issued

function meta(over: Partial<SessionMetadata> = {}): SessionMetadata {
  const phase = over.phase ?? "running";
  return {
    sessionId: "s-1",
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    createdAt: 1,
    model: null,
    title: "t",
    ...over,
  };
}

describe("mergeSessionSnapshotWithLivePatches", () => {
  it("returns the snapshot unchanged when there is no local row", () => {
    const snap = meta({ phase: "idle" });
    expect(mergeSessionSnapshotWithLivePatches(snap, undefined, ISSUED_AT)).toBe(snap);
  });

  it("preserves a fresh status patch (phase + display status + lifecycle stage) over a stale snapshot", () => {
    const snap = meta({ phase: "idle", displayStatus: "stopped", uiLifecycleStage: null });
    const local = meta({
      phase: "running",
      displayStatus: "working",
      uiLifecycleStage: "verifying",
      lastLiveStatusPatchAt: FRESH,
    });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.phase).toBe("running");
    expect(merged.displayStatus).toBe("working");
    expect(merged.uiLifecycleStage).toBe("verifying");
  });

  it("preserves the locally-cleared FSM trio over a stale snapshot's superseded fsmState", () => {
    // A live status delta cleared fsmState (freshening displayStatus) and
    // stamped the status marker. An in-flight stale poll returns a snapshot
    // still carrying the pre-transition fsmState=REVIEW; the fresher local
    // clear must win so the row keeps bucketing on the fresh displayStatus.
    const snap = meta({ fsmState: "REVIEW", displayStatus: "working" });
    const local = meta({
      fsmState: null,
      blockedReason: null,
      failureReason: null,
      displayStatus: "waiting_for_input",
      lastLiveStatusPatchAt: FRESH,
    });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.fsmState).toBeNull();
    expect(merged.displayStatus).toBe("waiting_for_input");
  });

  it("takes the snapshot's fresh fsmState when the local status marker is stale", () => {
    const snap = meta({ fsmState: "NEEDS_YOU", blockedReason: "review_stuck" });
    const local = meta({ fsmState: null, lastLiveStatusPatchAt: STALE });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.fsmState).toBe("NEEDS_YOU");
    expect(merged.blockedReason).toBe("review_stuck");
  });

  it("preserves a fresh status patch's userStopped over a stale list snapshot that omits it", () => {
    // A live-idle stop frame (phase:idle + userStopped:true) stamps the status
    // marker. A list poll already in flight returns a snapshot without
    // userStopped; the fresher local flag must survive so the "Stopped —
    // continue anytime" state isn't cleared until a real update lands.
    const snap = meta({ phase: "idle" });
    const local = meta({ phase: "idle", userStopped: true, lastLiveStatusPatchAt: FRESH });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.userStopped).toBe(true);
  });

  it("drops userStopped when the local status marker is stale (snapshot wins)", () => {
    const snap = meta({ phase: "idle" });
    const local = meta({ phase: "idle", userStopped: true, lastLiveStatusPatchAt: STALE });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.userStopped).toBeUndefined();
  });

  it("does NOT let a fresh status patch shield a newer poll's done-state (the regression)", () => {
    // Status marker is fresh, but the verification marker is not: the poll's
    // newer done-state must win — a phase-only delta must not freeze done-state.
    const snap = meta({ cycloidDoneState: "done" });
    const local = meta({ cycloidDoneState: "working", lastLiveStatusPatchAt: FRESH });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.cycloidDoneState).toBe("done");
  });

  it("preserves a fresh verification patch's done-state over an outdated snapshot", () => {
    const snap = meta({
      cycloidDoneState: "working",
      verificationState: null,
      verificationResult: null,
      verificationAttemptCount: 1,
      verificationMaxAttempts: 3,
    });
    const local = meta({
      cycloidDoneState: "done",
      cycloidDoneOutcome: "needs_attention",
      verificationState: "verification-done",
      verificationResult: "merge-ready",
      verificationNeedsWorkLabel: null,
      verificationAttemptCount: 2,
      verificationMaxAttempts: 3,
      lastLiveVerificationPatchAt: FRESH,
    });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.cycloidDoneState).toBe("done");
    expect(merged.cycloidDoneOutcome).toBe("needs_attention");
    expect(merged.verificationState).toBe("verification-done");
    expect(merged.verificationResult).toBe("merge-ready");
    expect(merged.verificationAttemptCount).toBe(2);
  });

  it("preserves a fresh PR patch (prUrl + prManualReviewReason) over a stale snapshot", () => {
    const snap = meta({ prUrl: null, prManualReviewReason: null });
    const local = meta({ prUrl: "https://pr/1", prManualReviewReason: "needs human", lastLivePrPatchAt: FRESH });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.prUrl).toBe("https://pr/1");
    expect(merged.prManualReviewReason).toBe("needs human");
  });

  it("takes the snapshot when local markers are stale", () => {
    const snap = meta({ phase: "idle", cycloidDoneState: "done", verificationState: "verification-in-progress" });
    const local = meta({
      phase: "running",
      cycloidDoneState: "working",
      verificationState: "verification-done",
      lastLiveStatusPatchAt: STALE,
      lastLiveVerificationPatchAt: STALE,
    });
    const merged = mergeSessionSnapshotWithLivePatches(snap, local, ISSUED_AT);
    expect(merged.phase).toBe("idle");
    expect(merged.cycloidDoneState).toBe("done");
    expect(merged.verificationState).toBe("verification-in-progress");
  });
});
