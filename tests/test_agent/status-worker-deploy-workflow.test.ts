import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/deploy-status-worker.yml");

type WorkflowStep = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, unknown>;
  "working-directory"?: string;
};

type Workflow = {
  on: {
    pull_request?: {
      branches?: string[];
      paths?: string[];
    };
    push?: {
      branches?: string[];
      paths?: string[];
    };
    workflow_dispatch?: Record<string, unknown> | null;
  };
  permissions?: Record<string, unknown>;
  jobs: {
    validate: {
      if?: string;
      steps?: WorkflowStep[];
    };
    deploy: {
      if?: string;
      steps?: WorkflowStep[];
    };
  };
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function jobStep(jobName: keyof Workflow["jobs"], stepName: string): WorkflowStep | undefined {
  return loadWorkflow().jobs[jobName].steps?.find((step) => step.name === stepName);
}

describe("status worker deploy workflow", () => {
  it("keeps pull-request validation tokenless while still dry-running the worker bundle", () => {
    const workflow = loadWorkflow();
    const validate = jobStep("validate", "Typecheck and test");
    const dryRun = jobStep("validate", "Wrangler dry-run");

    expect(workflow.on.pull_request?.branches).toEqual(["main"]);
    expect(workflow.jobs.validate.if).toBe("github.event_name == 'pull_request'");
    expect(validate?.run).toContain("tests/test_agent/status-worker-deploy-workflow.test.ts");
    expect(dryRun?.run).toBe('npx wrangler deploy --env="" --dry-run --outdir /tmp/status-bundle');
    expect(dryRun?.["working-directory"]).toBe("apps/status-worker");
    expect(dryRun?.env).toBeUndefined();
  });

  it("keeps authenticated deploys limited to trusted push and manual events", () => {
    const workflow = loadWorkflow();
    const deployStep = jobStep("deploy", "Deploy worker");

    expect(workflow.jobs.deploy.if).toBe("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
    expect(deployStep?.run).toBe('npx wrangler deploy --env=""');
    expect(deployStep?.["working-directory"]).toBe("apps/status-worker");
    expect(deployStep?.env).toEqual({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    });
  });
});
