import { isAbsolute, relative, sep } from "path";

import type { BridgeLogger } from "../../logger.js";
import { splitDelimitedPathList } from "../../utils/path-list.js";
import { isProtectedPath } from "../../utils/protection.js";
import { execRepoGitSync } from "./exec.js";

const GIT_ADD_BATCH_SIZE = 500;

export type StagingResult = {
  status: string;
  hasStagedFiles: boolean;
  stagedFiles: string[];
  diffStat?: string;
};

type StageChangedFilesOptions = {
  cwd: string;
  getModifiedFiles: () => Iterable<string>;
  promptLog: BridgeLogger;
};

export function stageChangedFiles({
  cwd,
  getModifiedFiles,
  promptLog,
}: StageChangedFilesOptions): StagingResult | undefined {
  let rawStatus: string;
  let status: string;
  try {
    rawStatus = execRepoGitSync(["status", "--porcelain"], { cwd });
    status = rawStatus.trim();
  } catch {
    promptLog.warn({}, "Git not available, skipping staging");
    return undefined;
  }

  let hasStagedFiles = false;
  let stagedFiles: string[] = [];
  let diffStat: string | undefined;

  if (status) {
    try {
      const repoRoot = execRepoGitSync(["rev-parse", "--show-toplevel"], {
        cwd,
      }).trim();
      const { modifiedStageablePaths, trackedStageablePaths, protectedPaths } = collectStagingPathSets(
        repoRoot,
        rawStatus,
        getModifiedFiles(),
      );

      if (modifiedStageablePaths.length > 0) {
        runGitForPathBatches(repoRoot, ["add", "--"], modifiedStageablePaths);
        promptLog.info({ fileCount: modifiedStageablePaths.length }, "Staged tracked modified files");
      }

      if (trackedStageablePaths.length > 0) {
        runGitForPathBatches(repoRoot, ["add", "-u", "--"], trackedStageablePaths);
      }

      if (protectedPaths.length > 0) {
        promptLog.warn(
          { fileCount: protectedPaths.length, files: protectedPaths },
          "Skipped protected paths during staging",
        );
      }

      stagedFiles = listStagedFiles(cwd);
      const protectedStagedFiles = stagedFiles.filter((filePath) => isProtectedPath(filePath));
      if (protectedStagedFiles.length > 0) {
        execRepoGitSync(["reset", "--", ...protectedStagedFiles], { cwd: repoRoot });
        promptLog.warn(
          { fileCount: protectedStagedFiles.length, files: protectedStagedFiles },
          "Unstaged protected paths before commit",
        );
        stagedFiles = listStagedFiles(cwd);
      }

      if (stagedFiles.length === 0) {
        promptLog.warn({}, "No files staged after reconciliation, skipping commit");
      } else {
        hasStagedFiles = true;
        // Wide stat width keeps git from abbreviating long pathnames with a leading "...".
        diffStat =
          execRepoGitSync(["diff", "--cached", "--stat=9999,9999"], {
            cwd,
          }).trim() || undefined;
      }
    } catch (err) {
      promptLog.info({ error: String(err) }, "Failed to stage changes");
    }
  }

  return { status, hasStagedFiles, stagedFiles, diffStat };
}

function collectStagingPathSets(
  repoRoot: string,
  status: string,
  modifiedFiles: Iterable<string>,
): { modifiedStageablePaths: string[]; trackedStageablePaths: string[]; protectedPaths: string[] } {
  const protectedPaths = new Set<string>();
  const modifiedPaths = new Set<string>();
  const trackedPaths = new Set<string>();

  const addPath = (paths: Set<string>, filePath: string | null): void => {
    if (!filePath) return;
    if (isProtectedPath(filePath)) {
      protectedPaths.add(filePath);
      return;
    }
    paths.add(filePath);
  };

  for (const filePath of expandModifiedPaths(modifiedFiles)) {
    addPath(modifiedPaths, toRepoRelativePath(repoRoot, filePath));
  }

  for (const filePath of parseTrackedStatusPaths(status)) {
    addPath(trackedPaths, filePath);
  }

  return {
    modifiedStageablePaths: Array.from(modifiedPaths),
    trackedStageablePaths: Array.from(trackedPaths).filter((filePath) => !modifiedPaths.has(filePath)),
    protectedPaths: Array.from(protectedPaths),
  };
}

function* expandModifiedPaths(filePaths: Iterable<string>): Iterable<string> {
  for (const filePath of filePaths) {
    yield* splitDelimitedPathList(filePath);
  }
}

function toRepoRelativePath(repoRoot: string, filePath: string): string | null {
  const repoRelativePath = relative(repoRoot, filePath);
  if (
    !repoRelativePath ||
    repoRelativePath === ".." ||
    repoRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(repoRelativePath)
  ) {
    return null;
  }
  return repoRelativePath;
}

function listStagedFiles(cwd: string): string[] {
  const staged = execRepoGitSync(["diff", "--cached", "--name-only"], {
    cwd,
  }).trim();
  return staged
    .split("\n")
    .map((filePath) => filePath.trim())
    .filter((filePath) => filePath.length > 0);
}

function parseTrackedStatusPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    if (code === "??") continue;

    const rawPath = line.slice(line[2] === " " ? 3 : 2).trim();
    if (!rawPath) continue;
    const destinationPath = porcelainDestinationPath(rawPath);
    if (destinationPath) paths.push(destinationPath);
  }
  return paths;
}

/**
 * Resolve the on-disk (destination) path from the path portion of a
 * `git status --porcelain` entry. For rename/copy entries (`old -> new`)
 * this returns the decoded destination; otherwise it decodes the single
 * porcelain path. Callers must pass the path portion only (status code
 * already stripped).
 */
export function porcelainDestinationPath(rawPath: string): string {
  if (rawPath.includes(" -> ")) {
    const renameParts = splitRenameStatusPath(rawPath);
    return renameParts[renameParts.length - 1] ?? "";
  }
  return decodePorcelainPath(rawPath);
}

function runGitForPathBatches(cwd: string, argsPrefix: string[], filePaths: string[]): void {
  for (let index = 0; index < filePaths.length; index += GIT_ADD_BATCH_SIZE) {
    const batch = filePaths.slice(index, index + GIT_ADD_BATCH_SIZE);
    execRepoGitSync([...argsPrefix, ...batch], { cwd });
  }
}

function splitRenameStatusPath(rawPath: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;

  for (let index = 0; index < rawPath.length; index++) {
    const char = rawPath[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inQuotes) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && rawPath.startsWith(" -> ", index)) {
      parts.push(decodePorcelainPath(rawPath.slice(start, index).trim()));
      start = index + 4;
      index += 3;
    }
  }

  parts.push(decodePorcelainPath(rawPath.slice(start).trim()));
  return parts.filter(Boolean);
}

export function decodePorcelainPath(rawPath: string): string {
  if (!rawPath.startsWith('"') || !rawPath.endsWith('"')) return rawPath;

  const bytes: number[] = [];
  const appendString = (value: string): void => {
    bytes.push(...new TextEncoder().encode(value));
  };

  for (let index = 1; index < rawPath.length - 1; index++) {
    const char = rawPath[index];
    if (char !== "\\") {
      appendString(char);
      continue;
    }

    const next = rawPath[index + 1];
    if (!next) break;
    if (/[0-7]/.test(next)) {
      let octal = next;
      let offset = 2;
      while (offset <= 3 && /[0-7]/.test(rawPath[index + offset] ?? "")) {
        octal += rawPath[index + offset];
        offset++;
      }
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    const escapeMap: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    appendString(escapeMap[next] ?? next);
    index++;
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
}
