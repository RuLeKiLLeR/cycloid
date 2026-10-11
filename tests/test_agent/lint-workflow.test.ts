import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/lint.yml");
const LINT_CHANGED_SCRIPT = resolve("scripts/lint-changed-ts.sh");

type Step = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Workflow = {
  on: {
    pull_request: {
      branches: string[];
      types?: string[];
    };
    push: {
      branches: string[];
    };
  };
  concurrency: {
    group: string;
    "cancel-in-progress": string;
  };
  jobs: {
    lint: {
      steps: Step[];
    };
  };
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

describe("lint workflow", () => {
  it("runs changed-file lint with enough checkout history for merge-base", () => {
    const steps = loadWorkflow().jobs.lint.steps;

    const checkout = steps.find((step) => step.uses === "actions/checkout@v7");
    const eslint = steps.find((step) => step.name === "Run changed-file lint");

    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.head.sha || github.sha }}");
    expect(eslint?.run).toBe("npm run lint:changed");
    expect(eslint?.if).toBe("github.event_name == 'pull_request'");
    expect(steps.some((step) => step.name === "Skip ESLint when only markdown changed")).toBe(false);
  });

  it("guards resolved production E2B template changes and reruns when the bypass label changes", () => {
    const workflow = loadWorkflow();
    const steps = workflow.jobs.lint.steps;
    const guard = steps.find((step) => step.name === "Guard production E2B template set");

    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "labeled", "unlabeled"]);
    expect(guard?.if).toBe("github.event_name == 'pull_request'");
    expect(guard?.env).toMatchObject({
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      ALLOW_NEW_PROD_TEMPLATE: "${{ contains(github.event.pull_request.labels.*.name, 'e2b-template-prebuilt') }}",
    });
    expect(guard?.run).toContain("git merge-base");
    expect(guard?.run).toContain("scripts/guard-prod-e2b-template-set.sh");
    expect(guard?.run).toContain("--allow-new-prod-template");
  });

  it("does not let main-push lint backstops cancel each other", () => {
    const concurrency = loadWorkflow().concurrency;

    expect(concurrency.group).toBe("${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}");
    expect(concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });

  it("runs a full-tree format and lint backstop on main pushes", () => {
    const workflow = loadWorkflow();
    const steps = workflow.jobs.lint.steps;

    const fullFormat = steps.find((step) => step.name === "Run full format check");
    const fullLint = steps.find((step) => step.name === "Run full lint");

    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(fullFormat?.if).toBe("github.event_name == 'push'");
    expect(fullFormat?.run).toBe("npm run format:check");
    expect(fullLint?.if).toBe("github.event_name == 'push'");
    expect(fullLint?.run).toBe("npx eslint .");
  });

  it("keeps non-ESLint guardrails in the changed-file lint script", () => {
    const script = readFileSync(LINT_CHANGED_SCRIPT, "utf-8");

    expect(script).toContain("npm run check:developer-paths");
    expect(script).toContain("npm run guard:bridge-llm");
    expect(script).toContain("npm run guard:pr-coordination-writers");
  });
});
