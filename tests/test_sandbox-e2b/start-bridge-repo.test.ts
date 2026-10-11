import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  baseEnv,
  cleanupTempDirs,
  CLONE_TOKEN,
  makeTempDir,
  REPO_ROOT,
  START_BRIDGE,
  TEMPLATE_TS,
  writeFakeGit,
} from "./start-bridge-helpers";

afterEach(cleanupTempDirs);

describe("E2B start-bridge script", () => {
  it("is copied into the template as /app/start-bridge.sh with executable mode", () => {
    const template = readFileSync(TEMPLATE_TS, "utf8");
    const script = readFileSync(START_BRIDGE, "utf8");

    expect(template).toContain(
      '{ src: requireFile("apps/sandbox-e2b/start-bridge.sh"), dest: "/app/start-bridge.sh", mode: 0o755 }',
    );
    expect(template).toContain('src: requireFile("apps/sandbox-e2b/enforce-egress.sh")');
    expect(template).toContain('dest: "/usr/local/sbin/cycloid-enforce-egress"');
    expect(template).toContain(
      '{ src: requireFile("apps/sandbox-e2b/curl-egress-wrapper.sh"), dest: "/usr/local/bin/curl", mode: 0o755 }',
    );
    expect(script).toContain('REPO_PATH="${REPO_PATH:-/workspace/repo}"');
    expect(script).toContain("enforce_egress_if_configured");
    expect(script).toContain('node "${BRIDGE_BUNDLE}"');
  });

  it("clones a private non-default branch, fetches base branch, and scrubs the tokenized remote", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/private-branch",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] bridge_exec");
    expect(startupLog).not.toContain("bridge-ok");
    const config = readFileSync(join(repoPath, ".git/config"), "utf8");
    expect(config).toContain("https://github.com/acme/widget.git");
    expect(config).not.toContain("x-access-token");
    expect(config).not.toContain(CLONE_TOKEN);
    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("clone --depth 1 --branch feature/private-branch");
    // Explicit refspec: the fetch must create refs/remotes/origin/<base>, not
    // just update FETCH_HEAD, so the bridge's base diff baseline resolves.
    expect(log).toContain("fetch origin +refs/heads/main:refs/remotes/origin/main --depth 1");
  });

  it("writes a sanitized clone repo-prep timing breadcrumb for a fresh clone", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const timingsPath = join(dir, "repo-prep-timings");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/private-branch",
      ARCANIST_REPO_PREP_TIMINGS_PATH: timingsPath,
    };

    execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const timings = readFileSync(timingsPath, "utf8");
    expect(timings).toContain("repo_prep_path=clone");
    expect(timings).toMatch(/repo_prep_ms=\d+/);
    // Sanitized: only the path label + integer ms, never tokens/URLs/paths.
    expect(timings).not.toContain(CLONE_TOKEN);
    expect(timings).not.toContain("github.com");
    expect(timings).not.toContain(repoPath);
  });

  it("writes a fetch repo-prep timing breadcrumb for an existing (prebaked) repo", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const timingsPath = join(dir, "repo-prep-timings");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      ARCANIST_REPO_PREP_TIMINGS_PATH: timingsPath,
    };

    execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const timings = readFileSync(timingsPath, "utf8");
    expect(timings).toContain("repo_prep_path=fetch");
    expect(timings).toMatch(/repo_prep_ms=\d+/);
  });

  it("keeps starting the bridge when the base-branch refspec fetch fails, logging the failure", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/private-branch",
      FAKE_GIT_FAIL_FETCH_BASE: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_fetch_base_branch_failed base=main");
  });

  it("ARC-1515 strict adopted checkout fails closed instead of falling back to base (existing repo)", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/pr-head",
      ARCANIST_STRICT_HEAD_CHECKOUT: "1",
      FAKE_GIT_FAIL_CHECKOUT_BRANCH: "1",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_checkout_strict_no_base_fallback stage=prepare_existing");
    expect(startupLog).not.toContain("repo_checkout_base_branch");
    expect(result.stdout ?? "").not.toContain("bridge-ok");
  });

  it("ARC-1515 strict adopted checkout fails closed instead of cloning the base branch (fresh clone)", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/pr-head",
      ARCANIST_STRICT_HEAD_CHECKOUT: "1",
      FAKE_GIT_FAIL_BRANCH_CLONE: "feature/pr-head",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_checkout_strict_no_base_fallback stage=clone");
    const gitLog = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(gitLog).not.toContain("clone --depth 1 --branch main");
  });

  it("ARC-1515 strict adopted checkout proceeds and verifies the head branch on success", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/pr-head",
      ARCANIST_STRICT_HEAD_CHECKOUT: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_checkout_strict_verified branch=feature/pr-head");
  });

  it("keeps the base-branch fallback when strict adopted checkout is not set (regression)", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "feature/pr-head",
      FAKE_GIT_FAIL_CHECKOUT_BRANCH: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_checkout_base_branch base=main");
    expect(startupLog).not.toContain("repo_checkout_strict_no_base_fallback");
  });

  it("starts the bridge for a zero-commit repo whose advertised default branch has no ref yet", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "",
      FAKE_GIT_FAIL_BRANCH_CLONE: "main",
      FAKE_GIT_EMPTY_CLONE: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_clone_branch_failed_try_empty_fallback branch=main");
    expect(startupLog).toContain(
      "[start-bridge] repo_clone_empty_fallback branch=main checkout_branch=cycloid/session-work-sess-1",
    );
    expect(startupLog).toContain("[start-bridge] bridge_exec");
    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("clone --depth 1 --branch main");
    expect(log).toContain("clone --depth 1 https://x-access-token:");
    expect(log).toContain("checkout -B cycloid/session-work-sess-1");
  });

  it("starts a zero-commit repo on the session branch when the session and base refs are missing", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      CHECKOUT_BRANCH: "cycloid/session-x",
      FAKE_GIT_FAIL_BRANCH_CLONE: "cycloid/session-x main",
      FAKE_GIT_EMPTY_CLONE: "1",
    };

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_clone_branch_failed_try_empty_fallback branch=cycloid/session-x");
    expect(startupLog).toContain(
      "[start-bridge] repo_clone_empty_fallback branch=cycloid/session-x checkout_branch=cycloid/session-x",
    );
    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("clone --depth 1 --branch cycloid/session-x");
    expect(log).toContain("clone --depth 1 --branch main");
    expect(log).toContain("clone --depth 1 https://x-access-token:");
    expect(log).toContain("checkout -B cycloid/session-x");
  });

  it("uses one-shot auth for existing repo fetches and scrubs before bridge start", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(
      join(repoPath, ".git/config"),
      `[remote "origin"]\n\turl = https://x-access-token:${CLONE_TOKEN}@github.com/acme/widget.git\n`,
    );
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      CHECKOUT_BRANCH: "feature/existing",
    };

    execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const config = readFileSync(join(repoPath, ".git/config"), "utf8");
    expect(config).toContain("https://github.com/acme/widget.git");
    expect(config).not.toContain(CLONE_TOKEN);
    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("http.https://github.com/.extraheader=AUTHORIZATION: basic");
    // Explicit refspec: the session-branch fetch must create the tracking ref
    // the bridge diffs against to detect publishable work.
    expect(log).toContain("fetch origin +refs/heads/feature/existing:refs/remotes/origin/feature/existing --depth 1");
    expect(log).toContain("checkout feature/existing");
    expect(log).not.toContain(`x-access-token:${CLONE_TOKEN}`);
  });

  it("fast-forwards an existing base-branch checkout to FETCH_HEAD before bridge start", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
    };

    execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("fetch origin +refs/heads/main:refs/remotes/origin/main --depth 1");
    expect(log).toContain("checkout -B main FETCH_HEAD");
  });

  it("boots a prebaked image with the REAL agent git policy wrapper on PATH (checkout -B bypass)", () => {
    // The 2026-07-08 cycloid prebaked-snapshot incident: on sandbox images PATH
    // `git` is the agent policy wrapper, which denies `checkout -B` as branch
    // creation (exit 126) — the prebaked path's mandatory reset-to-FETCH_HEAD died
    // and the bridge never started. start-bridge must route its own git calls
    // to the real binary. This test puts the ACTUAL wrapper on PATH (with the
    // permissive fake git playing the real binary behind it), so any future
    // start-bridge git call that leaks through PATH lookup dies here exactly
    // as it would in production.
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);

    const realBinDir = join(dir, "real-bin");
    mkdirSync(realBinDir, { recursive: true });
    writeFakeGit(realBinDir);

    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      ARCANIST_REAL_GIT_PATH: join(realBinDir, "git"),
    };
    // Overwrite baseEnv's PATH fake git with the real policy wrapper.
    copyFileSync(resolve(REPO_ROOT, "apps/sandbox-e2b/git-command-wrapper.sh"), join(dir, "bin", "git"));
    chmodSync(join(dir, "bin", "git"), 0o755);

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("checkout -B main FETCH_HEAD");
  });

  it("fails closed when an existing base-branch checkout is dirty before bridge start", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "main",
      FAKE_GIT_STATUS_PORCELAIN: " M apps/control-plane-worker/src/session/feedback-db.ts\n",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[start-bridge] repo_checkout_dirty_without_session_branch");
  });

  it("rejects a CHECKOUT_BRANCH with a leading dash before any git call", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const injectionTarget = join(dir, "injected-file");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      CHECKOUT_BRANCH: `--upload-pack=touch ${injectionTarget}`,
      BRANCH: "main",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing CHECKOUT_BRANCH with leading dash");
    expect(existsSync(injectionTarget)).toBe(false);
    expect(existsSync(env.FAKE_GIT_LOG as string)).toBe(false);
  });

  it("rejects a BRANCH with a leading dash before any git call", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      BRANCH: "-x",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing BRANCH with leading dash");
    expect(existsSync(env.FAKE_GIT_LOG as string)).toBe(false);
  });

  it("fails closed when fallback base-branch reuse sees a dirty checkout", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      CHECKOUT_BRANCH: "feature/existing",
      BRANCH: "main",
      FAKE_GIT_FAIL_CHECKOUT_BRANCH: "1",
      FAKE_GIT_STATUS_PORCELAIN: " M apps/control-plane-worker/src/session/feedback-db.ts\n",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[start-bridge] repo_checkout_dirty_without_session_branch");
  });

  it("falls back to FETCH_HEAD when an existing-repo session-branch checkout has no local ref", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      CHECKOUT_BRANCH: "feature/existing",
      // plain `checkout feature/existing` fails ("pathspec did not match");
      // only `checkout -B feature/existing FETCH_HEAD` succeeds
      FAKE_GIT_FAIL_PLAIN_CHECKOUT: "1",
    };

    // recovers instead of exiting non-zero -> reaches the bridge
    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("bridge-ok");
    const log = readFileSync(env.FAKE_GIT_LOG!, "utf8");
    expect(log).toContain("checkout feature/existing");
    expect(log).toContain("checkout -B feature/existing FETCH_HEAD");
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    expect(startupLog).toContain("[start-bridge] repo_checkout_session_branch_fetchhead_fallback");
  });

  it("records git stderr and stage in the startup log when an existing-repo checkout fails", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = {
      ...baseEnv(dir, repoPath),
      CHECKOUT_BRANCH: "feature/existing",
      FAKE_GIT_FAIL_CHECKOUT: "1",
    };

    const result = spawnSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    const startupLog = readFileSync(env.ARCANIST_START_BRIDGE_LOG_PATH!, "utf8");
    // the stage breadcrumb pins which sub-step we reached...
    expect(startupLog).toContain("[start-bridge] repo_checkout_session_branch branch=feature/existing");
    // ...and the captured git stderr is now in the log instead of vanishing
    expect(startupLog).toContain("fatal: checkout failed: ambiguous ref");
    // the bridge never starts when repo prepare fails
    expect(startupLog).not.toContain("[start-bridge] bridge_exec");
  });

  it("keeps snapshot-prebuilt node_modules instead of re-running npm ci", () => {
    const dir = makeTempDir();
    const repoPath = join(dir, "workspace", "repo");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    mkdirSync(join(repoPath, "node_modules"), { recursive: true });
    writeFileSync(join(repoPath, "package-lock.json"), "{}\n");
    writeFileSync(join(repoPath, ".git/config"), `[remote "origin"]\n\turl = https://github.com/acme/widget.git\n`);
    const env: NodeJS.ProcessEnv = baseEnv(dir, repoPath);

    const output = execFileSync("bash", [START_BRIDGE], { env, encoding: "utf8" });

    expect(output).toContain("[start-bridge] npm.ci_skip reason=existing_node_modules");
    expect(output).toContain("bridge-ok");
  });
});
