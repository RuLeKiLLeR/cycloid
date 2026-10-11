import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const EVENT_GATED_ACTOR = "${{ github.event_name != 'schedule' && github.actor || '' }}";

type Step = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
};

type Workflow = {
  jobs: Record<string, { steps: Step[] }>;
};

function loadWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf-8")) as Workflow;
}

function stepByName(path: string, jobName: string, stepName: string): Step {
  const step = loadWorkflow(path).jobs[jobName].steps.find((candidate) => candidate.name === stepName);
  expect(step, `${path} should define step "${stepName}"`).toBeDefined();
  return step as Step;
}

function expectSlackPostShape(step: Step): void {
  const run = step.run ?? "";

  expect(run).toContain('if [ -z "$SLACK_WEBHOOK_URL" ]; then exit 0; fi');
  expect(run).toContain("PAYLOAD=$(jq -n");
  expect(run).toContain("'{text: $text}'");
  expect(run).toContain('curl -s -X POST "$SLACK_WEBHOOK_URL"');
  expect(run).toContain("-H 'Content-Type: application/json'");
  expect(run).toContain('-d "$PAYLOAD"');
}

describe("CI failure Slack notifications", () => {
  it.each([
    {
      path: resolve(".github/workflows/prod-e2b-verifier.yml"),
      job: "verify",
      step: "Notify Slack on failure",
    },
  ])("$path routes failure mentions through an event-gated actor", ({ path, job, step: stepName }) => {
    const step = stepByName(path, job, stepName);
    const run = step.run ?? "";

    expect(step.env?.ACTOR).toBe(EVENT_GATED_ACTOR);
    expect(run).toContain('MENTION="$(bash scripts/deploy-slack-mention.sh "$ACTOR"');
    expect(run).toContain('echo " cc <@U0AHT782S65> <@U0AHJCUSM70>"');
    expect(run).toContain("${MENTION}");
    expectSlackPostShape(step);
  });

  it("event-gates every prod verifier Slack actor env", () => {
    const workflow = loadWorkflow(resolve(".github/workflows/prod-e2b-verifier.yml"));
    const slackSteps = workflow.jobs.verify.steps.filter((step) => step.env?.SLACK_WEBHOOK_URL);

    expect(slackSteps.map((step) => step.name)).toEqual([
      "Notify Slack on success",
      "Notify Slack test alert",
      "Notify Slack on failure",
    ]);
    for (const step of slackSteps) {
      expect(step.env?.ACTOR, `${step.name} should not attribute schedule runs to github.actor`).toBe(
        EVENT_GATED_ACTOR,
      );
      expectSlackPostShape(step);
    }
  });
});
