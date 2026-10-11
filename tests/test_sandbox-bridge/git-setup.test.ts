// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CYCLOID_PROTECTED_PRE_COMMIT_MARKER } from "../../apps/sandbox-bridge/src/utils/git-protected-hook.js";
import {
  setupGitConfig,
  setupGitExclude,
  setupProtectedPathPreCommitHook,
} from "../../apps/sandbox-bridge/src/utils/git-setup.js";
import { CYCLOID_GIT_COMMITTER_EMAIL, CYCLOID_GIT_COMMITTER_NAME } from "../../shared/constants/git-identity.js";

function makeLog() {
  const warns: unknown[] = [];
  const infos: unknown[] = [];
  const errors: unknown[] = [];
  const log = {
    info: (obj: unknown) => infos.push(obj),
    warn: (obj: unknown) => warns.push(obj),
    error: (obj: unknown) => errors.push(obj),
    debug: () => {},
    child: () => log,
  };
  return { log, warns, infos, errors };
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

let cwd: string;
const cleanup: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "git-setup-"));
  cleanup.push(cwd);
  mkdirSync(join(cwd, ".git", "info"), { recursive: true });
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.GIT_AUTHOR_NAME;
});

describe("setupGitExclude", () => {
  it("adds Cycloid entries when missing", async () => {
    const { log } = makeLog();
    await setupGitExclude({ cwd, log, execAsync: vi.fn() });
    const content = readFileSync(join(cwd, ".git", "info", "exclude"), "utf-8");
    expect(content).toContain(".cycloid-context.md");
    expect(content).toContain(".codex/");
    expect(content).toContain("AGENTS.override.md");
  });

  it("does not duplicate entries that already exist", async () => {
    const excludePath = join(cwd, ".git", "info", "exclude");
    writeFileSync(excludePath, ".cycloid-context.md\n.codex/\n", "utf-8");
    const { log } = makeLog();
    await setupGitExclude({ cwd, log, execAsync: vi.fn() });
    const content = readFileSync(excludePath, "utf-8");
    expect(content.match(/\.cycloid-context\.md/g)).toHaveLength(1);
    expect(content.match(/\.codex\//g)).toHaveLength(1);
  });

  it("warns but does not throw when the exclude path is unwritable", async () => {
    const { log, warns } = makeLog();
    // Remove .git/info so the write target dir is missing.
    rmSync(join(cwd, ".git", "info"), { recursive: true, force: true });
    await expect(setupGitExclude({ cwd, log, execAsync: vi.fn() })).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe("setupGitConfig", () => {
  it("sets the Cycloid committer identity", async () => {
    const execAsync = vi.fn().mockResolvedValue("");
    const { log } = makeLog();
    await setupGitConfig({ cwd, log, execAsync });
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["config", "user.name", CYCLOID_GIT_COMMITTER_NAME],
      expect.objectContaining({ cwd }),
    );
    expect(execAsync).toHaveBeenCalledWith(
      "git",
      ["config", "user.email", CYCLOID_GIT_COMMITTER_EMAIL],
      expect.objectContaining({ cwd }),
    );
  });

  it("warns but does not throw when git config fails", async () => {
    const execAsync = vi.fn().mockRejectedValue(new Error("git missing"));
    const { log, warns } = makeLog();
    await expect(setupGitConfig({ cwd, log, execAsync })).resolves.toBeUndefined();
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe("setupProtectedPathPreCommitHook", () => {
  function makeExecAsync({ coreHooksPath }: { coreHooksPath?: string | null } = {}) {
    return vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${cwd}\n`;
      if (args[0] === "config" && args[1] === "--get" && args[2] === "core.hooksPath") {
        if (coreHooksPath === undefined) throw new Error("unset");
        return `${coreHooksPath ?? ""}\n`;
      }
      if (args[0] === "rev-parse" && args[1] === "--git-path" && args[2] === "hooks/pre-commit") {
        return ".git/hooks/pre-commit\n";
      }
      return "";
    });
  }

  it("installs the protected-path hook with the marker", async () => {
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    const execAsync = makeExecAsync();
    const { log } = makeLog();
    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });
    expect(readFileSync(hookPath, "utf-8")).toContain(CYCLOID_PROTECTED_PRE_COMMIT_MARKER);
  });

  it("preserves an existing hook as .cycloid-original and chains to it", async () => {
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    writeFileSync(hookPath, "#!/bin/sh\necho custom\n", "utf-8");
    const execAsync = makeExecAsync();
    const { log } = makeLog();
    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });
    expect(existsSync(`${hookPath}.cycloid-original`)).toBe(true);
    expect(readFileSync(`${hookPath}.cycloid-original`, "utf-8")).toContain("echo custom");
    expect(readFileSync(hookPath, "utf-8")).toContain(CYCLOID_PROTECTED_PRE_COMMIT_MARKER);
  });

  it("is idempotent when the marker is already present", async () => {
    const hookPath = join(cwd, ".git", "hooks", "pre-commit");
    mkdirSync(join(cwd, ".git", "hooks"), { recursive: true });
    writeFileSync(hookPath, `#!/bin/sh\n# ${CYCLOID_PROTECTED_PRE_COMMIT_MARKER}\n`, "utf-8");
    const execAsync = makeExecAsync();
    const { log } = makeLog();
    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });
    expect(existsSync(`${hookPath}.cycloid-original`)).toBe(false);
  });

  it("installs into a repo-contained core.hooksPath redirect", async () => {
    const huskyDir = join(cwd, ".husky", "_");
    const hookPath = join(huskyDir, "pre-commit");
    mkdirSync(huskyDir, { recursive: true });
    const execAsync = makeExecAsync({ coreHooksPath: ".husky/_" });
    const { log } = makeLog();

    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });

    expect(readFileSync(hookPath, "utf-8")).toContain(CYCLOID_PROTECTED_PRE_COMMIT_MARKER);
    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("blocks a manual git commit with a protected file when core.hooksPath is redirected", async () => {
    execFileSync("git", ["init"], { cwd });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    setCoreHooksPath(cwd, ".husky/_");
    mkdirSync(join(cwd, ".husky", "_"), { recursive: true });
    const execAsync = async (_cmd: string, args: string[]): Promise<string> =>
      execFileSync("git", args, { cwd, encoding: "utf8" });
    const { log } = makeLog();
    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });
    writeFileSync(join(cwd, ".env"), "SECRET=value\n", "utf8");
    execFileSync("git", ["add", ".env"], { cwd });

    expect(() => execFileSync("git", ["commit", "-m", "leak"], { cwd, encoding: "utf8", stdio: "pipe" })).toThrow(
      /protected files are staged/,
    );
  });

  it("skips installing when core.hooksPath escapes the repo", async () => {
    const execAsync = makeExecAsync({ coreHooksPath: "../outside-hooks" });
    const { log, errors } = makeLog();

    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });

    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(cwd, "..", "outside-hooks", "pre-commit"))).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ hooksPath: "../outside-hooks" })]));
  });

  it("skips installing when core.hooksPath is absolute outside the repo", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "git-hooks-outside-"));
    cleanup.push(outsideDir);
    const execAsync = makeExecAsync({ coreHooksPath: outsideDir });
    const { log, errors } = makeLog();

    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });

    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(outsideDir, "pre-commit"))).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ hooksPath: outsideDir })]));
  });

  it("skips installing when core.hooksPath is a symlink outside the repo", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "git-hooks-symlink-target-"));
    cleanup.push(outsideDir);
    symlinkSync(outsideDir, join(cwd, ".husky-outside"));
    const execAsync = makeExecAsync({ coreHooksPath: ".husky-outside" });
    const { log, errors } = makeLog();

    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });

    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(outsideDir, "pre-commit"))).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ hooksPath: ".husky-outside" })]));
  });

  it("skips installing when an intermediate hook path component symlinks outside the repo", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "git-hooks-intermediate-target-"));
    cleanup.push(outsideDir);
    symlinkSync(outsideDir, join(cwd, ".husky"));
    const execAsync = makeExecAsync({ coreHooksPath: ".husky/_" });
    const { log, errors } = makeLog();

    await setupProtectedPathPreCommitHook({ cwd, log, execAsync });

    expect(existsSync(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(outsideDir, "_", "pre-commit"))).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ hooksPath: ".husky/_" })]));
  });
});
