import { describe, expect, it } from "vitest";

import {
  isReviewLoopWorktreeBlockError,
  REVIEW_LOOP_WORKTREE_BLOCK_PHRASE,
} from "../../shared/transcript/review-loop-worktree-block.js";

// The exact message the bridge builds for a review-loop worktree-boundary block
// (apps/sandbox-bridge/src/utils/protection.ts). Kept here as a drift guard: if
// the message wording changes without the shared constant, this string stops
// matching and the detector (and the UI suppression it drives) silently breaks.
const CANONICAL_BLOCK_MESSAGE = `Policy block: review-loop access outside worktree "/tmp/review-lint-format.log"`;

describe("isReviewLoopWorktreeBlockError", () => {
  it("matches the canonical review-loop worktree-boundary block message", () => {
    expect(isReviewLoopWorktreeBlockError("policy_block", CANONICAL_BLOCK_MESSAGE)).toBe(true);
  });

  it("keeps the phrase constant in sync with the canonical message", () => {
    expect(REVIEW_LOOP_WORKTREE_BLOCK_PHRASE).toBe("review-loop access outside worktree");
    expect(CANONICAL_BLOCK_MESSAGE).toContain(REVIEW_LOOP_WORKTREE_BLOCK_PHRASE);
  });

  it("does not match other policy_block kinds that must stay visible", () => {
    expect(isReviewLoopWorktreeBlockError("policy_block", `Policy block: protected path "package-lock.json"`)).toBe(
      false,
    );
    expect(
      isReviewLoopWorktreeBlockError("policy_block", "Policy block: plan mode is read-only. Use read-only inspection"),
    ).toBe(false);
    expect(
      isReviewLoopWorktreeBlockError(
        "policy_block",
        'Policy block: tool "bash" is not permitted for this review-loop source kind.',
      ),
    ).toBe(false);
  });

  it("requires the policy_block code, not just the phrase in the text", () => {
    expect(isReviewLoopWorktreeBlockError("unknown", CANONICAL_BLOCK_MESSAGE)).toBe(false);
    expect(isReviewLoopWorktreeBlockError(undefined, CANONICAL_BLOCK_MESSAGE)).toBe(false);
  });

  it("is safe on a missing message", () => {
    expect(isReviewLoopWorktreeBlockError("policy_block", undefined)).toBe(false);
  });
});
