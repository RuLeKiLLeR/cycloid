// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { execRepoGit, execRepoGitSync } from "../../apps/sandbox-bridge/src/services/git/exec.js";

const repos = [];
function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "git-exec-env-"));
  repos.push(repo);
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  return repo;
}

/** Probe child env via core.fsmonitor: git runs it on status, so whatever the
 * hook can read is what attacker-influenceable repo config can read. */
function installEnvProbe(repo, varNames) {
  const probe = join(repo, "fsmonitor-probe.sh");
  const reads = varNames.map((name) => `"\${${name}:-ABSENT}"`).join(' "|" ');
  writeFileSync(probe, `#!/bin/sh\nprintf "%s" ${reads} > "${join(repo, "seen.txt")}"\nexit 1\n`);
  chmodSync(probe, 0o755);
  execFileSync("git", ["config", "core.fsmonitor", probe], { cwd: repo });
}

let savedDdApiKey;
let savedSandboxAuthToken;
let savedRealGitPath;
beforeEach(() => {
  savedDdApiKey = process.env.DD_API_KEY;
  savedSandboxAuthToken = process.env.SANDBOX_AUTH_TOKEN;
  savedRealGitPath = process.env.ARCANIST_REAL_GIT_PATH;
});
afterEach(() => {
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  if (savedDdApiKey === undefined) delete process.env.DD_API_KEY;
  else process.env.DD_API_KEY = savedDdApiKey;
  if (savedSandboxAuthToken === undefined) delete process.env.SANDBOX_AUTH_TOKEN;
  else process.env.SANDBOX_AUTH_TOKEN = savedSandboxAuthToken;
  if (savedRealGitPath === undefined) delete process.env.ARCANIST_REAL_GIT_PATH;
  else process.env.ARCANIST_REAL_GIT_PATH = savedRealGitPath;
});

describe("execRepoGit env sanitization", () => {
  it("runs an attacker-controlled core.fsmonitor hook without exposing platform secrets", () => {
    const repo = gitRepo();
    installEnvProbe(repo, ["DD_API_KEY"]);

    process.env.DD_API_KEY = "super-secret";
    try {
      execRepoGitSync(["status", "--porcelain"], { cwd: repo });
    } catch {
      // git may surface the fsmonitor non-zero exit; the probe still ran.
    }
    expect(readFileSync(join(repo, "seen.txt"), "utf8")).toBe("ABSENT");
  });

  it("async variant strips SANDBOX_AUTH_TOKEN and platform secrets from repo-git subprocesses", async () => {
    const repo = gitRepo();
    installEnvProbe(repo, ["SANDBOX_AUTH_TOKEN", "DD_API_KEY", "ARCANIST_REAL_GIT_PATH"]);

    process.env.SANDBOX_AUTH_TOKEN = "sess";
    process.env.DD_API_KEY = "dd";
    try {
      await execRepoGit(["status", "--porcelain"], {
        cwd: repo,
        env: { ARCANIST_REAL_GIT_PATH: "/usr/local/lib/cycloid/real-bin/git" },
      });
    } catch {
      // fsmonitor exit propagates; the probe still ran.
    }
    // SANDBOX_AUTH_TOKEN is bridge/agent-operational, never git-hook-visible:
    // buildSanitizedHookEnv strips it alongside the platform keys.
    expect(readFileSync(join(repo, "seen.txt"), "utf8")).toBe("ABSENT|ABSENT|ABSENT");
  });

  it("uses the configured real git binary path for bridge-owned repo git calls", () => {
    const repo = gitRepo();
    const realGit = join(repo, "real-git.sh");
    const logPath = join(repo, "real-git.log");
    writeFileSync(realGit, `#!/bin/sh\nprintf '%s' "$*" > "${logPath}"\n`);
    chmodSync(realGit, 0o755);
    process.env.ARCANIST_REAL_GIT_PATH = realGit;

    execRepoGitSync(["status", "--porcelain"], { cwd: repo });

    expect(readFileSync(logPath, "utf8")).toBe("status --porcelain");
  });

  it("a caller env overlay cannot reintroduce a denylisted key", () => {
    const repo = gitRepo();
    installEnvProbe(repo, ["DD_API_KEY", "GIT_COMMITTER_NAME"]);

    try {
      execRepoGitSync(["status", "--porcelain"], {
        cwd: repo,
        env: { DD_API_KEY: "smuggled", GIT_COMMITTER_NAME: "Overlay" },
      });
    } catch {
      // fsmonitor exit propagates; the probe still ran.
    }
    expect(readFileSync(join(repo, "seen.txt"), "utf8")).toBe("ABSENT|Overlay");
  });
});

describe("no raw repo-cwd git spawns remain in the bridge source", () => {
  it("every git child-process spawn goes through the sanitized exec helper", () => {
    const srcRoot = join(__dirname, "..", "..", "apps", "sandbox-bridge", "src");
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        // Allowed: the helper itself, and commit.ts which spawns git directly
        // but with an explicit buildSanitizedHookEnv (GIT_COMMITTER_* overlay).
        if (full.endsWith(join("git", "exec.ts"))) continue;
        if (full.endsWith(join("git", "commit.ts"))) continue;
        const text = readFileSync(full, "utf8");
        // Raw `git` spawns through the direct child_process API. The negative
        // lookbehind excludes injected-deps calls (`deps.execAsync("git"`),
        // which receive a sanitized env at their call site.
        const rawGit = /(?<![.\w])(execFileSync|execFile|spawnSync|spawn)\(\s*["']git["']/g;
        if (rawGit.test(text)) offenders.push(full.replace(srcRoot, "src"));
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
