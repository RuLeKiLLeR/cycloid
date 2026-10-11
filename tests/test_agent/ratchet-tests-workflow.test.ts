import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/ratchet-tests.yml");

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
    "ratchet-tests": {
      "runs-on": string;
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

describe("ratchet tests workflow", () => {
  it("keeps a single always-running required `ratchet-tests` job", () => {
    const workflow = loadWorkflow();

    expect(workflow.jobs["ratchet-tests"]).toBeDefined();
    expect(Object.keys(workflow.jobs)).toEqual(["ratchet-tests"]);
    expect(workflow.on?.pull_request?.paths).toBeUndefined();
  });

  it("fails closed during detection and reports a green skip when irrelevant", () => {
    const job = loadWorkflow().jobs["ratchet-tests"];

    const detectStep = job.steps.find((step) => step.name === "Detect ratchet-relevant changes");
    expect(detectStep).toBeDefined();
    expect(detectStep?.if).toBeUndefined();
    expect(detectStep?.uses).toBe("actions/github-script@v9");

    const skipStep = job.steps.find((step) => step.name === "Skip ratchet tests when irrelevant");
    expect(skipStep?.if).toContain("steps.changes.outputs.ratchet_changed != 'true'");

    const source = loadWorkflowSource();
    expect(source).toContain("fileListTruncated");
    expect(source).toContain("Running ratchet tests because this PR changed:");
  });

  it("checks previous filenames so renames out of covered paths still run ratchets", () => {
    const source = loadWorkflowSource();

    expect(source).toContain("file.previous_filename");
    expect(source).toContain("[file.filename, file.previous_filename]");
  });

  it("runs the uncovered Cloudflare ratchets and this workflow guard", () => {
    const runStep = loadWorkflow().jobs["ratchet-tests"].steps.find((step) => step.name === "Run ratchet tests");

    expect(runStep).toBeDefined();
    expect(runStep?.if).toContain("steps.changes.outputs.ratchet_changed == 'true'");
    expect(runStep?.run).toContain("tests/test_cloudflare/migration-integrity.test.ts");
    expect(runStep?.run).toContain("tests/test_cloudflare/schema-validation.test.ts");
    expect(runStep?.run).toContain("tests/test_agent/ratchet-tests-workflow.test.ts");
    expect(runStep?.run).toContain("--maxWorkers=2");
  });

  it("detects every source tree scanned by the ratchet tests plus self-edits", () => {
    const source = loadWorkflowSource();

    expect(source).toContain("apps\\/control-plane-worker\\/(migrations\\/|src\\/)");
    expect(source).toContain("drizzle\\/");
    expect(source).toContain("tests\\/test_cloudflare\\/(migration-integrity|schema-validation)\\.test\\.ts$");
    expect(source).toContain("tests\\/test_agent\\/ratchet-tests-workflow\\.test\\.ts$");
    expect(source).toContain("\\.github\\/workflows\\/ratchet-tests\\.yml$");
  });
});
