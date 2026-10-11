import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

import { redact } from "../../../../shared/observability/redact.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { splitGitDiffByFile } from "./git-diff.js";
import {
  allChangedFilesMatchSkipPaths,
  DEFAULT_VERIFY_TIMEOUT_MS,
  normalizeChangedFiles,
  normalizeVerifyConfig,
  readVerifyConfig,
  resolveConfiguredCommands,
  type VerifyCommand,
} from "./pre-publish-config.js";
import { diffSnapshots, runCommand, runShellCommand, trackedMutationSnapshot } from "./pre-publish-tests.js";

const CONFIGURED_FIX_OUTPUT_OMITTED_REASON =
  "Raw stdout/stderr omitted because configured pre-publish fix output can contain sensitive data.";

export type ConfiguredFixCommand = VerifyCommand;

export type PrePublishFixPlan =
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
      commands: ConfiguredFixCommand[];
      timeoutMs: number;
    };

export type PrePublishFixResult = {
  ok: boolean;
  command: string;
  reason: string;
  exitCode: number | null;
  mutatedFiles: string[];
  output: string;
  failureLogTail?: string;
};

type TrackedFixBaseline = {
  snapshot: Map<string, string>;
  stagedPatches: Map<string, string>;
  unstagedPatches: Map<string, string>;
};

export function resolvePrePublishFixPlan(cwd: string, changedFiles?: Iterable<string>): PrePublishFixPlan {
  const changed = normalizeChangedFiles(cwd, changedFiles);
  const rawConfig = readVerifyConfig(cwd, "fix");
  if (!rawConfig.ok) return failedSkip(rawConfig.reason);
  if (!rawConfig.configured) {
    return skippedUnconfigured("No .cycloid.json verify.fix configuration found; skipping pre-publish fix.");
  }
  if (rawConfig.value === false) {
    return skippedConfigured("verify.fix is disabled; skipping pre-publish fix.");
  }
  if (changed.length === 0) {
    return skippedConfigured("No changed files; skipping configured pre-publish fix.");
  }

  const normalizedConfig = normalizeVerifyConfig(rawConfig.value, "verify.fix");
  if (!normalizedConfig.ok) return failedSkip(normalizedConfig.reason);
  const { config: fixConfig, timeoutMs } = normalizedConfig;
  if (fixConfig.required === false) {
    return skippedConfigured("verify.fix.required is false; skipping pre-publish fix.");
  }
  if (allChangedFilesMatchSkipPaths(changed, fixConfig.skipPaths)) {
    return skippedConfigured("Changed files match verify.fix.skipPaths; skipping pre-publish fix.");
  }

  const commands = resolveConfiguredCommands(fixConfig, changed, "verify.fix");
  if (!commands.ok) return failedSkip(commands.reason, timeoutMs);
  if (commands.commands.length === 0) {
    return skippedConfigured("No verify.fix command matched the changed files.");
  }

  return {
    configured: true,
    ok: true,
    skipped: false,
    commands: commands.commands,
    timeoutMs,
  };
}

export async function runConfiguredPrePublishFixCommand(
  cwd: string,
  configuredCommand: ConfiguredFixCommand,
  timeoutMs: number,
): Promise<PrePublishFixResult> {
  const beforeMutationBaseline = await trackedFixBaseline(cwd);
  let exitCode: number | null = null;
  let output = "";
  let executionError: unknown;

  try {
    const runResult = await runShellCommand(configuredCommand.command, cwd, timeoutMs);
    exitCode = runResult.exitCode;
    output = runResult.output;
  } catch (error) {
    executionError = error;
    output = error instanceof Error ? (error.stack ?? error.message) : String(error);
  }

  const afterMutationSnapshot = await trackedFixSnapshot(cwd);
  const mutatedFiles = diffSnapshots(beforeMutationBaseline.snapshot, afterMutationSnapshot);
  const ok = executionError === undefined && exitCode === 0;
  if (!ok && mutatedFiles.length > 0) {
    await restoreTrackedFilesToBaseline(cwd, beforeMutationBaseline, mutatedFiles);
  }

  const failureLogTail = ok ? undefined : buildFailureLogOutput(output);
  return {
    ok,
    command: configuredCommand.command,
    reason: configuredCommand.reason,
    exitCode,
    mutatedFiles,
    output: ok
      ? `Configured pre-publish fix completed${mutatedFiles.length > 0 ? ` and mutated tracked files: ${mutatedFiles.join(", ")}` : " without tracked mutations"}.`
      : configuredFixFailureOutput(exitCode, executionError),
    ...(failureLogTail ? { failureLogTail } : {}),
  };
}

