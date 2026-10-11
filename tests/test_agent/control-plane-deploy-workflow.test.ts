import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/deploy-control-plane.yml");
const QA_WORKFLOW = resolve(".github/workflows/deploy-control-plane-qa.yml");
const QA_FRONTEND_WORKFLOW = resolve(".github/workflows/deploy-frontend-qa.yml");
const QA_E2B_SANDBOX_WORKFLOW = resolve(".github/workflows/deploy-e2b-sandbox-qa.yml");
const QA_GATED_PROD_WORKFLOW = resolve(".github/workflows/qa-gated-prod-deploy.yml");
const UI_CORE_WORKFLOW = resolve(".github/workflows/deploy-ui-core.yml");
const CONTROL_CORE_WORKFLOW = resolve(".github/workflows/deploy-control-plane-core.yml");
const E2B_CORE_WORKFLOW = resolve(".github/workflows/deploy-e2b-sandbox-core.yml");
const GITHUB_OIDC_TERRAFORM = resolve("infra/github-oidc.tf");
const VALIDATE_DEPLOY_WORKFLOW = resolve(".github/workflows/validate-deploy-commands.yml");

const PROD_WRANGLER_VAR_KEYS = [
  "CONTROL_PLANE_URL",
  "JIRA_OAUTH_CALLBACK_URL",
  "LINEAR_OAUTH_CALLBACK_URL",
  "NOTION_OAUTH_CALLBACK_URL",
  "SLACK_OAUTH_CALLBACK_URL",
  "SLACK_INSTALL_CALLBACK_URL",
  "OTEL_COLLECTOR_URL",
  "COLLECTOR_AUTH_KEY",
];

const QA_WRANGLER_VAR_KEYS = [
  "CONTROL_PLANE_URL",
  "JIRA_OAUTH_CALLBACK_URL",
  "LINEAR_OAUTH_CALLBACK_URL",
  "NOTION_OAUTH_CALLBACK_URL",
  "SLACK_OAUTH_CALLBACK_URL",
  "SLACK_INSTALL_CALLBACK_URL",
];

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  on: {
    pull_request: { paths: string[] };
    push?: { paths: string[] };
    workflow_dispatch: { inputs?: Record<string, { type?: string; default?: unknown }> } | null;
  };
  permissions?: Record<string, unknown>;
  jobs: Record<
    string,
    { steps?: WorkflowStep[]; uses?: string; with?: Record<string, unknown>; permissions?: Record<string, unknown> }
  >;
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function loadQaGatedProdWorkflow(): Workflow {
  return parse(readFileSync(QA_GATED_PROD_WORKFLOW, "utf-8")) as Workflow;
}

function loadControlCoreWorkflow(): Workflow {
  return parse(readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")) as Workflow;
}

function deploySteps(): WorkflowStep[] {
  return loadControlCoreWorkflow().jobs["deploy-control-plane"].steps ?? [];
}

function stepIndexByName(name: string): number {
  return deploySteps().findIndex((step) => step.name === name);
}

function pathMatches(pattern: string, file: string): boolean {
  if (pattern.endsWith("/**")) {
    return file.startsWith(pattern.slice(0, -3));
  }
  return file === pattern;
}

function workflowTriggers(paths: string[], files: string[]): boolean {
  return files.some((file) => paths.some((pattern) => pathMatches(pattern, file)));
}

// Anti-drift coverage of the PR-time wrangler guard (validate-deploy-commands.yml).
// The guard only protects a deploy command it explicitly mirrors, so a `secret`
// or `versions` command added/changed in the core deploy without a matching guard
// entry would ship unvalidated - the exact gap #7629 fell through. These helpers
// extract the normalized (subcommand, env, significant flags) shape of every such
// command from both files so the test below can assert the guard covers each one
// the deploy runs.

// The guard owns the wrangler command families where #7629 broke (secret list
// --json, versions upload --json, versions deploy --json). Other families in the
// deploy (kv key get/put, d1 migrations apply, the deploy --dry-run bundle gate)
// are read-only or already offline-validated and are intentionally out of scope.
const GUARDED_WRANGLER_FAMILIES = new Set(["secret", "versions"]);
const IGNORED_GUARD_ONLY_FLAGS = new Set(["--dry-run"]);

// Value of --env (or --env=X) in a wrangler token list, quotes stripped. Absent
// and empty both normalize to "" (wrangler's top-level/production environment).
function envOf(tokens: string[]): string {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--env=")) return token.slice("--env=".length).replace(/^["']|["']$/g, "");
    if (token === "--env") return (tokens[i + 1] ?? "").replace(/^["']|["']$/g, "");
  }
  return "";
}

