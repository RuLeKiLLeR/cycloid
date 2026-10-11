// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
//
// Repo-path fixtures so AgentBridge's constructor validation takes the same
// branch on every host. Without an explicit repoPath the constructor falls
// back to /workspace/repo, which exists inside Cycloid sandboxes but not on
// dev machines or CI — making the validation branch (and therefore mock call
// counts and wholesale execFileSync overrides) host-dependent.
import { execFileSync } from "child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Fixture for suites that mock child_process: a temp dir with a `.git` entry.
 * The suite's mocked `git rev-parse --is-inside-work-tree` must answer
 * `"true\n"` for the constructor validation to pass (the shared harness
 * default mock already does).
 */
export function createMockedRepoFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-repo-fixture-")));
  writeFileSync(join(dir, ".git"), "gitdir: rev-parse-is-mocked-by-the-test\n", "utf-8");
  return dir;
}

/**
 * Fixture for suites that do NOT mock child_process: a real `git init` repo so
 * the constructor's unmocked validation passes without touching /workspace/repo.
 * Do not call from a module graph that mocks child_process — the mocked
 * execFileSync would not actually initialize the repo.
 */
export function createRealGitRepoFixture(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bridge-real-repo-")));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  return dir;
}
