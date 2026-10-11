// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

import { createCommit } from "../../apps/sandbox-bridge/src/services/git/commit.js";
import { CYCLOID_GIT_COMMITTER_EMAIL, CYCLOID_GIT_COMMITTER_NAME } from "../../shared/constants/git-identity.js";

const reposToCleanup: string[] = [];

afterEach(() => {
  for (const repo of reposToCleanup.splice(0)) rmSync(repo, { recursive: true, force: true });
  delete process.env.SANDBOX_AUTH_TOKEN;
});

function createGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cycloid-commit-env-"));
  reposToCleanup.push(repo);
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Cycloid Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  return repo;
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noopLog };

describe("createCommit hook environment", () => {
  it("runs commit hooks without exposing bridge secrets", () => {
    const repo = createGitRepo();
    // A pre-commit hook that records whatever it can read from the bridge secret.
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, '#!/bin/sh\nprintf "%s" "${SANDBOX_AUTH_TOKEN:-ABSENT}" > token-seen.txt\n', "utf-8");
    chmodSync(hookPath, 0o755);
    writeFileSync(join(repo, "src.ts"), "export const x = 1;\n", "utf-8");
    execFileSync("git", ["add", "src.ts"], { cwd: repo });

    process.env.SANDBOX_AUTH_TOKEN = "super-secret";
    const result = createCommit({
      cwd: repo,
      currentBranch: "main",
      commitMessage: "add file",
      promptLog: noopLog,
      recordTimeline: () => {},
    });

    expect(result.status).toBe("committed");
    expect(existsSync(join(repo, "token-seen.txt"))).toBe(true);
    expect(readFileSync(join(repo, "token-seen.txt"), "utf-8")).toBe("ABSENT");
    expect(execFileSync("git", ["log", "-1", "--format=%cn <%ce>"], { cwd: repo, encoding: "utf-8" }).trim()).toBe(
      `${CYCLOID_GIT_COMMITTER_NAME} <${CYCLOID_GIT_COMMITTER_EMAIL}>`,
    );
  });
});
