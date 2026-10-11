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
  resolvePrePublishTestPlan,
  runConfiguredPrePublishTestCommand,
} from "../../apps/sandbox-bridge/src/utils/pre-publish-tests.js";

describe("pre-publish configured tests", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), "pre-publish-tests-"));
    mocks.mockExecFile.mockReset();
    mocks.mockExecFile.mockImplementation((_cmd, _args, _options, callback) => {
      callback(null, "", "");
      return { on: vi.fn() };
    });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("skips neutrally when verify.test is not configured", () => {
    const plan = resolvePrePublishTestPlan(repoDir, ["src/app.ts"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: false,
        ok: true,
        skipped: true,
      }),
    );
  });

  // Round-trip guard for the onboarding playbook (buildOnboardingAgentGuidance):
  // a config authored exactly as the playbook teaches must parse into runnable
  // rules, and the dotted-key shape the playbook forbids must stay unconfigured.
  it("parses a playbook-shaped nested verify config into runnable rules", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        appRuntime: { kind: "web", runner: "docker" },
        verify: {
          test: {
            command: "bash .cycloid/verify.sh default",
            rules: [{ name: "cycloid-onboarding", paths: [".cycloid/**"], command: "bash .cycloid/verify.sh cycloid" }],
            timeoutSeconds: 120,
            skipPaths: ["docs/**"],
          },
        },
      }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, [".cycloid/verify.sh"]);

    expect(plan.skipped).toBe(false);
    expect(plan.commands.map((command) => command.command)).toEqual([
      "bash .cycloid/verify.sh default",
      "bash .cycloid/verify.sh cycloid",
    ]);
  });

  it('treats a dotted "verify.test" top-level key as unconfigured (QA session 9adfa1d7 regression)', () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({ "verify.test": { command: "bash .cycloid/verify.sh" } }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, [".cycloid/verify.sh"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: false,
        ok: true,
        skipped: true,
      }),
    );
  });

  it("matches changed files to configured test rules", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: {
          test: {
            rules: [
              {
                paths: ["apps/ui/**"],
                command: "npm --workspace apps/ui test",
              },
              {
                paths: ["apps/api/**"],
                command: "npm --workspace apps/api test",
              },
            ],
          },
        },
      }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, ["apps/ui/src/App.tsx"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: false,
        commands: [
          {
            command: "npm --workspace apps/ui test",
            reason: "verify.test rule matched apps/ui/**.",
          },
        ],
      }),
    );
  });

  it("matches double-star rules against direct child files", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: {
          test: {
            rules: [
              {
                paths: ["src/**/*.ts"],
                command: "npm test -- src",
              },
            ],
          },
        },
      }),
    );

    const directChildPlan = resolvePrePublishTestPlan(repoDir, ["src/index.ts"]);
    const nestedChildPlan = resolvePrePublishTestPlan(repoDir, ["src/routes/index.ts"]);

    expect(directChildPlan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: false,
      }),
    );
    expect(nestedChildPlan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: false,
      }),
    );
  });

  it("skips when configured test rules do not match changed code", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: {
          test: {
            rules: [{ paths: ["apps/ui/**"], command: "npm --workspace apps/ui test" }],
          },
        },
      }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, ["apps/api/src/index.ts"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: true,
        skipReason: "No verify.test command matched the changed files.",
      }),
    );
  });

  // Guards this repo's own .cycloid.json verify.test block (PR 1: dogfood the gate).
  // The dogfood session relies on this exact shape resolving to a runnable typecheck.
  it("resolves this repo's verify.test typecheck config for a non-docs change", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: { test: { command: "npm run typecheck", timeoutSeconds: 600 } },
        appRuntime: { kind: "web", runner: "docker" },
      }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, ["apps/control-plane-worker/src/index.ts"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: false,
        commands: [{ command: "npm run typecheck", reason: "Default verify.test command." }],
        timeoutMs: 600_000,
      }),
    );
  });

  it("skips this repo's verify.test typecheck config for a docs-only change", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: { test: { command: "npm run typecheck", timeoutSeconds: 600 } },
        appRuntime: { kind: "web", runner: "docker" },
      }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, ["docs/workflow.md"]);

    expect(plan).toEqual(expect.objectContaining({ configured: true, ok: true, skipped: true }));
  });

  it("fails closed when this repo's .cycloid.json is malformed", () => {
    writeFileSync(path.join(repoDir, ".cycloid.json"), "{ not valid json ");

    const plan = resolvePrePublishTestPlan(repoDir, ["apps/control-plane-worker/src/index.ts"]);

    expect(plan).toEqual(expect.objectContaining({ configured: true, ok: false, skipped: true }));
  });

  it("skips configured tests for docs-only changes", () => {
    writeFileSync(
      path.join(repoDir, ".cycloid.json"),
      JSON.stringify({
        verify: {
          test: "npm test",
        },
      }),
    );

    const plan = resolvePrePublishTestPlan(repoDir, ["docs/setup.md", "README.md"]);

    expect(plan).toEqual(
      expect.objectContaining({
        configured: true,
        ok: true,
        skipped: true,
      }),
    );
  });

  it("runs configured commands without exposing the shell wrapper as evidence", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    mocks.mockExecFile.mockImplementation((cmd, args, _options, callback) => {
      calls.push({ cmd, args });
      callback(null, cmd === "/bin/bash" ? "ok\n" : "", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test -- --run src/app.test.ts", reason: "verify.test rule matched src/**." },
      30_000,
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        command: ["npm test -- --run src/app.test.ts"],
        output: "Configured pre-publish test passed.",
      }),
    );
    expect(
      calls.some((call) => call.cmd === "/bin/bash" && call.args.join(" ") === "-lc npm test -- --run src/app.test.ts"),
    ).toBe(true);
  });

  it("runs configured commands without exposing the sandbox auth token", async () => {
    const oldSandboxAuthToken = process.env.SANDBOX_AUTH_TOKEN;
    const oldPath = process.env.PATH;
    process.env.SANDBOX_AUTH_TOKEN = "strix-demo-session-token";
    const calls: Array<{ cmd: string; options: { env?: Record<string, string> } }> = [];
    mocks.mockExecFile.mockImplementation((cmd, _args, options, callback) => {
      calls.push({ cmd, options });
      callback(null, "", "");
      return { on: vi.fn() };
    });

    try {
      const result = await runConfiguredPrePublishTestCommand(
        repoDir,
        { command: 'printf "%s" "$SANDBOX_AUTH_TOKEN" > token.txt', reason: "Default verify.test command." },
        30_000,
      );

      expect(result.ok).toBe(true);
      const bashEnv = calls.find((call) => call.cmd === "/bin/bash")?.options.env;
      expect(bashEnv).toBeDefined();
      expect(bashEnv?.SANDBOX_AUTH_TOKEN).toBeUndefined();
      expect(bashEnv?.PATH).toBe(oldPath);
    } finally {
      if (oldSandboxAuthToken === undefined) delete process.env.SANDBOX_AUTH_TOKEN;
      else process.env.SANDBOX_AUTH_TOKEN = oldSandboxAuthToken;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it("fails when a configured command mutates tracked files", async () => {
    let gitDiffCalls = 0;
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "git") {
        gitDiffCalls++;
        callback(null, gitDiffCalls === 1 ? "" : " M src/generated.ts\n", "");
        return { on: vi.fn() };
      }
      callback(null, "SECRET_TOKEN=generated\n", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test", reason: "Default verify.test command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("mutated tracked files: src/generated.ts");
    expect(result.output).toContain("Raw stdout/stderr omitted");
    expect(result.output).not.toContain("SECRET_TOKEN");
  });

  it("omits configured command stdout and stderr from failed evidence", async () => {
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "git") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("failed") as Error & { code?: number };
      error.code = 1;
      callback(error, "SECRET_TOKEN=abc\n", "database_url=postgres://secret\n");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test", reason: "Default verify.test command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Configured pre-publish test failed with exit code 1");
    expect(result.output).toContain("Raw stdout/stderr omitted");
    expect(result.output).not.toContain("SECRET_TOKEN");
    expect(result.output).not.toContain("postgres://secret");
  });

  it("surfaces redacted captured output on a failing exit, keeping the PR field redacted", async () => {
    const ghpToken = `ghp_${"a".repeat(36)}`;
    const output = [
      "BEGIN failing test output",
      "x".repeat(9_000),
      `AssertionError: expected 1 to equal 2`,
      `leaked ${ghpToken}`,
      "database_url=postgres://user:pass@localhost:5432/app",
      "END failing test output",
    ].join("\n");
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "git") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("failed") as Error & { code?: number };
      error.code = 2;
      callback(error, output, "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test", reason: "Default verify.test command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    // Captured output carries the real diagnostic, with pattern-matched secrets redacted.
    expect(result.failureLogTail).toBeDefined();
    expect(result.failureLogTail).toContain("BEGIN failing test output");
    expect(result.failureLogTail).toContain("AssertionError: expected 1 to equal 2");
    expect(result.failureLogTail).toContain("END failing test output");
    expect(result.failureLogTail).not.toContain(ghpToken);
    expect(result.failureLogTail).not.toContain("postgres://user:pass");
    expect(result.failureLogTail).toContain("[REDACTED]");
    // The generic result field stays the redacted constant; readiness evidence uses failureLogTail.
    expect(result.output).toContain("Configured pre-publish test failed with exit code 2");
    expect(result.output).not.toContain("AssertionError");
    expect(result.output).not.toContain(ghpToken);
  });

  it("does not attach a tail to a passing test", async () => {
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      callback(null, cmd === "/bin/bash" ? "all good\n" : "", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test", reason: "Default verify.test command." },
      30_000,
    );

    expect(result.ok).toBe(true);
    expect(result.failureLogTail).toBeUndefined();
  });

  it("carries a redacted tail when the command cannot be spawned", async () => {
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "git") {
        callback(null, "", "");
        return { on: vi.fn() };
      }
      const error = new Error("spawn /bin/bash ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      // No output + non-numeric code triggers the execution-error branch (reject).
      callback(error, "", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test", reason: "Default verify.test command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("Configured pre-publish test could not run");
    expect(result.failureLogTail).toBeDefined();
    expect(result.failureLogTail).toContain("ENOENT");
  });

  it("attaches an operator tail without leaking it into the PR field when a command mutates files", async () => {
    let gitDiffCalls = 0;
    mocks.mockExecFile.mockImplementation((cmd, _args, _options, callback) => {
      if (cmd === "git") {
        gitDiffCalls++;
        callback(null, gitDiffCalls === 1 ? "" : " M src/generated.ts\n", "");
        return { on: vi.fn() };
      }
      callback(null, "wrote generated output\n", "");
      return { on: vi.fn() };
    });

    const result = await runConfiguredPrePublishTestCommand(
      repoDir,
      { command: "npm test", reason: "Default verify.test command." },
      30_000,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("mutated tracked files: src/generated.ts");
    expect(result.failureLogTail).toBeDefined();
    expect(result.failureLogTail).toContain("mutated tracked files: src/generated.ts");
    expect(result.failureLogTail).toContain("wrote generated output");
  });
});
