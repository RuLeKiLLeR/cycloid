import { buildTruncatedDiffExcerpt } from "../../../../../shared/post-execution.js";
import type { BridgeLogger } from "../../logger.js";
import { execRepoGitSync } from "./exec.js";
import type { GitDiffPreparation } from "./types.js";

type ComputeDiffPreparationOptions = {
  cwd: string;
  baseBranch?: string;
  /**
   * The currently checked-out branch. Its remote tracking ref
   * (origin/<publishBranch>) is the authoritative per-prompt diff baseline:
   * it is the tip the previous prompt pushed, so a diff against it captures
   * exactly this prompt's work (committed or not) and an empty diff means
   * "no new work" — unlike the base refs, whose diff is the cumulative PR
   * delta.
   */
  publishBranch?: string;
  maxFullDiffBytes: number;
  truncatedFullDiffBytes: number;
  status: string;
  hasStagedFiles: boolean;
  stagedFiles: string[];
  diffStat?: string;
  promptLog: BridgeLogger;
};

type DiffRefResult = {
  ref: string;
  publishFiles: string[];
  diffSummary?: string;
};

type DiffBaseline = "publish_branch" | "base_walk" | "working_tree_fallback" | "staged_only";

const DIFF_METADATA_MAX_BUFFER = 10 * 1024 * 1024;

/** Diff the working tree against one ref; throws when the ref is unresolvable. */
function diffAgainstRef(cwd: string, ref: string, timeout?: number): DiffRefResult {
  const changedFiles = execRepoGitSync(["diff", "--name-only", ref], {
    cwd,
    timeout,
    maxBuffer: DIFF_METADATA_MAX_BUFFER,
  }).trim();
  const publishFiles = changedFiles
    .split("\n")
    .map((filePath) => filePath.trim())
    .filter((filePath) => filePath.length > 0);
  let diffSummary: string | undefined;
  try {
    const stat = execRepoGitSync(["diff", "--stat=9999,9999", ref], {
      cwd,
      timeout,
      maxBuffer: DIFF_METADATA_MAX_BUFFER,
    }).trim();
    diffSummary = stat.length > 0 ? stat : undefined;
  } catch {
    // A summary is optional. Keep a usable name-only diff when a large stat
    // output exhausts the process buffer or another summary-only failure occurs.
  }
  return { ref, publishFiles, diffSummary };
}

/**
 * Walk a prioritized list of base refs (origin/<base>, <base>, merge-base of
 * each) and return the first one that produces a non-empty diff against the
 * working tree. This catches both uncommitted edits AND agent-created commits
 * that are ahead of the publish base — without those, sessions where the agent
 * commits during the prompt silently skipped the push (ARC-1192).
 */
function diffAgainstFirstReachableBase(
  cwd: string,
  baseBranch: string,
  promptLog: BridgeLogger,
  timeout?: number,
): DiffRefResult | undefined {
  const candidateRefs = [`origin/${baseBranch}`, baseBranch];
  const refsToTry: string[] = [];
  for (const ref of candidateRefs) {
    refsToTry.push(ref);
    try {
      const mergeBase = execRepoGitSync(["merge-base", "HEAD", ref], { cwd, timeout }).trim();
      if (mergeBase && !refsToTry.includes(mergeBase)) refsToTry.push(mergeBase);
    } catch {
      // ref not resolvable yet; recorded as a probe failure below.
    }
  }

  const failures: { ref: string; error: string }[] = [];
  let lastEmpty: DiffRefResult | undefined;
  for (const ref of refsToTry) {
    try {
      const result = diffAgainstRef(cwd, ref, timeout);
      if (result.publishFiles.length > 0) {
        return result;
      }
      // Empty diff against this ref. Keep walking — a later candidate may be
      // less stale (e.g. origin/<base> tracking a fetch from before HEAD
      // diverged) and produce a non-empty result.
      lastEmpty = { ref, publishFiles: result.publishFiles, diffSummary: undefined };
    } catch (err) {
      failures.push({ ref, error: String(err) });
    }
  }

  // No ref produced a non-empty diff. Prefer the last empty result (a real
  // "no changes vs that base") over the all-refs-errored case so the caller
  // gets a stable diffRef for the no-op path.
  if (lastEmpty) return lastEmpty;

  // Every candidate ref errored. Fail loud so the symptom isn't hidden as it
  // was in ARC-1192, where this fall-through silently meant "no changes".
  promptLog.warn(
    { baseBranch, failures },
    "Failed to diff against any candidate base ref; falling back to working-tree status",
  );
  return undefined;
}

