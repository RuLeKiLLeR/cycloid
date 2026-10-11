import { describe, expect, it } from "vitest";

import {
  SUMMARY_TEXT_CLAMP_CHAR_THRESHOLD,
  SUMMARY_TEXT_CLAMP_LINE_THRESHOLD,
} from "../../../constants/session-summary";
import { deriveSummaryNextAction, isSummaryTextClampable, type SummaryNextActionInput } from "./summary-derivations";

function nextActionInput(overrides: Partial<SummaryNextActionInput> = {}): SummaryNextActionInput {
  return { phase: "running", prUrl: null, ...overrides };
}

describe("deriveSummaryNextAction", () => {
  it("recommends inspecting the runtime while working", () => {
    const action = deriveSummaryNextAction(nextActionInput({ phase: "running" }));
    expect(action?.kind).toBe("inspect-runtime");
    expect(action?.label).toBe("Inspect runtime");
    expect(action?.targetTab).toBe("runtime");
    expect(action?.failureDetail).toBeNull();
  });

  it("prefers the record's displayStatus over the phase fallback", () => {
    const action = deriveSummaryNextAction(nextActionInput({ phase: "completed", displayStatus: "working" }));
    expect(action?.kind).toBe("inspect-runtime");
  });

  it("recommends answering the agent when waiting for input", () => {
    const action = deriveSummaryNextAction(nextActionInput({ phase: "waiting_for_input" }));
    expect(action?.kind).toBe("answer-agent");
    expect(action?.label).toBe("Answer agent");
    expect(action?.targetTab).toBeNull();
  });

  it("recommends Retry with the failure detail retained when the session failed", () => {
    const action = deriveSummaryNextAction(
      nextActionInput({ phase: "failed", publishError: "push rejected by branch protection" }),
    );
    expect(action?.kind).toBe("retry");
    expect(action?.label).toBe("Retry");
    expect(action?.targetTab).toBeNull();
    expect(action?.failureDetail).toBe("push rejected by branch protection");
  });

  it("recommends Retry for blocked sessions via the shared phase projection", () => {
    const action = deriveSummaryNextAction(nextActionInput({ phase: "blocked", closeReason: "sandbox lost" }));
    expect(action?.kind).toBe("retry");
    expect(action?.failureDetail).toBe("sandbox lost");
  });

  it("falls back to Inspect runtime when the phase is not retryable", () => {
    // `displayStatus: "failed"` with a non-retryable phase (finalizing races the
    // publish-prep window) keeps the failure evidence but drops the Retry.
    const action = deriveSummaryNextAction(
      nextActionInput({ phase: "finalizing", displayStatus: "failed", publishError: "publish failed" }),
    );
    expect(action?.kind).toBe("inspect-runtime");
    expect(action?.targetTab).toBe("runtime");
    expect(action?.failureDetail).toBe("publish failed");
  });

  it("keeps a null failure detail when no error text exists", () => {
    const action = deriveSummaryNextAction(nextActionInput({ phase: "failed" }));
    expect(action?.kind).toBe("retry");
    expect(action?.failureDetail).toBeNull();
  });

  it("recommends reviewing the PR when the session is done and the PR is open", () => {
    const action = deriveSummaryNextAction(
      nextActionInput({ phase: "completed", prUrl: "https://github.com/o/r/pull/12" }),
    );
    expect(action?.kind).toBe("review-pr");
    expect(action?.label).toBe("Open PR");
    expect(action?.description).toBe("Cycloid opened a PR for your review.");
  });

  it("cites the review loop when the PR is merge ready", () => {
    const action = deriveSummaryNextAction(
      nextActionInput({
        phase: "review_listening",
        uiLifecycleStage: "merge_ready",
        prUrl: "https://github.com/o/r/pull/12",
      }),
    );
    expect(action?.kind).toBe("review-pr");
    expect(action?.description).toBe("Review loop caught up and checks passed.");
  });

  it("notes running verification when the lifecycle stage is verifying", () => {
    const action = deriveSummaryNextAction(
      nextActionInput({
        phase: "review_listening",
        uiLifecycleStage: "verifying",
        prUrl: "https://github.com/o/r/pull/12",
      }),
    );
    expect(action?.kind).toBe("review-pr");
    expect(action?.description).toBe("Cycloid opened a PR. Verification is still running.");
  });

  it("recommends the report for completed sessions without a PR", () => {
    const action = deriveSummaryNextAction(nextActionInput({ phase: "completed" }));
    expect(action?.kind).toBe("read-report");
    expect(action?.targetTab).toBe("report");
  });

  it("still points at the PR when a stopped session left one open", () => {
    const action = deriveSummaryNextAction(
      nextActionInput({ phase: "stopped", prUrl: "https://github.com/o/r/pull/3" }),
    );
    expect(action?.kind).toBe("review-pr");
  });

  it.each(["merged", "closed", "superseded"] as const)("returns null once the PR lifecycle is %s", (stage) => {
    const action = deriveSummaryNextAction(
      nextActionInput({ phase: "completed", uiLifecycleStage: stage, prUrl: "https://github.com/o/r/pull/3" }),
    );
    expect(action).toBeNull();
  });

  it("returns null for an archived session whose PR already merged", () => {
    const action = deriveSummaryNextAction(
      nextActionInput({ phase: "archived", closeReason: "pr_merged", prUrl: "https://github.com/o/r/pull/3" }),
    );
    expect(action).toBeNull();
  });

  it("returns null for a stopped session with nothing to act on", () => {
    expect(deriveSummaryNextAction(nextActionInput({ phase: "stopped" }))).toBeNull();
  });
});

describe("isSummaryTextClampable", () => {
  it("keeps short single-line text inline", () => {
    expect(isSummaryTextClampable("Fix the flaky retry test")).toBe(false);
  });

  it("clamps past the character threshold", () => {
    expect(isSummaryTextClampable("x".repeat(SUMMARY_TEXT_CLAMP_CHAR_THRESHOLD + 1))).toBe(true);
  });

  it("clamps past the line threshold", () => {
    expect(isSummaryTextClampable("line\n".repeat(SUMMARY_TEXT_CLAMP_LINE_THRESHOLD))).toBe(true);
    expect(isSummaryTextClampable("a\nb")).toBe(false);
  });
});
