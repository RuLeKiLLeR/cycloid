import { describe, expect, it } from "vitest";

import { extractCycloidReviewTrigger } from "../../apps/control-plane-worker/src/webhooks/github-review-trigger";

describe("extractCycloidReviewTrigger", () => {
  it.each([
    ["@cycloid-review", null],
    ["please @CYCLOID-REVIEW!", null],
    ["@cycloid-review focus on the migration", "focus on the migration"],
    ["prefix\n@cycloid-review: security only", "security only"],
  ])("detects %s", (body, focus) => {
    expect(extractCycloidReviewTrigger(body)).toEqual({ triggered: true, focus });
  });

  it.each(["x@cycloid-review", "@cycloid-reviewer", "@cycloid-review/now", "plain text", null])(
    "rejects non-token %s",
    (body) => {
      expect(extractCycloidReviewTrigger(body)).toEqual({ triggered: false, focus: null });
    },
  );

  it("wins independently when the ordinary app mention is also present", () => {
    expect(extractCycloidReviewTrigger("@cycloid implement this @cycloid-review focus on auth")).toEqual({
      triggered: true,
      focus: "focus on auth",
    });
  });
});
