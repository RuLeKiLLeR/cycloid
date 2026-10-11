// @ts-nocheck - sandbox-bridge is excluded from root tsconfig
import { describe, expect, it, vi } from "vitest";

import {
  buildPostExecutionCommandEvidence,
  buildPrReadinessEvidence,
  isRecoveredFailedCommand,
  verificationTargetKeys,
  verificationTargetsFullyCovered,
} from "../../apps/sandbox-bridge/src/services/pr-readiness.js";
import type { PrReadinessCheck } from "../../shared/types/sandbox.js";

const mockLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function commandEvidence(input: {
  command: string;
  status?: "completed" | "error";
  output?: string;
  check?: PrReadinessCheck;
}) {
  const status = input.status ?? "completed";
  return buildPostExecutionCommandEvidence({
    command: [input.command],
    ok: status !== "error",
    output: input.output ?? "",
    exitCode: status === "error" ? 1 : 0,
    check: input.check ?? "tests",
  });
}

describe("buildPrReadinessEvidence", () => {
  it("collects changed files, parsed diff stats, and final-answer file mentions", () => {
    const evidence = buildPrReadinessEvidence(
      {
        changedFiles: ["apps/sandbox-bridge/src/utils/bash-parser.ts", "apps/control-plane-worker/src/router.ts"],
        diffStat: [
          " apps/sandbox-bridge/src/utils/bash-parser.ts | 10 +++++-----",
          " apps/control-plane-worker/src/router.ts              |  4 +++-",
          " 2 files changed, 8 insertions(+), 6 deletions(-)",
        ].join("\n"),
        commandsRun: [],
        finalAnswer:
          "Updated `apps/sandbox-bridge/src/utils/bash-parser.ts` and apps/control-plane-worker/src/router.ts.",
      },
      mockLog,
    );

    expect(evidence.changedFiles).toEqual([
      "apps/control-plane-worker/src/router.ts",
      "apps/sandbox-bridge/src/utils/bash-parser.ts",
    ]);
    expect(evidence.diffStats).toMatchObject({
      filesChanged: 2,
      insertions: 8,
      deletions: 6,
    });
    expect(evidence.filesMentionedInFinalAnswer).toEqual([
      "apps/control-plane-worker/src/router.ts",
      "apps/sandbox-bridge/src/utils/bash-parser.ts",
    ]);
    expect(evidence).not.toHaveProperty("claims");
    expect(evidence).not.toHaveProperty("riskyAreasTouched");
    expect(evidence).not.toHaveProperty("missingEvidence");
  });

  it("falls back to diff stat paths when explicit changed files are unavailable", () => {
    const evidence = buildPrReadinessEvidence({
      changedFiles: [],
      diffStat: " src/app.ts | 2 +-",
      commandsRun: [],
      finalAnswer: "Implemented the login validation change.",
    });

    expect(evidence.changedFiles).toEqual(["src/app.ts"]);
  });

  it("prefers explicit changed files over ellipsized diff stat entries", () => {
    const evidence = buildPrReadinessEvidence({
      changedFiles: ["apps/control-plane-worker/src/services/session-view.ts"],
      diffStat: [" .../src/services/session-view.ts | 4 ++--", " 1 file changed, 2 insertions(+), 2 deletions(-)"].join(
        "\n",
      ),
      commandsRun: [],
      finalAnswer: "Updated the session view projection.",
    });

    expect(evidence.changedFiles).toEqual(["apps/control-plane-worker/src/services/session-view.ts"]);
  });

  it("preserves the explicit final agent message in the evidence bundle", () => {
    const evidence = buildPrReadinessEvidence({
      changedFiles: ["src/app.ts"],
      commandsRun: [],
      finalAnswer: "Full accumulated response text.",
      evidenceBundle: {
        originalPrompt: "Implement the login validation change. ".repeat(80),
        finalSummary: "Full accumulated response text.",
        agentFinalMessage: "Final agent message with verification commands.",
      },
    });

    expect(evidence.evidenceBundle).toMatchObject({
      originalPrompt: "Implement the login validation change. ".repeat(80).trim(),
      finalSummary: "Full accumulated response text.",
      agentFinalMessage: "Final agent message with verification commands.",
    });
  });

  it("extracts the same pytest target from uv and plain pytest invocations", () => {
    expect(
      verificationTargetKeys({
        command: "uv run --group test pytest tests/schedulers/test_integration_health_scheduler.py -q",
      }),
    ).toEqual(["tests:pytest:tests/schedulers/test_integration_health_scheduler.py"]);
    expect(
      verificationTargetKeys({
        command:
          "pytest tests/schedulers/test_integration_health_scheduler.py::TestIntegrationHealthScheduler::test_recovers",
      }),
    ).toEqual(["tests:pytest:tests/schedulers/test_integration_health_scheduler.py"]);
  });

  it("canonicalizes verifier targets through cwd and uv project context", () => {
    expect(
      verificationTargetKeys({
        command: "cd core && uv run pytest tests/schedulers/test_integration_health_scheduler.py",
      }),
    ).toEqual(["tests:pytest:core/tests/schedulers/test_integration_health_scheduler.py"]);
    expect(
      verificationTargetKeys({
        command: "pytest core/tests/schedulers/test_integration_health_scheduler.py",
      }),
    ).toEqual(["tests:pytest:core/tests/schedulers/test_integration_health_scheduler.py"]);
    expect(
      verificationTargetKeys({
        command: "uv run --project dag/data pytest tests/test_daily_integration_health_summary.py",
      }),
    ).toEqual(["tests:pytest:dag/data/tests/test_daily_integration_health_summary.py"]);
    expect(
      verificationTargetKeys({
        command: "uv --project dag/data run pyright src/mia_analytics/assets/analytics/integration_health.py",
      }),
    ).toEqual(["typecheck:pyright:dag/data/src/mia_analytics/assets/analytics/integration_health.py"]);
  });

  describe("verificationTargetKeys — JS test runners", () => {
    it("extracts a vitest test file target regardless of extra flags", () => {
      expect(verificationTargetKeys({ command: "npx vitest run tests/test_ui/api.test.ts" })).toEqual([
        "tests:js:tests/test_ui/api.test.ts",
      ]);
      expect(verificationTargetKeys({ command: "npx vitest run tests/test_ui/api.test.ts --reporter=basic" })).toEqual([
        "tests:js:tests/test_ui/api.test.ts",
      ]);
    });

    it("extracts a jest spec target", () => {
      expect(verificationTargetKeys({ command: "jest src/foo.spec.tsx" })).toEqual(["tests:js:src/foo.spec.tsx"]);
    });

    it("returns no target for a repo-wide typecheck", () => {
      expect(verificationTargetKeys({ command: "tsc --noEmit" })).toEqual([]);
    });

    it("treats vitest -w as a boolean flag, not value-taking, so the following file is still a target", () => {
      expect(verificationTargetKeys({ command: "npx vitest -w src/a.test.ts" })).toEqual(["tests:js:src/a.test.ts"]);
    });

    it("does not treat a value-option argument as a test file (#4)", () => {
      // `-t foo.spec.ts` is a test-NAME filter, not a file; only the real file is a target.
      expect(verificationTargetKeys({ command: "npx vitest run -t foo.spec.ts src/a.test.ts" })).toEqual([
        "tests:js:src/a.test.ts",
      ]);
      expect(verificationTargetKeys({ command: "npx vitest run -t foo.spec.ts" })).toEqual([]);
      expect(verificationTargetKeys({ command: "jest --testNamePattern bar.test.ts src/b.test.ts" })).toEqual([
        "tests:js:src/b.test.ts",
      ]);
    });
  });

  it("preserves explicit post-execution test evidence", () => {
    const command = commandEvidence({
      command: "npx vitest run tests/foo.test.ts",
      status: "completed",
      output: "1 passed",
    });
    const evidence = buildPrReadinessEvidence({
      changedFiles: ["tests/foo.test.ts"],
      commandsRun: [command!],
      finalAnswer: "Updated tests/foo.test.ts.",
    });

    expect(evidence.commandsRun).toEqual([
      expect.objectContaining({
        command: "npx vitest run tests/foo.test.ts",
        status: "completed",
        source: "post_execution",
        check: "tests",
      }),
    ]);
  });

  it("summarizes post-execution command output when available", () => {
    const command = commandEvidence({
      command: "npm start",
      status: "error",
      output: "Error: listen EADDRINUSE: address already in use 127.0.0.1:3001\nnpm ERR! code 1",
    });

    expect(command).toMatchObject({
      command: "npm start",
      status: "error",
      source: "post_execution",
      summary: "Error: listen EADDRINUSE: address already in use 127.0.0.1:3001 | npm ERR! code 1",
    });
  });

  it("strips ANSI escape codes from summarized command evidence and stored reviewer output", () => {
    const command = commandEvidence({
      command: "npm test",
      status: "error",
      output: "\u001b[31mFAIL\u001b[39m tests/failing.test.ts\n\u001b[2m1 failed\u001b[22m",
    });

    expect(command).toMatchObject({
      summary: "FAIL tests/failing.test.ts | 1 failed",
      failureOutput: "FAIL tests/failing.test.ts\n1 failed",
    });
    expect(command?.summary).not.toMatch(/\u001b\[/);
    expect(command?.failureOutput).not.toMatch(/\u001b\[/);
  });

  it("strips ANSI escape codes from evidence-bundle summaries before storing them", () => {
    const evidence = buildPrReadinessEvidence({
      changedFiles: ["src/app.ts"],
      commandsRun: [],
      finalAnswer: "Finished the login validation change.",
      evidenceBundle: {
        finalSummary: "\u001b[32mUpdated src/app.ts and added regression coverage.\u001b[39m",
        agentFinalMessage: "Applied fix.\n\u001b[36mVerified: tests passed.\u001b[39m",
      },
    });

    expect(evidence.evidenceBundle).toMatchObject({
      finalSummary: "Updated src/app.ts and added regression coverage.",
      agentFinalMessage: "Applied fix.\nVerified: tests passed.",
    });
  });

  it("stores redacted failed command output for reviewer comments", () => {
    const command = commandEvidence({
      command: "npm run test -- --token=abcdef1234567890abcdef1234567890abcdef12",
      status: "error",
      output: [
        "FAIL tests/failing.test.ts",
        "Authorization: Bearer abcdef1234567890abcdef1234567890abcdef12",
        "AssertionError: expected true to be false",
      ].join("\n"),
    });

    expect(command?.failureOutput).toContain("FAIL tests/failing.test.ts");
    expect(command?.failureOutput).toContain("[REDACTED]");
    expect(command?.failureOutput).toContain("AssertionError: expected true to be false");
    expect(command?.failureOutput).not.toContain("abcdef1234567890abcdef1234567890abcdef12");
  });

  it.each([
    ["mysql -u test -pActualSecretValue test_db", "mysql -u test -p[REDACTED] test_db", "ActualSecretValue"],
    ["mysql -uroot -p'ActualSecret!' test_db", "mysql -uroot -p[REDACTED] test_db", "ActualSecret!"],
    [
      "cat dump.sql | mysql -uroot -pActualSecretValue test_db",
      "cat dump.sql | mysql -uroot -p[REDACTED] test_db",
      "ActualSecretValue",
    ],
    ["sshpass -pwActualSecretValue ssh host", "sshpass -pw[REDACTED] ssh host", "ActualSecretValue"],
    ["mysql -u test -p ActualSecretValue test_db", "mysql -u test -p [REDACTED] test_db", "ActualSecretValue"],
    ["tool -password ActualSecretValue", "tool -password [REDACTED]", "ActualSecretValue"],
    [
      "/bin/bash -lc 'mysql -u test -pActualSecretValue test_db'",
      "/bin/bash -lc 'mysql -u test -p[REDACTED] test_db'",
      "ActualSecretValue",
    ],
  ])("redacts inline and separated short password options in %s", (rawCommand, expectedCommand, secret) => {
    const command = commandEvidence({
      command: rawCommand,
      status: "completed",
    });

    expect(command?.command).toBe(expectedCommand);
    expect(command?.command).not.toContain(secret);
  });

  it("applies top-level and shell-payload redactions in source order", () => {
    const command = commandEvidence({
      command: "mysql -u test -pOuterSecret db && /bin/bash -lc 'mysql -u test -pInnerSecret db'",
      status: "completed",
    });

    expect(command?.command).toBe("mysql -u test -p[REDACTED] db && /bin/bash -lc 'mysql -u test -p[REDACTED] db'");
    expect(command?.command).not.toContain("OuterSecret");
    expect(command?.command).not.toContain("InnerSecret");
  });

  it.each([
    [
      'deploy --client-secret "quoted secret value" --target prod',
      "deploy --client-secret [REDACTED] --target prod",
      "quoted secret value",
    ],
    ["deploy --token=Escaped\\Secret --target prod", "deploy --token=[REDACTED] --target prod", "EscapedSecret"],
    [
      "/bin/bash -lc 'deploy --token=NestedSecret --target prod'",
      "/bin/bash -lc 'deploy --token=[REDACTED] --target prod'",
      "NestedSecret",
    ],
  ])("preserves redaction golden output for %s", (rawCommand, expectedCommand, secret) => {
    const command = commandEvidence({
      command: rawCommand,
      status: "completed",
    });

    expect(command?.command).toBe(expectedCommand);
    expect(command?.command).not.toContain(secret);
  });

  it.each([
    "vite --host 0.0.0.0 -p3000",
    "node -p'process.env.NODE_ENV'",
    "deploy -profile production",
    "runner -processName worker",
  ])("does not redact common non-secret short -p forms in %s", (rawCommand) => {
    const command = commandEvidence({
      command: rawCommand,
      status: "completed",
    });

    expect(command?.command).toBe(rawCommand);
  });

  it("keeps the tail of long failed command output for reviewer comments", () => {
    const startupOutput = [
      "Starting test runner...",
      "Installing dependencies...",
      "Launching services...",
      "progress noise\n".repeat(2_000),
    ].join("\n");
    const failureTail = [
      "FAIL tests/failing.test.ts",
      "AssertionError: expected true to be false",
      "at tests/failing.test.ts:12:7",
    ].join("\n");
    const command = commandEvidence({
      command: "npm run test -- tests/failing.test.ts",
      status: "error",
      output: `${startupOutput}${failureTail}`,
    });

    expect(command?.failureOutput).toMatch(/^\[truncated \d+ chars\]\n/);
    expect(command?.failureOutput).not.toContain("Starting test runner...");
    expect(command?.failureOutput).not.toContain("Installing dependencies...");
    expect(command?.failureOutput).not.toContain("Launching services...");
    expect(command?.failureOutput).toContain("FAIL tests/failing.test.ts");
    expect(command?.failureOutput).toContain("AssertionError: expected true to be false");
    expect(command?.failureOutput).toContain("at tests/failing.test.ts:12:7");
  });

  it("preserves a server port collision from the first line of a stack trace", () => {
    const command = commandEvidence({
      command: "npm start",
      status: "error",
      output: [
        "Error: listen EADDRINUSE: address already in use :::3000",
        "    at Server.setupListenHandle [as _listen2] (node:net:1940:16)",
        "    at listenInCluster (node:net:1997:12)",
        "    at Server.listen (node:net:2102:7)",
        "    at Object.<anonymous> (/workspace/app/server.js:8:8)",
      ].join("\n"),
    });

    expect(command?.summary).toContain("EADDRINUSE");
  });

  describe("summarizeCommandOutput result line", () => {
    it("prefers the test-tally result line over npm boilerplate tail", () => {
      const output = [
        "> @cycloid/sandbox-bridge@0.0.1 test",
        "> vitest run",
        "BENCH src/utils.ts",
        "✓ basic_test (10ms)",
        "Tests 90 passed (90)",
        "  Running post-test hooks...",
        "  Cleaning up...",
        "  Done in 8.53s",
      ].join("\n");
      const evidence = commandEvidence({
        command: "npm test",
        status: "completed",
        output,
      });
      expect(evidence?.summary).toContain("90 passed");
    });

    it("falls back to the last lines when no result line is present", () => {
      const output = ["building...", "linking...", "wrote dist/index.js"].join("\n");
      const evidence = commandEvidence({
        command: "npm run build",
        status: "completed",
        output,
      });
      expect(evidence?.summary).toContain("wrote dist/index.js");
    });

    it("prefers a 2xx HTTP status even when it is not in the tail", () => {
      const output = ["< HTTP/1.1 200 OK", "a", "b", "c", "d"].join("\n");
      const evidence = commandEvidence({
        command: "curl -v http://localhost:3000/health",
        status: "completed",
        output,
      });
      expect(evidence?.summary).toContain("200");
    });

    it("does not present a 5xx HTTP status as the result line", () => {
      const output = ["< HTTP/1.1 500 Internal Server Error", "a", "b", "c", "d"].join("\n");
      const evidence = commandEvidence({
        command: "curl -v http://localhost:3000/health",
        status: "completed",
        output,
      });
      expect(evidence?.summary).not.toContain("500");
    });

    it("does not present a zero-pass tally as the result line", () => {
      const output = ["0 passed (0)", "a", "b", "c", "no tests ran"].join("\n");
      const evidence = commandEvidence({
        command: "npm test",
        status: "completed",
        output,
      });
      expect(evidence?.summary).not.toContain("0 passed");
    });
  });

  it("records skipped post-execution typecheck commands without marking unsupported typecheck as missing", () => {
    const command = buildPostExecutionCommandEvidence({
      command: undefined,
      ok: true,
      output: "No package.json found; skipping repository typecheck.",
      exitCode: null,
      skipped: true,
      skipReason: "No package.json found; skipping repository typecheck.",
      check: "typecheck",
    });
    const evidence = buildPrReadinessEvidence({
      changedFiles: ["src/app.ts"],
      commandsRun: [command],
      finalAnswer: "Updated app.",
    });

    expect(evidence.commandsRun).toEqual([
      expect.objectContaining({
        command: "typecheck check",
        status: "skipped",
        source: "post_execution",
        check: "typecheck",
      }),
    ]);
    expect(evidence.skippedChecks).toEqual([]);
  });

  it("does not create heuristic gates for final-answer claims, test files, risky paths, or failed commands", () => {
    const evidence = buildPrReadinessEvidence({
      changedFiles: ["apps/control-plane-worker/src/router.ts", "tests/app.test.ts"],
      commandsRun: [
        {
          command: "npm test",
          status: "error",
          exitCode: 1,
          source: "post_execution",
          check: "tests",
        },
      ],
      finalAnswer: "Tests passed and typecheck passed.",
    });

    expect(evidence).not.toHaveProperty("claims");
    expect(evidence).not.toHaveProperty("riskyAreasTouched");
    expect(evidence).not.toHaveProperty("missingEvidence");
  });
});

describe("recovered command detection", () => {
  const command = (rawCommand, status) => ({
    command: rawCommand,
    status,
    exitCode: status === "error" ? 1 : 0,
    source: "post_execution",
    check: "tests",
  });

  it("requires every failed target to be covered by a later passing target", () => {
    const commands = [
      command("npx vitest run tests/a.test.ts tests/b.test.ts", "error"),
      command("npx vitest run tests/a.test.ts", "completed"),
    ];

    expect(isRecoveredFailedCommand(commands, 0)).toBe(false);
  });

  it("does not recover a targeted failure with a later same-check command that has no parsed targets", () => {
    const commands = [
      command("npx vitest run tests/a.test.ts tests/b.test.ts", "error"),
      command("npm test -- tests/a.test.ts tests/b.test.ts", "completed"),
    ];

    expect(isRecoveredFailedCommand(commands, 0)).toBe(false);
  });

  it("keeps single-target recovery behavior unchanged", () => {
    const commands = [
      command("npx vitest run tests/a.test.ts", "error"),
      command("npx vitest run tests/a.test.ts", "completed"),
    ];

    expect(isRecoveredFailedCommand(commands, 0)).toBe(true);
  });

  it("treats multiple failed targets as covered when a later broader target passes", () => {
    expect(
      verificationTargetsFullyCovered(
        ["tests:js:tests/unit/a.test.ts", "tests:js:tests/unit/b.test.ts"],
        ["tests:js:tests/unit"],
      ),
    ).toBe(true);
  });

  it("does not treat passing Error:CODE output as a recovered failed command", () => {
    const commands = [
      {
        command: "npm test",
        status: "completed",
        exitCode: 0,
        source: "post_execution",
        check: "tests",
        summary: "Handled Error:ENOENT fallback path successfully.",
      },
      {
        command: "npm test",
        status: "completed",
        exitCode: 0,
        source: "post_execution",
        check: "tests",
        summary: "All tests passed.",
      },
    ] as const;

    const evidence = buildPrReadinessEvidence({
      changedFiles: ["src/app.ts"],
      commandsRun: [...commands],
      finalAnswer: "Done",
    });

    expect(evidence.commandsRun.map((command) => command.summary)).toContain(
      "Handled Error:ENOENT fallback path successfully.",
    );
  });
});
