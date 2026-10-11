export type RepoTestResult = {
  ok: boolean;
  output: string;
  command?: string[];
  exitCode: number | null;
  skipped: boolean;
  skipReason?: string;
  reason: string;
  /**
   * Pre-redacted captured failing output. Safe for reviewer-facing failed-command evidence;
   * operator-only deep links and metadata should stay out of PR surfaces.
   */
  failureLogTail?: string;
};

const NODE_TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const PYTHON_TEST_FILE_PATTERN = /(?:^|\/)test_[^/]+\.py$|_test\.py$/i;
const GO_TEST_FILE_PATTERN = /_test\.go$/i;
const RUST_TEST_FILE_PATTERN = /(?:^|\/)tests\/[^/]+\.rs$/i;
const RUBY_SPEC_FILE_PATTERN = /_spec\.rb$/i;

export const TEST_FILE_PATTERN = new RegExp(
  [
    NODE_TEST_FILE_PATTERN.source,
    PYTHON_TEST_FILE_PATTERN.source,
    GO_TEST_FILE_PATTERN.source,
    RUST_TEST_FILE_PATTERN.source,
    RUBY_SPEC_FILE_PATTERN.source,
  ].join("|"),
  "i",
);

export function isResourceKilledCommandResult(result: { exitCode?: number | null; output?: string }): boolean {
  if (result.exitCode === 137) return true;
  const output = result.output ?? "";
  const tailLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-20);
  return tailLines.some((line) =>
    [
      /^killed(?:\s|$)/i,
      /^fatal error:.*(?:heap out of memory|out of memory)/i,
      /\b(?:process|command|subprocess|npm|pnpm|yarn|node|tsc|typescript|vitest|jest|pytest|runner)\b.*\b(?:killed|sigkill|oom|out of memory|heap out of memory|enomem|resource limit)\b/i,
      /\b(?:killed|sigkill|out of memory|heap out of memory|enomem|resource limit)\b.*\b(?:process|command|subprocess|npm|pnpm|yarn|node|tsc|typescript|vitest|jest|pytest|runner|memory|limit)\b/i,
      /\b(?:terminated|exited|failed|aborted)\b.*\b(?:sigkill|out of memory|heap out of memory|enomem|resource limit)\b/i,
    ].some((pattern) => pattern.test(line)),
  );
}

export function formatResourceKilledManualReviewReason(check: "typecheck" | "tests" | string): string {
  return `Broad ${check} could not complete because the command was killed by resource limits; review the scoped verification evidence before merge.`;
}

/**
 * Signatures that mean a shell command genuinely failed to run, as opposed to
 * running fine and reporting a non-zero exit as information (grep/rg/diff/test/
 * `git diff --exit-code` and friends). The agent runtime only hands us a boolean
 * "is_error" for Bash - it conflates non-zero exit with real infra failures and
 * never exposes the numeric exit code - so we recover the distinction from the
 * combined stdout/stderr text. Kept deliberately narrow: matching the common
 * benign-non-zero flood here would re-introduce the false failures we are trying
 * to suppress, so we only escalate on strong, stable failure evidence.
 */
const BASH_TIMEOUT_PATTERN = /command timed out after/i;
// A shell that could not launch the requested command (exit 126/127): missing
// executable, unreadable/unexecutable file, or a directory used as a command.
// bash prints "<cmd>: command not found"; POSIX sh/dash - how package scripts and
// many `sh -c` invocations run - instead print "<shell>: [line:] <path>: <reason>"
// with no "command". Match the bash phrase plus the shell-prefixed forms, anchored
// to a shell name so benign "<tool>: <path>: No such file or directory" traversal
// output (find/grep/cat that ran fine and merely reported a missing path) is left
// as a completed command.
const SHELL_EXEC_FAILURE_PATTERN =
  /\bcommand not found\b|(?:^|\n)\S*sh: (?:\d+: )?[^\n]*: (?:not found|permission denied|no such file or directory|cannot execute|is a directory)\b/i;

/**
 * True when a Bash command's output shows it genuinely failed to execute
 * (resource-killed/OOM, timed out, or the executable was missing), rather than
 * merely exiting non-zero. Callers use this to keep an error status only for
 * real failures and treat every other non-zero exit as a completed command.
 */
export function isGenuineBashFailure(output: string): boolean {
  if (isResourceKilledCommandResult({ output })) return true;
  return BASH_TIMEOUT_PATTERN.test(output) || SHELL_EXEC_FAILURE_PATTERN.test(output);
}