function configuredFixFailureOutput(exitCode: number | null, error: unknown): string {
  if (exitCode !== null) {
    return `Configured pre-publish fix failed with exit code ${exitCode}. ${CONFIGURED_FIX_OUTPUT_OMITTED_REASON}`;
  }
  const code = typeof (error as { code?: unknown })?.code === "string" ? ` (${(error as { code: string }).code})` : "";
  return `Configured pre-publish fix could not run${code}. ${CONFIGURED_FIX_OUTPUT_OMITTED_REASON}`;
}

function buildFailureLogOutput(rawOutput: string): string | undefined {
  const trimmed = rawOutput.trim();
  if (!trimmed) return undefined;
  return redact(trimmed);
}

async function trackedFixBaseline(cwd: string): Promise<TrackedFixBaseline> {
  return trackedFixPatchSnapshot(cwd);
}

async function trackedFixSnapshot(cwd: string): Promise<Map<string, string>> {
  return (await trackedFixPatchSnapshot(cwd)).snapshot;
}

async function trackedFixPatchSnapshot(cwd: string): Promise<TrackedFixBaseline> {
  const statusSnapshot = await trackedMutationSnapshot(cwd);
  const snapshot = new Map<string, string>();
  const stagedFiles = filesWithStagedChanges(statusSnapshot);
  const unstagedFiles = filesWithUnstagedChanges(statusSnapshot);
  const stagedPatches = await gitDiffByFile(cwd, stagedFiles, ["--cached", "--binary"]);
  const unstagedPatches = await gitDiffByFile(cwd, unstagedFiles, ["--binary"]);

  for (const [file, status] of statusSnapshot) {
    const stagedPatch = stagedPatches.get(file) ?? "";
    const unstagedPatch = unstagedPatches.get(file) ?? "";
    snapshot.set(file, `${status}\n${stagedPatch}\n${unstagedPatch}`);
  }

  return { snapshot, stagedPatches, unstagedPatches };
}

function filesWithStagedChanges(statusSnapshot: Map<string, string>): string[] {
  return [...statusSnapshot.entries()]
    .filter(([, status]) => status[0] !== " " && status[0] !== "?")
    .map(([file]) => file);
}

function filesWithUnstagedChanges(statusSnapshot: Map<string, string>): string[] {
  return [...statusSnapshot.entries()]
    .filter(([, status]) => status[1] !== " " && status[1] !== "?")
    .map(([file]) => file);
}

async function gitDiffByFile(cwd: string, files: string[], args: string[]): Promise<Map<string, string>> {
  const patches = new Map<string, string>();
  if (files.length === 0) return patches;

  const combinedPatch = await gitDiff(cwd, args);
  const splitPatches = splitGitDiffByFile(combinedPatch, files);
  for (const file of files) {
    const splitPatch = splitPatches.get(file);
    patches.set(file, splitPatch ?? (await gitDiff(cwd, [...args, "--", file])));
  }
  return patches;
}

async function gitDiff(cwd: string, args: string[]): Promise<string> {
  try {
    const { output } = await runCommand(["git", "diff", ...args], cwd, 10_000);
    return output;
  } catch {
    return "";
  }
}

async function restoreTrackedFilesToBaseline(
  cwd: string,
  baseline: TrackedFixBaseline,
  _files: string[],
): Promise<void> {
  try {
    await runCommand(["git", "reset", "--hard", "HEAD"], cwd, 10_000);
    for (const file of baseline.snapshot.keys()) {
      const stagedPatch = baseline.stagedPatches.get(file) ?? "";
      await applyPatch(cwd, stagedPatch, true);
      if (stagedPatch.trim()) {
        await runCommand(["git", "checkout", "--", file], cwd, 10_000);
      }
      await applyPatch(cwd, baseline.unstagedPatches.get(file) ?? "", false);
    }
  } catch (error) {
    throw new Error(
      `Failed to restore tracked files after configured pre-publish fix failure: ${stringifyError(error)}`,
    );
  }
}

async function applyPatch(cwd: string, patch: string, cached: boolean): Promise<void> {
  if (!patch.trim()) return;
  const tmpDir = await mkdtemp(path.join(tmpdir(), "cycloid-fix-patch-"));
  const patchPath = path.join(tmpDir, "patch.diff");
  try {
    await writeFile(patchPath, patch);
    await runCommand(["git", "apply", ...(cached ? ["--cached"] : []), "--binary", patchPath], cwd, 10_000);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function skippedUnconfigured(skipReason: string): PrePublishFixPlan {
  return { configured: false, ok: true, skipped: true, skipReason, commands: [], timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS };
}

function skippedConfigured(skipReason: string): PrePublishFixPlan {
  return { configured: true, ok: true, skipped: true, skipReason, commands: [], timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS };
}

function failedSkip(skipReason: string, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS): PrePublishFixPlan {
  return { configured: true, ok: false, skipped: true, skipReason, commands: [], timeoutMs };
}
