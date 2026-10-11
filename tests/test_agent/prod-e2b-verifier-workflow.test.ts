import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const VERIFIER = resolve(".github/workflows/prod-e2b-verifier.yml");
const DEADMAN = resolve(".github/workflows/prod-e2b-verifier-deadman.yml");
const CONTROL_PLANE = resolve(".github/workflows/deploy-control-plane.yml");
const E2B_SANDBOX = resolve(".github/workflows/deploy-e2b-sandbox.yml");
const QA_GATED_PROD = resolve(".github/workflows/qa-gated-prod-deploy.yml");

type Triggers = {
  workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] };
  schedule?: { cron: string }[];
  workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } | null;
};

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};

type VerifierWorkflow = {
  on: Triggers;
  permissions?: Record<string, string>;
  jobs: { verify: { if?: string; env?: Record<string, string>; steps: Step[] } };
};

function loadWorkflow<T>(path: string): T {
  return parse(readFileSync(path, "utf-8")) as T;
}

function verifySteps(): Step[] {
  return loadWorkflow<VerifierWorkflow>(VERIFIER).jobs.verify.steps;
}

function stepByName(name: string): Step | undefined {
  return verifySteps().find((step) => step.name === name);
}

// The condition gating the expensive smoke steps, whitespace-normalized.
function smokeStepGuard(name: string): string {
  return (stepByName(name)?.if ?? "").replace(/\s+/g, " ").trim();
}

function workflowName(path: string): string {
  return loadWorkflow<{ name: string }>(path).name;
}

