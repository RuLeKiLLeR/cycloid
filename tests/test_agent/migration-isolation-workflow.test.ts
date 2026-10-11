import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = resolve(".github/workflows/migration-isolation.yml");

type Step = {
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: {
    "migration-isolation": {
      steps: Step[];
    };
  };
};

function loadWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf-8")) as Workflow;
}

function loadWorkflowSource(): string {
  return readFileSync(WORKFLOW, "utf-8");
}

function forbiddenReference(parts: string[]): string {
  return parts.join("");
}

describe("migration isolation workflow", () => {
  it("gates migration validation on SQL migrations only", () => {
    const source = loadWorkflowSource();

    expect(source).toContain('echo "has_sql_migration=$HAS_SQL_MIGRATION"');
    expect(source).toContain('if [ "$HAS_SQL_MIGRATION" = "false" ]; then');
    expect(source).toContain("No migration files in this PR -- skipping check.");
    expect(source).not.toContain("has_migration_lock");
    expect(source).not.toContain("HAS_MIGRATION_LOCK");
    expect(source).not.toContain(forbiddenReference(["migration-", "lock.txt"]));
    expect(source).not.toContain(forbiddenReference(["npm run migration", ":lock"]));
  });

  it("runs retained migration checks only when SQL migrations are present", () => {
    const steps = loadWorkflow().jobs["migration-isolation"].steps;
    const guardedSteps = [
      steps.find((step) => step.uses === "actions/setup-node@v6"),
      steps.find((step) => step.name === "Cache node_modules"),
      steps.find((step) => step.name === "Install dependencies"),
      steps.find((step) => step.name === "Merge PR head with latest target branch before validation"),
      steps.find((step) => step.name === "Check migration integrity (unique prefixes, sequential numbering)"),
      steps.find((step) => step.name === "Validate migrations apply from empty local D1"),
    ];

    expect(guardedSteps).not.toContain(undefined);
    for (const step of guardedSteps) {
      expect(step?.if).toContain("steps.migration_check.outputs.has_sql_migration == 'true'");
      expect(step?.if).not.toContain("has_migration_lock");
    }
  });

  it("validates migrations on the current target-branch merge tree", () => {
    const steps = loadWorkflow().jobs["migration-isolation"].steps;
    const checkout = steps.find((step) => step.uses === "actions/checkout@v7");
    const migrationCheck = steps.find((step) => step.name === "Ensure migration PRs contain only migration files");
    const mergeBeforeValidation = steps.find(
      (step) => step.name === "Merge PR head with latest target branch before validation",
    );

    expect(checkout).toMatchObject({
      with: {
        ref: "${{ github.event.pull_request.head.sha }}",
        "fetch-depth": 0,
      },
    });
    expect(migrationCheck?.run).toContain("git fetch origin ${{ github.event.pull_request.base.ref }}");
    expect(migrationCheck?.run).toContain(
      'BASE=$(git merge-base origin/${{ github.event.pull_request.base.ref }} "$HEAD")',
    );
    expect(mergeBeforeValidation?.run).toContain("git fetch origin ${{ github.event.pull_request.base.ref }}");
    expect(mergeBeforeValidation?.run).toContain("git checkout --detach ${{ github.event.pull_request.head.sha }}");
    expect(mergeBeforeValidation?.run).toContain(
      "git merge --no-edit --no-commit origin/${{ github.event.pull_request.base.ref }}",
    );
  });
});
