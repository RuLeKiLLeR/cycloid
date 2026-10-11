import { describe, expect, it } from "vitest";

import { displayStatusFromPhase } from "../../../../shared/session/display-status";
import type { FeedDelta, FeedSessionRow } from "../../../../shared/types/session-feed";
import type { SessionMetadata } from "../types";
import { applyFeedDelta, feedDeltaMatchesScope } from "./applyFeedDelta";

const NOW = 1_700_000_000_000;

function row(over: Partial<SessionMetadata> = {}): SessionMetadata {
  const phase = over.phase ?? "running";
  return {
    sessionId: "s-1",
    phase,
    displayStatus: displayStatusFromPhase(phase),
    prUrl: null,
    createdAt: 1,
    model: null,
    title: "one",
    ...over,
  };
}

const envelope = {
  ownerUserId: "owner-1",
  repoOwner: "acme" as string | null,
  repoName: "widgets" as string | null,
  source: "test",
};

describe("applyFeedDelta", () => {
  describe("session_upserted", () => {
    const upsertSession: FeedSessionRow = {
      sessionId: "s-new",
      ownerUserId: "owner-1",
      businessId: "biz-1",
      phase: "running",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: "new session",
      prUrl: null,
    };
    const delta: FeedDelta = { type: "session_upserted", sessionId: "s-new", ...envelope, session: upsertSession };

    it("inserts a new row at the front, normalized like a list row, with both freshness markers", () => {
      const next = applyFeedDelta([row({ sessionId: "s-1" })], delta, NOW);
      expect(next.map((s) => s.sessionId)).toEqual(["s-new", "s-1"]);
      expect(next[0]).toMatchObject({
        sessionId: "s-new",
        phase: "running",
        title: "new session",
        lastLiveStatusPatchAt: NOW,
        lastLivePrPatchAt: NOW,
        lastLiveVerificationPatchAt: NOW,
      });
    });

    it("replaces an existing row by id (no duplicate)", () => {
      const next = applyFeedDelta([row({ sessionId: "s-new", title: "stale" }), row({ sessionId: "s-1" })], delta, NOW);
      expect(next.map((s) => s.sessionId)).toEqual(["s-new", "s-1"]);
      expect(next[0].title).toBe("new session");
    });

    it("replaces an existing mid-list row in place (no jump to the top)", () => {
      const before = [row({ sessionId: "a" }), row({ sessionId: "s-new", title: "stale" }), row({ sessionId: "b" })];
      const next = applyFeedDelta(before, delta, NOW);
      expect(next.map((s) => s.sessionId)).toEqual(["a", "s-new", "b"]);
      expect(next[1].title).toBe("new session");
    });

    it("narrows an unknown phase to idle (list-row normalization)", () => {
      const weird = { ...delta, session: { ...upsertSession, phase: "bogus" } } as FeedDelta;
      const next = applyFeedDelta([], weird, NOW);
      expect(next[0].phase).toBe("idle");
    });
  });

  describe("session_status", () => {
    it("patches phase + lifecycle and stamps the live-status freshness marker", () => {
      const delta: FeedDelta = {
        type: "session_status",
        sessionId: "s-1",
        ...envelope,
        phase: "finalizing",
        displayStatus: "working",
        uiLifecycleStage: "verifying",
        finalizingStep: "publishing",
      };
      const next = applyFeedDelta([row()], delta, NOW);
      expect(next[0]).toMatchObject({
        phase: "finalizing",
        displayStatus: "working",
        uiLifecycleStage: "verifying",
        finalizingStep: "publishing",
        lastLiveStatusPatchAt: NOW,
      });
    });

    it("clears the stale FSM trio so a status delta re-buckets on the fresh displayStatus", () => {
      // A previously-fetched fsmState=REVIEW must not keep an actually-blocked
      // row bucketing as Working once a live status delta moves it to waiting.
      const delta: FeedDelta = {
        type: "session_status",
        sessionId: "s-1",
        ...envelope,
        phase: "waiting_for_input",
        displayStatus: "waiting_for_input",
      };
      const next = applyFeedDelta([row({ fsmState: "REVIEW", blockedReason: null, failureReason: null })], delta, NOW);
      expect(next[0]).toMatchObject({
        displayStatus: "waiting_for_input",
        fsmState: null,
        blockedReason: null,
        failureReason: null,
        lastLiveStatusPatchAt: NOW,
      });
    });

    it("preserves lifecycle when a legacy status delta omits it", () => {
      const delta: FeedDelta = {
        type: "session_status",
        sessionId: "s-1",
        ...envelope,
        phase: "completed",
      };
      const next = applyFeedDelta([row({ uiLifecycleStage: "merge_ready" })], delta, NOW);
      expect(next[0]).toMatchObject({
        phase: "completed",
        uiLifecycleStage: "merge_ready",
        lastLiveStatusPatchAt: NOW,
      });
    });

    it("clears the user-stopped badge when a later status delta sets userStopped:false", () => {
      const stopped: FeedDelta = {
        type: "session_status",
        sessionId: "s-1",
        ...envelope,
        phase: "idle",
        userStopped: true,
      };
      const afterStop = applyFeedDelta([row()], stopped, NOW);
      expect(afterStop[0]).toMatchObject({ phase: "idle", userStopped: true });

      const admitted: FeedDelta = {
        type: "session_status",
        sessionId: "s-1",
        ...envelope,
        phase: "running",
        userStopped: false,
      };
      const afterAdmit = applyFeedDelta(afterStop, admitted, NOW);
      expect(afterAdmit[0]).toMatchObject({ phase: "running", userStopped: false });
    });
  });

  describe("pr", () => {
    it("patches prUrl + prDraft and stamps the live-pr freshness marker", () => {
      const delta: FeedDelta = {
        type: "pr",
        sessionId: "s-1",
        ...envelope,
        prUrl: "https://pr/1",
        prDraft: true,
      };
      const next = applyFeedDelta([row()], delta, NOW);
      expect(next[0]).toMatchObject({ prUrl: "https://pr/1", prDraft: true, lastLivePrPatchAt: NOW });
    });
  });

  describe("verification", () => {
    it("patches the done-state badge fields", () => {
      const delta: FeedDelta = {
        type: "verification",
        sessionId: "s-1",
        ...envelope,
        phase: "review_listening",
        displayStatus: "completed",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "needs_attention",
        reviewLoopDoneState: "done",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
      };
      const next = applyFeedDelta([row()], delta, NOW);
      expect(next[0]).toMatchObject({
        phase: "review_listening",
        displayStatus: "completed",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "needs_attention",
        reviewLoopDoneState: "done",
        verificationState: "verification-done",
        verificationResult: "merge-ready",
        lastLiveStatusPatchAt: NOW,
        // Rides its own marker (not the status one) so a phase-only delta can't
        // shield it from a newer poll.
        lastLiveVerificationPatchAt: NOW,
      });
    });

    it("applies explicit null clears and ignores omitted fields", () => {
      const delta: FeedDelta = {
        type: "verification",
        sessionId: "s-1",
        ...envelope,
        reviewLoopDoneState: null,
        cycloidDoneState: null,
        cycloidDoneOutcome: null,
        cycloidDoneReasons: null,
        verificationState: null,
        verificationResult: null,
      };
      const before = row({
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "needs_attention",
        cycloidDoneReasons: ["ci_red"],
        verificationState: "verification-done",
        verificationResult: "merge-ready",
      });

      const next = applyFeedDelta([before], delta, NOW);

      expect(next[0]).toMatchObject({
        reviewLoopDoneState: null,
        cycloidDoneState: "working",
        cycloidDoneOutcome: null,
        cycloidDoneReasons: [],
        verificationState: null,
        verificationResult: null,
        lastLiveVerificationPatchAt: NOW,
      });
    });

    it("preserves explicit verification fields when a delta omits them", () => {
      const delta: FeedDelta = {
        type: "verification",
        sessionId: "s-1",
        ...envelope,
        cycloidDoneState: "done",
      };
      const before = row({
        verificationState: "verification-done",
        verificationResult: "needs-work",
      });

      const next = applyFeedDelta([before], delta, NOW);

      expect(next[0]).toMatchObject({
        cycloidDoneState: "done",
        verificationState: "verification-done",
        verificationResult: "needs-work",
        lastLiveVerificationPatchAt: NOW,
      });
    });
  });

  describe("session_closed", () => {
    it("sets the closed phase + closeReason and stamps the status marker (no zombie row)", () => {
      const delta: FeedDelta = {
        type: "session_closed",
        sessionId: "s-1",
        ...envelope,
        phase: "archived",
        displayStatus: "archived",
        closeReason: null,
      };
      const next = applyFeedDelta([row({ phase: "running" })], delta, NOW);
      expect(next[0]).toMatchObject({
        phase: "archived",
        displayStatus: "archived",
        closeReason: null,
        lastLiveStatusPatchAt: NOW,
      });
    });
  });

  describe("unknown session", () => {
    it("is a no-op for a patch delta whose session is not in the list", () => {
      const before = [row({ sessionId: "s-1" })];
      const delta: FeedDelta = { type: "session_status", sessionId: "absent", ...envelope, phase: "stopped" };
      const next = applyFeedDelta(before, delta, NOW);
      expect(next).toBe(before);
    });
  });
});

