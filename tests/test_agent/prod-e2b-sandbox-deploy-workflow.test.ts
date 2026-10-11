import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/deploy-e2b-sandbox.yml");
const CORE_WORKFLOW = resolve(".github/workflows/deploy-e2b-sandbox-core.yml");

type WorkflowStep = {
  name?: string;
  id?: string;
  env?: Record<string, string>;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
};

type Workflow = {
  on: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } | null };
  jobs: {
    deploy: {
      uses?: string;
      with?: Record<string, unknown>;
      steps: WorkflowStep[];
    };
    "deploy-e2b-sandbox": {
      steps: WorkflowStep[];
    };
  };
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function deploySteps(): WorkflowStep[] {
  return (parse(readFileSync(CORE_WORKFLOW, "utf-8")) as Workflow).jobs["deploy-e2b-sandbox"].steps;
}

function stepByName(name: string): WorkflowStep | undefined {
  return deploySteps().find((step) => step.name === name);
}

describe("production E2B sandbox deploy workflow", () => {
  it("supports manual force rebuild while defaulting to content-hash skips", () => {
    const workflow = loadWorkflow();
    const buildStep = stepByName("Build production E2B sandbox template");

    expect(workflow.on.workflow_dispatch?.inputs?.ref).toMatchObject({
      default: "main",
    });
    expect(workflow.on.workflow_dispatch?.inputs?.force_rebuild).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(workflow.jobs.deploy.uses).toBe("./.github/workflows/deploy-e2b-sandbox-core.yml");
    expect(workflow.jobs.deploy.with).toMatchObject({
      environment: "production",
      force_rebuild: "${{ inputs.force_rebuild }}",
    });
    expect(buildStep?.env?.FORCE_REBUILD).toBe("${{ inputs.force_rebuild == true }}");
    expect(buildStep?.run).toContain("--skip-matching-registry");
    expect(buildStep?.run).toContain("--registry-url https://api.trycycloid.com");
    expect(buildStep?.run).toContain('[ "$FORCE_REBUILD" = "true" ]');
    expect(buildStep?.run).toContain("--force-rebuild");
    expect(buildStep?.run).toContain("--prod --include-repo-spec-templates");
  });

  it("loads only named production E2B deploy secrets from SSM and guards placeholders", () => {
    const loadStep = stepByName("Load E2B deploy secrets from SSM");

    expect(loadStep?.run).toContain("aws ssm get-parameters");
    expect(loadStep?.run).toContain("--names /cycloid/E2B_API_KEY /cycloid/CI_AUTOMATION_TOKEN");
    expect(loadStep?.run).toContain("--with-decryption");
    expect(loadStep?.run).toContain("--query 'Parameters[]'");
    expect(loadStep?.run).not.toContain("get-parameters-by-path");
    expect(loadStep?.run).not.toContain("--path /cycloid/");
    expect(loadStep?.run).toContain('echo "::add-mask::$value"');
    expect(loadStep?.run).toContain('select(.Name=="/cycloid/E2B_API_KEY")');
    expect(loadStep?.run).toContain('select(.Name=="/cycloid/CI_AUTOMATION_TOKEN")');
    expect(loadStep?.run).toContain('[ "$E2B_API_KEY" = "CHANGE_ME" ]');
    expect(loadStep?.run).toContain('[ "$CI_AUTOMATION_TOKEN" = "CHANGE_ME" ]');
    expect(loadStep?.run).toContain("E2B_API_KEY=$E2B_API_KEY");
    expect(loadStep?.run).toContain("CI_AUTOMATION_TOKEN=$CI_AUTOMATION_TOKEN");
  });

  it("caches production E2B deploy node_modules by lockfile and installs only on misses", () => {
    const setupNode = deploySteps().find((step) => step.uses === "actions/setup-node@v6");
    const nodeModulesCache = stepByName("Restore node_modules cache");
    const install = stepByName("Install dependencies");
    const installCondition =
      "${{ inputs.environment == 'production' && (inputs.run_template_build == true || inputs.register_base_templates == true) && steps.node-modules-cache.outputs.cache-hit != 'true' }}";

    expect(setupNode?.with).toMatchObject({
      "node-version": 22,
      cache: "npm",
      "cache-dependency-path": "package-lock.json",
    });
    expect(nodeModulesCache).toMatchObject({
      id: "node-modules-cache",
      uses: "actions/cache@v6",
    });
    expect(nodeModulesCache?.with).toMatchObject({
      path: "node_modules\napps/*/node_modules\n",
      key: "${{ runner.os }}-${{ runner.arch }}-node-22-node-modules-${{ hashFiles('package-lock.json', 'package.json', 'apps/*/package.json') }}",
    });
    expect(nodeModulesCache?.if).toBe(
      "${{ inputs.environment == 'production' && (inputs.run_template_build == true || inputs.register_base_templates == true) }}",
    );
    expect(install?.if).toBe(installCondition);
    expect(install?.run).toBe("HUSKY=0 npm ci --no-audit --no-fund");
  });

  it("smokes every production template, including repo-spec templates", () => {
    const smokeStep = stepByName("Smoke test the production template");

    expect(smokeStep?.["timeout-minutes"]).toBe(5);
    expect(smokeStep?.run).toContain("--prod --include-repo-spec-templates --print-template");
    expect(smokeStep?.run).toContain("E2B_SANDBOX_TEMPLATE=*)");
    expect(smokeStep?.run).toContain("E2B_REPO_SANDBOX_TEMPLATE=*)");
    expect(smokeStep?.run).toContain('npm run smoke:e2b:compat -- --template "$template"');
  });

  it("registers non-empty content-addressed base templates after smoke", () => {
    const registerStep = stepByName("Register production sandbox base templates");

    expect(registerStep?.["continue-on-error"]).toBe(true);
    expect(registerStep?.run).toContain("--print-template --print-content-hashes");
    expect(registerStep?.run).toContain("E2B_SANDBOX_TEMPLATE_CONTENT_HASH=*)");
    expect(registerStep?.run).toContain("E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=*)");
    expect(registerStep?.run).toContain('--arg baseVersion "$content_hash"');
    expect(registerStep?.run).toContain('--arg contentHash "$content_hash"');
    expect(registerStep?.run).toContain("No production sandbox base templates were collected");
    expect(registerStep?.run).toContain("https://api.trycycloid.com/api/admin/sandbox-base-templates/register");
    expect(registerStep?.run).toContain("Authorization: Bearer ${CI_AUTOMATION_TOKEN}");
  });

  it("soft-fails retryable registration failures but gates fatal setup and hard 4xx errors", () => {
    const source = readFileSync(CORE_WORKFLOW, "utf-8");
    const registerStep = stepByName("Register production sandbox base templates");
    const fatalStep = stepByName("Fail on fatal sandbox base-template registration errors");

    expect(registerStep?.run).toContain("for attempt in 1 2 3 4 5 6");
    expect(registerStep?.run).toContain('[ "$status" = "000" ]');
    expect(registerStep?.run).toContain('[ "$status" = "404" ]');
    expect(registerStep?.run).toContain('[ "$status" -ge 500 ]');
    expect(registerStep?.run).toContain("sleep 20");
    expect(registerStep?.run).toContain("fatal_file=");
    expect(registerStep?.run).toContain("mark_fatal_registration_error");
    expect(registerStep?.run).toContain("failed with HTTP ${status}");
    expect(fatalStep?.run).toContain('if [ -s "$fatal_file" ]; then');
    expect(source).toContain("Register production sandbox base templates");
    expect(source).toContain("Fail on fatal sandbox base-template registration errors");
  });
});
