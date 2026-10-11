import { describe, expect, it } from "vitest";

import {
  compactCommandOutputForReview,
  extractIssueUrl,
} from "../../apps/sandbox-bridge/src/services/post-execution/format.js";

describe("compactCommandOutputForReview", () => {
  it("keeps the last three non-empty trimmed lines joined by ' | '", () => {
    const output = ["line one", "  ", "line two", "line three", "line four"].join("\n");
    expect(compactCommandOutputForReview(output)).toBe("line two | line three | line four");
  });

  it("returns 'no output' for empty output", () => {
    expect(compactCommandOutputForReview("")).toBe("no output");
    expect(compactCommandOutputForReview("\n  \n")).toBe("no output");
  });

  it("redacts secrets in the excerpt (security invariant)", () => {
    const secret = "Bearer ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const out = compactCommandOutputForReview(`auth failed\ncurl -H "Authorization: ${secret}"`);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("truncates very long output at the review limit", () => {
    const out = compactCommandOutputForReview("x".repeat(1000));
    expect(out.startsWith("x".repeat(240))).toBe(true);
    expect(out).toContain("[truncated");
    expect(out).not.toContain("x".repeat(241));
  });
});

describe("extractIssueUrl", () => {
  it("prefers an explicit 'Issue URL:' line", () => {
    expect(extractIssueUrl("Issue URL: https://linear.app/acme/issue/ABC-123/title")).toBe(
      "https://linear.app/acme/issue/ABC-123/title",
    );
  });

  it("strips trailing punctuation from the explicit url", () => {
    expect(extractIssueUrl("Issue URL: https://linear.app/acme/issue/ABC-123).")).toBe(
      "https://linear.app/acme/issue/ABC-123",
    );
  });

  it("falls back to an inline GitHub issue url", () => {
    expect(extractIssueUrl("see https://github.com/acme/repo/issues/42 for details")).toBe(
      "https://github.com/acme/repo/issues/42",
    );
  });

  it("falls back to an inline Linear issue url", () => {
    expect(extractIssueUrl("tracked at https://linear.app/acme/issue/ABC-7/foo here")).toBe(
      "https://linear.app/acme/issue/ABC-7/foo",
    );
  });

  it("returns undefined when no issue url is present", () => {
    expect(extractIssueUrl("just a plain task description")).toBeUndefined();
    expect(extractIssueUrl("see https://example.com/not-an-issue")).toBeUndefined();
  });
});
