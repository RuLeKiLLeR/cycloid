// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BridgeLogger } from "../../apps/sandbox-bridge/src/logger.js";
import { resolveChangedFilesAgainstBase } from "../../apps/sandbox-bridge/src/services/git/diff.js";
import { runReviewPreflight } from "../../apps/sandbox-bridge/src/services/pr-review-checks.js";

const dirs: string[] = [];
const logger = { warn: () => undefined } as unknown as BridgeLogger;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function commit(cwd: string, file: string, contents: string, message: string) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), contents);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message]);
}

function repoWithRemoteMain(): string {
  const repo = tempDir("review-diff-repo-");
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  commit(repo, "README.md", "base\n", "base");
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return repo;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ARCANIST_REAL_GIT_PATH;
});

describe("review changed-file resolution", () => {
  it("uses a two-dot diff in a shallow review checkout where three-dot cannot find a merge base", async () => {
    const source = repoWithRemoteMain();
    git(source, ["checkout", "-b", "review"]);
    commit(source, "src/feature.ts", "export const feature = true;\n", "review change");
    const bare = tempDir("review-diff-remote-");
    git(bare, ["init", "--bare"]);
    git(source, ["remote", "add", "origin", bare]);
    git(source, ["push", "origin", "main", "review"]);

    const checkout = tempDir("review-diff-shallow-");
    git(checkout, ["clone", "--branch", "main", "--depth=1", `file://${bare}`, "."]);
    git(checkout, ["fetch", "--depth=1", "origin", "+refs/heads/review:refs/remotes/origin/review"]);
    git(checkout, ["checkout", "--detach", "origin/review"]);
    expect(() => git(checkout, ["diff", "--name-only", "origin/main...HEAD"])).toThrow(/no merge base/);
    expect(git(checkout, ["diff", "--name-only", "origin/main"]).trim()).toBe("src/feature.ts");
    writeFileSync(join(checkout, ".cycloid.json"), JSON.stringify({ verify: { test: { command: "true" } } }));

    await expect(runReviewPreflight(checkout, "main", logger)).resolves.toEqual([
      expect.objectContaining({ command: "true", status: "passed" }),
    ]);
  });

  it("reports an unresolved base without exposing a raw git command error", async () => {
    const records = await runReviewPreflight(tempDir("review-diff-empty-"), "main", logger);
    expect(records).toEqual([
      expect.objectContaining({ status: "failed", reason: "Could not resolve any base ref for the PR diff" }),
    ]);
  });

  it("rejects unsafe base refs before running git", async () => {
    const records = await runReviewPreflight(tempDir("review-diff-invalid-"), "--upload-pack=bad", logger);
    expect(records).toEqual([
      expect.objectContaining({ status: "failed", reason: expect.stringContaining("safe git ref") }),
    ]);
  });

  it("defaults a missing base to main", async () => {
    const repo = repoWithRemoteMain();
    await expect(runReviewPreflight(repo, undefined, logger)).resolves.toEqual(
      await runReviewPreflight(repo, "main", logger),
    );
  });

  it("keeps a name-only result when a stat command fails", () => {
    const repo = repoWithRemoteMain();
    commit(repo, "src/feature.ts", "export const feature = true;\n", "review change");
    const wrapper = join(repo, "git-wrapper.sh");
    writeFileSync(
      wrapper,
      '#!/bin/sh\nif [ "$1" = diff ] && [ "$2" = --stat=9999,9999 ]; then exit 1; fi\nexec git "$@"\n',
    );
    chmodSync(wrapper, 0o755);
    process.env.ARCANIST_REAL_GIT_PATH = wrapper;

    expect(resolveChangedFilesAgainstBase(repo, "main", logger, 30_000)).toEqual({
      files: ["src/feature.ts"],
      resolved: true,
    });
  });
});
