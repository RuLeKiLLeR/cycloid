import { describe, expect, it } from "vitest";

import {
  isCheckRunFailureSourceId,
  parseReviewLoopSourceNumericId,
} from "../../apps/control-plane-worker/src/services/review-loop-source-id";

describe("review loop source ids", () => {
  it("parses positive safe integer source ids", () => {
    expect(parseReviewLoopSourceNumericId(" review-comment:123 ", "review-comment")).toBe(123);
    expect(parseReviewLoopSourceNumericId("issue-comment:123", "review-comment")).toBeNull();
  });

  it("rejects zero, negative, malformed, and unsafe ids", () => {
    expect(parseReviewLoopSourceNumericId("check-run-failure:0", "check-run-failure")).toBeNull();
    expect(parseReviewLoopSourceNumericId("check-run-failure:-1", "check-run-failure")).toBeNull();
    expect(parseReviewLoopSourceNumericId("check-run-failure:1.2", "check-run-failure")).toBeNull();
    expect(parseReviewLoopSourceNumericId("check-run-failure:9007199254740992", "check-run-failure")).toBeNull();
  });

  it("parses the human review trigger source-id form", () => {
    expect(parseReviewLoopSourceNumericId("human:4647984291", "human")).toBe(4647984291);
    expect(parseReviewLoopSourceNumericId(" human:42 ", "human")).toBe(42);
    expect(parseReviewLoopSourceNumericId("human:0", "human")).toBeNull();
    expect(parseReviewLoopSourceNumericId("review-body:42", "human")).toBeNull();
    expect(parseReviewLoopSourceNumericId("human:abc", "human")).toBeNull();
  });

  it("uses the strict check-run failure source-id contract", () => {
    expect(isCheckRunFailureSourceId(" check-run-failure:1 ")).toBe(true);
    expect(isCheckRunFailureSourceId("check-run-failure:0")).toBe(false);
  });

  it("classifies check-run ids above Number.MAX_SAFE_INTEGER as CI items", () => {
    // Classification must not depend on safe-integer parsing: a large check-run id is still a CI
    // item and must not be misread as unresolved human feedback.
    expect(isCheckRunFailureSourceId("check-run-failure:9007199254740992")).toBe(true);
    expect(isCheckRunFailureSourceId("check-run-failure:99999999999999999999")).toBe(true);
  });
});
