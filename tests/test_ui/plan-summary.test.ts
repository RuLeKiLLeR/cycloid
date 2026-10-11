import { describe, expect, it } from "vitest";

import { extractPlanMarkdown, isPlanText, parsePlanSummary } from "../../apps/ui/src/utils/plan-summary";

const PLAN = [
  "# Plan",
  "",
  "## Intent Restatement",
  "Add a Running tests note to README.md. It should be short and clear.",
  "",
  "## Scope In/Out",
  "In scope: README only.",
  "",
  "## Approach",
  "Reuse existing commands.",
  "",
  "## Breadth",
  "XS. One-file documentation addition.",
].join("\n");

const COMPACT_PLAN = [
  "# Plan",
  "",
  "## Intent Restatement",
  "Add a short troubleshooting note to README.md.",
  "",
  "## Ordered Steps",
  "1. Read the README.",
  "2. Add the note.",
  "",
  "## Files To Touch",
  "- README.md",
].join("\n");

describe("isPlanText", () => {
  it("detects a `# Plan` document", () => {
    expect(isPlanText(PLAN)).toBe(true);
    expect(isPlanText("\n\n# Plan\n...")).toBe(true);
    expect(isPlanText("#  Plan for the feature\n...")).toBe(true);
  });

  it("tolerates a short prose preamble before the `# Plan` heading", () => {
    expect(isPlanText("I have enough context to lock the plan.\n\n# Plan\n\n## Intent\nDo it.")).toBe(true);
  });

  it("does not match normal replies or lookalike headings", () => {
    expect(isPlanText("Sure, here is the fix.")).toBe(false);
    expect(isPlanText("# Planning notes\ncontent")).toBe(false);
    expect(isPlanText("## Plan\ncontent")).toBe(false); // subsection, not the plan H1
    expect(isPlanText("Here is the # Plan inline")).toBe(false);
    expect(isPlanText("## Summary\nfirst heading is not Plan\n\n# Plan")).toBe(false);
  });
});

describe("extractPlanMarkdown", () => {
  it("strips a preamble before `# Plan`", () => {
    const raw = "I have enough context.\n\n# Plan\n\n## Intent\nDo it.";
    expect(extractPlanMarkdown(raw)).toBe("# Plan\n\n## Intent\nDo it.");
  });

  it("returns the text unchanged when it already starts with `# Plan`", () => {
    expect(extractPlanMarkdown(PLAN)).toBe(PLAN);
  });
});

describe("parsePlanSummary", () => {
  it("derives title, breadth, and section count", () => {
    const summary = parsePlanSummary(PLAN);
    expect(summary.title).toBe("Add a Running tests note to README.md.");
    expect(summary.breadth).toBe("XS");
    expect(summary.sectionCount).toBe(4);
  });

  it("degrades gracefully when sections are missing", () => {
    const summary = parsePlanSummary("# Plan\n\nJust a paragraph with no sections.");
    expect(summary.breadth).toBeNull();
    expect(summary.sectionCount).toBe(0);
    expect(summary.title).toBe("Just a paragraph with no sections.");
  });

  it("summarizes compact plans without a breadth chip", () => {
    const summary = parsePlanSummary(COMPACT_PLAN);
    expect(summary.title).toBe("Add a short troubleshooting note to README.md.");
    expect(summary.breadth).toBeNull();
    expect(summary.sectionCount).toBe(3);
  });

  it("ignores a preamble before the plan when deriving the summary", () => {
    const summary = parsePlanSummary(`I have enough context to lock the plan.\n\n${PLAN}`);
    expect(summary.title).toBe("Add a Running tests note to README.md.");
    expect(summary.breadth).toBe("XS");
    expect(summary.sectionCount).toBe(4);
  });
});
