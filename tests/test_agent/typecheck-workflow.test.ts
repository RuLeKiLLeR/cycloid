import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/typecheck.yml");
const ROOT_PACKAGE = resolve("package.json");

type Step = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
};

type Workflow = {
  on?: {
    pull_request?: {
      paths?: string[];
    };
  };
  jobs: {
    typecheck: {
      name?: string;
      steps: Step[];
    };
  };
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function loadWorkflowSource(): string {
  return readFileSync(WORKFLOW, "utf-8");
}

function rootTypecheckLabels(): string[] {
  const packageJson = JSON.parse(readFileSync(ROOT_PACKAGE, "utf-8")) as {
    scripts: { typecheck: string };
  };
  const match = packageJson.scripts.typecheck.match(/-n ([^ ]+)/);
  expect(match).not.toBeNull();
  return match?.[1]?.split(",") ?? [];
}

function ciTypecheckLabels(): string[] {
  const typecheckStep = loadWorkflow().jobs.typecheck.steps.find((step) => step.name === "Typecheck all targets");
  expect(typecheckStep).toBeDefined();

  return Array.from(typecheckStep?.run?.matchAll(/run_target ([^ ]+) /g) ?? [], (match) => match[1]);
}

describe("typecheck workflow", () => {
  it("keeps the required typecheck job always present", () => {
    const workflow = loadWorkflow();

    expect(workflow.jobs.typecheck.name).toBe("typecheck");
    expect(workflow.on?.pull_request?.paths).toBeUndefined();

    const detectStep = workflow.jobs.typecheck.steps.find((step) => step.name === "Detect typecheck-relevant changes");
    expect(detectStep).toBeDefined();
    expect(detectStep?.uses).toBe("actions/github-script@v9");
    expect(detectStep?.if).toBeUndefined();

    const skipStep = workflow.jobs.typecheck.steps.find((step) => step.name === "Skip typecheck when irrelevant");
    expect(skipStep?.if).toContain("steps.changes.outputs.typecheck_changed != 'true'");
  });

  it("keeps CI typecheck targets in parity with the root typecheck script", () => {
    expect(ciTypecheckLabels()).toEqual(rootTypecheckLabels());
  });

  it("detects every typecheck input class and fails closed on truncated PR file lists", () => {
    const source = loadWorkflowSource();

    expect(source).toContain("file.previous_filename");
    expect(source).toContain("fileListTruncated");
    expect(source).toContain("\\.github\\/workflows\\/");
    expect(source).toContain("apps\\/.*\\.(ts|tsx)$");
    expect(source).toContain("tools\\/.*\\.(ts|tsx)$");
    expect(source).toContain("shared\\/.*\\.(ts|tsx)$");
    expect(source).toContain("scripts\\/.*\\.(ts|tsx|mts|cts|js|mjs|cjs)$");
    expect(source).toContain("tests\\/(?!(test_sandbox-bridge|test_cloudflare|test_status-worker|smoke)\\/)");
    expect(source).toContain("tsconfig(\\..+)?\\.json$");
    expect(source).toContain("package\\.json$");
    expect(source).toContain("package-lock\\.json$");
  });
});
