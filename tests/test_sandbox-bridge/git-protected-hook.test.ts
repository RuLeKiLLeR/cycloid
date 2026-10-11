import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { buildProtectedPathPreCommitHook } from "../../apps/sandbox-bridge/src/utils/git-protected-hook.js";

const reposToCleanup: string[] = [];

afterEach(() => {
  for (const repo of reposToCleanup.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("protected path pre-commit hook", () => {
  it("blocks protected files staged by bulk git add before commit", () => {
    const repo = createGitRepo();
    writeFileSync(join(repo, ".env"), "SECRET=value\n", "utf-8");
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n", "utf-8");
    installHook(repo);

    execFileSync("git", ["add", "-f", ".env", "src.ts"], { cwd: repo });

    expect(() => execFileSync("git", ["commit", "-m", "commit bulk add"], { cwd: repo, encoding: "utf-8" })).toThrow(
      /Cycloid blocked commit: protected files are staged/,
    );
  });

  it("allows commits when only ordinary files are staged", () => {
    const repo = createGitRepo();
    writeFileSync(join(repo, "src.ts"), "export const value = 1;\n", "utf-8");
    installHook(repo);

    execFileSync("git", ["add", "."], { cwd: repo });
    const output = execFileSync("git", ["commit", "-m", "commit safe file"], { cwd: repo, encoding: "utf-8" });

    expect(output).toContain("commit safe file");
  });
});

function createGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cycloid-protected-hook-"));
  reposToCleanup.push(repo);
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Cycloid Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  return repo;
}

function installHook(repo: string): void {
  const hookPath = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, buildProtectedPathPreCommitHook(), "utf-8");
  chmodSync(hookPath, 0o755);
}