describe("feedDeltaMatchesScope", () => {
  const upsert = (ownerUserId: string): FeedDelta => ({
    type: "session_upserted",
    sessionId: "s-x",
    ownerUserId,
    repoOwner: "acme",
    repoName: "widgets",
    source: "session-create",
    session: {
      sessionId: "s-x",
      ownerUserId,
      businessId: "biz-1",
      phase: "running",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: "t",
      prUrl: null,
    },
  });
  const statusPatch: FeedDelta = {
    type: "session_status",
    sessionId: "s-x",
    ownerUserId: "teammate",
    repoOwner: "acme",
    repoName: "widgets",
    source: "status",
    phase: "running",
  };

  it("blocks a teammate's session_upserted in personal scope", () => {
    expect(feedDeltaMatchesScope(upsert("teammate"), "personal", "me")).toBe(false);
  });

  it("allows the user's own session_upserted in personal scope", () => {
    expect(feedDeltaMatchesScope(upsert("me"), "personal", "me")).toBe(true);
  });

  it("allows any session_upserted in business scope", () => {
    expect(feedDeltaMatchesScope(upsert("teammate"), "business", "me")).toBe(true);
  });

  it("always allows patch deltas (self-guarding via patchById)", () => {
    expect(feedDeltaMatchesScope(statusPatch, "personal", "me")).toBe(true);
  });
});
