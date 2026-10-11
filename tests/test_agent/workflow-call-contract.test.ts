import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_DIR = resolve(".github/workflows");

type WorkflowCallInput = { type?: "boolean" | "number" | "string"; required?: boolean };
type WorkflowCallSecret = { required?: boolean };
type Workflow = {
  on?: {
    workflow_call?: {
      inputs?: Record<string, WorkflowCallInput>;
      secrets?: Record<string, WorkflowCallSecret>;
    };
  };
  jobs?: Record<
    string,
    {
      uses?: string;
      with?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
    }
  >;
};

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((file) => resolve(WORKFLOW_DIR, file));
}

function loadWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf-8")) as Workflow;
}

function localWorkflowPath(uses: string): string | null {
  const match = uses.match(/^\.\/(.+\.ya?ml)$/);
  return match ? resolve(match[1]) : null;
}

describe("local reusable workflow calls", () => {
  it("passes only declared inputs and supplies required secrets", () => {
    for (const callerPath of workflowFiles()) {
      const caller = loadWorkflow(callerPath);
      for (const [jobName, job] of Object.entries(caller.jobs ?? {})) {
        if (!job.uses) continue;

        const calleePath = localWorkflowPath(job.uses);
        if (!calleePath) continue;

        const callee = loadWorkflow(calleePath);
        const contract = callee.on?.workflow_call;
        expect(
          contract,
          `${callerPath} job ${jobName} calls ${job.uses}, which must declare workflow_call`,
        ).toBeDefined();

        const declaredInputs = contract?.inputs ?? {};
        for (const inputName of Object.keys(job.with ?? {})) {
          expect(declaredInputs, `${callerPath} job ${jobName} passes undeclared input ${inputName}`).toHaveProperty(
            inputName,
          );
        }
        for (const [inputName, input] of Object.entries(declaredInputs)) {
          if (input.required) {
            expect(job.with ?? {}, `${callerPath} job ${jobName} must pass required input ${inputName}`).toHaveProperty(
              inputName,
            );
          }
        }

        const declaredSecrets = contract?.secrets ?? {};
        for (const secretName of Object.keys(job.secrets ?? {})) {
          expect(declaredSecrets, `${callerPath} job ${jobName} passes undeclared secret ${secretName}`).toHaveProperty(
            secretName,
          );
        }
        for (const [secretName, secret] of Object.entries(declaredSecrets)) {
          if (secret.required) {
            expect(
              job.secrets ?? {},
              `${callerPath} job ${jobName} must pass required secret ${secretName}`,
            ).toHaveProperty(secretName);
          }
        }
      }
    }
  });
});
