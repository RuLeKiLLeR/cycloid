import { describe, expect, it } from "vitest";

import type { SessionDetail } from "../types";
import { getCanonicalSessionStatus } from "./SessionHeader";

// PR-E1: the merge-ready chip copy is reframed to "Checks passed" (QA no longer gates the review loop).
// `getCanonicalSessionStatus` is a pure projection of the session fields, so we exercise it directly.
function session(over: Partial<SessionDetail>): SessionDetail {
  return {
    displayStatus: "completed",
    phase: "completed",
    prUrl: "https://github.com/acme/repo/pull/1",
    uiLifecycleStage: null,
    reviewLoopDoneState: null,
    cycloidDoneState: null,
    cycloidDoneOutcome: null,
    ...over,
  } as unknown as SessionDetail;
}

describe("getCanonicalSessionStatus — PR-E1 merge-ready copy", () => {
  it("merge_ready lifecycle stage → chip title 'Checks passed'", () => {
    const status = getCanonicalSessionStatus(session({ uiLifecycleStage: "merge_ready" }));
    expect(status.label).toBe("Merge ready");
    expect(status.title).toBe("Checks passed");
  });

  it("the legacy PR-ready merge-ready fallback → chip title 'Checks passed'", () => {
    const status = getCanonicalSessionStatus(
      session({
        displayStatus: "completed",
        reviewLoopDoneState: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "success",
      }),
    );
    expect(status.label).toBe("PR ready");
    expect(status.title).toBe("Checks passed");
  });

  it("a PR-ready session that is NOT merge-ready keeps the neutral 'Pull request is ready' copy", () => {
    const status = getCanonicalSessionStatus(session({ displayStatus: "completed" }));
    expect(status.label).toBe("PR ready");
    expect(status.title).toBe("Pull request is ready");
  });
});

describe("getCanonicalSessionStatus — plan-approval park (PR15)", () => {
  it("shows 'Needs you' for a parked plan even after the sandbox suspends", () => {
    // The 5-min park suspend sets a stopped/paused sandbox, but the server keeps
    // deriving displayStatus=waiting_for_input (planApprovalPending wins in
    // computePhase before the stopped-resumable branch). The chip keys on that
    // displayStatus, so a suspended park still reads "Needs you".
    const status = getCanonicalSessionStatus(
      session({
        displayStatus: "waiting_for_input",
        phase: "waiting_for_input",
        planApprovalPending: true,
        planStatus: "pending",
        stopMode: "resumable",
        prUrl: null,
      }),
    );
    expect(status.label).toBe("Needs you");
    expect(status.tone).toBe("warning");
  });
});
