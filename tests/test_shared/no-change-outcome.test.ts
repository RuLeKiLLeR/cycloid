import { describe, expect, it } from "vitest";

import {
  isLatestCompletedPromptNoChanges,
  isNoChangesPromptResult,
  latestCompletedPromptResult,
  noChangeOutcomeCopy,
} from "../../shared/session/no-change-outcome.js";

describe("isNoChangesPromptResult", () => {
  it("accepts a no-change result object", () => {
    expect(isNoChangesPromptResult({ noChanges: true, noChangeReason: "no_diff" })).toBe(true);
    expect(isNoChangesPromptResult({ noChanges: true })).toBe(true);
  });

  it("rejects results that produced changes", () => {
    expect(isNoChangesPromptResult({ diffSummary: "Changes detected" })).toBe(false);
    expect(isNoChangesPromptResult({ noChanges: false })).toBe(false);
  });

  it("rejects non-object results", () => {
    expect(isNoChangesPromptResult("[Result truncated]")).toBe(false);
    expect(isNoChangesPromptResult(null)).toBe(false);
    expect(isNoChangesPromptResult(undefined)).toBe(false);
  });
});

describe("latestCompletedPromptResult", () => {
  it("returns the latest completed prompt result", () => {
    expect(
      latestCompletedPromptResult([
        { status: "completed", result: { noChanges: true, noChangeReason: "no_diff" } },
        { status: "failed", result: { ignored: true } },
        { status: "completed", result: { branch: "feature/test" } },
      ]),
    ).toEqual({ branch: "feature/test" });
  });

  it("detects when the latest completed prompt is a no-changes result", () => {
    expect(
      isLatestCompletedPromptNoChanges([
        { status: "completed", result: { branch: "feature/test" } },
        { status: "failed", result: null },
        { status: "completed", result: { noChanges: true, noChangeReason: "no_diff" } },
      ]),
    ).toBe(true);
  });

  it("does not look past a newer completed change result to an older no-changes result", () => {
    expect(
      isLatestCompletedPromptNoChanges([
        { status: "completed", result: { noChanges: true, noChangeReason: "no_diff" } },
        { status: "completed", result: { branch: "feature/test" } },
      ]),
    ).toBe(false);
  });
});

describe("noChangeOutcomeCopy", () => {
  it("maps no_diff to a clean info outcome", () => {
    expect(noChangeOutcomeCopy("no_diff")).toEqual({
      state: "no_changes",
      tone: "info",
      title: "Completed without code changes - no PR created.",
      detail: null,
    });
  });

  it("maps no_staged_files to a clean info outcome", () => {
    const copy = noChangeOutcomeCopy("no_staged_files");
    expect(copy.state).toBe("no_changes");
    expect(copy.tone).toBe("info");
  });

  it("maps prep_failed to an abnormal error outcome", () => {
    expect(noChangeOutcomeCopy("prep_failed")).toEqual({
      state: "no_change_abnormal",
      tone: "error",
      title: "Finalization failed before changes could be prepared.",
      detail: null,
    });
  });

  it("maps post_prep_failed to a distinct abnormal error outcome", () => {
    expect(noChangeOutcomeCopy("post_prep_failed")).toEqual({
      state: "no_change_abnormal",
      tone: "error",
      title: "Finalization failed after changes were prepared.",
      detail: null,
    });
  });

  it("routes unknown and missing reasons to the abnormal path", () => {
    for (const reason of ["some_future_reason", undefined, null, ""]) {
      const copy = noChangeOutcomeCopy(reason);
      expect(copy.state).toBe("no_change_abnormal");
      expect(copy.tone).toBe("error");
    }
  });
});
