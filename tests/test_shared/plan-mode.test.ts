import { describe, expect, it } from "vitest";

import {
  buildPlanContext,
  countPlanFilesToTouch,
  isPlanContextExcerptTruncated,
  normalizePlanModeSetting,
  summarizePlanModeResearchReuse,
  validatePlanMarkdown,
} from "../../shared/plan-mode";

const VALID_PLAN = [
  "# Plan",
  "## Intent Restatement",
  "Do the requested work.",
  "## Scope In/Out",
  "In scope: worker code. Out of scope: UI.",
  "## Approach",
  "Patch the narrow path.",
  "## Ordered Steps",
  "1. Read code.",
  "2. Patch code.",
  "## Files To Touch",
  "- apps/control-plane-worker/src/session/prompt-queue.ts",
  "## Verification Plan",
  "- Run focused tests.",
  "## Risks",
  "- Queue ordering regression.",
  "## Breadth",
  "S because it is a narrow queue change.",
  "## Open Assumptions",
  "- Existing queue ordering is authoritative.",
].join("\n\n");

const COMPACT_PLAN = [
  "# Plan",
  "## Intent Restatement",
  "Add a short troubleshooting note.",
  "## Ordered Steps",
  "1. Read the README.",
  "2. Add the note.",
  "## Files To Touch",
  "- README.md",
].join("\n\n");

describe("plan mode contract", () => {
  it("normalizes only exact enum settings", () => {
    expect([
      normalizePlanModeSetting(true as unknown as string),
      normalizePlanModeSetting(false as unknown as string),
      normalizePlanModeSetting("off"),
      normalizePlanModeSetting("on"),
      normalizePlanModeSetting("auto"),
      normalizePlanModeSetting("AUTO"),
      normalizePlanModeSetting("yes"),
      normalizePlanModeSetting(undefined),
    ]).toEqual([undefined, undefined, "off", "on", "auto", undefined, undefined, undefined]);
  });

  it("validates the required plan headings", () => {
    expect(validatePlanMarkdown(VALID_PLAN)).toEqual({ valid: true, missingHeadings: [] });
  });

  it("validates a compact low-risk plan", () => {
    expect(validatePlanMarkdown(COMPACT_PLAN)).toEqual({ valid: true, missingHeadings: [] });
  });

  it("reports missing headings", () => {
    expect(validatePlanMarkdown("# Plan\n\n## Approach\nDo it.")).toMatchObject({
      valid: false,
      reason: "missing_required_headings",
      missingHeadings: expect.arrayContaining(["intent restatement", "ordered steps", "files to touch"]),
    });
  });

  it("builds bounded implementation context with artifact metadata", () => {
    const context = buildPlanContext({
      markdown: VALID_PLAN,
      artifactId: "artifact-1",
      planPromptId: "p-1",
      valid: true,
    });

    expect(context).toMatchObject({
      planPromptId: "p-1",
      valid: true,
      artifactId: "artifact-1",
      missingReason: null,
    });
    expect(context.excerpt).toContain("## Verification Plan");
    expect(context).not.toHaveProperty("revision");
    expect(context).not.toHaveProperty("userEdited");
  });

  it("passes plan revision and user-edited metadata through without changing the excerpt", () => {
    const context = buildPlanContext({
      markdown: VALID_PLAN,
      artifactId: "artifact-2",
      planPromptId: "p-2",
      valid: true,
      revision: 2,
      userEdited: true,
    });

    expect(context).toMatchObject({
      planPromptId: "p-2",
      revision: 2,
      userEdited: true,
      excerpt: VALID_PLAN,
    });
  });

  it("counts files-to-touch entries from the carried plan excerpt", () => {
    expect(countPlanFilesToTouch(VALID_PLAN)).toBe(1);
    expect(
      countPlanFilesToTouch(
        [
          "# Plan",
          "## Intent Restatement",
          "Do the work.",
          "## Ordered Steps",
          "1. Step.",
          "## Files To Touch",
          "- apps/control-plane-worker/src/session/prompt-queue.ts",
          "1. infra/datadog-agent-behavior.tf",
          "Notes are ignored.",
          "## Verification Plan",
          "- Run tests.",
        ].join("\n"),
      ),
    ).toBe(2);
  });

  it("detects truncated plan excerpts", () => {
    expect(isPlanContextExcerptTruncated("## Files To Touch\n- README.md")).toBe(false);
    expect(isPlanContextExcerptTruncated("## Files To Touch\n- README.md\n\n[plan excerpt truncated]")).toBe(true);
  });

  it("separates implementation discovery ops from file-read ops", () => {
    expect(
      summarizePlanModeResearchReuse([
        { type: "tool_call", tool: "bash", input: { command: 'rg -n "PlanContext" shared apps' } },
        { type: "tool_call", tool: "bash", input: { command: "sed -n '1,120p' shared/plan-mode.ts" } },
        { type: "tool_call", tool: "bash", input: { command: "awk 'NR>=10 && NR<=80' shared/plan-mode.ts" } },
        { type: "tool_call", tool: "bash", input: { command: "jq '.scripts' package.json" } },
        { type: "tool_call", tool: "read", input: { filePath: "shared/plan-mode.ts" } },
        { type: "tool_call", tool: "bash", input: { command: "npm test" } },
      ]),
    ).toEqual({ discoveryOps: 1, readOps: 4 });
  });

  it("does not count errored, denied, or in-flight tool calls as successful research work", () => {
    expect(
      summarizePlanModeResearchReuse([
        { type: "tool_call", tool: "bash", status: "error", input: { command: "rg terminal-error" } },
        { type: "tool_call", tool: "bash", toolStatus: "error", input: { command: "rg denied" } },
        { type: "tool_call", tool: "bash", data: { toolStatus: "error" }, input: { command: "cat denied.txt" } },
        { type: "tool_call", tool: "bash", toolStatus: "running", input: { command: "rg still-running" } },
        { type: "tool_call", tool: "bash", toolStatus: "completed", input: { command: "find . -name '*.ts'" } },
      ]),
    ).toEqual({ discoveryOps: 1, readOps: 0 });
  });
});
