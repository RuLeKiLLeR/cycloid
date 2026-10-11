import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/request-reviewer.yml", import.meta.url));

type Workflow = {
  jobs: {
    "request-reviewer": {
      steps: Array<{
        name?: string;
        uses?: string;
        with?: { script?: string };
      }>;
    };
  };
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function requestReviewerScript(): string {
  const step = loadWorkflow().jobs["request-reviewer"].steps.find((item) => item.name === "Request one reviewer");
  return step?.with?.script ?? "";
}

describe("request reviewer workflow", () => {
  it("selects a reviewer randomly instead of deriving the index from the PR number", () => {
    const script = requestReviewerScript();

    expect(script).not.toContain("(pullRequest.number - 1) %");
    expect(script).not.toMatch(/const\s+startIndex\s*=/);
    expect(script).toContain("Math.floor(Math.random() * eligibleReviewers.length)");
    expect(script).toContain(
      "const reviewer = eligibleReviewers[Math.floor(Math.random() * eligibleReviewers.length)]",
    );
  });

  it("preserves author exclusion and the no-eligible-reviewer early return", () => {
    const script = requestReviewerScript();

    expect(script).toContain("const author = pullRequest.user.login");
    expect(script).toContain("reviewers.filter((reviewer) => reviewer !== author)");
    expect(script).toContain("if (eligibleReviewers.length === 0)");
    expect(script).toContain("No eligible reviewers remain after excluding PR author");
    expect(script).toContain("return;");
  });

  it("keeps the existing-reviewer no-op and re-fetches live PR state before mutating", () => {
    const script = requestReviewerScript();

    expect(script).toContain("const existingReviewers = pullRequest.requested_reviewers ?? []");
    expect(script).toContain("const existingTeams = pullRequest.requested_teams ?? []");
    expect(script).toContain("if (existingReviewers.length > 0 || existingTeams.length > 0)");

    expect(script).toContain("const fresh = await github.rest.pulls.get");
    expect(script).toContain("pull_number: pullRequest.number");
    expect(script).toContain("const freshReviewers = fresh.data.requested_reviewers ?? []");
    expect(script).toContain("const freshTeams = fresh.data.requested_teams ?? []");
    expect(script).toContain("if (freshReviewers.length > 0 || freshTeams.length > 0)");

    const liveFetchIndex = script.indexOf("github.rest.pulls.get");
    const randomSelectionIndex = script.indexOf("Math.floor(Math.random() * eligibleReviewers.length)");
    const mutationIndex = script.indexOf("github.rest.pulls.requestReviewers");
    expect(liveFetchIndex).toBeGreaterThanOrEqual(0);
    expect(randomSelectionIndex).toBeGreaterThan(liveFetchIndex);
    expect(mutationIndex).toBeGreaterThan(randomSelectionIndex);
  });
});
