import { execFile } from "child_process";

import { redact } from "../../../../shared/observability/redact.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { EXEC_MAX_BUFFER_BYTES } from "../constants/bridge.js";
import { porcelainDestinationPath } from "../services/git/staging.js";
import type { RepoTestResult } from "./diagnostics.js";
import {
  allChangedFilesMatchSkipPaths,
  DEFAULT_VERIFY_TIMEOUT_MS,
  DOCS_ONLY_FILE_PATTERN,
  normalizeChangedFiles,
  normalizeVerifyConfig,
  readVerifyConfig,
  resolveConfiguredCommands,
  type VerifyCommand,
} from "./pre-publish-config.js";
import { buildRepoCommandEnv } from "./sanitized-env.js";

const CONFIGURED_TEST_OUTPUT_OMITTED_REASON =
  "Raw stdout/stderr omitted because configured pre-publish test output can contain sensitive data.";

/**
 * Build the diagnostics output: redact secrets at the source (the shared logger
 * writes raw entries to stdout before sink redaction, so we cannot rely on sink-level scrubbing)
 * and return the captured command output. Returns undefined when there is nothing useful to log.
 */
function buildFailureLogOutput(rawOutput: string): string | undefined {
  const trimmed = rawOutput.trim();
  if (!trimmed) return undefined;
  return redact(trimmed);
}

export type PrePublishTestPlan =
  | {
      configured: false;
      ok: true;
      skipped: true;
      skipReason: string;
      commands: [];
      timeoutMs: number;
    }
  | {
      configured: true;
      ok: true;
      skipped: true;
      skipReason: string;
      commands: [];
      timeoutMs: number;
    }
  | {
      configured: true;
      ok: false;
      skipped: true;
      skipReason: string;
      commands: [];
      timeoutMs: number;
    }
  | {
      configured: true;
      ok: true;
      skipped: false;
      commands: VerifyCommand[];
      timeoutMs: number;
    };

export type ConfiguredTestCommand = VerifyCommand;

export type CommandRunResult = {
  exitCode: number;
  output: string;
};

export function resolvePrePublishTestPlan(cwd: string, changedFiles?: Iterable<string>): PrePublishTestPlan {
  const changed = normalizeChangedFiles(cwd, changedFiles);
  const rawConfig = readVerifyConfig(cwd, "test");
  if (!rawConfig.ok) {
    return failedSkip(rawConfig.reason);
  }
  if (!rawConfig.configured) {
    return skippedUnconfigured("No .cycloid.json verify.test configuration found; skipping pre-publish tests.");
  }
  if (rawConfig.value === false) {
    return skippedConfigured("verify.test is disabled; skipping pre-publish tests.");
  }
  if (changed.length > 0 && changed.every((file) => DOCS_ONLY_FILE_PATTERN.test(file))) {
    return skippedConfigured("Changed files are docs-only; skipping configured pre-publish tests.");
  }

  const normalizedConfig = normalizeVerifyConfig(rawConfig.value, "verify.test");
  if (!normalizedConfig.ok) return failedSkip(normalizedConfig.reason);
  const { config: testConfig, timeoutMs } = normalizedConfig;
  if (testConfig.required === false) {
    return skippedConfigured("verify.test.required is false; skipping pre-publish tests.");
  }
  if (allChangedFilesMatchSkipPaths(changed, testConfig.skipPaths)) {
    return skippedConfigured("Changed files match verify.test.skipPaths; skipping pre-publish tests.");
  }

  const commands = resolveConfiguredCommands(testConfig, changed, "verify.test");
  if (!commands.ok) return failedSkip(commands.reason, timeoutMs);
  if (commands.commands.length === 0) {
    return skippedConfigured("No verify.test command matched the changed files.");
  }

  return {
    configured: true,
    ok: true,
    skipped: false,
    commands: commands.commands,
    timeoutMs,
  };
}

