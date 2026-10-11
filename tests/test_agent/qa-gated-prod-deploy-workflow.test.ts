import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { detectSurfacesFromFiles } from "../../scripts/detect-deploy-surfaces.mjs";

const GATE = resolve(".github/workflows/qa-gated-prod-deploy.yml");
const UI_PROD = resolve(".github/workflows/deploy.yml");
const CONTROL_PROD = resolve(".github/workflows/deploy-control-plane.yml");
const SANDBOX_PROD = resolve(".github/workflows/deploy-e2b-sandbox.yml");

type Workflow = {
  on: {
    push?: { branches?: string[]; paths?: string[] };
    workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } | null;
  };
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      needs?: string | string[];
      if?: string;
      uses?: string;
      with?: Record<string, unknown>;
      outputs?: Record<string, string>;
      permissions?: Record<string, string>;
      steps?: Array<{ name?: string; if?: string; run?: string; with?: Record<string, unknown> }>;
    }
  >;
};

function loadWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf-8")) as Workflow;
}

function needs(job: Workflow["jobs"][string]): string[] {
  if (Array.isArray(job.needs)) return job.needs;
  return job.needs ? [job.needs] : [];
}

describe("QA-gated production deploy workflow", () => {
  it("owns main push deploys while production deploy workflows stay dispatch-only wrappers", () => {
    const gate = loadWorkflow(GATE);

    expect(gate.on.push?.branches).toEqual(["main"]);
    for (const workflow of [UI_PROD, CONTROL_PROD, SANDBOX_PROD]) {
      const loaded = loadWorkflow(workflow);
      expect(loaded.on.push).toBeUndefined();
      expect(loaded.on.workflow_dispatch?.inputs?.ref).toMatchObject({ default: "main" });
    }
  });

  it("uses reusable deploy cores without workflow dispatch or actions write permission", () => {
    const workflow = loadWorkflow(GATE);
    const source = readFileSync(GATE, "utf-8");

    expect(source).not.toContain("gh workflow run");
    expect(source).not.toContain("gh run list");
    expect(source).not.toContain("gh run view");
    expect(source).not.toContain("wait_for_run");
    expect(source).not.toContain("dispatch_gate");
    expect(workflow.permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
      statuses: "read",
      "pull-requests": "read",
    });
    expect(workflow.permissions).not.toHaveProperty("actions");
  });

  it("detects surfaces in a checkout with full history and includes core workflow paths", () => {
    const workflow = loadWorkflow(GATE);
    const paths = workflow.on.push?.paths ?? [];
    const detect = workflow.jobs["detect-surfaces"];

    expect(paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/deploy-ui-core.yml",
        ".github/workflows/deploy-control-plane-core.yml",
        ".github/workflows/deploy-e2b-sandbox-core.yml",
        "scripts/detect-deploy-surfaces.mjs",
      ]),
    );
    expect(detect.steps?.find((step) => step.with?.["fetch-depth"] === 0)).toBeDefined();
    expect(detect.steps?.find((step) => step.name === "Detect affected deploy surfaces")?.run).toBe(
      "node scripts/detect-deploy-surfaces.mjs",
    );
    expect(workflow.jobs["detect-surfaces"].outputs?.skip).toBe("${{ steps.surfaces.outputs.skip }}");
    expect(workflow.jobs["detect-surfaces"].outputs?.base_sha).toBe("${{ steps.surfaces.outputs.base_sha }}");
    expect(detectSurfacesFromFiles([".github/workflows/deploy-ui-core.yml"]).ui).toBe(true);
    expect(detectSurfacesFromFiles([".github/workflows/deploy-control-plane-core.yml"]).control).toBe(true);
    expect(detectSurfacesFromFiles([".github/workflows/deploy-e2b-sandbox-core.yml"]).sandbox).toBe(true);
  });

  it("treats changes to the parent QA-gated workflow as affecting every deploy surface", () => {
    expect(detectSurfacesFromFiles([".github/workflows/qa-gated-prod-deploy.yml"])).toEqual({
      ui: true,
      control: true,
      sandbox: true,
      ssm: false,
    });
  });

  it("fans out requested QA jobs and fails closed through an explicit qa-gate", () => {
    const workflow = loadWorkflow(GATE);

    expect(workflow.jobs["qa-control"].uses).toBe("./.github/workflows/deploy-control-plane-core.yml");
    expect(workflow.jobs["qa-control"].if).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(workflow.jobs["qa-control"].permissions).toMatchObject({
      contents: "read",
      "id-token": "write",
      statuses: "read",
    });
    expect(workflow.jobs["qa-sandbox"].uses).toBe("./.github/workflows/deploy-e2b-sandbox-core.yml");
    expect(workflow.jobs["qa-sandbox"].if).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(workflow.jobs["qa-ui"].uses).toBe("./.github/workflows/deploy-ui-core.yml");
    expect(workflow.jobs["qa-ui"].if).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(workflow.jobs["qa-gate"].if).toBe("${{ always() && needs.detect-surfaces.outputs.skip != 'true' }}");
    expect(needs(workflow.jobs["qa-gate"])).toEqual(["detect-surfaces", "qa-control", "qa-sandbox", "qa-ui"]);
    expect(workflow.jobs["qa-gate"].steps?.[0]?.run).toContain("was requested but result=");
  });

  it("runs production control-plane in parallel with E2B template build and registers after both", () => {
    const workflow = loadWorkflow(GATE);

    expect(needs(workflow.jobs["prod-sandbox"])).toEqual(["detect-surfaces", "qa-gate"]);
    expect(needs(workflow.jobs["prod-control"])).toEqual(["detect-surfaces", "qa-gate"]);
    expect(needs(workflow.jobs["prod-sandbox-register"])).toEqual([
      "detect-surfaces",
      "qa-gate",
      "prod-sandbox",
      "prod-control",
    ]);
    expect(needs(workflow.jobs["prod-ui"])).toEqual(["detect-surfaces", "qa-gate", "prod-control"]);
    expect(workflow.jobs["prod-sandbox"].with).toMatchObject({
      run_template_build: true,
      register_base_templates: false,
    });
    expect(workflow.jobs["prod-sandbox-register"].with).toMatchObject({
      run_template_build: false,
      register_base_templates: true,
    });
  });

  it("keeps production deploy conditions correct when requested surfaces are skipped", () => {
    const workflow = loadWorkflow(GATE);
    const controlIf = workflow.jobs["prod-control"].if ?? "";
    const sandboxIf = workflow.jobs["prod-sandbox"].if ?? "";
    const registerIf = workflow.jobs["prod-sandbox-register"].if ?? "";
    const uiIf = workflow.jobs["prod-ui"].if ?? "";

    expect(controlIf).toContain("always()");
    expect(controlIf).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(controlIf).toContain("needs.detect-surfaces.outputs.control == 'true'");
    expect(controlIf).not.toContain("needs.prod-sandbox");

    expect(sandboxIf).toContain("always()");
    expect(sandboxIf).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(sandboxIf).toContain("needs.detect-surfaces.outputs.sandbox == 'true'");

    expect(registerIf).toContain("always()");
    expect(registerIf).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(registerIf).toContain("needs.detect-surfaces.outputs.sandbox == 'true'");
    expect(registerIf).toContain("needs.prod-sandbox.result == 'success'");
    expect(registerIf).toContain("needs.detect-surfaces.outputs.control != 'true'");
    expect(registerIf).toContain("needs.prod-control.result == 'success'");

    expect(uiIf).toContain("always()");
    expect(uiIf).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(uiIf).toContain("needs.detect-surfaces.outputs.ui == 'true'");
    expect(uiIf).toContain("needs.detect-surfaces.outputs.control != 'true'");
    expect(uiIf).toContain("needs.prod-control.result == 'success'");
  });

  it("passes SSM sequencing flags only into prod control-plane", () => {
    const workflow = loadWorkflow(GATE);

    expect(workflow.jobs["prod-control"].with).toMatchObject({
      environment: "production",
      ref: "${{ github.sha }}",
      force_deploy: false,
      sync_secrets: "${{ needs.detect-surfaces.outputs.ssm == 'true' }}",
      wait_for_tfc: "${{ needs.detect-surfaces.outputs.ssm == 'true' }}",
      notify_slack: false,
    });
    expect(workflow.jobs["prod-sandbox"].with).toMatchObject({ force_rebuild: false, notify_slack: false });
    expect(workflow.jobs["prod-sandbox-register"].with).toMatchObject({ force_rebuild: false, notify_slack: false });
    expect(workflow.jobs["prod-ui"].with).toMatchObject({ notify_slack: false });
  });

  it("keeps grouped Slack notifications parent-owned and always evaluated", () => {
    const workflow = loadWorkflow(GATE);

    expect(workflow.jobs["notify-success"].if).toContain("always()");
    expect(workflow.jobs["notify-success"].if).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(workflow.jobs["notify-success"].if).toContain("needs.detect-surfaces.result == 'success'");
    expect(workflow.jobs["notify-failure"].if).toContain("always()");
    expect(workflow.jobs["notify-failure"].if).toContain("needs.detect-surfaces.outputs.skip != 'true'");
    expect(workflow.jobs["notify-failure"].if).toContain("needs.detect-surfaces.result == 'failure'");
    expect(workflow.jobs["notify-failure"].if).toContain("needs.detect-surfaces.result == 'cancelled'");
    expect(needs(workflow.jobs["notify-success"])).toContain("qa-gate");
    expect(needs(workflow.jobs["notify-failure"])).toContain("prod-sandbox");
    expect(needs(workflow.jobs["notify-success"])).toContain("prod-sandbox-register");
    expect(needs(workflow.jobs["notify-failure"])).toContain("prod-sandbox-register");
    expect(workflow.jobs["notify-success"].if).toContain("needs.prod-sandbox-register.result == 'success'");
    expect(workflow.jobs["notify-failure"].if).toContain("needs.prod-sandbox-register.result == 'failure'");
    expect(workflow.jobs["notify-failure"].if).toContain("needs.prod-sandbox-register.result == 'cancelled'");
    expect(workflow.jobs["notify-success"].steps?.at(-1)?.run).toContain("*QA + PROD deploy*");
    expect(workflow.jobs["notify-success"].steps?.at(-1)?.run).toContain("RANGE_TEXT");
    expect(workflow.jobs["notify-failure"].steps?.at(-1)?.run).toContain("*QA + PROD deploy blocked*");
    expect(workflow.jobs["notify-failure"].steps?.at(-1)?.run).toContain("failed_service=");
    expect(workflow.jobs["notify-failure"].steps?.at(-1)?.run).toContain("set_failed_service");
    expect(workflow.jobs["notify-failure"].steps?.at(-1)?.run).toContain("PROD E2B Sandbox registration");
  });

  it("advances the prod deployed marker only after the grouped deploy succeeds", () => {
    const workflow = loadWorkflow(GATE);
    const marker = workflow.jobs["advance-prod-deployed-marker"];

    expect(marker.permissions).toMatchObject({ contents: "write" });
    expect(marker.if).toBe(workflow.jobs["notify-success"].if);
    expect(needs(marker)).toEqual([
      "detect-surfaces",
      "qa-control",
      "qa-sandbox",
      "qa-ui",
      "qa-gate",
      "prod-control",
      "prod-sandbox",
      "prod-sandbox-register",
      "prod-ui",
    ]);
    expect(marker.steps?.at(-1)?.run).toContain('git merge-base --is-ancestor "$SHA" "$current_marker"');
    expect(marker.steps?.at(-1)?.run).toContain('git tag -f "$MARKER_REF" "$SHA"');
    expect(marker.steps?.at(-1)?.run).toContain("GITHUB_STEP_SUMMARY");
  });
});
