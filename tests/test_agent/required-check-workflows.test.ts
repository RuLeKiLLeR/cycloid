import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on?: {
    pull_request?: {
      paths?: string[];
      "paths-ignore"?: string[];
    };
  };
  jobs: Record<string, unknown>;
};

const REQUIRED_CHECK_WORKFLOWS = [
  {
    path: ".github/workflows/typecheck.yml",
    context: "typecheck",
  },
  {
    path: ".github/workflows/ratchet-tests.yml",
    context: "ratchet-tests",
  },
  {
    path: ".github/workflows/secret-scan.yml",
    context: "gitleaks",
  },
  {
    path: ".github/workflows/backend-tests.yml",
    context: "workerd",
  },
] as const;

const REQUIRED_CHECK_CONTEXTS = ["build", "lint", "test", "typecheck", "gitleaks", "ratchet-tests", "workerd"] as const;

function loadWorkflow(path: string): Workflow {
  return parse(readFileSync(resolve(path), "utf-8")) as Workflow;
}

describe("required check workflows", () => {
  // Keep required checks running after a base retarget.
  it("keeps the required-check candidate set unique and complete", () => {
    expect(new Set(REQUIRED_CHECK_CONTEXTS).size).toBe(REQUIRED_CHECK_CONTEXTS.length);
    expect(REQUIRED_CHECK_CONTEXTS).toEqual(expect.arrayContaining(["typecheck", "gitleaks", "ratchet-tests"]));
  });

  it("keeps required-check candidates always reporting on pull requests", () => {
    for (const workflow of REQUIRED_CHECK_WORKFLOWS) {
      const parsed = loadWorkflow(workflow.path);

      expect(parsed.jobs[workflow.context], `${workflow.path} must define ${workflow.context}`).toBeDefined();
      expect(parsed.on?.pull_request, `${workflow.path} must run on pull_request`).toBeDefined();
      expect(parsed.on?.pull_request?.paths, `${workflow.path} must not use pull_request.paths`).toBeUndefined();
      expect(
        parsed.on?.pull_request?.["paths-ignore"],
        `${workflow.path} must not use pull_request.paths-ignore`,
      ).toBeUndefined();
    }
  });
});
