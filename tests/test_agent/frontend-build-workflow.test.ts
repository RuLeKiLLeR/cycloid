import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/frontend-build.yml");

type Step = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
};

type Workflow = {
  jobs: {
    build: {
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

describe("frontend build workflow", () => {
  it("force-runs the frontend architecture audit, gated on ui_changed", () => {
    const auditStep = loadWorkflow().jobs.build.steps.find(
      (step) => step.name === "Run UI tests and frontend architecture audit",
    );

    // The audit is a filesystem scanner with no import edge, so vitest --changed
    // never selects it. It must run explicitly here on every ui-relevant PR.
    expect(auditStep).toBeDefined();
    expect(auditStep?.run).toContain("tests/test_ui");
    expect(auditStep?.run).toContain("tests/test_scripts/frontend-audit.test.ts");
    // The step must also run THIS guard test; otherwise a PR removing the audit
    // step would never run the guard and pass the required checks silently.
    expect(auditStep?.run).toContain("tests/test_agent/frontend-build-workflow.test.ts");
    expect(auditStep?.if).toContain("steps.changes.outputs.ui_changed == 'true'");
  });

  it("treats the audit scanner, its test, this guard test, and the scanned roots as ui-relevant", () => {
    const source = loadWorkflowSource();

    // The detector must trip for the paths the audit scans (so drift is caught
    // on the PR) and for edits to the auditor/tests themselves (so a self-edit is
    // gated rather than silently skipped).
    expect(source).toContain("apps\\/ui\\/");
    expect(source).toContain("apps\\/control-plane-worker\\/");
    expect(source).toContain("scripts\\/frontend-audit\\/");
    expect(source).toContain("tests\\/test_scripts\\/frontend-audit\\.test\\.ts$");
    expect(source).toContain("tests\\/test_agent\\/frontend-build-workflow\\.test\\.ts$");
  });

  it("keeps a single always-running required `build` job that reports without running the suite when irrelevant", () => {
    const buildJob = loadWorkflow().jobs.build;
    expect(buildJob).toBeDefined();

    // The detection step runs before any gate and has no `if`, so a
    // github-script/API error fails the whole job (required check goes red)
    // instead of passing open.
    const detectStep = buildJob.steps.find((step) => step.name === "Detect UI-relevant changes");
    expect(detectStep).toBeDefined();
    expect(detectStep?.if).toBeUndefined();

    // A skip path keeps the required check green when no UI files changed.
    const skipStep = buildJob.steps.find((step) => step.name === "Skip UI tests when irrelevant");
    expect(skipStep?.if).toContain("steps.changes.outputs.ui_changed != 'true'");

    // A truncated PR file list forces the UI build (fail closed).
    expect(loadWorkflowSource()).toContain("fileListTruncated");
  });

  it("invalidates the node_modules cache when package manifests change", () => {
    const cacheStep = loadWorkflow().jobs.build.steps.find((step) => step.name === "Cache node_modules");

    expect(cacheStep).toBeDefined();
    expect(cacheStep?.uses).toBe("actions/cache@v6");
    expect(loadWorkflowSource()).toContain("hashFiles('package-lock.json', 'package.json', 'apps/*/package.json')");
  });

  it("runs unauthenticated exposure checks in strict asset mode", () => {
    const exposureStep = loadWorkflow().jobs.build.steps.find(
      (step) => step.name === "Run unauthenticated exposure static checks",
    );

    expect(exposureStep).toBeDefined();
    expect(exposureStep?.if).toContain("steps.changes.outputs.ui_changed == 'true'");
    expect(exposureStep?.run).toContain("--strict-assets");
  });
});
