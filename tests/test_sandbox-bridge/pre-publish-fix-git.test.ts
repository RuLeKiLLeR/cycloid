import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runConfiguredPrePublishFixCommand } from "../../apps/sandbox-bridge/src/utils/pre-publish-fix.js";

describe("pre-publish configured fixes with real git diffs", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), "pre-publish-fix-git-"));
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    writeFileSync(path.join(repoDir, "text.txt"), "base text\n");
    writeFileSync(path.join(repoDir, "keep.txt"), "base keep\n");
    writeFileSync(path.join(repoDir, "old-name.txt"), "base rename\n");
    writeFileSync(path.join(repoDir, "bin.dat"), Buffer.from([0, 1, 2, 3, 4]));
    git("add", ".");
    git("commit", "-m", "base");
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("restores staged, unstaged, binary, and renamed tracked changes after a fixer failure", async () => {
    writeFileSync(path.join(repoDir, "text.txt"), "staged text\n");
    writeFileSync(path.join(repoDir, "bin.dat"), Buffer.from([5, 4, 3, 2, 1]));
    git("add", "text.txt", "bin.dat");
    writeFileSync(path.join(repoDir, "keep.txt"), "unstaged keep\n");
    git("mv", "old-name.txt", "new-name.txt");
    writeFileSync(path.join(repoDir, "new-name.txt"), "staged rename\n");
    git("add", "new-name.txt");

    const cachedBefore = gitOutput("diff", "--cached", "--binary");
    const unstagedBefore = gitOutput("diff", "--binary");
    const statusBefore = gitOutput("status", "--porcelain", "--untracked-files=no");

    const mutateAndFail = [
      "node",
      "-e",
      JSON.stringify(
        [
          "const fs = require('fs');",
          "fs.writeFileSync('text.txt', 'fixer text\\n');",
          "fs.writeFileSync('keep.txt', 'fixer keep\\n');",
          "fs.writeFileSync('new-name.txt', 'fixer rename\\n');",
          "fs.writeFileSync('bin.dat', Buffer.from([9, 8, 7, 6]));",
          "process.exit(1);",
        ].join(" "),
      ),
    ].join(" ");

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: mutateAndFail, reason: "Default verify.fix command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(gitOutput("status", "--porcelain", "--untracked-files=no")).toBe(statusBefore);
    expect(gitOutput("diff", "--cached", "--binary")).toBe(cachedBefore);
    expect(gitOutput("diff", "--binary")).toBe(unstagedBefore);
  }, 20_000);

  it("restores a pure rename (no content change) after a fixer failure", async () => {
    // A pure `git mv` with no content change produces `R  old -> new` porcelain
    // status. Before ARC-1546 the mutation snapshot keyed this by the literal
    // "old -> new" string, so restore targeted an invalid pathspec and the
    // staged rename was silently discarded.
    git("mv", "old-name.txt", "new-name.txt");

    const statusBefore = gitOutput("status", "--porcelain", "--untracked-files=no");
    expect(statusBefore).toMatch(/R\s+old-name\.txt -> new-name\.txt/);

    const mutateAndFail = ["sh", "-c", "echo 'fixer content' > new-name.txt && exit 1"].join(" ");

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: mutateAndFail, reason: "Test fixer" },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(gitOutput("status", "--porcelain", "--untracked-files=no")).toBe(statusBefore);
  }, 20_000);

  function git(...args: string[]): void {
    execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
  }

  function gitOutput(...args: string[]): string {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
  }
});