describe("prod PR smoke test workflow", () => {
  it("triggers on completion of prod deploy workflows and the parent QA-gated DAG by their real names", () => {
    const workflow = loadWorkflow<VerifierWorkflow>(VERIFIER);
    const names = workflow.on.workflow_run?.workflows ?? [];

    // Pinned to the actual upstream `name:` fields so a rename there breaks this
    // test instead of silently disabling the deploy-triggered run in prod.
    expect(names).toContain(workflowName(CONTROL_PLANE));
    expect(names).toContain(workflowName(E2B_SANDBOX));
    expect(names).toContain(workflowName(QA_GATED_PROD));
    expect(names).toHaveLength(3);
    expect(workflow.on.workflow_run?.types).toEqual(["completed"]);
    expect(workflow.on.workflow_run?.branches).toEqual(["main"]);
  });

  it("only runs deploy-triggered jobs for successful push/dispatch upstream runs", () => {
    const guard = (loadWorkflow<VerifierWorkflow>(VERIFIER).jobs.verify.if ?? "").replace(/\s+/g, " ").trim();

    // Non-workflow_run events (schedule, dispatch) always run.
    expect(guard).toContain("github.event_name != 'workflow_run'");
    // Deploy-triggered runs require a real successful prod deploy...
    expect(guard).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(guard).toContain("github.event.workflow_run.event == 'push'");
    expect(guard).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    // ...and must NOT admit validate-only pull_request runs of the upstream workflow.
    expect(guard).not.toContain("pull_request");
  });

  it("keeps a single every-3h liveness heartbeat and drops the old frequent cron", () => {
    const schedule = loadWorkflow<VerifierWorkflow>(VERIFIER).on.schedule ?? [];
    const crons = schedule.map((entry) => entry.cron);

    expect(crons).toHaveLength(1);
    const [cron] = crons;
    // Every 3h: fixed minute, `*/3` hour step. This is a cheap liveness tick for
    // the dead-man switch, not a smoke run (smoke steps are gated off below).
    expect(cron).toMatch(/^\d+ \*\/3 \* \* \*$/);
    // No multi-entry / old frequent cron (the cost we are cutting).
    expect(cron).not.toContain(",");
  });

  it("gates the expensive smoke steps to deploy/manual events and excludes schedule", () => {
    // The smoke must run for deploy-triggered (workflow_run) or manual non-test
    // dispatch, and NEVER for schedule (which is liveness-only). Each expensive
    // step carries the same compound guard.
    const expensiveSteps = ["Verify token secret is configured", "Install dependencies", "Run prod PR smoke test"];
    for (const name of expensiveSteps) {
      const guard = smokeStepGuard(name);
      expect(guard, `${name} should be present with an if: guard`).not.toBe("");
      // Only deploy-triggered or manual (non-test) dispatch reach the smoke...
      expect(guard).toContain("github.event_name == 'workflow_run'");
      expect(guard).toContain("github.event_name == 'workflow_dispatch'");
      expect(guard).toContain("!inputs.test_alert");
      // ...and a cooldown skip suppresses the expensive work.
      expect(guard).toContain("steps.cooldown.outputs.skip != 'true'");
      expect(guard).toContain("steps.deploy_surface.outputs.run_smoke != 'false'");
      // schedule is neither workflow_run nor workflow_dispatch, so it is excluded
      // structurally; assert the guard never names the schedule event as eligible.
      expect(guard).not.toContain("schedule");
    }
  });

  it("skips QA-gated parent runs that did not deploy production control-plane or E2B", () => {
    const surfaceGate = stepByName("Determine deploy smoke eligibility");

    expect(surfaceGate?.if).toBe("${{ github.event_name == 'workflow_run' }}");
    expect(surfaceGate?.run).toContain('UPSTREAM_WORKFLOW_NAME" != "QA-Gated Production Deploy"');
    expect(surfaceGate?.run).toContain('name == "Prod Control Plane"');
    expect(surfaceGate?.run).toContain('startswith("Prod Control Plane / ")');
    expect(surfaceGate?.run).toContain('name == "Prod E2B Sandbox"');
    expect(surfaceGate?.run).toContain('startswith("Prod E2B Sandbox / ")');
    expect(surfaceGate?.run).toContain('name == "Prod E2B Sandbox Registration"');
    expect(surfaceGate?.run).toContain('startswith("Prod E2B Sandbox Registration / ")');
    expect(surfaceGate?.run).toContain("run_smoke=false");
  });

  it("computes a 30-min cooldown from this workflow's own run artifacts", () => {
    const workflow = loadWorkflow<VerifierWorkflow>(VERIFIER);

    // Reading run history/artifacts requires actions:read.
    expect(workflow.permissions?.actions).toBe("read");

    const cooldown = workflow.jobs.verify.steps.find((step) => step.id === "cooldown");
    expect(cooldown, "a step with id: cooldown must exist").toBeDefined();
    // Cooldown only applies to deploy-triggered runs; manual dispatch bypasses it
    // and schedule never reaches the smoke.
    expect((cooldown?.if ?? "").replace(/\s+/g, " ")).toContain("github.event_name == 'workflow_run'");
    // Authenticated to the GitHub API like the dead-man step.
    expect(cooldown?.env?.GH_TOKEN).toBe("${{ github.token }}");
    // 30-minute window.
    expect(cooldown?.env?.COOLDOWN_SECONDS).toBe("1800");

    const run = cooldown?.run ?? "";
    // Keys off this workflow's own uploaded artifacts (name-scoped), not a blunt
    // total_count, so unrelated artifacts cannot masquerade as a smoke.
    expect(run).toContain("/actions/artifacts");
    expect(run).toContain('startswith("prod-pr-smoke-")');
    // Ignores expired artifacts and the current run.
    expect(run).toContain(".expired == false");
    expect(run).toContain("skip=");
  });

  it("writes a smoke-attempt marker before running so failed smokes still trip cooldown", () => {
    // The verifier report is written only on success; a marker written before the
    // smoke ensures a failed attempt still produces a prod-pr-smoke-* artifact,
    // so the cooldown counts attempts (not just passes) and avoids a retry storm.
    const run = stepByName("Run prod PR smoke test")?.run ?? "";
    expect(run).toContain("-attempt.json");
    // Marker is written before the verifier is invoked.
    const markerIdx = run.indexOf("-attempt.json");
    const verifierIdx = run.indexOf("verify-e2b-session.ts");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(verifierIdx).toBeGreaterThan(markerIdx);
  });

  it("labels each run kind distinctly for Slack attribution", () => {
    const runKind = loadWorkflow<VerifierWorkflow>(VERIFIER).jobs.verify.env?.RUN_KIND ?? "";

    expect(runKind).toContain("workflow_dispatch");
    expect(runKind).toContain("manual");
    expect(runKind).toContain("workflow_run");
    expect(runKind).toContain("deploy-triggered");
    expect(runKind).toContain("heartbeat");
    // Includes the upstream workflow name on deploy-triggered runs.
    expect(runKind).toContain("github.event.workflow_run.name");
  });

  it("preserves the manual test-alert dispatch path", () => {
    const dispatch = loadWorkflow<VerifierWorkflow>(VERIFIER).on.workflow_dispatch;

    expect(dispatch?.inputs?.test_alert).toBeDefined();
    expect(dispatch?.inputs?.test_alert?.type).toBe("boolean");
    expect(dispatch?.inputs?.test_alert?.default).toBe(false);
  });
});

describe("prod PR smoke test dead-man switch", () => {
  it("watches the verifier workflow on its own schedule and alerts when stale", () => {
    const workflow = loadWorkflow<{ on: Triggers }>(DEADMAN);
    const text = readFileSync(DEADMAN, "utf-8");

    // Scheduled independently so it can detect a disabled/broken verifier cron.
    expect(workflow.on.schedule ?? []).not.toHaveLength(0);
    // Asserts liveness of the verifier workflow file, not some unrelated job.
    expect(text).toContain("prod-e2b-verifier.yml");
    expect(text).toContain("MAX_AGE_HOURS");
    // Reads run history (needs actions:read) and pings Slack on staleness.
    expect(text).toContain("actions: read");
    expect(text).toContain("SLACK_WEBHOOK_URL");
  });
});
