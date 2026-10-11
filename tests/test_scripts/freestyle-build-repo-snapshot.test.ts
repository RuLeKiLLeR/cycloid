import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type RepoSnapshotScriptModule = {
  REPO_PATH: string;
  TOKEN_PATH: string;
  REAL_GIT: string;
  parseArgs(argv: string[]): {
    repo: string | null;
    branch: string;
    baseSnapshot: string | null;
    diskGb: number | null;
    verify: boolean;
    public: boolean;
  };
  sanitizeCheckCommand(): string;
};

const { REPO_PATH, REAL_GIT, parseArgs, sanitizeCheckCommand } = (await import(
  new URL("../../scripts/freestyle-build-repo-snapshot.mjs", import.meta.url).href
)) as RepoSnapshotScriptModule;
const { shellSingleQuote } = (await import(
  new URL("../../scripts/freestyle-build-common.mjs", import.meta.url).href
)) as {
  shellSingleQuote(value: string): string;
};

describe("freestyle-build-repo-snapshot args", () => {
  it("parses the full flag surface", () => {
    const args = parseArgs([
      "node",
      "script",
      "--repo",
      "trycycloid/cycloid",
      "--branch",
      "main",
      "--base-snapshot",
      "sh-base",
      "--disk-gb",
      "32",
      "--verify",
      "--public",
    ]);
    expect(args).toEqual({
      repo: "trycycloid/cycloid",
      branch: "main",
      baseSnapshot: "sh-base",
      diskGb: 32,
      verify: true,
      public: true,
    });
  });

  it("defaults branch to main with no base snapshot pinned", () => {
    const args = parseArgs(["node", "script", "--repo", "trycycloid/mia-copy-4"]);
    expect(args.branch).toBe("main");
    expect(args.baseSnapshot).toBeNull();
    expect(args.diskGb).toBeNull();
    expect(args.verify).toBe(false);
    expect(args.public).toBe(false);
  });
});

describe("freestyle-build-repo-snapshot sanitize gate", () => {
  // Rewrites the command's baked-in VM paths onto a disposable fixture so the
  // REAL bash logic runs: this is the gate that decides whether a snapshot with
  // a leaked credential gets minted, so it is tested behaviorally, not textually.
  function runSanitizeCheck(setup: (dirs: { repo: string; root: string; tmp: string }) => void): {
    status: number;
    output: string;
  } {
    const base = mkdtempSync(join(tmpdir(), "freestyle-repo-sanitize-"));
    const dirs = { repo: join(base, "repo"), root: join(base, "root"), tmp: join(base, "tmp") };
    try {
      mkdirSync(join(dirs.repo, ".git"), { recursive: true });
      mkdirSync(dirs.root, { recursive: true });
      mkdirSync(dirs.tmp, { recursive: true });
      execFileSync("git", ["-C", dirs.repo, "init", "-q"]);
      execFileSync("git", ["-C", dirs.repo, "remote", "add", "origin", "https://github.com/acme/widget.git"]);
      setup(dirs);

      // NOTE: the generic /root/ rewrite also covers TOKEN_PATH (it lives under
      // /root/); a dedicated TOKEN_PATH rewrite would be double-replaced into a
      // nonexistent path and silently defeat the token check below.
      const command = sanitizeCheckCommand()
        .replaceAll(`${REPO_PATH}/.git/config`, join(dirs.repo, ".git/config"))
        .replaceAll(`${REPO_PATH}/.npmrc`, join(dirs.repo, ".npmrc"))
        .replaceAll(REPO_PATH, dirs.repo)
        .replaceAll("/root/", `${dirs.root}/`)
        .replaceAll(REAL_GIT, "git")
        .replaceAll("ls /tmp", `ls ${dirs.tmp}`);
      try {
        // Run through the SAME quoting layer production uses: the exec transport
        // shell-parses the command string, so the outer bash here plays the
        // transport's shell and the inner `bash -c '<script>'` is the real gate
        // invocation. A quoting regression (e.g. JSON.stringify escaping) now
        // fails these tests instead of only failing on a live builder VM.
        const output = execFileSync("bash", ["-c", `bash -c ${shellSingleQuote(command)}`], { encoding: "utf8" });
        return { status: 0, output };
      } catch (error) {
        const err = error as { status?: number; stdout?: string };
        return { status: err.status ?? 1, output: err.stdout?.toString() ?? "" };
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  it("passes on a clean image (tokenless origin, no credentials, no build artifacts)", () => {
    const result = runSanitizeCheck(() => {});
    expect(result.output).toContain("sanitize-ok");
    expect(result.status).toBe(0);
  });

  it("fails when the clone token file survived", () => {
    const result = runSanitizeCheck(({ root }) => {
      writeFileSync(join(root, ".cycloid-build-clone-token"), "ghs_abc123\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TAINTED");
  });

  it("fails when a credential-shaped string survived in git config", () => {
    const result = runSanitizeCheck(({ repo }) => {
      execFileSync("git", ["-C", repo, "config", "http.extraHeader", "Authorization: basic ghp_secret"]);
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TAINTED");
  });

  it("fails when the origin URL is not a tokenless github https URL", () => {
    const result = runSanitizeCheck(({ repo }) => {
      execFileSync("git", [
        "-C",
        repo,
        "remote",
        "set-url",
        "origin",
        "https://x-access-token:ghs_abc@github.com/acme/widget.git",
      ]);
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TAINTED");
  });

  it("fails when an npmrc auth token survived", () => {
    const result = runSanitizeCheck(({ root }) => {
      writeFileSync(join(root, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_secret\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TAINTED");
  });

  it("fails when build script artifacts survived in /tmp", () => {
    const result = runSanitizeCheck(({ tmp }) => {
      writeFileSync(join(tmp, "cycloid-build-1.log"), "xtrace with secrets\n");
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("TAINTED");
  });
});