// Canonicalized flag names for coverage matching. Only flag names matter here:
// placeholder-only value differences (`--var "SENTRY_RELEASE:..."`) and the
// synthetic UUID argument for `versions deploy` are intentionally ignored, while
// correctness-affecting flag drift (for example `--json`) becomes visible.
function significantFlagsOf(tokens: string[]): string[] {
  const flags = new Set<string>();
  for (const token of tokens) {
    if (!token.startsWith("-")) continue;
    const flag = token.split("=", 1)[0];
    if (IGNORED_GUARD_ONLY_FLAGS.has(flag)) continue;
    flags.add(flag);
  }
  return [...flags].sort();
}

// A guarded wrangler command reduced to its two-word subcommand, env, and
// significant flag set, e.g. `secret list --name x --format json` ->
// "secret list||--format,--name". The env follows a literal "|" delimiter so a
// top-level ("") env is unambiguous. Returns null for commands outside
// GUARDED_WRANGLER_FAMILIES.
function guardedKey(tokens: string[]): string | null {
  const words = tokens.filter((token) => !token.startsWith("-"));
  if (words.length < 2 || !GUARDED_WRANGLER_FAMILIES.has(words[0])) return null;
  return `${words[0]} ${words[1]}|${envOf(tokens)}|${significantFlagsOf(tokens).join(",")}`;
}

// Every wrangler invocation in a deploy workflow's run-blocks, as token lists
// after the `wrangler` word. Resolves both direct `npx wrangler ...` lines and
// commands assembled through `args=(...)`/`args+=(...)` fed to
// `npx wrangler "${args[@]}"` (the versions upload steps), mirroring the tokenizer
// the "never combines --name with --env" test relies on.
function coreWranglerCommands(text: string): string[][] {
  const commands: string[][] = [];
  let argsBuf: string[] = [];
  const STOP = new Set([">", ">>", "<", "|", "||", "&&", "2>", "2>>", ";", "&"]);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();

    // Match `args=(...)` / `args+=(...)` whether it starts the line or is nested in
    // an inline conditional like `if ...; then args+=(...); fi` - the shape the
    // deploy uses for its conditional --secrets-file append. Anchoring on `^args`
    // would skip the inline form, so a guarded command introduced that way would
    // silently drop out of the coverage set.
    const argsAssign = line.match(/\bargs(\+)?=\((.*?)\)/);
    if (argsAssign) {
      const inner = argsAssign[2].split(/\s+/).filter(Boolean);
      argsBuf = argsAssign[1] ? [...argsBuf, ...inner] : inner;
      continue;
    }

    if (!line.includes("wrangler")) continue;

    if (line.includes('"${args[@]}"')) {
      commands.push([...argsBuf]);
      continue;
    }

    const tokens = line.split(/\s+/);
    const wranglerIndex = tokens.indexOf("wrangler");
    if (wranglerIndex === -1) continue;
    const after: string[] = [];
    for (const token of tokens.slice(wranglerIndex + 1)) {
      if (STOP.has(token) || token.startsWith(">") || token.startsWith("<")) break;
      after.push(token);
    }
    commands.push(after);
  }
  return commands;
}

function expandGuardWrapper(text: string, name: string, callArgs: string[]): string[] | null {
  const lines = text.split("\n");
  const fnStart = lines.findIndex((line) => line.trim() === `${name}() {`);
  if (fnStart === -1) return null;

  for (const rawLine of lines.slice(fnStart + 1)) {
    const line = rawLine.trim();
    if (line === "}") break;
    if (!line.includes("npx wrangler")) continue;

    const tokens = line.split(/\s+/);
    const wranglerIndex = tokens.indexOf("wrangler");
    if (wranglerIndex === -1) continue;

    return tokens.slice(wranglerIndex + 1).flatMap((token) => (token === '"$@"' ? callArgs : [token]));
  }

  return null;
}

// The wrangler commands the guard validates, extracted from its assert_upload /
// assert_parses helper calls. assert_upload expands through its wrapper
// definition's real `npx wrangler ... "$@" ...` line so coverage tracks wrapper
// flag changes automatically; assert_parses takes the full wrangler command.
// Function-definition lines (`assert_x() {`) do not match because they have no
// whitespace before `(`.
function guardWranglerCommands(text: string): string[][] {
  const commands: string[][] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const upload = line.match(/^assert_upload\s+(.+)$/);
    if (upload) {
      const callArgs = upload[1].split(/\s+/).filter(Boolean);
      const expanded = expandGuardWrapper(text, "assert_upload", callArgs);
      if (expanded) commands.push(expanded);
      continue;
    }
    const parses = line.match(/^assert_parses\s+(.+)$/);
    if (parses) commands.push(parses[1].split(/\s+/).filter(Boolean));
  }
  return commands;
}

