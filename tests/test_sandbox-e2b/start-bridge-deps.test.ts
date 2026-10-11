import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  baseEnv,
  cleanupTempDirs,
  CLONE_TOKEN,
  makeTempDir,
  START_BRIDGE,
  writeFakeExecutable,
} from "./start-bridge-helpers";

afterEach(cleanupTempDirs);

describe("E2B start-bridge script", () => {
  const scrubbedRepoEnv = [
    "SANDBOX_AUTH_TOKEN",
    "ARCANIST_TOKEN",
    "ARCANIST_ADMIN_TOKEN",
    "ARCANIST_RUNTIME_AUTH_PROOF",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "ARCANIST_OPENAI_API_KEY",
    "ARCANIST_CODEX_AUTH_JSON",
    "ANTHROPIC_API_KEY",
    "ARCANIST_ANTHROPIC_API_KEY",
    "BASETEN_API_KEY",
    "ARCANIST_BASETEN_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_USER_TOKEN",
    "DD_API_KEY",
    "DD_APP_KEY",
    "BRAINTRUST_API_KEY",
    "SANDBOX_CALLBACK_SECRET",
    "SANDBOX_RUNTIME_CLEANUP_SECRET",
    "LINEAR_ACCESS_TOKEN",
    "JIRA_ACCESS_TOKEN",
    "NOTION_ACCESS_TOKEN",
    "SENTRY_ACCESS_TOKEN",
    "CLOUDFLARE_API_TOKEN",
    "LAUNCHDARKLY_ACCESS_TOKEN",
    "VERCEL_ACCESS_TOKEN",
    "STRIPE_SECRET_KEY",
    "ARCANIST_TERRAFORM_PLAN_TOKEN",
  ];

  it("scrubs Cycloid-owned credentials from dependency lifecycle environments", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    const envDump = join(dir, "install-env");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFileSync(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFakeExecutable(
      binDir,
      "pnpm",
      `#!/usr/bin/env bash
set -euo pipefail
{
  for name in ${scrubbedRepoEnv.join(" ")}; do echo "$name=\${!name:-UNSET}"; done
  echo "GITHUB_CLONE_TOKEN=\${GITHUB_CLONE_TOKEN:-UNSET}"
} > "${envDump}"
mkdir -p "${repoPath}/node_modules"
`,
    );
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...Object.fromEntries(scrubbedRepoEnv.map((name) => [name, `sentinel-${name}`])),
    };

    execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const dump = readFileSync(envDump, "utf8");
    for (const name of scrubbedRepoEnv) expect(dump).toContain(`${name}=UNSET`);
    expect(dump).toContain(`GITHUB_CLONE_TOKEN=${CLONE_TOKEN}`);
  });

  it("runs pnpm install for pnpm-lock repos before marking workspace setup ready", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFileSync(join(repoPath, "package.json"), '{"scripts":{"typecheck":"pnpm -r do-typecheck"}}\n');
    writeFileSync(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const pnpmLog = join(dir, "pnpm.log");
    const readyPath = join(dir, "workspace-ready");
    writeFakeExecutable(
      binDir,
      "pnpm",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${pnpmLog}"
mkdir -p "${repoPath}/node_modules"
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
for _ in 1 2 3 4 5; do
  if [ -f "${readyPath}" ]; then
    echo "bridge-ok"
    exit 0
  fi
  sleep 0.2
done
echo "workspace setup was not marked ready" >&2
exit 3
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_WORKSPACE_SETUP_READY_PATH: readyPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] pnpm.install_start reason=fresh_clone_background");
    expect(output).toContain("[start-bridge] pnpm.install_complete reason=fresh_clone_background");
    expect(output).toContain("bridge-ok");
    expect(readFileSync(pnpmLog, "utf8")).toContain("install --frozen-lockfile");
  });

  it("writes a sanitized setup-timing breadcrumb for the dependency install", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFileSync(join(repoPath, "package.json"), "{}\n");
    writeFileSync(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

    const readyPath = join(dir, "workspace-ready");
    const timingsPath = join(dir, "setup-timings");
    writeFakeExecutable(
      binDir,
      "pnpm",
      `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${repoPath}/node_modules"
`,
    );
    // node fake blocks until ready so the backgrounded install (which writes the
    // timing file just before marking ready) has completed by the time we read.
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
for _ in 1 2 3 4 5; do
  if [ -f "${readyPath}" ]; then echo "bridge-ok"; exit 0; fi
  sleep 0.2
done
echo "workspace setup was not marked ready" >&2
exit 3
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_WORKSPACE_SETUP_READY_PATH: readyPath,
      ARCANIST_SETUP_TIMINGS_PATH: timingsPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const timings = readFileSync(timingsPath, "utf8");
    expect(timings).toContain("setup_kind=pnpm");
    expect(timings).toMatch(/setup_ms=\d+/);
    // Breadcrumb must stay sanitized: no repo content, paths, or token.
    expect(timings).not.toContain(CLONE_TOKEN);
    expect(timings).not.toContain(repoPath);
  });

  it("records a zero-duration skip breadcrumb when node_modules already exist (existing-deps reuse)", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFileSync(join(repoPath, "package-lock.json"), "{}\n");
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });

    const timingsPath = join(dir, "setup-timings");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      ARCANIST_SETUP_TIMINGS_PATH: timingsPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("npm.ci_skip");
    const timings = readFileSync(timingsPath, "utf8");
    expect(timings).toContain("setup_kind=npm_skip_existing");
    expect(timings).toContain("setup_ms=0");
  });

  it("reuses node_modules when the baked lockfile-hash marker matches the lockfile", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const lockfile = '{"lockfileVersion":3}\n';
    writeFileSync(join(repoPath, "package-lock.json"), lockfile);
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    writeFileSync(
      join(repoPath, "node_modules/.cycloid-lockfile-hash"),
      `${createHash("sha256").update(lockfile).digest("hex")}\n`,
    );

    const npmLog = join(dir, "npm.log");
    writeFakeExecutable(
      binDir,
      "npm",
      `#!/usr/bin/env bash
echo "$*" >> "${npmLog}"
`,
    );

    const timingsPath = join(dir, "setup-timings");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_SETUP_TIMINGS_PATH: timingsPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("npm.ci_skip reason=existing_node_modules");
    expect(readFileSync(timingsPath, "utf8")).toContain("setup_kind=npm_skip_existing");
    expect(existsSync(npmLog)).toBe(false);
  });

  it("reinstalls and refreshes the marker when the lockfile drifted from the baked hash", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const lockfile = '{"lockfileVersion":3,"packages":{"noise":"drifted"}}\n';
    writeFileSync(join(repoPath, "package-lock.json"), lockfile);
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    const markerPath = join(repoPath, "node_modules/.cycloid-lockfile-hash");
    writeFileSync(
      markerPath,
      `${createHash("sha256").update("the lockfile the snapshot was baked with").digest("hex")}\n`,
    );

    const npmLog = join(dir, "npm.log");
    const readyPath = join(dir, "workspace-ready");
    writeFakeExecutable(
      binDir,
      "npm",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${npmLog}"
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
for _ in 1 2 3 4 5; do
  if [ -f "${readyPath}" ]; then echo "bridge-ok"; exit 0; fi
  sleep 0.2
done
echo "workspace setup was not marked ready" >&2
exit 3
`,
    );

    const timingsPath = join(dir, "setup-timings");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_WORKSPACE_SETUP_READY_PATH: readyPath,
      ARCANIST_SETUP_TIMINGS_PATH: timingsPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] npm.install_stale reason=lockfile_drift");
    expect(output).toContain("[start-bridge] npm.install_start reason=lockfile_drift");
    expect(output).toContain("[start-bridge] npm.install_complete reason=lockfile_drift");
    expect(output).toContain("bridge-ok");
    // npm install, NOT npm ci: ci would wipe the baked node_modules before a
    // possibly-failing reinstall, downgrading "stale deps" to "no deps".
    expect(readFileSync(npmLog, "utf8").trim()).toBe("install");
    expect(readFileSync(timingsPath, "utf8")).toContain("setup_kind=npm");
    // Marker refreshed to the CURRENT lockfile so the next boot skips again.
    expect(readFileSync(markerPath, "utf8").trim()).toBe(createHash("sha256").update(lockfile).digest("hex"));
  });

  it("restores a lockfile rewritten by the drift install and reports failure instead", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const lockfile = '{"lockfileVersion":3}\n';
    writeFileSync(join(repoPath, "package-lock.json"), lockfile);
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    const markerPath = join(repoPath, "node_modules/.cycloid-lockfile-hash");
    const bakedHash = createHash("sha256").update("baked lockfile").digest("hex");
    writeFileSync(markerPath, `${bakedHash}\n`);

    const readyPath = join(dir, "workspace-ready");
    const failedPath = join(dir, "workspace-failed");
    writeFakeExecutable(
      binDir,
      "npm",
      `#!/usr/bin/env bash
exit 0
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
for _ in 1 2 3 4 5; do
  if [ -f "${readyPath}" ]; then echo "bridge-ok"; exit 0; fi
  sleep 0.2
done
echo "workspace setup was not marked ready" >&2
exit 3
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_WORKSPACE_SETUP_READY_PATH: readyPath,
      ARCANIST_WORKSPACE_SETUP_FAILED_PATH: failedPath,
      // Simulates npm install rewriting package-lock.json (package.json/lockfile
      // mismatch — the state the frozen npm ci contract would have failed on).
      FAKE_GIT_LOCKFILE_DIRTY: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] npm.install_start reason=lockfile_drift");
    expect(output).toContain("bridge-ok");
    // The rewrite is treated as the failure npm ci would have surfaced: lockfile
    // restored from git, failed marker set, and the stale marker NOT refreshed —
    // never publish setup-generated lockfile changes. (The _lockfile_rewritten
    // line goes to stderr via log_error, which execFileSync does not capture.)
    expect(existsSync(readyPath)).toBe(true);
    expect(existsSync(failedPath)).toBe(true);
    expect(readFileSync(join(dir, "git.log"), "utf8")).toContain("checkout -- package-lock.json");
    expect(readFileSync(markerPath, "utf8").trim()).toBe(bakedHash);
  });

  it("writes the failed marker when the background dependency install exits non-zero", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFileSync(join(repoPath, "package.json"), "{}\n");
    writeFileSync(join(repoPath, "package-lock.json"), "{}\n");

    const readyPath = join(dir, "workspace-ready");
    const failedPath = join(dir, "workspace-failed");
    writeFakeExecutable(
      binDir,
      "npm",
      `#!/usr/bin/env bash
echo "npm ERR! network refused" >&2
exit 1
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
for _ in 1 2 3 4 5; do
  if [ -f "${readyPath}" ]; then
    echo "bridge-ok"
    exit 0
  fi
  sleep 0.2
done
echo "workspace setup was not marked ready" >&2
exit 3
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_WORKSPACE_SETUP_READY_PATH: readyPath,
      ARCANIST_WORKSPACE_SETUP_FAILED_PATH: failedPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] npm.ci_start reason=fresh_clone_background");
    expect(output).toContain("bridge-ok");
    // Ready unblocks the agent; the failed marker lets the bridge surface the
    // broken install instead of reporting a healthy workspace. (The npm.ci_failed
    // line itself goes to stderr via log_error, which execFileSync does not capture.)
    expect(existsSync(readyPath)).toBe(true);
    expect(existsSync(failedPath)).toBe(true);
  });

  it("uses Yarn Berry immutable installs when .yarnrc.yml is present", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    writeFileSync(join(repoPath, "package.json"), '{"packageManager":"yarn@4.6.0"}\n');
    writeFileSync(join(repoPath, "yarn.lock"), "# yarn lockfile v1\n");
    writeFileSync(join(repoPath, ".yarnrc.yml"), "nodeLinker: node-modules\n");

    const yarnLog = join(dir, "yarn.log");
    const readyPath = join(dir, "workspace-ready");
    writeFakeExecutable(
      binDir,
      "yarn",
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "${yarnLog}"
mkdir -p "${repoPath}/node_modules"
`,
    );
    writeFakeExecutable(
      binDir,
      "node",
      `#!/usr/bin/env bash
set -euo pipefail
for _ in 1 2 3 4 5; do
  if [ -f "${readyPath}" ]; then
    echo "bridge-ok"
    exit 0
  fi
  sleep 0.2
done
echo "workspace setup was not marked ready" >&2
exit 3
`,
    );

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCANIST_WORKSPACE_SETUP_READY_PATH: readyPath,
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] yarn.install_start reason=fresh_clone_background");
    expect(output).toContain("[start-bridge] yarn.install_complete reason=fresh_clone_background");
    expect(output).toContain("bridge-ok");
    expect(readFileSync(yarnLog, "utf8")).toContain("install --immutable");
  });

  it("fails without echoing the clone token if the git config remains credential-bearing", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      FAKE_GIT_NO_SCRUB: "1",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("credential-bearing git remote remains after clone");
    expect(result.stderr).not.toContain(CLONE_TOKEN);
  });

  it("fails closed when clone/bootstrap leaves no git worktree behind", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      FAKE_GIT_SKIP_GIT_DIR: "1",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[start-bridge] repo_checkout_missing");
  });

  it("accepts linked-worktree style .git files during bootstrap", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      FAKE_GIT_WORKTREE_FILE: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const config = readFileSync(join(repoPath, ".git-common", "config"), "utf8");
    expect(config).toContain("https://github.com/acme/widget.git");
    expect(config).not.toContain("x-access-token");
    expect(config).not.toContain(CLONE_TOKEN);
  });
});
