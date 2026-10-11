import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/backend-tests.yml");

type Step = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  with?: {
    script?: string;
  };
};

type Workflow = {
  on?: {
    pull_request?: {
      paths?: string[];
      "paths-ignore"?: string[];
    };
  };
  jobs: {
    test: {
      "runs-on": string;
      needs?: string[];
      if?: string;
      steps: Step[];
    };
    "test-shard-1": {
      "runs-on": string;
      steps: Step[];
    };
    "test-shard-2": {
      "runs-on": string;
      steps: Step[];
    };
    workerd: {
      "runs-on": string;
      steps: Step[];
    };
  };
};

type ChangedFile = {
  filename: string;
  previous_filename?: string;
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function loadWorkflowSource(): string {
  return readFileSync(WORKFLOW, "utf-8");
}

function getDetectorScript(job: Workflow["jobs"][keyof Workflow["jobs"]]): string {
  const detectStep = job.steps.find((step) => step.name === "Detect backend-relevant changes");
  expect(detectStep?.with?.script).toBeDefined();
  return detectStep?.with?.script ?? "";
}

function extractRegex(script: string, name: string): RegExp {
  const match = script.match(new RegExp(`const ${name}\\s*=\\s*(/.+/);`));
  expect(match?.[1], `Expected ${name} literal in detector script`).toBeDefined();
  return new Function(`return ${match?.[1]};`)() as RegExp;
}

function backendChangedFor(script: string, files: ChangedFile[], reportedChangedFiles = files.length): boolean {
  const changedFiles = files.flatMap((file) =>
    file.previous_filename ? [file.filename, file.previous_filename] : [file.filename],
  );
  const fileListTruncated = Number.isInteger(reportedChangedFiles) && reportedChangedFiles > files.length;
  const backendPattern = extractRegex(script, "backendPattern");
  const nonBackendTestsPattern = extractRegex(script, "nonBackendTestsPattern");

  return (
    fileListTruncated || changedFiles.some((file) => backendPattern.test(file) && !nonBackendTestsPattern.test(file))
  );
}

describe("backend test workflow", () => {
  it("runs the full backend suite in two shards gated on backend_changed, never an affected subset", () => {
    const workflow = loadWorkflow();
    const testShard1 = workflow.jobs["test-shard-1"];
    const testShard2 = workflow.jobs["test-shard-2"];
    const shard1Step = testShard1.steps.find((step) => step.name === "Run backend test shard 1");
    const shard2Step = testShard2.steps.find((step) => step.name === "Run backend test shard 2");

    // The affected-subset path is gone: every backend-relevant PR runs the whole
    // suite, so a regression the PR's import graph missed cannot merge green.
    expect(testShard1.steps.find((step) => step.name === "Run affected backend tests")).toBeUndefined();
    expect(testShard2.steps.find((step) => step.name === "Run affected backend tests")).toBeUndefined();

    // No run step may use the affected-subset flags or the PR base sha (checked
    // on step commands, not raw source, so the explanatory header comment that
    // names the retired `--changed` strategy does not trip the assertion).
    for (const step of [...testShard1.steps, ...testShard2.steps]) {
      expect(step.run ?? "").not.toContain("--changed");
      expect(step.run ?? "").not.toContain("github.event.pull_request.base.sha");
    }
    // The run_full output branch is removed; backend_changed alone gates the run.
    expect(loadWorkflowSource()).not.toContain("run_full");

    // Full path: complete suite, gated only on backend_changed so it shares the
    // checkout/setup/cache gate and never runs on a bare runner.
    expect(shard1Step?.run).toContain('--exclude "tests/test_ui/**"');
    expect(shard2Step?.run).toContain('--exclude "tests/test_ui/**"');
    expect(shard1Step?.if).toContain("steps.changes.outputs.backend_changed == 'true'");
    expect(shard2Step?.if).toContain("steps.changes.outputs.backend_changed == 'true'");

    // Internal parallelism stays 1:1 with each 4-core arm64 runner. The two
    // shards preserve full-suite coverage while avoiding the unavailable
    // arm-8core runner label.
    expect(testShard1["runs-on"]).toBe("arm-4core");
    expect(testShard2["runs-on"]).toBe("arm-4core");
    expect(shard1Step?.run).toContain("--shard=1/2");
    expect(shard2Step?.run).toContain("--shard=2/2");
    expect(shard1Step?.run).toContain("--maxWorkers=4");
    expect(shard2Step?.run).toContain("--maxWorkers=4");
  });

  it("runs the full suite on push to main as the post-merge backstop", () => {
    const workflowSource = loadWorkflowSource();
    // The PR-only trigger would leave affected-graph misses uncaught; a
    // push-to-main trigger runs the full suite after merge as the safety net.
    expect(workflowSource).toContain("push:");
    expect(workflowSource).toContain('context.eventName !== "pull_request"');
  });

  it("keeps backend detection identical for test and workerd jobs", () => {
    const workflow = loadWorkflow();

    expect(getDetectorScript(workflow.jobs["test-shard-2"])).toBe(getDetectorScript(workflow.jobs["test-shard-1"]));
    expect(getDetectorScript(workflow.jobs.workerd)).toBe(getDetectorScript(workflow.jobs["test-shard-1"]));
  });

  it("matches backend detection to the tests the backend suite executes", () => {
    const workflow = loadWorkflow();
    const detectorScript = getDetectorScript(workflow.jobs["test-shard-1"]);

    expect(
      backendChangedFor(detectorScript, [{ filename: "tests/test_scripts/control-plane-bundle-hash.test.ts" }]),
    ).toBe(true);
    expect(backendChangedFor(detectorScript, [{ filename: "tests/test_ui/session-list.test.ts" }])).toBe(false);
    expect(
      backendChangedFor(detectorScript, [
        {
          filename: "docs/old-worker-code.md",
          previous_filename: "apps/control-plane-worker/src/router.ts",
        },
      ]),
    ).toBe(true);
    expect(backendChangedFor(detectorScript, [{ filename: "tools/linear/client.ts" }])).toBe(true);
    expect(backendChangedFor(detectorScript, [{ filename: "tools.toml" }])).toBe(true);
  });

  it("keeps required workerd coverage from becoming required-but-skipped", () => {
    const workflow = loadWorkflow();
    const detectorScript = getDetectorScript(workflow.jobs["test-shard-1"]);

    const requiredWorkerdPaths = [
      "tests/test_workerd/d1-session.test.ts",
      "apps/control-plane-worker/migrations/0252_example.sql",
      "apps/control-plane-worker/src/session/service.ts",
      "shared/utils/errors.ts",
      ".github/workflows/backend-tests.yml",
    ];

    for (const filename of requiredWorkerdPaths) {
      expect(backendChangedFor(detectorScript, [{ filename }]), filename).toBe(true);
    }
  });

  it("detects truncated PR file lists before expanding renamed paths", () => {
    const workflow = loadWorkflow();
    const detectorScript = getDetectorScript(workflow.jobs["test-shard-1"]);

    expect(
      backendChangedFor(
        detectorScript,
        [
          {
            filename: "apps/ui/src/App.tsx",
            previous_filename: "apps/ui/src/OldApp.tsx",
          },
        ],
        2,
      ),
    ).toBe(true);
  });

  it("always reports required contexts instead of leaving them pending", () => {
    const workflow = loadWorkflow();

    expect(workflow.on?.pull_request?.paths).toBeUndefined();
    expect(workflow.on?.pull_request?.["paths-ignore"]).toBeUndefined();
    expect(backendChangedFor(getDetectorScript(workflow.jobs.workerd), [{ filename: "apps/ui/src/App.tsx" }])).toBe(
      false,
    );
  });

  it("does not evict or cancel push-to-main backstop runs on rapid merges", () => {
    const workflow = parse(loadWorkflowSource()) as {
      concurrency: { group: string; "cancel-in-progress": string };
    };
    // The concurrency group must key push runs on github.sha, not github.ref.
    // A shared github.ref group makes every main commit collide, so rapid merges
    // evict each other's pending full-suite runs (the eviction bug). Per-commit
    // grouping gives each merge its own run to completion.
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number || github.sha");
    expect(workflow.concurrency.group).not.toContain("github.event.pull_request.number || github.ref");

    // cancel-in-progress must stay scoped to pull_request runs only. A flat
    // `true` would cancel an in-progress push-to-main run.
    expect(String(workflow.concurrency["cancel-in-progress"])).toContain("github.event_name == 'pull_request'");
  });

  it("treats root instructions and docs guarded by backend parity tests as backend-relevant", () => {
    const workflowSource = loadWorkflowSource();

    expect(workflowSource).toContain("AGENTS\\.md$");
    expect(workflowSource).toContain("CLAUDE\\.md$");
    expect(workflowSource).toContain("agents\\.md$");
    expect(workflowSource).toContain("docs\\/");
    expect(workflowSource).not.toContain("evals");
  });

  it("runs workflow guard tests when guarded workflow files change", () => {
    const workflowSource = loadWorkflowSource();

    expect(workflowSource).toContain("\\.github\\/workflows\\/(backend-tests|request-reviewer)\\.yml$");
  });

  it("keeps a single always-running required `test` job that fails closed on detection failure", () => {
    const workflow = loadWorkflow();
    const testJob = workflow.jobs.test;
    const testShard1 = workflow.jobs["test-shard-1"];
    const testShard2 = workflow.jobs["test-shard-2"];

    // The required ruleset check is named `test`; the shard jobs are internal
    // fan-out and the aggregate job preserves the required context.
    expect(testJob).toBeDefined();
    expect(testJob.needs).toEqual(["test-shard-1", "test-shard-2"]);
    expect(testJob.if).toBe("always()");

    // The detection step runs before any gate and has no `if` guard on each
    // shard, so a github-script/API error fails the shard and the aggregate
    // required check goes red instead of passing open.
    for (const shard of [testShard1, testShard2]) {
      const detectStep = shard.steps.find((step) => step.name === "Detect backend-relevant changes");
      expect(detectStep).toBeDefined();
      expect(detectStep?.if).toBeUndefined();
    }

    // A skip path keeps the required check green when no backend files
    // changed, without running either shard's suite.
    for (const shard of [testShard1, testShard2]) {
      const skipStep = shard.steps.find((step) => step.name === "Skip backend tests when irrelevant");
      expect(skipStep?.if).toContain("steps.changes.outputs.backend_changed != 'true'");
    }

    const aggregateStep = testJob.steps.find((step) => step.name === "Verify backend test shards");
    expect(aggregateStep?.run).toContain("SHARD_1_RESULT");
    expect(aggregateStep?.run).toContain("SHARD_2_RESULT");
    expect(aggregateStep?.run).toContain("exit 1");

    // A truncated PR file list forces the full suite (fail closed).
    expect(loadWorkflowSource()).toContain("fileListTruncated");
  });
});
