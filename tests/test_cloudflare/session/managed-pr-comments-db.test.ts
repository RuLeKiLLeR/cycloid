import { describe, expect, it } from "vitest";

import { shouldApplyManagedPrCommentUpdate } from "../../../apps/control-plane-worker/src/session/managed-pr-comments-db";

describe("managed PR comment update decisions", () => {
  it("rejects equal-rank result updates from a different prompt or head", () => {
    expect(
      shouldApplyManagedPrCommentUpdate({
        currentOwnerSessionId: "session-1",
        currentStateRank: 4,
        currentPromptId: "prompt-new",
        currentHeadSha: "head-new",
        incomingOwnerSessionId: "session-1",
        incomingState: "result",
        incomingPromptId: "prompt-old",
        incomingHeadSha: "head-old",
      }),
    ).toBe(false);
  });

  it("allows idempotent equal-rank result refreshes for the same prompt and head", () => {
    expect(
      shouldApplyManagedPrCommentUpdate({
        currentOwnerSessionId: "session-1",
        currentStateRank: 4,
        currentPromptId: "prompt-1",
        currentHeadSha: "head-1",
        incomingOwnerSessionId: "session-1",
        incomingState: "result",
        incomingPromptId: "prompt-1",
        incomingHeadSha: "head-1",
      }),
    ).toBe(true);
  });

  it("still allows higher-rank terminal updates over non-terminal comments", () => {
    expect(
      shouldApplyManagedPrCommentUpdate({
        currentOwnerSessionId: "session-1",
        currentStateRank: 1,
        currentPromptId: "prompt-1",
        currentHeadSha: "head-1",
        incomingOwnerSessionId: "session-1",
        incomingState: "result",
        incomingPromptId: "prompt-2",
        incomingHeadSha: "head-2",
      }),
    ).toBe(true);
  });
});
