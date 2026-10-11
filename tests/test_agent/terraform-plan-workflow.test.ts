import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/terraform-plan.yml");

type WorkflowStep = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
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
    plan: {
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

function setupTerraformStep(jobName: keyof Workflow["jobs"]): WorkflowStep | undefined {
  // Match any ref (SHA-pinned or tag): ARCWF1001 requires third-party actions
  // to pin a full commit SHA, so an exact tag match would never find the step.
  return loadWorkflow().jobs[jobName].steps?.find((step) => step.uses?.startsWith("hashicorp/setup-terraform@"));
}

describe("terraform plan workflow", () => {
  it("keeps pull-request validation tokenless and validate-only", () => {
    const workflow = loadWorkflow();
    const validateJob = workflow.jobs.validate;
    const initStep = jobStep("validate", "Terraform Init");
    const validateStep = jobStep("validate", "Terraform Validate");

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.on.pull_request?.branches).toEqual(["main"]);
    expect(workflow.on.pull_request?.paths).toEqual(
      expect.arrayContaining([
        "infra/**",
        ".github/workflows/terraform-plan.yml",
        "tests/test_agent/terraform-plan-workflow.test.ts",
      ]),
    );
    expect(validateJob.if).toBe("github.event_name == 'pull_request'");
    expect(setupTerraformStep("validate")?.with).toBeUndefined();
    expect(JSON.stringify(validateJob)).not.toContain("TF_API_TOKEN");
    expect(JSON.stringify(validateJob)).not.toContain("cli_config_credentials_token");
    expect(jobStep("validate", "Terraform Plan")).toBeUndefined();
    expect(initStep?.run).toBe("terraform init -backend=false -input=false -no-color");
    expect(initStep?.["working-directory"]).toBe("infra/");
    expect(validateStep?.run).toBe("terraform validate -no-color");
    expect(validateStep?.["working-directory"]).toBe("infra/");
  });

  it("limits authenticated terraform plans to trusted main runs", () => {
    const workflow = loadWorkflow();
    const planJob = workflow.jobs.plan;
    const initStep = jobStep("plan", "Terraform Init");
    const planStep = jobStep("plan", "Terraform Plan");

    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.push?.paths).toEqual(
      expect.arrayContaining(["infra/**", ".github/workflows/terraform-plan.yml"]),
    );
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(planJob.if).toBe(
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    expect(setupTerraformStep("plan")?.with).toEqual({
      cli_config_credentials_token: "${{ secrets.TF_API_TOKEN }}",
    });
    expect(jobStep("plan", "Comment on PR")).toBeUndefined();
    expect(initStep?.run).toBe("terraform init -input=false -no-color");
    expect(initStep?.["working-directory"]).toBe("infra/");
    expect(planStep?.run).toBe("terraform plan -input=false -no-color");
    expect(planStep?.["working-directory"]).toBe("infra/");
  });

  it("self-tests the workflow when its contract changes", () => {
    const workflow = loadWorkflow();

    expect(jobStep("validate", "Typecheck workflow contract")?.run).toBe(
      "npx vitest run tests/test_agent/terraform-plan-workflow.test.ts",
    );
  });
});
