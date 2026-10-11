// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { execFile } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapHookManagers,
  detectHookManagers,
  HOOK_BOOTSTRAP_COMMAND_TIMEOUT_MS,
} from "../../apps/sandbox-bridge/src/services/hook-bootstrap.js";
import { CYCLOID_PROTECTED_PRE_COMMIT_MARKER } from "../../apps/sandbox-bridge/src/utils/git-protected-hook.js";
import { buildSanitizedHookEnv } from "../../apps/sandbox-bridge/src/utils/sanitized-env.js";

const execFileAsync = promisify(execFile);
const realExec = async (cmd: string, args: string[], opts?: { cwd?: string }) =>
  (await execFileAsync(cmd, args, opts)).stdout;

function makeLog() {
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  const log = {
    info: (obj: unknown) => infos.push(obj),
    warn: (obj: unknown) => warns.push(obj),
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return { log, warns, infos };
}

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-bootstrap-"));
  cleanup.push(dir);
  return dir;
}

function setCoreHooksPath(repo: string, hooksPath: string) {
  const configPath = join(repo, ".git", "config");
  const existing = readFileSync(configPath, "utf-8");
  const updated = existing.replace(/\[core\]\n((?:\t.*\n)*)/, (_match, coreBody: string) => {
    const nextCoreBody = coreBody.includes("\thooksPath =")
      ? coreBody.replace(/^\thooksPath = .*$/m, `\thooksPath = ${hooksPath}`)
      : `${coreBody}\thooksPath = ${hooksPath}\n`;
    return `[core]\n${nextCoreBody}`;
  });
  writeFileSync(configPath, updated, "utf-8");
}

describe("detectHookManagers", () => {
  it("detects pre-commit from .pre-commit-config.yaml as supported", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, ".pre-commit-config.yaml"), "repos: []\n");
    const detected = detectHookManagers(cwd);
    expect(detected).toEqual([
      { name: "pre-commit", supported: true, install: expect.objectContaining({ cmd: "pre-commit" }) },
    ]);
    expect(detected[0].install.args).toEqual([
      "install",
      "--install-hooks",
      "--hook-type",
      "pre-commit",
      "--hook-type",
      "commit-msg",
    ]);
  });

  it("detects the .yml extension variant", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, ".pre-commit-config.yml"), "repos: []\n");
    expect(detectHookManagers(cwd).map((m) => m.name)).toEqual(["pre-commit"]);
  });

  it("detects Husky from the .husky directory as verify-only (no install command)", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".husky"));
    const detected = detectHookManagers(cwd);
    expect(detected).toEqual([{ name: "husky", supported: true, install: null }]);
  });

  it("recognizes Lefthook but marks it unsupported", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "lefthook.yml"), "pre-commit:\n");
    expect(detectHookManagers(cwd)).toEqual([{ name: "lefthook", supported: false, install: null }]);
  });

  it("returns nothing when no hook config is present", () => {
    expect(detectHookManagers(tempRepo())).toEqual([]);
  });

  it("detects multiple declared managers", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, ".pre-commit-config.yaml"), "repos: []\n");
    mkdirSync(join(cwd, ".husky"));
    expect(detectHookManagers(cwd).map((m) => m.name)).toEqual(["pre-commit", "husky"]);
  });
});

describe("buildSanitizedHookEnv", () => {
  it("strips bridge secrets and credential-shaped keys but keeps toolchain vars", () => {
    const env = buildSanitizedHookEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "C.UTF-8",
      SANDBOX_AUTH_TOKEN: "secret",
      GITHUB_CLONE_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      SOME_OTHER_SECRET: "secret",
      CUSTOM_API_KEY: "secret",
      SENTRY_DSN: "https://abc@o1.ingest.sentry.io/2",
      DD_SITE: "datadoghq.com",
      GIT_AUTHOR_NAME: "User",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.GIT_AUTHOR_NAME).toBe("User");
    expect(env.SANDBOX_AUTH_TOKEN).toBeUndefined();
    expect(env.GITHUB_CLONE_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SOME_OTHER_SECRET).toBeUndefined();
    expect(env.CUSTOM_API_KEY).toBeUndefined();
    // SENTRY_DSN and DD_SITE do not match the credential-suffix pattern; the
    // shared platform denylist is what strips them from hook env.
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.DD_SITE).toBeUndefined();
  });

  it("strips legacy GitHub shim directories from hook env", () => {
    const env = buildSanitizedHookEnv({
      PATH: "/tmp/cycloid-gh-shim-s-1:/usr/bin",
      ARCANIST_GH_SHIM_DIR: "/tmp/cycloid-gh-shim-s-1",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ARCANIST_GH_SHIM_DIR).toBeUndefined();
  });
});

