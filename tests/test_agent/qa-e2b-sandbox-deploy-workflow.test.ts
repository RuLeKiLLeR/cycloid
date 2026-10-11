import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/deploy-e2b-sandbox-qa.yml");
const CORE_WORKFLOW = resolve(".github/workflows/deploy-e2b-sandbox-core.yml");

type WorkflowStep = {
  name?: string;
  id?: string;
  env?: Record<string, unknown>;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
};

type Workflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } | null };
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

function loadWorkflowSource(): string {
  return readFileSync(CORE_WORKFLOW, "utf-8");
}

function deploySteps(): WorkflowStep[] {
  return (parse(readFileSync(CORE_WORKFLOW, "utf-8")) as Workflow).jobs["deploy-e2b-sandbox"].steps;
}

function stepByName(name: string): WorkflowStep | undefined {
  return deploySteps().find((step) => step.name === name);
}

function stepIndexByName(name: string): number {
  return deploySteps().findIndex((step) => step.name === name);
}

describe("QA E2B sandbox deploy workflow", () => {
  it("keeps the QA manual wrapper and maps skip_cache into the reusable core", () => {
    const workflow = loadWorkflow();

    expect(workflow.on?.workflow_dispatch?.inputs?.ref).toMatchObject({ default: "main" });
    expect(workflow.on?.workflow_dispatch?.inputs?.skip_cache).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(workflow.jobs.deploy.uses).toBe("./.github/workflows/deploy-e2b-sandbox-core.yml");
    expect(workflow.jobs.deploy.with).toMatchObject({
      environment: "qa",
      skip_cache: "${{ inputs.skip_cache }}",
    });
    expect(workflow.jobs.deploy.with).not.toHaveProperty("force_rebuild");
  });

  it("loads only named QA E2B deploy secrets from SSM and guards placeholders", () => {
    const loadStep = stepByName("Load QA E2B deploy secrets from SSM");

    expect(loadStep?.run).toContain("aws ssm get-parameters");
    expect(loadStep?.run).toContain("--names /cycloid/qa/E2B_API_KEY /cycloid/qa/CI_AUTOMATION_TOKEN");
    expect(loadStep?.run).toContain("--with-decryption");
    expect(loadStep?.run).toContain("--query 'Parameters[]'");
    expect(loadStep?.run).not.toContain("get-parameters-by-path");
    expect(loadStep?.run).not.toContain("--path /cycloid/qa/");
    expect(loadStep?.run).toContain('echo "::add-mask::$value"');
    expect(loadStep?.run).toContain('select(.Name=="/cycloid/qa/E2B_API_KEY")');
    expect(loadStep?.run).toContain('select(.Name=="/cycloid/qa/CI_AUTOMATION_TOKEN")');
    expect(loadStep?.run).toContain('[ "$E2B_API_KEY" = "CHANGE_ME" ]');
    expect(loadStep?.run).toContain('[ "$CI_AUTOMATION_TOKEN" = "CHANGE_ME" ]');
    expect(loadStep?.run).toContain("E2B_API_KEY=$E2B_API_KEY");
    expect(loadStep?.run).toContain("CI_AUTOMATION_TOKEN=$CI_AUTOMATION_TOKEN");
  });

  it("keeps node_modules cache restore and install scoped to production E2B paths", () => {
    const nodeModulesCache = stepByName("Restore node_modules cache");
    const install = stepByName("Install dependencies");

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
    expect(install?.if).toBe(
      "${{ inputs.environment == 'production' && (inputs.run_template_build == true || inputs.register_base_templates == true) && steps.node-modules-cache.outputs.cache-hit != 'true' }}",
    );
  });

  it("smokes every QA template that can be registered as passed", () => {
    const smokeStep = stepByName("Smoke test sandbox egress allowlist");
    expect(smokeStep?.["timeout-minutes"]).toBe(10);
    expect(smokeStep?.run).toContain("--qa --include-repo-spec-templates --print-template");
    expect(smokeStep?.run).toContain("E2B_SANDBOX_TEMPLATE=*)");
    expect(smokeStep?.run).toContain("E2B_REPO_SANDBOX_TEMPLATE=*)");
    expect(smokeStep?.run).toContain('npm run smoke:e2b:egress -- --template "$template"');
  });

  it("skips unchanged QA template builds while preserving the skip_cache force-build lever", () => {
    const buildStep = stepByName("Build QA E2B sandbox template");

    expect(buildStep?.env).toMatchObject({
      E2B_SKIP_CACHE: "${{ inputs.skip_cache && '1' || '' }}",
      SKIP_CACHE: "${{ inputs.skip_cache == true }}",
    });
    expect(buildStep?.run).toContain("set -euo pipefail");
    expect(buildStep?.run).toContain(
      "args=(--skip-bundles --qa --include-repo-spec-templates --skip-matching-registry --registry-url https://qa.trycycloid.com)",
    );
    expect(buildStep?.run).toContain('if [ "$SKIP_CACHE" = "true" ]; then');
    expect(buildStep?.run).toContain("args+=(--force-rebuild)");
    expect(buildStep?.run).toContain('bash scripts/e2b-template-build.sh "${args[@]}"');
  });

  it("registers QA sandbox base templates after migrations and the worker deploy", () => {
    const registerIndex = stepIndexByName("Register QA sandbox base templates");
    expect(registerIndex).toBeGreaterThan(stepIndexByName("Run D1 migrations (QA)"));
    expect(registerIndex).toBeGreaterThan(stepIndexByName("Deploy QA worker"));
  });

  it("mirrors the production registration payload and points at the QA API host", () => {
    const registerStep = stepByName("Register QA sandbox base templates");
    expect(registerStep?.["continue-on-error"]).toBe(true);
    expect(registerStep?.run).toContain(
      "--qa --include-repo-spec-templates --skip-bundles --print-template --print-content-hashes",
    );
    expect(registerStep?.run).toContain("E2B_SANDBOX_TEMPLATE_AGENT_BACKENDS=*)");
    expect(registerStep?.run).toContain("CAPABILITIES=");
    expect(registerStep?.run).toContain("declare -A BASE_TEMPLATE_REFS=()");
    expect(registerStep?.run).toContain("expected_base_template_count=0");
    expect(registerStep?.run).toContain('BASE_TEMPLATE_REFS["$resource_profile_key"]="$base_template_ref"');
    expect(registerStep?.run).toContain("expected_base_template_count=$((expected_base_template_count + 1))");
    expect(registerStep?.run).toContain("E2B_SANDBOX_TEMPLATE_CONTENT_HASH=*)");
    expect(registerStep?.run).toContain(
      "# Content-hash lines must follow their matching template-ref line so the payload can pair them.",
    );
    expect(registerStep?.run).toContain('content_hash="${line#E2B_SANDBOX_TEMPLATE_CONTENT_HASH=}"');
    expect(registerStep?.run).toContain('resource_profile_key="${value%%:*}"');
    expect(registerStep?.run).toContain('base_template_ref="${value#*:}"');
    expect(registerStep?.run).toContain("E2B_REPO_SANDBOX_TEMPLATE_CONTENT_HASH=*)");
    expect(registerStep?.run).toContain('content_hash="${value#*:}"');
    expect(registerStep?.run).toContain("Missing template ref or content hash for ${resource_profile_key}");
    expect(registerStep?.run).toContain('--arg baseVersion "$TEMPLATE_SHA"');
    expect(registerStep?.run).toContain('--arg contentHash "$content_hash"');
    expect(registerStep?.run).toContain("contentHash: $contentHash");
    expect(registerStep?.run).toContain('--arg gitSha "$TEMPLATE_SHA"');
    expect(registerStep?.run).toContain("https://qa.trycycloid.com/api/admin/sandbox-base-templates/register");
    expect(registerStep?.run).toContain("Authorization: Bearer ${CI_AUTOMATION_TOKEN}");
    expect(registerStep?.run?.indexOf("jq 'length' <<< \"$BASES\"")).toBeLessThan(
      registerStep?.run?.indexOf('PAYLOAD="$(jq -n') ?? -1,
    );
    expect(registerStep?.run).toContain('"$expected_base_template_count"');
    expect(registerStep?.run).toContain("every template ref must have a paired content hash");
  });

  it("passes untrusted deploy inputs through env before shell logging", () => {
    const printStep = stepByName("Print QA template");

    expect(printStep?.env).toMatchObject({ DEPLOY_REF: "${{ inputs.ref }}" });
    expect(printStep?.run).toContain("$DEPLOY_REF");
    expect(printStep?.run).not.toContain("${{ inputs.ref }}");
  });

  it("soft-fails retryable registration failures but gates fatal setup and hard 4xx errors", () => {
    const source = loadWorkflowSource();
    const registerStep = stepByName("Register QA sandbox base templates");
    const fatalStep = stepByName("Fail on fatal QA sandbox base-template registration errors");

    expect(registerStep?.run).toContain("for attempt in 1 2 3 4 5 6");
    expect(registerStep?.run).toContain('[ "$status" = "000" ]');
    expect(registerStep?.run).toContain('[ "$status" = "404" ]');
    expect(registerStep?.run).toContain('[ "$status" -ge 500 ]');
    expect(registerStep?.run).toContain("sleep 20");
    expect(registerStep?.run).toContain("fatal_file=");
    expect(registerStep?.run).toContain("mark_fatal_registration_error");
    expect(registerStep?.run).toContain("jq 'length' <<< \"$BASES\"");
    expect(registerStep?.run).toContain("No QA sandbox base templates were collected");
    expect(registerStep?.run).toContain("trap - ERR");
    expect(registerStep?.run).toContain("failed with HTTP ${status}");
    expect(fatalStep?.run).toContain('if [ -s "$fatal_file" ]; then');
    expect(source).toContain("Register QA sandbox base templates");
    expect(source).toContain("Fail on fatal QA sandbox base-template registration errors");
  });
});
