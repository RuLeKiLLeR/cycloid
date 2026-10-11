import { describe, expect, it } from "vitest";

import { PrReviewPublishBodySchema } from "../../apps/control-plane-worker/src/session/pr-review-publish-schema";

const finding = {
  path: "src/index.ts",
  line: 12,
  side: "RIGHT",
  severity: "P2",
  title: "Handle missing value",
  bodyMarkdown: "When input is empty, this returns the wrong state.",
};

const payload = {
  summaryMarkdown: "## Summary",
  verdict: "issues_found",
  checks: [
    { command: "", reason: "No checks configured", status: "skipped", exitCode: null, detail: "No checks configured" },
  ],
  scopeNotVerified: ["Browser and runtime behavior are not verified."],
  confidenceScore: 4,
  importantFiles: [],
  findings: [finding],
  headSha: "a".repeat(40),
};

describe("PrReviewPublishBodySchema", () => {
  it("accepts optional per-finding confidence for deploy skew", () => {
    expect(PrReviewPublishBodySchema.safeParse(payload).success).toBe(true);
    expect(
      PrReviewPublishBodySchema.safeParse({
        ...payload,
        findings: [{ ...finding, confidence: 3 }],
      }).success,
    ).toBe(true);
  });

  it("rejects out-of-range per-finding confidence", () => {
    expect(
      PrReviewPublishBodySchema.safeParse({
        ...payload,
        findings: [{ ...finding, confidence: 0 }],
      }).success,
    ).toBe(false);
  });

  it("keeps finding payloads strict", () => {
    expect(
      PrReviewPublishBodySchema.safeParse({
        ...payload,
        findings: [{ ...finding, extra: true }],
      }).success,
    ).toBe(false);
  });

  it("accepts bounded suggestions, security badges, and context citations", () => {
    expect(
      PrReviewPublishBodySchema.safeParse({
        ...payload,
        findings: [{ ...finding, security: true, suggestion: "return fallback;", citations: ["AGENTS.md"] }],
      }).success,
    ).toBe(true);
    expect(
      PrReviewPublishBodySchema.safeParse({
        ...payload,
        findings: [{ ...finding, citations: Array.from({ length: 6 }, () => "AGENTS.md") }],
      }).success,
    ).toBe(false);
    expect(
      PrReviewPublishBodySchema.safeParse({
        ...payload,
        findings: [{ ...finding, suggestion: "first line\nsecond line" }],
      }).success,
    ).toBe(false);
  });
});