describe("bootstrapHookManagers", () => {
  it("runs the pre-commit install with a timeout and a sanitized environment", async () => {
    const cwd = await initGitRepo();
    writeFileSync(join(cwd, ".pre-commit-config.yaml"), "repos: []\n");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedTimeout: number | undefined;
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd === "pre-commit") {
        capturedEnv = opts?.env as NodeJS.ProcessEnv;
        capturedTimeout = opts?.timeout as number;
        writeInstalledHook(cwd, "echo pre-commit-ran");
        return "";
      }
      return realExec(cmd, args, opts as { cwd?: string });
    });
    const { log } = makeLog();

    process.env.SANDBOX_AUTH_TOKEN = "leak-me";
    let result;
    try {
      result = await bootstrapHookManagers({
        cwd,
        log,
        execAsync,
        managers: detectHookManagers(cwd),
      });
    } finally {
      delete process.env.SANDBOX_AUTH_TOKEN;
    }

    expect(result.managers).toEqual([{ name: "pre-commit", status: "installed" }]);
    expect(capturedTimeout).toBe(HOOK_BOOTSTRAP_COMMAND_TIMEOUT_MS);
    expect(capturedEnv?.SANDBOX_AUTH_TOKEN).toBeUndefined();
  });

  it("forwards the abort signal to the install command", async () => {
    const cwd = await initGitRepo();
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd === "pre-commit") {
        capturedSignal = opts?.signal as AbortSignal;
        writeInstalledHook(cwd, "echo ran");
        return "";
      }
      return realExec(cmd, args, opts as { cwd?: string });
    });
    const { log } = makeLog();

    await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "pre-commit", supported: true, install: { cmd: "pre-commit", args: ["install"] } }],
      signal: controller.signal,
    });

    expect(capturedSignal).toBe(controller.signal);
  });

  it("re-chains the Cycloid wrapper to the hook the manager installed", async () => {
    const cwd = await initGitRepo();
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd === "pre-commit") {
        writeInstalledHook(cwd, "echo repo-hook-ran");
        return "";
      }
      return realExec(cmd, args, opts as { cwd?: string });
    });
    const { log } = makeLog();

    await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "pre-commit", supported: true, install: { cmd: "pre-commit", args: ["install"] } }],
    });

    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    expect(readFileSync(hookPath, "utf-8")).toContain(CYCLOID_PROTECTED_PRE_COMMIT_MARKER);
    expect(existsSync(`${hookPath}.cycloid-original`)).toBe(true);
    expect(readFileSync(`${hookPath}.cycloid-original`, "utf-8")).toContain("repo-hook-ran");
  });

  it("reports a failed manager without throwing", async () => {
    const cwd = await initGitRepo();
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd === "pre-commit") {
        const err = new Error("boom") as Error & { status: number; stderr: string };
        err.status = 1;
        err.stderr = "InvalidConfigError: bad config";
        throw err;
      }
      return realExec(cmd, args, opts as { cwd?: string });
    });
    const { log, warns } = makeLog();

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "pre-commit", supported: true, install: { cmd: "pre-commit", args: ["install"] } }],
    });

    expect(result.managers[0].status).toBe("failed");
    expect(result.managers[0].error).toContain("InvalidConfigError");
    expect(warns.length).toBeGreaterThan(0);
    // C3: the per-manager failure carries the distinct queryable event, plus an aggregate so a surge
    // of bootstrap failures across sessions is detectable from the bridge logs.
    const events = warns.map((w) => (w as { event?: string }).event);
    expect(events).toContain("git.hooks.bootstrap_failed");
    expect(events).toContain("git.hooks.bootstrap_completed_with_failures");
  });

  it("verifies Husky without running an install command when core.hooksPath points at .husky/_ (v9)", async () => {
    const cwd = await initGitRepo();
    mkdirSync(join(cwd, ".husky", "_"), { recursive: true });
    setCoreHooksPath(cwd, ".husky/_");
    const installCalls: string[] = [];
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd !== "git") installCalls.push(cmd);
      return realExec(cmd, args, opts as { cwd?: string });
    });
    const { log } = makeLog();

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "husky", supported: true, install: null }],
    });

    expect(result.managers).toEqual([{ name: "husky", status: "verified" }]);
    expect(installCalls).toEqual([]);
  });

  it("verifies Husky when core.hooksPath points at .husky (pre-v9)", async () => {
    const cwd = await initGitRepo();
    mkdirSync(join(cwd, ".husky"), { recursive: true });
    setCoreHooksPath(cwd, ".husky");
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log } = makeLog();

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "husky", supported: true, install: null }],
    });

    expect(result.managers).toEqual([{ name: "husky", status: "verified" }]);
  });

  it("reports Husky as failed when core.hooksPath was never set (prepare lifecycle skipped)", async () => {
    const cwd = await initGitRepo();
    mkdirSync(join(cwd, ".husky"), { recursive: true });
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log, warns } = makeLog();
    const timeline: string[] = [];

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "husky", supported: true, install: null }],
      recordTimeline: (event) => timeline.push(event),
    });

    expect(result.managers[0].status).toBe("failed");
    expect(result.managers[0].error).toContain("core.hooksPath is not set");
    expect(timeline).toContain("git.hooks.verify_failed");
    expect(timeline.filter((event) => event === "git.hooks.husky_inert")).toHaveLength(1);
    expect(warns.length).toBeGreaterThan(0);
    // C3: verify failures keep their distinct event name (not merged with bootstrap_failed), and the
    // aggregate fires regardless of whether a recordTimeline callback was supplied.
    const events = warns.map((w) => (w as { event?: string }).event);
    expect(events).toContain("git.hooks.verify_failed");
    expect(events).toContain("git.hooks.bootstrap_completed_with_failures");
  });

  it("reports Husky as failed when core.hooksPath points outside .husky", async () => {
    const cwd = await initGitRepo();
    setCoreHooksPath(cwd, ".github/hooks");
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log } = makeLog();

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "husky", supported: true, install: null }],
    });

    expect(result.managers[0].status).toBe("failed");
    expect(result.managers[0].error).toContain("does not point into .husky");
  });

  it("does not emit an inert-Husky timeline event when Husky is correctly installed", async () => {
    const cwd = await initGitRepo();
    mkdirSync(join(cwd, ".husky", "_"), { recursive: true });
    setCoreHooksPath(cwd, ".husky/_");
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log } = makeLog();
    const timeline: string[] = [];

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "husky", supported: true, install: null }],
      recordTimeline: (event) => timeline.push(event),
    });

    expect(result.managers).toEqual([{ name: "husky", status: "verified" }]);
    expect(timeline).not.toContain("git.hooks.husky_inert");
  });

  it("reports Husky as failed when the configured hooks directory does not exist", async () => {
    const cwd = await initGitRepo();
    setCoreHooksPath(cwd, ".husky/_");
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log } = makeLog();

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "husky", supported: true, install: null }],
    });

    expect(result.managers[0].status).toBe("failed");
    expect(result.managers[0].error).toContain("does not exist");
  });

  it("skips recognized-but-unsupported managers", async () => {
    const cwd = await initGitRepo();
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log } = makeLog();

    const result = await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "lefthook", supported: false, install: null }],
    });

    expect(result.managers).toEqual([{ name: "lefthook", status: "skipped" }]);
  });

  it("counts skipped managers separately from attempted ones in the failure aggregate", async () => {
    const cwd = await initGitRepo();
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) => {
      if (cmd === "pre-commit") {
        const err = new Error("boom") as Error & { status: number; stderr: string };
        err.status = 1;
        err.stderr = "InvalidConfigError: bad config";
        throw err;
      }
      return realExec(cmd, args, opts as { cwd?: string });
    });
    const { log, warns } = makeLog();

    await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [
        { name: "pre-commit", supported: true, install: { cmd: "pre-commit", args: ["install"] } },
        { name: "lefthook", supported: false, install: null },
      ],
    });

    const aggregate = warns.find(
      (w) => (w as { event?: string }).event === "git.hooks.bootstrap_completed_with_failures",
    ) as { failedCount: number; supportedCount: number; skippedCount: number } | undefined;
    // The skipped lefthook must not inflate the attempted count: 1 supported (failed) + 1 skipped.
    expect(aggregate).toMatchObject({ failedCount: 1, supportedCount: 1, skippedCount: 1 });
  });

  it("does not emit the failure-aggregate event when no manager fails (unsupported are skipped, not failed)", async () => {
    const cwd = await initGitRepo();
    const execAsync = vi.fn(async (cmd: string, args: string[], opts?: Record<string, unknown>) =>
      realExec(cmd, args, opts as { cwd?: string }),
    );
    const { log, warns } = makeLog();

    await bootstrapHookManagers({
      cwd,
      log,
      execAsync,
      managers: [{ name: "lefthook", supported: false, install: null }],
    });

    const events = warns.map((w) => (w as { event?: string }).event);
    expect(events).not.toContain("git.hooks.bootstrap_completed_with_failures");
  });
});

async function initGitRepo(): Promise<string> {
  const repo = tempRepo();
  await realExec("git", ["init"], { cwd: repo });
  return repo;
}

function writeInstalledHook(repo: string, body: string): void {
  const hooksDir = join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, `#!/bin/sh\n${body}\n`, "utf-8");
  chmodSync(hookPath, 0o755);
}
