import { describe, expect, it } from "vitest";

import { buildPlanContextSection } from "../../apps/sandbox-bridge/src/constants/bridge";

const VALID_PLAN_EXCERPT = [
  "# Plan",
  "## Intent Restatement",
  "Fix the plan handoff.",
  "## Ordered Steps",
  "1. Patch the bridge branch.",
  "## Files To Touch",
  "- apps/sandbox-bridge/src/constants/bridge.ts",
].join("\n\n");

describe("buildPlanContextSection", () => {
  it("renders the execute-this blueprint for a valid plan excerpt", () => {
    const section = buildPlanContextSection({
      planPromptId: "p-1",
      valid: true,
      excerpt: VALID_PLAN_EXCERPT,
      artifactId: "artifact-1",
      missingReason: null,
    });

    expect(section).toContain("# Implementation plan — execute this");
    expect(section).toContain("A prior read-only planning pass already researched this task");
    expect(section).toContain("Treat the plan as your implementation blueprint.");
    expect(section).not.toContain("reviewed, edited, and approved by the user");
    expect(section).toContain("valid: true");
    expect(section).toContain('artifactId: "artifact-1"');
    expect(section).toContain("## Files To Touch");
  });

  it("renders a user-edited valid plan as the authoritative blueprint", () => {
    const section = buildPlanContextSection({
      planPromptId: "p-2",
      valid: true,
      excerpt: VALID_PLAN_EXCERPT,
      artifactId: null,
      missingReason: null,
      revision: 2,
      userEdited: true,
    });

    expect(section).toContain("reviewed, edited, and approved by the user");
    expect(section).toContain("authoritative implementation blueprint");
  });

  it("falls back to plan-less guidance for an invalid excerpt while still surfacing the notes", () => {
    const section = buildPlanContextSection({
      planPromptId: "p-1",
      valid: false,
      excerpt: "## Ordered Steps\n\n1. Partial streamed note.",
      artifactId: null,
      missingReason: "plan_prompt_failed",
    });

    expect(section).toContain("# Implementation plan");
    expect(section).not.toContain("# Implementation plan — execute this");
    expect(section).toContain("Proceed from the original user request.");
    expect(section).toContain("not an implementation blueprint");
    expect(section).toContain("valid: false");
    expect(section).toContain('missingReason: "plan_prompt_failed"');
    expect(section).toContain("Partial streamed note.");
  });

  it("preserves the empty-excerpt fallback for legacy plan context", () => {
    expect(
      buildPlanContextSection({
        planPromptId: "p-1",
        valid: true,
        excerpt: "   ",
        artifactId: null,
        missingReason: "missing_final_response",
      }),
    ).toBe(
      [
        "# Implementation plan",
        "A read-only planning pass ran first but produced no usable plan (see missingReason). Proceed from the original user request.",
        'planPromptId: "p-1"\nvalid: true\nartifactId: null\nmissingReason: "missing_final_response"',
      ].join("\n\n"),
    );
  });
});