export async function runConfiguredPrePublishTestCommand(
  cwd: string,
  configuredCommand: ConfiguredTestCommand,
  timeoutMs: number,
): Promise<RepoTestResult> {
  const beforeMutationSnapshot = await trackedMutationSnapshot(cwd);
  let runResult: CommandRunResult;
  try {
    runResult = await runShellCommand(configuredCommand.command, cwd, timeoutMs);
  } catch (error) {
    const failureLogTail = buildFailureLogOutput(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return {
      ok: false,
      output: configuredTestExecutionErrorOutput(error),
      command: [configuredCommand.command],
      exitCode: null,
      skipped: false,
      reason: configuredCommand.reason,
      ...(failureLogTail ? { failureLogTail } : {}),
    };
  }

  const afterMutationSnapshot = await trackedMutationSnapshot(cwd);
  const mutatedFiles = diffSnapshots(beforeMutationSnapshot, afterMutationSnapshot);
  if (mutatedFiles.length > 0) {
    const mutationOutput = `Configured pre-publish test mutated tracked files: ${mutatedFiles.join(", ")}`;
    // The mutated-file names are already in `output`; the tail adds the redacted command output
    // (no file contents) so operators can see why the command misbehaved.
    const failureLogTail = buildFailureLogOutput(`${mutationOutput}\n${runResult.output}`);
    return {
      ok: false,
      output: `${mutationOutput} ${CONFIGURED_TEST_OUTPUT_OMITTED_REASON}`,
      command: [configuredCommand.command],
      exitCode: runResult.exitCode,
      skipped: false,
      reason: `${configuredCommand.reason} The command changed tracked files while running.`,
      ...(failureLogTail ? { failureLogTail } : {}),
    };
  }

  const passed = runResult.exitCode === 0;
  const failureLogTail = passed ? undefined : buildFailureLogOutput(runResult.output);
  return {
    ok: passed,
    output: passed ? "Configured pre-publish test passed." : configuredTestFailureOutput(runResult.exitCode),
    command: [configuredCommand.command],
    exitCode: runResult.exitCode,
    skipped: false,
    reason: configuredCommand.reason,
    ...(failureLogTail ? { failureLogTail } : {}),
  };
}

function configuredTestFailureOutput(exitCode: number): string {
  return `Configured pre-publish test failed with exit code ${exitCode}. ${CONFIGURED_TEST_OUTPUT_OMITTED_REASON}`;
}

function configuredTestExecutionErrorOutput(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === "string" ? ` (${(error as { code: string }).code})` : "";
  return `Configured pre-publish test could not run${code}. ${CONFIGURED_TEST_OUTPUT_OMITTED_REASON}`;
}

export async function trackedMutationSnapshot(cwd: string): Promise<Map<string, string>> {
  try {
    const { output } = await runCommand(["git", "status", "--porcelain", "--untracked-files=no"], cwd, 10_000);
    const snapshot = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      // For pure renames git emits `R  old -> new`; key by the destination
      // (on-disk) path so downstream diff/checkout restoration targets a real
      // pathspec instead of the literal "old -> new" string (ARC-1546).
      const file = porcelainDestinationPath(line.slice(3).trim());
      if (!file) continue;
      snapshot.set(file, line.slice(0, 2));
    }
    return snapshot;
  } catch {
    return new Map();
  }
}

export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, status] of before) {
    if (after.get(file) !== status) changed.add(file);
  }
  for (const [file, status] of after) {
    if (before.get(file) !== status) changed.add(file);
  }
  return Array.from(changed).sort();
}

export function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandRunResult> {
  return runCommand(["/bin/bash", "-lc", command], cwd, timeoutMs);
}

export function runCommand(command: string[], cwd: string, timeoutMs: number): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command;
    const child = execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: EXEC_MAX_BUFFER_BYTES,
        // Repo-controlled command (test scripts steered by repo content): strip
        // platform/bridge secrets from its env.
        env: buildRepoCommandEnv(),
      },
      (err, stdout, stderr) => {
        const stdoutText = typeof stdout === "string" ? stdout : "";
        const stderrText = typeof stderr === "string" ? stderr : "";
        const output = [stdoutText, stderrText].filter(Boolean).join(stdoutText && stderrText ? "\n" : "");
        const errCode = (err as { code?: unknown } | null)?.code;
        if (err && !output && typeof errCode !== "number") {
          reject(err);
          return;
        }
        const exitCode = !err ? 0 : typeof errCode === "number" ? errCode : 1;
        resolve({ exitCode, output: output || (err ? stringifyError(err) : "") });
      },
    );
    child.on("error", reject);
  });
}

function skippedUnconfigured(skipReason: string): PrePublishTestPlan {
  return { configured: false, ok: true, skipped: true, skipReason, commands: [], timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS };
}

function skippedConfigured(skipReason: string): PrePublishTestPlan {
  return { configured: true, ok: true, skipped: true, skipReason, commands: [], timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS };
}

function failedSkip(skipReason: string, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS): PrePublishTestPlan {
  return { configured: true, ok: false, skipped: true, skipReason, commands: [], timeoutMs };
}
