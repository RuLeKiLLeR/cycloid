import type { MemoryRef } from "../../../shared/events/bridge.js";
import type { BridgeLogger } from "./logger.js";
import { type Memory } from "./services/memory-ranking.js";
import { splitGitDiffByFile } from "./utils/git-diff.js";
import { memoryBlockReason, memoryForbiddenPatternMatches, memoryPathMatches } from "./utils/memory-enforcement.js";
import { buildSanitizedHookEnv } from "./utils/sanitized-env.js";

type MemoryManagerExecAsync = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

interface MemoryManagerDeps {
  getCwd: () => string;
  getBaseBranch: () => string | undefined;
  execAsync: MemoryManagerExecAsync;
  log: BridgeLogger;
}

export type MemoryBlockEnforcementResult =
  | {
      status: "handled";
      memoryId: string;
      reason: string;
      revertedFiles: string[];
    }
  | {
      status: "failed";
      memoryId: string;
      reason: string;
      file: string;
      detail: string;
    };

export class MemoryManager {
  orgMemories: Memory[] = [];
  memoryRefById: Map<string, MemoryRef> = new Map();
  allTouchedFiles = new Set<string>();

  private readonly deps: MemoryManagerDeps;

  constructor(deps: MemoryManagerDeps) {
    this.deps = deps;
  }

  async enforceBlockingMemoriesOnDiff(
    changedFiles: string[],
    promptLog: BridgeLogger,
    diffBaseRef?: string | null,
  ): Promise<MemoryBlockEnforcementResult | null> {
    if (changedFiles.length === 0) return null;
    const blockers = this.orgMemories.filter(
      (memory) =>
        memory.status === "active" &&
        memory.enforcement === "block" &&
        (memory.authority === "reviewed" || memory.authority === "source_of_truth") &&
        memory.confidence === "high",
    );
    if (blockers.length === 0) return null;

    const cwd = this.deps.getCwd();
    const baseBranch = this.deps.getBaseBranch();

    const baseRef = diffBaseRef || (baseBranch ? `origin/${baseBranch}` : null);
    // Accumulate handled results across ALL blocking memories. A single early
    // return here would leave later blockers' violations in the working tree,
    // where post-execution commits and pushes them (ARC-1542). The mid-loop
    // `status: "failed"` returns below stay hard fail-closed short-circuits:
    // if we cannot prove a forbidden hunk was removed, we abort immediately.
    const handled: Array<{ memoryId: string; reason: string; revertedFiles: string[] }> = [];
    for (const memory of blockers) {
      const matchingFiles = changedFiles.filter((file) => memoryPathMatches(memory, file));
      if (matchingFiles.length === 0) continue;
      // One diff spawn over all matching files; per-file chunks keep the
      // `git apply -R` reversal input identical to a single-file diff.
      const diffArgs = baseRef ? ["diff", baseRef, "--", ...matchingFiles] : ["diff", "--", ...matchingFiles];
      let chunksByFile: Map<string, string>;
      try {
        const combinedDiff = await this.deps.execAsync("git", diffArgs, { cwd, env: buildSanitizedHookEnv() });
        chunksByFile = splitGitDiffByFile(combinedDiff, matchingFiles);
      } catch (combinedError: unknown) {
        // A combined-diff failure must not bypass enforcement for every
        // file at once; fall back to per-file diffs so one bad path only
        // skips that file (the original pre-batching behavior).
        promptLog.warn(
          { memoryId: memory.id, files: matchingFiles, error: String(combinedError) },
          "Combined memory block diff failed; falling back to per-file diffs",
        );
        chunksByFile = new Map();
        for (const file of matchingFiles) {
          const fileArgs = baseRef ? ["diff", baseRef, "--", file] : ["diff", "--", file];
          const diffText = await this.deps
            .execAsync("git", fileArgs, { cwd, env: buildSanitizedHookEnv() })
            .catch((error: unknown) => {
              promptLog.warn(
                { memoryId: memory.id, file, error: String(error) },
                "Failed to inspect memory block diff",
              );
              return "";
            });
          if (diffText) chunksByFile.set(file, diffText);
        }
      }
      const violatingDiffs: Array<{ file: string; diffText: string }> = [];
      for (const file of matchingFiles) {
        const diffText = chunksByFile.get(file);
        if (diffText && memoryForbiddenPatternMatches(memory, diffText)) {
          violatingDiffs.push({ file, diffText });
        }
      }
      if (violatingDiffs.length === 0) continue;

      const revertedFiles: string[] = [];
      for (const violation of violatingDiffs) {
        const reversed = await this.reverseMemoryBlockedDiff(memory.id, violation, promptLog);
        if (!reversed) {
          const restored = await this.restoreMemoryBlockedFile(baseRef, memory.id, violation.file, promptLog);
          if (!restored) {
            return {
              status: "failed",
              memoryId: memory.id,
              reason: memoryBlockReason(memory),
              file: violation.file,
              detail: "Failed to reverse the violating hunk and failed to restore the file.",
            };
          }
          revertedFiles.push(violation.file);
        }
        const inspected = await this.inspectViolationAfterRestore(
          memory,
          violation.file,
          baseRef,
          promptLog,
          reversed ? "reversal" : "restore",
        );
        if (inspected.status === "failed") {
          return {
            status: "failed",
            memoryId: memory.id,
            reason: memoryBlockReason(memory),
            file: violation.file,
            detail: inspected.detail,
          };
        }
      }
      handled.push({ memoryId: memory.id, reason: memoryBlockReason(memory), revertedFiles });
    }

    if (handled.length > 0) {
      const first = handled[0]!;
      return {
        status: "handled",
        memoryId: first.memoryId,
        reason: first.reason,
        revertedFiles: handled.flatMap((entry) => entry.revertedFiles),
      };
    }

    return null;
  }

