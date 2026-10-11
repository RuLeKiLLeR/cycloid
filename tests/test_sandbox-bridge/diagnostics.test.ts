import { describe, expect, it } from "vitest";

import {
  formatResourceKilledManualReviewReason,
  isGenuineBashFailure,
  isResourceKilledCommandResult,
  TEST_FILE_PATTERN,
} from "../../apps/sandbox-bridge/src/utils/diagnostics.js";

describe("diagnostics helpers", () => {
  it("classifies exit-137 results as resource-killed manual-review candidates", () => {
    const result = {
      ok: false,
      output: "Command failed with exit code 137",
      command: ["npm", "run", "typecheck"],
      exitCode: 137,
      skipped: false,
    };
    expect(isResourceKilledCommandResult(result)).toBe(true);
    expect(formatResourceKilledManualReviewReason("typecheck")).toBe(
      "Broad typecheck could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.",
    );
  });

  it("does not classify ordinary compiler output mentioning resource limits as resource-killed", () => {
    expect(
      isResourceKilledCommandResult({
        exitCode: 1,
        output: [
          "src/resource-limit.test.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.",
          "The test fixture asserts OOM and resource limit behaviour.",
        ].join("\n"),
      }),
    ).toBe(false);
    expect(
      isResourceKilledCommandResult({
        exitCode: 1,
        output: "Process terminated with SIGKILL after exceeding memory.",
      }),
    ).toBe(true);
  });

  describe("isGenuineBashFailure", () => {
    it("treats benign non-zero exits (grep/rg/diff/test) as not-a-failure", () => {
      // grep no-match (incl. the reported `git log | grep` case): empty output, exit 1
      expect(isGenuineBashFailure("")).toBe(false);
      // diff finding differences, exit 1
      expect(isGenuineBashFailure("< old line\n> new line")).toBe(false);
      // failing test suite: ran fine, reported failures via non-zero exit
      expect(isGenuineBashFailure("Tests: 1 failed, 4 passed\nFAIL src/foo.test.ts")).toBe(false);
      // "timed out after" without the "command" prefix must NOT trip BASH_TIMEOUT_PATTERN
      expect(isGenuineBashFailure("Background task timed out after 5s, retrying")).toBe(false);
      // "not found" in benign output, not shell-prefixed, must NOT trip SHELL_EXEC_FAILURE_PATTERN
      expect(isGenuineBashFailure("grep: config: not found in index")).toBe(false);
      // benign traversal: a tool (not a shell) reporting an inaccessible/missing path
      expect(isGenuineBashFailure("find: '/proc/1': Permission denied")).toBe(false);
      expect(isGenuineBashFailure("cat: missing.txt: No such file or directory")).toBe(false);
    });

    it("flags resource-killed / OOM output as a genuine failure", () => {
      expect(isGenuineBashFailure("Killed")).toBe(true);
      expect(isGenuineBashFailure("FATAL ERROR: Reached heap limit - JavaScript heap out of memory")).toBe(true);
    });

    it("flags command timeouts as a genuine failure", () => {
      expect(isGenuineBashFailure("Error: Command timed out after 120000ms")).toBe(true);
    });

    it("flags shell exec failures (missing/unexecutable command) as genuine failures", () => {
      expect(isGenuineBashFailure("bash: rga: command not found")).toBe(true);
      expect(isGenuineBashFailure("zsh: command not found: pnpm")).toBe(true);
      // POSIX sh/dash form (exit 127, no "command") - common for package scripts
      expect(isGenuineBashFailure("sh: 1: vite: not found")).toBe(true);
      expect(isGenuineBashFailure("/bin/sh: vite: not found")).toBe(true);
      // shell could not launch the command it was given (exit 126/127)
      expect(isGenuineBashFailure("bash: ./script.sh: Permission denied")).toBe(true);
      expect(isGenuineBashFailure("bash: ./missing.sh: No such file or directory")).toBe(true);
    });
  });

  it("recognizes Python, Go, Rust, Ruby test files as test files", () => {
    expect(TEST_FILE_PATTERN.test("tests/test_admin.py")).toBe(true);
    expect(TEST_FILE_PATTERN.test("module/foo_test.py")).toBe(true);
    expect(TEST_FILE_PATTERN.test("pkg/user/user_test.go")).toBe(true);
    expect(TEST_FILE_PATTERN.test("tests/integration.rs")).toBe(true);
    expect(TEST_FILE_PATTERN.test("spec/user_spec.rb")).toBe(true);
    expect(TEST_FILE_PATTERN.test("src/foo.py")).toBe(false);
    expect(TEST_FILE_PATTERN.test("src/foo.go")).toBe(false);
    expect(TEST_FILE_PATTERN.test("src/lib.rs")).toBe(false);
  });
});
