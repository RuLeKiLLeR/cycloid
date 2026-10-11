import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: mocks.mockExecFile,
}));

import {
  resolvePrePublishFixPlan,
  runConfiguredPrePublishFixCommand,
} from "../../apps/sandbox-bridge/src/utils/pre-publish-fix.js";

describe("pre-publish configured fixes", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), "pre-publish-fix-"));
    mocks.mockExecFile.mockReset();
    mocks.mockExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, "", "");
      return { on: vi.fn() };
    });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("skips neutrally when verify.fix is not configured", () => {
    const plan = resolvePrePublishFixPlan(repoDir, ["src/app.ts"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: false,
        ok: true,
        skipped: true,
      }),
    );
  });

  it("does not report configured when no files changed and verify.fix is absent", () => {
    const plan = resolvePrePublishFixPlan(repoDir, []);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: false,
        ok: true,
        skipped: true,
      }),
    );
  });

  it("parses verify.fix with the same command and rule shapes as verify.test", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: {
          fix: {
            command: "npm run fix:default",
            rules: [{ name: "ui", paths: ["apps/ui/**"], command: "npm run fix:ui" }],
            timeoutSeconds: 120,
          },
        },
      }),
    );

    const plan = resolvePrePublishFixPlan(repoDir, ["apps/ui/src/App.tsx"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: false,
        commands: [
          { command: "npm run fix:default", reason: "Default verify.fix command." },
          { command: "npm run fix:ui", reason: "ui: verify.fix rule matched apps/ui/**." },
        ],
        timeoutMs: 120_000,
      }),
    );
  });

  it("does not apply the docs-only skip to verify.fix", () => {
    writeFileSync(path.join(repoDir, ".cycloid.json"), JSON.stringify({ verify: { fix: "npm run format" } }));

    const plan = resolvePrePublishFixPlan(repoDir, ["docs/setup.md"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: false,
      }),
    );
  });

  it("treats tracked mutations as successful fix output", async () => {
    let gitStatusCalls = 0;
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      if (cmd === "git" && args[0] === "status") {
        gitStatusCalls++;
        callback(null, gitStatusCalls === 1 ? "" : " M src/app.ts\n", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      callback(null, "formatted\n", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: "npm run fix", reason: "Default verify.fix command." },
      30_000,
    );

    expect(result.ok).toBe(true);
    expect(result.mutatedFiles).toEqual(["src/app.ts"]);
    expect(result.output).toContain("mutated tracked files: src/app.ts");
  });

  it("fails open and restores partially mutated tracked files after a non-zero exit", async () => {
    let gitStatusCalls = 0;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args[0] === "status") {
        gitStatusCalls++;
        callback(null, gitStatusCalls === 1 ? "" : " M src/app.ts\n", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "reset") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "checkout") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("failed") as Error & { code?: number };
      error.code = 1;
      callback(error, "SECRET_TOKEN=abc\n", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: "npm run fix", reason: "Default verify.fix command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.mutatedFiles).toEqual(["src/app.ts"]);
    expect(calls).toContainEqual({ cmd: "git", args: ["reset", "--hard", "HEAD"] });
    expect(result.output).toContain("failed with exit code 1");
    expect(result.output).not.toContain("SECRET_TOKEN");
  });

  it("restores staged fixer mutations that keep the same porcelain status after failure", async () => {
    let gitStatusCalls = 0;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const stagedPatchBefore = "diff --git a/src/app.ts b/src/app.ts\nold staged patch\n";
    const stagedPatchAfter = "diff --git a/src/app.ts b/src/app.ts\nnew staged patch\n";
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args[0] === "status") {
        gitStatusCalls++;
        callback(null, "M  src/app.ts\n", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) {
        callback(null, gitStatusCalls <= 1 ? stagedPatchBefore : stagedPatchAfter, "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && (args[0] === "reset" || args[0] === "checkout" || args[0] === "apply")) {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("failed") as Error & { code?: number };
      error.code = 1;
      callback(error, "", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: "npm run fix", reason: "Default verify.fix command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.mutatedFiles).toEqual(["src/app.ts"]);
    expect(calls).toContainEqual({ cmd: "git", args: ["reset", "--hard", "HEAD"] });
    expect(calls).toContainEqual({ cmd: "git", args: ["checkout", "--", "src/app.ts"] });
    expect(calls.some((call) => call.cmd === "git" && call.args[0] === "apply" && call.args[1] === "--cached")).toBe(
      true,
    );
  });

  it("captures pre-publish fix patches with combined staged and unstaged diffs", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const stagedPatch =
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n" +
      "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const unstagedPatch =
      "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-new\n+fixed\n" +
      "diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-new\n+fixed\n";
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args[0] === "status") {
        callback(null, "MM src/app.ts\nMM src/other.ts\n", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) {
        callback(null, stagedPatch, "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff") {
        callback(null, unstagedPatch, "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && (args[0] === "reset" || args[0] === "checkout" || args[0] === "apply")) {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("failed") as Error & { code?: number };
      error.code = 1;
      callback(error, "", "");
      return { on: vi.fn() };
    });

    await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: "npm run fix", reason: "Default verify.fix command." },
      30_000,
    );

    const diffCalls = calls.filter((call) => call.cmd === "git" && call.args[0] === "diff");
    expect(diffCalls).toEqual([
      { cmd: "git", args: ["diff", "--cached", "--binary"] },
      { cmd: "git", args: ["diff", "--binary"] },
      { cmd: "git", args: ["diff", "--cached", "--binary"] },
      { cmd: "git", args: ["diff", "--binary"] },
    ]);
  });

  it("falls back to per-file diff when the combined diff misses a staged file", async () => {
    let statusCalls = 0;
    let fallbackCalls = 0;
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const stagedPatchBefore = "diff --git a/src/app.ts b/src/app.ts\nold staged patch\n";
    const stagedPatchAfter = "diff --git a/src/app.ts b/src/app.ts\nnew staged patch\n";
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      calls.push({ cmd, args });
      if (cmd === "git" && args[0] === "status") {
        statusCalls += 1;
        callback(null, "M  src/app.ts\n", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--cached") && args.includes("--")) {
        fallbackCalls += 1;
        callback(null, fallbackCalls === 1 ? stagedPatchBefore : stagedPatchAfter, "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && args[0] === "diff" && args.includes("--cached")) {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      if (cmd === "git" && (args[0] === "reset" || args[0] === "checkout" || args[0] === "apply")) {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("failed") as Error & { code?: number };
      error.code = 1;
      callback(error, "", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: "npm run fix", reason: "Default verify.fix command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.mutatedFiles).toEqual(["src/app.ts"]);
    expect(statusCalls).toBe(2);
    expect(calls).toContainEqual({ cmd: "git", args: ["diff", "--cached", "--binary", "--", "src/app.ts"] });
    expect(calls.some((call) => call.cmd === "git" && call.args.join(" ") === "diff --binary")).toBe(false);
  });

  it("ignores untracked fixer byproducts", async () => {
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "git") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      callback(null, "created tmp file\n", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishFixCommand(
      repoDir,
      { command: "npm run fix", reason: "Default verify.fix command." },
      30_000,
    );

    expect(result.ok).toBe(true);
    expect(result.mutatedFiles).toEqual([]);
  });
});