/** Resolve changed files against the first reachable base ref without mutating the checkout. */
export function resolveChangedFilesAgainstBase(
  cwd: string,
  baseBranch: string | undefined,
  promptLog: BridgeLogger,
  timeoutMs: number,
): { files: string[]; resolved: boolean } {
  if (!baseBranch) return { files: [], resolved: false };

  const result = diffAgainstFirstReachableBase(cwd, baseBranch, promptLog, timeoutMs);
  return result ? { files: result.publishFiles, resolved: true } : { files: [], resolved: false };
}

export function computeDiffPreparation({
  cwd,
  baseBranch,
  publishBranch,
  maxFullDiffBytes,
  truncatedFullDiffBytes,
  status,
  hasStagedFiles,
  stagedFiles,
  diffStat,
  promptLog,
}: ComputeDiffPreparationOptions): GitDiffPreparation {
  let publishFiles = stagedFiles.slice();
  let diffSummary: string | undefined;
  let fullDiff: string | undefined;
  let diffRef: string | undefined;
  let baseline: DiffBaseline = "staged_only";
  const hasChanges = (() => {
    // When origin/<publishBranch> resolves, its result is TERMINAL: an empty
    // diff means no new work this prompt. Falling through to the base refs on
    // an empty result would surface the cumulative PR diff and re-publish
    // prior prompts' work on every no-op follow-up. Skipped when the checkout
    // is still the base branch (initial prompt: the refs are the same walk).
    if (publishBranch && publishBranch !== baseBranch) {
      try {
        const result = diffAgainstRef(cwd, `origin/${publishBranch}`);
        baseline = "publish_branch";
        publishFiles = result.publishFiles;
        diffSummary = result.diffSummary;
        diffRef = result.ref;
        return publishFiles.length > 0;
      } catch {
        // origin/<publishBranch> not resolvable (first-ever publish, or the
        // tracking ref was never created): fall through to the base-ref walk.
      }
    }
    if (!baseBranch) return hasStagedFiles;
    const result = diffAgainstFirstReachableBase(cwd, baseBranch, promptLog);
    if (result) {
      baseline = "base_walk";
      publishFiles = result.publishFiles;
      diffSummary = result.diffSummary;
      diffRef = result.ref;
      return publishFiles.length > 0;
    }
    // No base ref was reachable: fall back to working-tree-only signal.
    baseline = "working_tree_fallback";
    return hasStagedFiles || status.length > 0;
  })();
  promptLog.info(
    { event: "diff_baseline.selected", baseline, ref: diffRef, hasChanges, publishFileCount: publishFiles.length },
    "Selected diff baseline for the publish decision",
  );

  if (!hasChanges) {
    promptLog.debug({}, "No file changes to push");
    return { hasStagedFiles, stagedFiles, publishFiles, diffStat, diffSummary, fullDiff, hasChanges: false };
  }

  if (diffRef) {
    try {
      const rawDiff = execRepoGitSync(["diff", diffRef], {
        cwd,
        maxBuffer: maxFullDiffBytes,
      });
      fullDiff = buildTruncatedDiffExcerpt(rawDiff, truncatedFullDiffBytes);
    } catch (err) {
      promptLog.warn(
        { error: String(err), ref: diffRef },
        "Failed to compute full diff for PR summary -- continuing without it",
      );
    }
  }

  return { hasStagedFiles, stagedFiles, publishFiles, diffStat, diffSummary, fullDiff, hasChanges: true };
}