  private async reverseMemoryBlockedDiff(
    memoryId: string,
    violation: { file: string; diffText: string },
    promptLog: BridgeLogger,
  ): Promise<boolean> {
    const cwd = this.deps.getCwd();
    const applyAttempts = [
      ["apply", "-R", "--whitespace=nowarn"],
      ["apply", "-R", "--3way", "--whitespace=nowarn"],
    ];
    for (const args of applyAttempts) {
      const reversed = await this.deps
        .execAsync("git", args, {
          cwd,
          input: violation.diffText,
          env: buildSanitizedHookEnv(),
        })
        .then(() => true)
        .catch((error: unknown) => {
          promptLog.warn(
            { memoryId, file: violation.file, args, error: String(error) },
            "Failed to reverse memory-blocked diff",
          );
          return false;
        });
      if (reversed) return true;
    }
    return false;
  }

  private async restoreMemoryBlockedFile(
    baseRef: string | null,
    memoryId: string,
    file: string,
    promptLog: BridgeLogger,
  ): Promise<boolean> {
    const cwd = this.deps.getCwd();
    const restoreArgs = baseRef
      ? ["restore", "--source", baseRef, "--staged", "--worktree", "--", file]
      : ["restore", "--staged", "--worktree", "--", file];
    const restored = await this.deps
      .execAsync("git", restoreArgs, { cwd, env: buildSanitizedHookEnv() })
      .then(() => true)
      .catch((error: unknown) => {
        promptLog.warn({ memoryId, file, error: String(error) }, "Failed to restore memory-blocked file");
        return false;
      });
    if (restored) return true;

    const fetched = await this.fetchBaseRefForRestore(baseRef, promptLog, memoryId, file);
    if (!fetched) return false;
    return this.deps
      .execAsync("git", restoreArgs, { cwd, env: buildSanitizedHookEnv() })
      .then(() => true)
      .catch((error: unknown) => {
        promptLog.warn(
          { memoryId, file, error: String(error) },
          "Failed to restore memory-blocked file after fetching base ref",
        );
        return false;
      });
  }

  private async inspectViolationAfterRestore(
    memory: Memory,
    file: string,
    baseRef: string | null,
    promptLog: BridgeLogger,
    context: "reversal" | "restore",
  ): Promise<{ status: "clean" } | { status: "failed"; detail: string }> {
    const cwd = this.deps.getCwd();
    const diffArgGroups = [
      baseRef ? ["diff", baseRef, "--", file] : ["diff", "--", file],
      ["diff", "--cached", "--", file],
    ];
    for (const diffArgs of diffArgGroups) {
      const diffText = await this.deps
        .execAsync("git", diffArgs, { cwd, env: buildSanitizedHookEnv() })
        .catch((error: unknown) => {
          promptLog.warn(
            { memoryId: memory.id, file, args: diffArgs, error: String(error) },
            "Failed to re-inspect memory-blocked file",
          );
          return null;
        });
      if (diffText === null) return { status: "failed", detail: `Failed to re-inspect the file after ${context}.` };
      if (memoryForbiddenPatternMatches(memory, diffText)) {
        return { status: "failed", detail: `Forbidden pattern still appears in the file diff after ${context}.` };
      }
    }
    return { status: "clean" };
  }

  private async fetchBaseRefForRestore(
    baseRef: string | null,
    promptLog: BridgeLogger,
    memoryId: string,
    file: string,
  ): Promise<boolean> {
    const branch = baseRef?.startsWith("origin/") ? baseRef.slice("origin/".length) : null;
    if (!branch) return false;
    return this.deps
      .execAsync("git", ["fetch", "origin", branch], { cwd: this.deps.getCwd(), env: buildSanitizedHookEnv() })
      .then(() => true)
      .catch((error: unknown) => {
        promptLog.warn({ memoryId, file, baseRef, error: String(error) }, "Failed to fetch memory-block base ref");
        return false;
      });
  }
}
