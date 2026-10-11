import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = path.resolve(import.meta.dirname, "../../scripts/typecheck-workflows.mjs");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepoWithWorkflow(source: string) {
  const repoDir = mkdtempSync(path.join(tmpdir(), "workflow-typecheck-"));
  tempDirs.push(repoDir);
  const workflowDir = path.join(repoDir, ".github", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(path.join(workflowDir, "workflow.yml"), source);
  return repoDir;
}

function runTypecheck(repoDir: string) {
  try {
    execFileSync("node", [scriptPath], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return undefined;
  } catch (error) {
    return error as Error & { stderr?: string };
  }
}

describe("typecheck-workflows script", () => {
  it("fails when a workflow file contains invalid YAML", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "workflow-typecheck-"));
    tempDirs.push(repoDir);
    const workflowDir = path.join(repoDir, ".github", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      path.join(workflowDir, "broken.yml"),
      ["name: Broken workflow", "on:", "  pull_request:", "    branches: [main", "jobs: {}", ""].join("\n"),
    );

    const error = runTypecheck(repoDir);

    expect(error).toBeDefined();
    expect((error as Error & { stderr?: string }).stderr).toContain(".github/workflows/broken.yml(");
    expect((error as Error & { stderr?: string }).stderr).toContain("ARCYAML1000");
  });

  it("fails when a third-party GitHub Action is pinned to a mutable tag", () => {
    const repoDir = makeRepoWithWorkflow(
      [
        "name: Mutable third-party action",
        "on:",
        "  pull_request:",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: aws-actions/configure-aws-credentials@v6",
        "",
      ].join("\n"),
    );

    const error = runTypecheck(repoDir);

    expect(error).toBeDefined();
    expect(error?.stderr).toContain("ARCWF1001");
    expect(error?.stderr).toContain("aws-actions/configure-aws-credentials@v6");
  });

  it("fails when a quoted third-party GitHub Action is pinned to a mutable tag", () => {
    const repoDir = makeRepoWithWorkflow(
      [
        "name: Quoted mutable third-party action",
        "on:",
        "  pull_request:",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        '      - uses: "aws-actions/configure-aws-credentials@v6"',
        "",
      ].join("\n"),
    );

    const error = runTypecheck(repoDir);

    expect(error).toBeDefined();
    expect(error?.stderr).toContain("ARCWF1001");
    expect(error?.stderr).toContain("aws-actions/configure-aws-credentials@v6");
  });

  it("allows first-party tags, local workflow calls, and third-party SHA pins", () => {
    const repoDir = makeRepoWithWorkflow(
      [
        "name: Pinned third-party action",
        "on:",
        "  pull_request:",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v7",
        "      - uses: hashicorp/setup-terraform@0123456789abcdef0123456789abcdef01234567 # v4.0.1",
        "  reuse:",
        "    uses: ./.github/workflows/reusable.yml",
        "",
      ].join("\n"),
    );

    const error = runTypecheck(repoDir);

    expect(error).toBeUndefined();
  });
});
