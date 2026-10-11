import { describe, expect, it } from "vitest";

import { describeReviewLoopBlockedReason } from "../../apps/control-plane-worker/src/services/review-loop-blocked-reason";

describe("describeReviewLoopBlockedReason", () => {
  it("maps prompt_send_not_ready to retry-aware copy, not the generic fallback", () => {
    const copy = describeReviewLoopBlockedReason("prompt_send_not_ready");
    expect(copy).toBe("Paused after repeated attempts to wake this session up. This PR may need a human.");
  });

  it("maps rebase_needed to merge-conflict copy, not the generic fallback", () => {
    const copy = describeReviewLoopBlockedReason("rebase_needed");
    expect(copy).toBe("Paused — this branch has merge conflicts with its base. Please rebase or resolve them.");
  });

  it("maps branch_update_failed to update-failed copy, not the generic fallback", () => {
    const copy = describeReviewLoopBlockedReason("branch_update_failed");
    expect(copy).toBe("Paused — couldn't bring this branch up to date with its base. Please update it manually.");
  });

  it("maps transient_d1_error to retry-aware storage copy, not the generic fallback", () => {
    const copy = describeReviewLoopBlockedReason("transient_d1_error");
    expect(copy).toBe("Paused after repeated storage errors. I'll retry, but this PR may need a human.");
  });

  it("maps review_handling_disabled (manual review mode, ARC-1514) to friendly copy, not the generic fallback", () => {
    const copy = describeReviewLoopBlockedReason("review_handling_disabled");
    expect(copy).toBe(
      "Automatic review handling is off — Cycloid is working CI to green only. Mention @cycloid on a comment to pull it into a review.",
    );
  });

  it("falls back to the generic message for an unknown reason", () => {
    expect(describeReviewLoopBlockedReason("totally_unknown_reason")).toBe(
      "Paused responding to reviews on this PR. This PR may need a human to take a look.",
    );
  });
});
