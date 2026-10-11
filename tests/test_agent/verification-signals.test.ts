import { describe, expect, it } from "vitest";

/**
 * Tests for the regex patterns used to detect external state references
 * and verification tool usage in bridge.ts signal tracking.
 */

const EXTERNAL_REF_PR_NUMBER = /#\d{1,6}\b/;
const EXTERNAL_REF_GITHUB_URL = /github\.com\/[^\s]+\/(pull|issues)\/\d+/;
const VERIFICATION_TOOL_CMD = /\bgh\s+(pr|issue)\s+(view|diff|list)/;

describe("referencedExternalState detection", () => {
  describe("PR/issue number pattern", () => {
    it.each(["See PR #504", "Fixed in #123", "#1 is the first issue", "Check #999999"])("matches: %s", (text) => {
      expect(EXTERNAL_REF_PR_NUMBER.test(text)).toBe(true);
    });

    it.each([
      "color #fff",
      "color #ffffff",
      "section #overview",
      "step 3 of 5",
      "version 2.0",
      "#abcdef is a hex color",
    ])("does NOT match: %s", (text) => {
      expect(EXTERNAL_REF_PR_NUMBER.test(text)).toBe(false);
    });
  });

  describe("GitHub URL pattern", () => {
    it.each([
      "https://github.com/org/repo/pull/504",
      "https://github.com/org/repo/issues/42",
      "see github.com/trycycloid/cycloid/pull/123 for details",
    ])("matches: %s", (text) => {
      expect(EXTERNAL_REF_GITHUB_URL.test(text)).toBe(true);
    });

    it.each([
      "https://github.com/org/repo",
      "https://github.com/org/repo/tree/main",
      "github.com/org/repo/blob/main/file.ts",
    ])("does NOT match: %s", (text) => {
      expect(EXTERNAL_REF_GITHUB_URL.test(text)).toBe(false);
    });
  });

  describe("accumulated text catches split references", () => {
    it("matches when reference is assembled from deltas", () => {
      const delta1 = "See PR ";
      const delta2 = "#504 for details";
      const accumulated = delta1 + delta2;
      expect(EXTERNAL_REF_PR_NUMBER.test(accumulated)).toBe(true);
    });
  });
});

describe("usedVerificationTools detection", () => {
  describe("gh verification commands", () => {
    it.each([
      "gh pr view 504",
      "gh pr view https://github.com/org/repo/pull/504",
      "gh pr diff 504",
      "gh pr diff https://github.com/org/repo/pull/504",
      "gh issue view 42",
      "gh issue view 42 -R owner/repo",
      "gh pr list --state merged",
      "gh issue list --label bug",
    ])("matches: %s", (cmd) => {
      expect(VERIFICATION_TOOL_CMD.test(cmd)).toBe(true);
    });

    it.each([
      "gh repo clone foo",
      "gh auth login",
      "gh pr create --title test",
      "gh pr merge 504",
      "gh pr close 504",
      "gh release create v1.0",
    ])("does NOT match: %s", (cmd) => {
      expect(VERIFICATION_TOOL_CMD.test(cmd)).toBe(false);
    });
  });
});