function guardedKeysIn(commands: string[][]): Set<string> {
  const keys = new Set<string>();
  for (const command of commands) {
    const key = guardedKey(command);
    if (key) keys.add(key);
  }
  return keys;
}

describe("control-plane deploy workflow", () => {
  it("deploys for shared module changes used by the worker bundle", () => {
    const workflow = loadWorkflow();
    const qaGatedProdWorkflow = loadQaGatedProdWorkflow();

    expect(workflow.on.pull_request.paths).toContain("shared/**");
    expect(workflow.on.push).toBeUndefined();
    expect(qaGatedProdWorkflow.on.push?.paths).toContain("shared/**");

    const modelRegistryChange = ["shared/constants/models.ts"];
    expect(workflowTriggers(workflow.on.pull_request.paths, modelRegistryChange)).toBe(true);
    expect(workflowTriggers(qaGatedProdWorkflow.on.push?.paths ?? [], modelRegistryChange)).toBe(true);
  });

  it("uses the shared secret validator before syncing prod and QA worker secrets", () => {
    expect(readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")).toContain("scripts/validate-control-plane-secrets.mjs");
  });

  it("sends QA deploy notifications to the shared deploy Slack webhook", () => {
    for (const workflow of [QA_WORKFLOW, QA_FRONTEND_WORKFLOW, QA_E2B_SANDBOX_WORKFLOW]) {
      const workflowText = readFileSync(workflow, "utf-8");
      expect(workflowText).toContain("SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}");
      expect(workflowText).not.toContain("SLACK_QA_WEBHOOK_URL");
    }
  });

  it("labels deploy notifications with the target environment", () => {
    expect(readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")).toContain("SERVICE_NAME: PROD API");
    expect(readFileSync(UI_CORE_WORKFLOW, "utf-8")).toContain("'PROD UI'");
    expect(readFileSync(E2B_CORE_WORKFLOW, "utf-8")).toContain("SERVICE_NAME: PROD E2B Sandbox");
    expect(readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")).toContain("SERVICE_NAME: QA API");
    expect(readFileSync(UI_CORE_WORKFLOW, "utf-8")).toContain("'QA UI'");
    expect(readFileSync(E2B_CORE_WORKFLOW, "utf-8")).toContain("SERVICE_NAME: QA E2B Sandbox");
  });

  it("uses compact direct child deploy Slack notifications with deployed commit subjects", () => {
    const childWorkflows = [CONTROL_CORE_WORKFLOW, UI_CORE_WORKFLOW, E2B_CORE_WORKFLOW];

    for (const workflow of childWorkflows) {
      const workflowText = readFileSync(workflow, "utf-8");
      expect(workflowText).toContain("*deploy ${STATUS}* · ${SERVICE_NAME} · ${SUBJECT} · ${ACTOR}");
      expect(workflowText).toContain('SUBJECT="$(git log -1 --format=%s "$SHA" 2>/dev/null || true)"');
      expect(workflowText).toContain("HEAD_COMMIT_MESSAGE: ${{ github.event.head_commit.message }}");
      expect(workflowText).toContain("s/</\\&lt;/g");
      expect(workflowText).toContain("· <${RUN_URL}|run>");
      expect(workflowText).not.toContain("*${SERVICE_NAME} deploy ${STATUS}*");
      expect(workflowText).not.toContain("ref=`${REF}`");
      expect(workflowText).not.toContain("ref: `${REF}`");
    }

    expect(readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")).toContain('SKIP_SUFFIX=" · worker skipped: bundle unchanged"');
  });

  it("caches control-plane deploy node_modules by lockfile and installs only on misses", () => {
    const steps = deploySteps();
    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v6");
    const nodeModulesCache = steps.find((step) => step.name === "Restore node_modules cache");
    const install = steps.find((step) => step.name === "Install worker dependencies");

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
    expect(install?.if).toBe("steps.node-modules-cache.outputs.cache-hit != 'true'");
    expect(install?.run).toBe("npm ci");
  });

  it("suppresses child deploy Slack notifications when grouped deploy workflows dispatch them", () => {
    const childWorkflows = [CONTROL_CORE_WORKFLOW, UI_CORE_WORKFLOW, E2B_CORE_WORKFLOW];

    for (const workflow of childWorkflows) {
      const workflowText = readFileSync(workflow, "utf-8");
      expect(workflowText).toContain("notify_slack:");
      expect(workflowText).toContain("inputs.notify_slack != false");
    }

    for (const workflow of [resolve(".github/workflows/deploy.yml"), QA_FRONTEND_WORKFLOW]) {
      const workflowText = readFileSync(workflow, "utf-8");
      expect(workflowText).toContain("notify_slack:");
      expect(workflowText).toContain("uses: ./.github/workflows/deploy-ui-core.yml");
    }
    for (const workflow of [WORKFLOW, QA_WORKFLOW]) {
      const workflowText = readFileSync(workflow, "utf-8");
      expect(workflowText).toContain("notify_slack:");
      expect(workflowText).toContain("uses: ./.github/workflows/deploy-control-plane-core.yml");
    }
    for (const workflow of [resolve(".github/workflows/deploy-e2b-sandbox.yml"), QA_E2B_SANDBOX_WORKFLOW]) {
      const workflowText = readFileSync(workflow, "utf-8");
      expect(workflowText).toContain("notify_slack:");
      expect(workflowText).toContain("uses: ./.github/workflows/deploy-e2b-sandbox-core.yml");
    }

    const gatedProdText = readFileSync(QA_GATED_PROD_WORKFLOW, "utf-8");
    expect(gatedProdText).toContain("notify_slack: false");
    expect(gatedProdText).toContain("Notify Slack on successful grouped deploy");
    expect(gatedProdText).toContain("*QA + PROD deploy* · ${SURFACE_LIST:-workflow-only} · ${CHANGE} · ${ACTOR}");
    expect(gatedProdText).toContain(
      "*QA + PROD deploy blocked* · ${SURFACE_LIST:-workflow-only} · ${CHANGE} · ${ACTOR}",
    );
    expect(gatedProdText).toContain('SUBJECT="$(git log -1 --format=%s "$SHA" 2>/dev/null || true)"');
    expect(gatedProdText).toContain("HEAD_COMMIT_MESSAGE: ${{ github.event.head_commit.message }}");
    expect(gatedProdText).toContain('SUBJECT="${SUBJECT:-$SHORT_SHA}"');
    expect(gatedProdText).toContain("s/[`*_~]/ /g");
    expect(gatedProdText).toContain("pull-requests: read");
    expect(gatedProdText).toContain('PR="$(gh api "repos/${REPO}/commits/${SHA}/pulls"');
    expect(gatedProdText).toContain("--jq '.[0].number // \"\"'");
    expect(gatedProdText).toContain('CHANGE="$SUBJECT"');
    expect(gatedProdText).toContain('CHANGE="#${PR} ${SUBJECT}"');
    expect(gatedProdText).toContain("s/</\\&lt;/g");
    expect(gatedProdText).not.toContain("ref=`main`");
    expect(gatedProdText).not.toContain("*deploy* · ${SURFACE_LIST:-none} · ${CHANGE} · ${ACTOR}");
    expect(gatedProdText).not.toContain("Services: ${SURFACE_LIST:-none}");
    expect(gatedProdText).toContain("Failed: ${failed_service}");
    expect(gatedProdText).toContain("set_failed_service");
    expect(gatedProdText).toContain('set_failed_service "$QA_CONTROL_RESULT" "QA API"');
    expect(gatedProdText).toContain('surfaces+=("E2B Sandbox")');
    expect(gatedProdText).not.toContain('surfaces+=("E2B")');
    expect(gatedProdText).not.toContain("QA-gated prod deploy blocked");
    expect(gatedProdText).not.toContain("QA: ${SURFACE_LIST:-none}");
    expect(gatedProdText).not.toContain("PROD: ${SURFACE_LIST:-none}");
  });

  it("excludes wrangler-owned public config from prod and QA secret sync", () => {
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");
    const prodSecretSyncText = workflowText.slice(
      workflowText.indexOf("Prepare production secret reconciliation"),
      workflowText.indexOf("Run D1 migrations"),
    );
    const qaSecretSyncText = workflowText.slice(
      workflowText.indexOf("Prepare QA secret reconciliation"),
      workflowText.indexOf("Run D1 migrations (QA)"),
    );

    for (const key of PROD_WRANGLER_VAR_KEYS) {
      expect(prodSecretSyncText).toContain(`"${key}"`);
    }
    for (const key of QA_WRANGLER_VAR_KEYS) {
      expect(qaSecretSyncText).toContain(`"${key}"`);
    }
    expect(prodSecretSyncText).toContain("collide with Cloudflare binding names");
    expect(qaSecretSyncText).toContain("collide with Cloudflare binding names");
  });

  it("requires only QA-owned GitHub, Linear, and Slack OAuth config during QA deploy", () => {
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");

    expect(workflowText).toContain('--path "/cycloid/qa/"');
    expect(workflowText).toContain("--oauth=github,linear,slack");
    expect(workflowText).not.toContain("/cycloid/GITHUB_CLIENT_ID");
    expect(workflowText).not.toContain("/cycloid/JIRA_OAUTH_CLIENT_ID");
    expect(workflowText).not.toContain("/cycloid/LINEAR_OAUTH_CLIENT_ID");
    expect(workflowText).not.toContain("/cycloid/NOTION_OAUTH_CLIENT_ID");
    expect(workflowText).not.toContain("/cycloid/SLACK_CLIENT_ID");
    expect(workflowText).not.toContain("/cycloid/JIRA_OAUTH_CLIENT_SECRET");
    expect(workflowText).not.toContain("/cycloid/NOTION_OAUTH_CLIENT_SECRET");
  });

  it("keeps QA deploy isolated to the QA role and QA SSM path", () => {
    const steps = deploySteps();
    const checkoutIndex = steps.findIndex((step) => step.uses === "actions/checkout@v7");
    const qaCredentialsIndex = steps.findIndex(
      (step) =>
        step.uses?.startsWith("aws-actions/configure-aws-credentials@") &&
        step.with?.["role-to-assume"] === "arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/cycloid-github-actions-qa",
    );
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");
    const qaWorkflowText = workflowText.slice(
      workflowText.indexOf("Fail if wrangler.toml still has QA placeholder IDs"),
    );

    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(qaCredentialsIndex).toBeGreaterThan(checkoutIndex);
    expect(qaWorkflowText).not.toContain("role/cycloid-github-actions-prod");
    expect(qaWorkflowText).not.toContain('path "/cycloid/"');
    expect(qaWorkflowText).not.toContain("prod-oauth-client-ids");
    expect(qaWorkflowText).not.toContain("AWS_ACCESS_KEY_ID=");
    expect(qaWorkflowText).toContain("get-parameters-by-path");
    expect(qaWorkflowText).toContain('--path "/cycloid/qa/"');
    expect(qaWorkflowText).toContain("SHA: ${{ env.DEPLOY_SHA || github.sha }}");
  });

  it("checks deployed QA health before reporting a successful worker deploy", () => {
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");

    expect(workflowText).toContain("Verify deployed QA health");
    expect(workflowText).toContain("https://qa.trycycloid.com/api/health");
    expect(workflowText).not.toContain("https://qa.trycycloid.com/api/health/oauth-config");
  });

  it("keeps path SSM access and limits named E2B deploy reads to exact parameters", () => {
    const terraformText = readFileSync(GITHUB_OIDC_TERRAFORM, "utf-8");
    const prodPolicyStart = terraformText.indexOf('resource "aws_iam_role_policy" "github_actions_prod_deploy"');
    const qaPolicyStart = terraformText.indexOf('resource "aws_iam_role_policy" "github_actions_qa_deploy"');
    const prodPolicyText = terraformText.slice(prodPolicyStart, qaPolicyStart);
    const qaPolicyText = terraformText.slice(qaPolicyStart);

    expect(prodPolicyStart).toBeGreaterThanOrEqual(0);
    expect(qaPolicyStart).toBeGreaterThan(prodPolicyStart);
    expect(prodPolicyText).toContain('"ssm:GetParametersByPath"');
    expect(prodPolicyText).toContain("parameter/cycloid/*");
    expect(prodPolicyText).toContain('"ssm:GetParameters"');
    expect(prodPolicyText).toContain('aws_ssm_parameter.env["CI_AUTOMATION_TOKEN"].arn');
    expect(prodPolicyText).toContain('aws_ssm_parameter.env["E2B_API_KEY"].arn');
    expect(prodPolicyText).not.toContain('aws_ssm_parameter.env["GITHUB_CLIENT_SECRET"].arn');
    expect(prodPolicyText).not.toContain('aws_ssm_parameter.qa_env["CI_AUTOMATION_TOKEN"].arn');
    expect(qaPolicyText).toContain('"ssm:GetParametersByPath"');
    expect(qaPolicyText).toContain("parameter/cycloid/qa/*");
    expect(qaPolicyText).toContain('"ssm:GetParameters"');
    expect(qaPolicyText).toContain('aws_ssm_parameter.qa_env["CI_AUTOMATION_TOKEN"].arn');
    expect(qaPolicyText).toContain('aws_ssm_parameter.qa_env["E2B_API_KEY"].arn');
    expect(qaPolicyText).not.toContain('aws_ssm_parameter.qa_env["GITHUB_CLIENT_SECRET"].arn');
    expect(qaPolicyText).not.toContain('aws_ssm_parameter.env["CI_AUTOMATION_TOKEN"].arn');
    expect(terraformText).not.toContain("parameter/cycloid/GITHUB_CLIENT_ID");
    expect(terraformText).not.toContain("parameter/cycloid/GITHUB_CLIENT_SECRET");
    expect(terraformText).not.toContain("parameter/cycloid/JIRA_OAUTH_CLIENT_SECRET");
    expect(terraformText).not.toContain("parameter/cycloid/LINEAR_OAUTH_CLIENT_SECRET");
    expect(terraformText).not.toContain("parameter/cycloid/NOTION_OAUTH_CLIENT_SECRET");
    expect(terraformText).not.toContain("parameter/cycloid/SLACK_CLIENT_SECRET");
  });

  it("reruns prod secret sync after SSM config changes and waits for Terraform Cloud", () => {
    const workflow = loadWorkflow();
    const qaGatedProdWorkflow = loadQaGatedProdWorkflow();
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");

    expect(workflow.on.pull_request.paths).toContain("infra/ssm.tf");
    expect(workflow.on.pull_request.paths).toContain(".github/workflows/deploy-control-plane-core.yml");
    expect(workflow.on.push).toBeUndefined();
    expect(qaGatedProdWorkflow.on.push?.paths).toContain("infra/ssm.tf");
    expect(qaGatedProdWorkflow.on.push?.paths).toContain(".github/workflows/deploy-control-plane-core.yml");
    expect(workflowText).toContain("Wait for Terraform Cloud SSM apply");
    expect(workflowText).toContain("Resolve SSM sync inputs");
    expect(workflowText).toContain('echo "changed=${{ inputs.sync_secrets }}"');
    expect(workflowText).toContain('status.context.startsWith("Terraform Cloud/cycloid/")');
  });

  it("allows the QA caller to delegate core status reads and honors QA sync_secrets", () => {
    const qaWorkflow = parse(readFileSync(QA_WORKFLOW, "utf-8")) as Workflow;
    const qaSecretSync = deploySteps().find((step) => step.name === "Prepare QA secret reconciliation");

    expect(qaWorkflow.permissions).toMatchObject({ contents: "read", "id-token": "write", statuses: "read" });
    expect(qaWorkflow.jobs.deploy.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
      statuses: "read",
    });
    expect(qaSecretSync?.if).toBe("${{ inputs.environment == 'qa' && inputs.sync_secrets == true }}");
  });

  it("asserts the Freestyle key on every prod deploy without the denied get-parameter call (ARC-1492)", () => {
    const steps = deploySteps();
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");

    // The always-on guard is wired: named, prod-gated, and runs the safe script (not
    // the inline shell that #7017 reverted).
    const guardIndex = steps.findIndex((step) => step.name === "Assert Freestyle key when routing is enabled");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(steps[guardIndex]?.if).toBe("${{ inputs.environment == 'production' }}");
    expect(steps[guardIndex]?.run).toContain("node scripts/assert-freestyle-key.mjs");

    // It must gate the routing-enabling worker deploy, so a bad key blocks it.
    const deployWorkerIndex = steps.findIndex((step) => step.name === "Upload production candidate Worker version");
    expect(deployWorkerIndex).toBeGreaterThan(guardIndex);

    // Regression lock on the outage: the prod role is denied the singular
    // ssm:GetParameter, so that call (masked to empty, failing closed) broke every
    // deploy. Never fetch the key that way again.
    expect(workflowText).not.toContain("get-parameter --name /cycloid/FREESTYLE_API_KEY");
  });

  it("checks migration integrity before applying QA and production D1 migrations", () => {
    const steps = deploySteps();
    const prodGuardIndex = stepIndexByName("Check migration integrity before D1 apply");
    const prodMigrateIndex = stepIndexByName("Run D1 migrations");
    const qaGuardIndex = stepIndexByName("Check migration integrity before D1 apply (QA)");
    const qaMigrateIndex = stepIndexByName("Run D1 migrations (QA)");

    expect(prodGuardIndex).toBeGreaterThanOrEqual(0);
    expect(prodMigrateIndex).toBeGreaterThan(prodGuardIndex);
    expect(steps[prodGuardIndex]).toMatchObject({
      if: "${{ inputs.environment == 'production' }}",
    });
    expect(steps[prodGuardIndex]?.run).toContain("if [ ! -f tests/test_cloudflare/migration-integrity.test.ts ]; then");
    expect(steps[prodGuardIndex]?.run).toContain("skipping rollback-compatible guard");
    expect(steps[prodGuardIndex]?.run).toContain("npx vitest run tests/test_cloudflare/migration-integrity.test.ts");

    expect(qaGuardIndex).toBeGreaterThanOrEqual(0);
    expect(qaMigrateIndex).toBeGreaterThan(qaGuardIndex);
    expect(steps[qaGuardIndex]).toMatchObject({
      if: "${{ inputs.environment == 'qa' }}",
    });
    expect(steps[qaGuardIndex]?.run).toContain("if [ ! -f tests/test_cloudflare/migration-integrity.test.ts ]; then");
    expect(steps[qaGuardIndex]?.run).toContain("skipping rollback-compatible guard");
    expect(steps[qaGuardIndex]?.run).toContain("npx vitest run tests/test_cloudflare/migration-integrity.test.ts");
  });

  it("uses one candidate upload and one traffic switch without a fleet drain", () => {
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");
    expect(workflowText).not.toContain("scripts/deploy-gate.ts");
    expect(workflowText).not.toContain("Drain live sessions");
    expect(stepIndexByName("Drain live sessions")).toBe(-1);
    expect(stepIndexByName("Drain live sessions before deploy")).toBe(-1);
    expect(workflowText).toContain("versions upload");
    expect(workflowText).toContain("versions deploy");
    expect(workflowText).not.toContain("wrangler secret bulk");
    expect(workflowText).toContain("candidate_versions_created");
    expect(workflowText).toContain("traffic_deployments_applied");
    expect(workflowText).toContain("secrets_changed_count");
    expect(workflowText).toContain("deployed_version_id");
    expect(workflowText).not.toContain("No DO restart");
    expect(loadWorkflow().on.workflow_dispatch?.inputs?.force_deploy).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(loadWorkflow().on.workflow_dispatch?.inputs?.sync_secrets).toMatchObject({
      type: "boolean",
      default: true,
    });
    expect(loadWorkflow().on.workflow_dispatch?.inputs?.wait_for_tfc).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(loadWorkflow().on.workflow_dispatch?.inputs?.ref).toMatchObject({
      default: "main",
    });
  });

  it("keeps secret-only deploys separate from the code hash gate", () => {
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");
    expect(workflowText).toContain("secret reconciliation is evaluated separately");
    expect(workflowText).toContain("steps.prod_secrets.outputs.changed");
    expect(workflowText).toContain("steps.qa_secrets.outputs.changed");
    expect(workflowText).toContain("reconcile-control-plane-secrets.mjs");
    expect(workflowText).toContain("upload-succeeded-but-deploy-failed");
  });

  // Regression lock: a wrangler command that passes an explicit --name must NOT also pass a
  // non-empty --env. Under wrangler's default legacy environments, --env appends "-<env>" to
  // the --name value, so `secret list --name cycloid-control-plane-qa --env qa` targets the
  // nonexistent worker "cycloid-control-plane-qa-qa" and fails the QA deploy at runtime. The
  // PR-time flag guard cannot catch this because the flags parse fine; only the name composition
  // is wrong. --env="" (empty) is safe and stays allowed.
  //
  // The scan resolves both direct `npx wrangler ...` lines AND commands assembled through
  // `args=(...)`/`args+=(...)` shell arrays fed to `npx wrangler "${args[@]}"` (the versions
  // upload steps), so a future --name added to an args array is caught even though --env lives
  // on a different physical line.
  it("never combines an explicit --name with a non-empty --env in wrangler commands", () => {
    const workflowText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");
    const offenders: string[] = [];

    // A wrangler invocation is an offender when it carries an explicit --name AND a non-empty
    // --env. Returns the offending token list, or null when the combination is absent/safe.
    const findViolation = (tokens: string[]): string[] | null => {
      const hasName = tokens.some((t) => t === "--name" || t.startsWith("--name="));
      if (!hasName) return null;

      let env: string | null = null;
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith("--env=")) env = token.slice("--env=".length);
        else if (token === "--env") env = tokens[i + 1] ?? "";
      }
      if (env === null) return null;

      const normalized = env.replace(/^["']|["']$/g, "");
      return normalized.length > 0 ? tokens : null;
    };

    // Accumulates the current `args=(...)` array so it can be evaluated when the matching
    // `npx wrangler "${args[@]}"` expansion is reached. `args=(...)` resets it; `args+=(...)`
    // appends. Naive whitespace tokenization is sufficient because --name/--env values in these
    // commands never contain spaces.
    let argsBuf: string[] = [];

    for (const rawLine of workflowText.split("\n")) {
      const line = rawLine.trim();

      const argsAssign = line.match(/^args\+?=\((.*)\)/);
      if (argsAssign) {
        const inner = argsAssign[1].split(/\s+/).filter(Boolean);
        argsBuf = line.startsWith("args+=") ? [...argsBuf, ...inner] : inner;
        continue;
      }

      if (!line.includes("wrangler ")) continue;

      if (line.includes('"${args[@]}"')) {
        const violation = findViolation(argsBuf);
        if (violation) offenders.push(`args=(${violation.join(" ")})`);
        continue;
      }

      const violation = findViolation(line.split(/\s+/));
      if (violation) offenders.push(line);
    }

    expect(offenders).toEqual([]);
  });

  // Anti-drift backstop for the PR-time guard: every `secret`/`versions` wrangler
  // command the real deploy runs must have a matching normalized
  // (subcommand, env, significant flags) entry in validate-deploy-commands.yml.
  // Without this, someone could add or re-flag such a command in the core deploy
  // while the guard silently keeps passing - the narrow version of the gap that
  // let #7629's four flag bugs reach prod.
  it("guards every secret/versions wrangler command the deploy runs", () => {
    const coreText = readFileSync(CONTROL_CORE_WORKFLOW, "utf-8");
    const guardText = readFileSync(VALIDATE_DEPLOY_WORKFLOW, "utf-8");

    const required = guardedKeysIn(coreWranglerCommands(coreText));
    const guarded = guardedKeysIn(guardWranglerCommands(guardText));

    // Sanity: the deploy really does run guarded commands, so this test is not
    // vacuously green if the tokenizer ever stops matching.
    expect(required.size).toBeGreaterThanOrEqual(3);

    const uncovered = [...required].filter((key) => !guarded.has(key));
    expect(
      uncovered,
      `deploy wrangler command shapes missing from validate-deploy-commands.yml: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  // Proves the coverage check above also detects correctness-affecting flag drift,
  // not just brand-new subcommands: adding `--json` to an already-guarded versions
  // deploy must surface as uncovered.
  it("detects flag drift on an already-guarded secret/versions command", () => {
    const guardText = readFileSync(VALIDATE_DEPLOY_WORKFLOW, "utf-8");
    const drifted = `${readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")}\n          npx wrangler versions deploy 00000000-0000-0000-0000-000000000000 --json --yes\n`;

    const required = guardedKeysIn(coreWranglerCommands(drifted));
    const guarded = guardedKeysIn(guardWranglerCommands(guardText));

    expect(required.has("versions deploy||--json,--yes")).toBe(true);
    expect([...required].filter((key) => !guarded.has(key))).toContain("versions deploy||--json,--yes");
  });

  // Proves the coverage check above actually detects drift: a stray, unguarded
  // `secret bulk` added to the deploy must surface as uncovered. Uses synthetic
  // text so it does not depend on mutating the real workflow.
  it("detects an unguarded secret/versions command added to the deploy", () => {
    const guardText = readFileSync(VALIDATE_DEPLOY_WORKFLOW, "utf-8");
    const drifted = `${readFileSync(CONTROL_CORE_WORKFLOW, "utf-8")}\n          npx wrangler secret bulk /tmp/x.json --name cycloid-control-plane-production\n`;

    const required = guardedKeysIn(coreWranglerCommands(drifted));
    const guarded = guardedKeysIn(guardWranglerCommands(guardText));

    expect(required.has("secret bulk||--name")).toBe(true);
    expect([...required].filter((key) => !guarded.has(key))).toContain("secret bulk||--name");
  });

  // The deploy appends args conditionally with an inline `if ...; then args+=(...); fi`.
  // The tokenizer must fold that inline append into the accumulated command, or a
  // guarded command (or an env) introduced that way would silently drop out of the
  // required set and escape coverage.
  it("folds an inline conditional args+= append into the guarded command", () => {
    const inlineAppend = [
      '          args=(versions upload --var "SENTRY_RELEASE:x")',
      '          if [ "$changed" = "true" ]; then args+=(--env qa); fi',
      '          npx wrangler "${args[@]}"',
    ].join("\n");

    const keys = guardedKeysIn(coreWranglerCommands(inlineAppend));
    // The inline `--env qa` append must land on the command: env is "qa", not "".
    expect(keys.has("versions upload|qa|--env,--var")).toBe(true);
    expect(keys.has("versions upload||--env,--var")).toBe(false);
  });
});
