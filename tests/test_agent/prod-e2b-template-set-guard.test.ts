import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/guard-prod-e2b-template-set.sh");

let repoDir: string;

function run(command: string, args: string[], options: { check?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

function writeTemplateBuildScript(repoSpecs: string[]) {
  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  const body = `#!/usr/bin/env bash
set -euo pipefail
repo_sandbox_resource_specs=(${repoSpecs.map((spec) => `"${spec}"`).join(" ")})
`;
  const path = join(repoDir, "scripts/e2b-template-build.sh");
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeWranglerTemplateStem(stem: string) {
  mkdirSync(join(repoDir, "apps/control-plane-worker"), { recursive: true });
  writeFileSync(
    join(repoDir, "apps/control-plane-worker/wrangler.toml"),
    `name = "cycloid-control-plane"\nE2B_SANDBOX_TEMPLATE = "${stem}"\n\n[env.qa.vars]\nE2B_SANDBOX_TEMPLATE = "cycloid-sandbox-qa"\n`,
  );
}

function writeApprovedTemplates(templates: string[]) {
  mkdirSync(join(repoDir, ".github"), { recursive: true });
  writeFileSync(join(repoDir, ".github/e2b-prebuilt-prod-templates.txt"), `${templates.join("\n")}\n`);
}

function commit(message: string): string {
  run("git", ["add", "scripts/e2b-template-build.sh", "apps/control-plane-worker/wrangler.toml"]);
  run("git", ["add", ".github/e2b-prebuilt-prod-templates.txt"], { check: false });
  run("git", ["commit", "-m", message]);
  return run("git", ["rev-parse", "HEAD"]).stdout.trim();
}

function runGuard(base: string, head: string, extraArgs: string[] = []) {
  return spawnSync("bash", [SCRIPT, "--base", base, "--head", head, ...extraArgs], {
    cwd: repoDir,
    encoding: "utf8",
  });
}

describe("production E2B template-set guard", () => {
  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "prod-template-guard-"));
    run("git", ["init", "-q"]);
    run("git", ["config", "user.email", "test@example.com"]);
    run("git", ["config", "user.name", "Test User"]);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("passes when the resolved production template IDs are unchanged", () => {
    writeWranglerTemplateStem("arc-default-template");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4"]);
    const base = commit("base");

    const result = runGuard(base, base);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unchanged");
  });

  it("fails when head introduces a new resolved production template ID", () => {
    writeWranglerTemplateStem("arc-default-template");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4"]);
    const base = commit("base");
    writeWranglerTemplateStem("arc-default-template-v2");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4"]);
    const head = commit("head");

    const result = runGuard(base, head);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("arc-default-template-v2-mem4096-cpu2");
    expect(result.stdout).toContain("e2b-template-prebuilt");
  });

  it("fails under the prebuilt label when a new template ID is not listed in the annotation file", () => {
    writeWranglerTemplateStem("arc-default-template");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4"]);
    const base = commit("base");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4", "openevidence/xyla:16384:4"]);
    const head = commit("head");

    const result = runGuard(base, head, ["--allow-new-prod-template"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("arc-default-template-mem16384-cpu4");
    expect(result.stdout).toContain(".github/e2b-prebuilt-prod-templates.txt");
  });

  it("allows new resolved production template IDs only when the annotation file lists them", () => {
    writeWranglerTemplateStem("arc-default-template");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4"]);
    const base = commit("base");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4", "openevidence/xyla:16384:4"]);
    writeApprovedTemplates(["arc-default-template-mem16384-cpu4"]);
    const head = commit("head");

    const result = runGuard(base, head, ["--allow-new-prod-template"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("arc-default-template-mem16384-cpu4");
    expect(result.stdout).toContain("::warning::");
  });

  it("does not execute the head ref build script while computing template IDs", () => {
    writeWranglerTemplateStem("arc-default-template");
    writeTemplateBuildScript(["trycycloid/cycloid:8192:4"]);
    const base = commit("base");
    writeFileSync(join(repoDir, "scripts/e2b-template-build.sh"), "#!/usr/bin/env bash\nexit 42\n");
    chmodSync(join(repoDir, "scripts/e2b-template-build.sh"), 0o755);
    const head = commit("head");

    const result = runGuard(base, head);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unchanged");
  });
});
