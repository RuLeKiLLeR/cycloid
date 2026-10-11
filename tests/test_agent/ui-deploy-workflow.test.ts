import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const CORE = resolve(".github/workflows/deploy-ui-core.yml");
const PROD_WRAPPER = resolve(".github/workflows/deploy.yml");
const QA_WRAPPER = resolve(".github/workflows/deploy-frontend-qa.yml");

type WorkflowStep = {
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
};

type Workflow = {
  on: {
    workflow_call?: {
      inputs?: Record<string, { type?: string; default?: unknown; required?: boolean }>;
      secrets?: Record<string, { required?: boolean }>;
    };
    workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } | null;
  };
  permissions?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs: Record<
    string,
    {
      uses?: string;
      with?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      steps?: WorkflowStep[];
    }
  >;
};

function loadWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf-8")) as Workflow;
}

function coreSteps(): WorkflowStep[] {
  return loadWorkflow(CORE).jobs["deploy-ui"].steps ?? [];
}

function stepByName(name: string): WorkflowStep | undefined {
  return coreSteps().find((step) => step.name === name);
}

describe("UI deploy workflows", () => {
  it("keeps manual wrappers dispatch-only and maps them to the reusable UI core", () => {
    const prod = loadWorkflow(PROD_WRAPPER);
    const qa = loadWorkflow(QA_WRAPPER);

    expect(prod.on.workflow_dispatch?.inputs?.ref).toMatchObject({ default: "main" });
    expect(qa.on.workflow_dispatch?.inputs?.ref).toMatchObject({ default: "main" });
    expect(prod.permissions).toEqual({ contents: "read" });
    expect(qa.permissions).toEqual({ contents: "read" });
    expect(prod.concurrency).toEqual({ group: "deploy-ui", "cancel-in-progress": true });
    expect(qa.concurrency).toEqual({ group: "deploy-ui-qa", "cancel-in-progress": true });

    expect(prod.jobs["deploy-ui"].uses).toBe("./.github/workflows/deploy-ui-core.yml");
    expect(prod.jobs["deploy-ui"].with).toMatchObject({
      ref: "${{ inputs.ref }}",
      environment: "production",
      notify_slack: "${{ inputs.notify_slack }}",
    });
    expect(qa.jobs.deploy.uses).toBe("./.github/workflows/deploy-ui-core.yml");
    expect(qa.jobs.deploy.with).toMatchObject({
      ref: "${{ inputs.ref }}",
      environment: "qa",
      notify_slack: "${{ inputs.notify_slack }}",
    });

    for (const job of [prod.jobs["deploy-ui"], qa.jobs.deploy]) {
      expect(Object.keys(job.secrets ?? {}).sort()).toEqual([
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_TOKEN",
        "SENTRY_AUTH_TOKEN",
        "SLACK_WEBHOOK_URL",
      ]);
    }
  });

  it("declares an explicit workflow_call contract and checks out the requested ref", () => {
    const core = loadWorkflow(CORE);

    expect(core.on.workflow_call?.inputs).toMatchObject({
      ref: { required: true, type: "string" },
      environment: { required: true, type: "string" },
      notify_slack: { required: false, type: "boolean", default: true },
    });
    expect(core.on.workflow_call?.secrets).toMatchObject({
      SENTRY_AUTH_TOKEN: { required: true },
      CLOUDFLARE_API_TOKEN: { required: true },
      CLOUDFLARE_ACCOUNT_ID: { required: true },
      SLACK_WEBHOOK_URL: { required: true },
    });
    expect(core.jobs["deploy-ui"].concurrency).toBeUndefined();
    expect(stepByName("Validate deploy environment")?.run).toContain("production|qa");
    expect(coreSteps().find((step) => step.uses === "actions/checkout@v7")?.with?.ref).toBe("${{ inputs.ref }}");
  });

  it("preserves production and QA build environment parity", () => {
    const prodBuild = stepByName("Build UI (production)");
    const qaBuild = stepByName("Build UI (QA)");
    const target = stepByName("Resolve deploy target");

    // Build env tags are routed through the target step; the parity guarantee
    // lives in its per-environment defaults, which must reproduce the
    // pre-parameterization literals exactly when no override is passed.
    expect(target?.run).toContain('default_env_tag="production"');
    expect(target?.run).toContain('default_env_tag="qa"');
    expect(target?.run).toContain('env_tag="${IN_ENV_TAG:-$default_env_tag}"');

    expect(prodBuild?.if).toBe("${{ inputs.environment == 'production' }}");
    expect(prodBuild?.env).toEqual({
      VITE_SENTRY_RELEASE: "${{ steps.deployed_sha.outputs.sha }}",
      VITE_SENTRY_ENV: "${{ steps.target.outputs.env_tag }}",
    });
    expect(qaBuild?.if).toBe("${{ inputs.environment == 'qa' }}");
    expect(qaBuild?.env).toEqual({
      VITE_SENTRY_RELEASE: "${{ steps.deployed_sha.outputs.sha }}",
      VITE_SENTRY_ENV: "${{ steps.target.outputs.env_tag }}",
      VITE_DD_ENV: "${{ steps.target.outputs.env_tag }}",
    });
  });

  it("passes untrusted deploy inputs through env before shell logging", () => {
    const printUrl = stepByName("Print deployed UI URL");

    expect(printUrl?.env).toMatchObject({
      DEPLOY_ENV: "${{ inputs.environment }}",
      DEPLOY_REF: "${{ inputs.ref }}",
      DEPLOYED_SHA: "${{ steps.deployed_sha.outputs.sha }}",
    });
    expect(printUrl?.run).toContain("$DEPLOY_REF");
    expect(printUrl?.run).not.toContain("${{ inputs.ref }}");
  });

  it("preserves production R2 and QA Pages deployment behavior inside the core", () => {
    const prodDeploy = stepByName("Upload source maps and deploy to Cloudflare Pages");
    const qaDeploy = stepByName("Upload source maps to Sentry, deploy, and verify (QA)");

    expect(prodDeploy?.if).toBe("${{ inputs.environment == 'production' }}");
    expect(prodDeploy?.run).toContain("cycloid-ui-assets");
    // The Pages target is routed through the target step's outputs; parity is
    // guaranteed by the production defaults in "Resolve deploy target".
    expect(prodDeploy?.env).toMatchObject({
      DEPLOY_PROJECT: "${{ steps.target.outputs.project }}",
      DEPLOY_BRANCH: "${{ steps.target.outputs.branch }}",
      DEPLOY_ORIGIN: "${{ steps.target.outputs.origin }}",
    });
    expect(prodDeploy?.run).toContain('--project-name="$DEPLOY_PROJECT" --branch="$DEPLOY_BRANCH"');
    const target = stepByName("Resolve deploy target");
    expect(target?.run).toContain('default_project="cycloid-ui"');
    expect(target?.run).toContain('default_branch="main"');
    expect(target?.run).toContain('default_origin="https://app.trycycloid.com"');

    expect(qaDeploy?.if).toBe("${{ inputs.environment == 'qa' }}");
    expect(qaDeploy?.run).toContain("--project-name=cycloid-ui-qa");
    expect(qaDeploy?.run).toContain("--branch=qa");
    expect(qaDeploy?.run).toContain("https://qa.app.trycycloid.com");
  });

  it("keeps child deploy Slack notifications suppressible by the parent gate", () => {
    const slack = stepByName("Notify Slack");

    expect(slack?.if).toBe("${{ !cancelled() && inputs.notify_slack != false }}");
    expect(slack?.env?.SERVICE_NAME).toBe("${{ inputs.environment == 'qa' && 'QA UI' || 'PROD UI' }}");
    expect(slack?.run).toContain("*deploy ${STATUS}* · ${SERVICE_NAME} · ${SUBJECT} · ${ACTOR}");
  });
});
