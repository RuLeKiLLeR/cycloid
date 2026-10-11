// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { buildPrTemplateFillInput } from "../../apps/sandbox-bridge/src/services/post-execution/post-execution-runner.js";
import { DEFAULT_PR_SUMMARY_FILL_TEMPLATE } from "../../apps/sandbox-bridge/src/services/pr.js";

function evidence(overrides = {}) {
  return {
    changedFiles: ["a.ts"],
    diffStats: { filesChanged: 1, insertions: 1, deletions: 0 },
    commandsRun: [
      { command: "eslint a.ts", status: "completed", source: "post_execution", check: "lint", hasOutput: true },
      { command: "vitest", status: "error", source: "post_execution", check: "tests", hasOutput: true },
    ],
    checksDetected: { tests: true, lint: true, typecheck: false },
    skippedChecks: [],
    filesMentionedInFinalAnswer: [],
    evidenceBundle: { originalPrompt: "Do the thing.", agentFinalMessage: "Did the thing." },
    ...overrides,
  };
}

describe("buildPrTemplateFillInput", () => {
  it("maps headings, commands, narrative, task, and seam fields without raw urls", () => {
    const out = buildPrTemplateFillInput({
      templateContent: "## Description\n\n## Testing\n",
      evidence: evidence(),
      diffSummary: "1 file changed",
    });
    expect(out.headings).toEqual(["Description", "Testing"]);
    // The fill input deliberately carries no verdict: verdicts live in the
    // managed Cycloid QA comment, never the PR body.
    expect("verdict" in out).toBe(false);
    expect(out.commands).toEqual([
      { label: "lint", command: "eslint a.ts", status: "passed" },
      { label: "tests", command: "vitest", status: "failed" },
    ]);
    expect(out.narrative).toContain("Did the thing.");
    expect(out.taskPrompt).toBe("Do the thing.");
    expect(out.diffSizeBand).toBe("small");
    expect(out.instructions).toBeNull();
    expect(out.factPlacement).toBe("body");
    expect("evidenceUrls" in out).toBe(false);
  });

  it("fails closed on over-cap headings while capping commands and text fields", () => {
    const manyHeadings = Array.from({ length: 40 }, (_, i) => `## H${i}`).join("\n\n");
    const out = buildPrTemplateFillInput({
      templateContent: manyHeadings,
      evidence: evidence({
        commandsRun: Array.from({ length: 20 }, (_, i) => ({
          command: `eslint file${i}.ts`,
          status: "completed",
          source: "post_execution",
          check: "lint",
          hasOutput: true,
        })),
        evidenceBundle: { originalPrompt: "z".repeat(10_000), agentFinalMessage: "x".repeat(20_000) },
      }),
      diffSummary: "y".repeat(20_000),
    });
    expect(out.headings).toEqual([]);
    expect(out.commands.length).toBeLessThanOrEqual(12);
    expect(out.narrative.length).toBeLessThanOrEqual(8_000);
    expect(out.diffSummary.length).toBeLessThanOrEqual(4_000);
    expect(out.taskPrompt.length).toBeLessThanOrEqual(4_000);
    expect(out.diffSizeBand).toBe("small");
  });

  it("bands larger diffs for follow-on length adaptation", () => {
    expect(
      buildPrTemplateFillInput({
        templateContent: "## Summary\n",
        evidence: evidence({ diffStats: { filesChanged: 4, insertions: 300, deletions: 100 } }),
        diffSummary: "",
      }).diffSizeBand,
    ).toBe("medium");
    expect(
      buildPrTemplateFillInput({
        templateContent: "## Summary\n",
        evidence: evidence({ diffStats: { filesChanged: 10, insertions: 700, deletions: 200 } }),
        diffSummary: "",
      }).diffSizeBand,
    ).toBe("large");
  });

  it("excludes implementation-session commands from verification fill input", () => {
    const out = buildPrTemplateFillInput({
      templateContent: "## Testing\n",
      evidence: evidence({
        commandsRun: [
          { command: 'rg "buildPrTemplateFillInput" .', status: "completed", source: "agent", hasOutput: true },
          { command: "find . -name package.json", status: "completed", source: "agent", hasOutput: true },
          { command: "ls apps/sandbox-bridge", status: "completed", source: "agent", hasOutput: true },
          {
            command: "sed -n '1,80p' apps/sandbox-bridge/src/services/pr.ts",
            status: "completed",
            source: "agent",
            hasOutput: true,
          },
          { command: "test -f package.json", status: "completed", source: "agent", hasOutput: false },
          {
            command: "npm run -w @cycloid/sandbox-bridge typecheck",
            status: "completed",
            exitCode: 0,
            source: "agent",
            check: "typecheck",
            hasOutput: true,
          },
        ],
      }),
      diffSummary: "",
    });

    expect(out.commands).toEqual([]);
  });

  it("maps a completed command with a non-zero exit code to failed", () => {
    const out = buildPrTemplateFillInput({
      templateContent: "## Testing\n",
      evidence: evidence({
        commandsRun: [
          {
            command: "pytest",
            status: "completed",
            exitCode: 1,
            source: "post_execution",
            check: "tests",
            hasOutput: true,
          },
          {
            command: "eslint",
            status: "completed",
            exitCode: 0,
            source: "post_execution",
            check: "lint",
            hasOutput: true,
          },
        ],
      }),
      diffSummary: "",
    });
    expect(out.commands).toEqual([
      { label: "tests", command: "pytest", status: "failed" },
      { label: "lint", command: "eslint", status: "passed" },
    ]);
  });

  it("sets optional customer style instructions when provided", () => {
    const out = buildPrTemplateFillInput({
      templateContent: DEFAULT_PR_SUMMARY_FILL_TEMPLATE.content,
      evidence: evidence(),
      diffSummary: "",
      instructions: "Two sentences, plain language.",
    });

    expect(out.instructions).toBe("Two sentences, plain language.");
  });
});
