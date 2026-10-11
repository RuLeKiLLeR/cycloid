import { describe, expect, it } from "vitest";

import { normalizeReviewLoopDoneState, type ReviewLoopDoneState } from "../../shared/session/phase";

describe("ReviewLoopDoneState", () => {
  it("admits exactly the two live states and null is the no-claim sentinel", () => {
    // Compile-time anchor: every literal must be assignable.
    const working: ReviewLoopDoneState = "working";
    const done: ReviewLoopDoneState = "done";
    const all: ReviewLoopDoneState[] = [working, done];
    expect(all).toEqual(["working", "done"]);

    // null is NOT part of the union; the persisted/threaded value is `ReviewLoopDoneState | null`.
    const threaded: ReviewLoopDoneState | null = null;
    expect(threaded).toBeNull();
  });
});

describe("normalizeReviewLoopDoneState", () => {
  it("maps the live states through unchanged", () => {
    expect(normalizeReviewLoopDoneState("working")).toBe("working");
    expect(normalizeReviewLoopDoneState("done")).toBe("done");
  });

  it("collapses legacy persisted strings to done", () => {
    expect(normalizeReviewLoopDoneState("done_green")).toBe("done");
    expect(normalizeReviewLoopDoneState("done_exhausted")).toBe("done");
  });

  it("returns null for any other value (no-claim sentinel)", () => {
    expect(normalizeReviewLoopDoneState(null)).toBeNull();
    expect(normalizeReviewLoopDoneState(undefined)).toBeNull();
    expect(normalizeReviewLoopDoneState("")).toBeNull();
    expect(normalizeReviewLoopDoneState("bogus")).toBeNull();
    expect(normalizeReviewLoopDoneState(42)).toBeNull();
  });
});
