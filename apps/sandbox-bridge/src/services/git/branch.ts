import {
  appendCollisionSuffix,
  buildCycloidBranchBaseNameFromSafeHint,
  buildCycloidBranchCollisionSuffix,
} from "../../../../../shared/utils/cycloid-branch-name.js";
import type { BridgeLogger } from "../../logger.js";
import { execRepoGitSync } from "./exec.js";

/** Timeout for a fast local git ref read (no network). */
const LOCAL_GIT_TIMEOUT_MS = 5_000;
/** Timeout for a remote branch/ref lookup (`ls-remote`, tracking-ref read). */
const REMOTE_GIT_LOOKUP_TIMEOUT_MS = 10_000;

type EnsureSessionBranchOptions = {
  cwd: string;
  sessionId: string;
  /** Pre-sanitized branch slug captured from the initial task text. */
  branchNameHint?: string;
  baseBranch?: string;
  currentBranch: string;
  promptLog: BridgeLogger;
};

export function readCurrentBranch(cwd: string): string | undefined {
  try {
    return execRepoGitSync(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
    }).trim();
  } catch {
    return undefined;
  }
}

export function ensureSessionBranch({
  cwd,
  sessionId,
  branchNameHint,
  baseBranch,
  currentBranch,
  promptLog,
}: EnsureSessionBranchOptions): string | undefined {
  const preferredBranch = buildCycloidBranchBaseNameFromSafeHint(branchNameHint);
  const disambiguatedBranch = appendCollisionSuffix(preferredBranch, buildCycloidBranchCollisionSuffix(sessionId));
  const effectiveBase = baseBranch || detectDefaultBranch(cwd);

  if (!effectiveBase) {
    return currentBranch;
  }

  if (currentBranch !== effectiveBase) {
    promptLog.warn(
      { currentBranch, effectiveBase },
      "Current branch differs from the expected base before session branch creation; keeping current branch",
    );
    return currentBranch;
  }

  const localBranchState = hasLocalBranch(cwd, preferredBranch);
  const shouldDisambiguate = preferredBranch === effectiveBase || localBranchState;
  const featureBranch = shouldDisambiguate ? disambiguatedBranch : preferredBranch;
  if (shouldDisambiguate) {
    promptLog.info(
      { branch: featureBranch, preferredBranch, baseBranch: effectiveBase, localBranchState },
      "Readable branch name could collide with an existing branch; using a disambiguated branch name",
    );
  }

  return createOrSwitchBranch(cwd, featureBranch, effectiveBase, promptLog);
}

function detectDefaultBranch(cwd: string): string | undefined {
  try {
    const ref = execRepoGitSync(["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd,
    }).trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function createOrSwitchBranch(
  cwd: string,
  branch: string,
  baseBranch: string,
  promptLog: BridgeLogger,
): string | undefined {
  try {
    execRepoGitSync(["checkout", "-b", branch], { cwd });
    promptLog.info({ branch, baseBranch }, "Created feature branch for session work");
    return branch;
  } catch {
    try {
      execRepoGitSync(["checkout", branch], { cwd });
      promptLog.info({ branch, baseBranch }, "Switched to existing feature branch for session work");
      return branch;
    } catch (err) {
      promptLog.error(
        { error: String(err), branch, baseBranch },
        "Failed to switch to feature branch for session work",
      );
      return undefined;
    }
  }
}

function hasLocalBranch(cwd: string, branch: string): boolean {
  try {
    execRepoGitSync(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      timeout: LOCAL_GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the commit SHA an already-pushed branch points to on the remote,
 * via `git ls-remote --heads origin <branch>`. This returns the SHA, used by
 * crash recovery to reconstruct a `post_execution` when the in-memory push
 * metadata was lost.
 * Returns `undefined` when the branch is missing or the remote cannot be reached
 * (auth/network); callers must treat that as "SHA unknown", not "branch absent".
 */
export function resolveRemoteBranchHead(
  cwd: string,
  branch: string,
): { branch: string; commitSha: string } | undefined {
  try {
    const output = execRepoGitSync(["ls-remote", "--heads", "origin", branch], {
      cwd,
      timeout: REMOTE_GIT_LOOKUP_TIMEOUT_MS,
    }).trim();
    if (!output) return undefined;
    // Format: "<sha>\trefs/heads/<branch>" (first line is the head we asked for).
    const sha = output.split("\n")[0]?.split(/\s+/)[0]?.trim();
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return undefined;
    return { branch, commitSha: sha };
  } catch {
    return undefined;
  }
}

/**
 * Read the LOCAL remote-tracking ref `refs/remotes/origin/<branch>` without any
 * network access. `git push` advances this ref only on a successful push, so a
 * tracking ref pointing at an expected SHA is durable on-disk proof that a push
 * of that SHA succeeded before a crash - usable by recovery when `ls-remote`
 * cannot reach the remote (the origin URL is scrubbed token-less after clone,
 * so private repos are unreachable outside the push window).
 */
export function readRemoteTrackingBranchHead(cwd: string, branch: string): string | undefined {
  try {
    const sha = execRepoGitSync(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
      cwd,
      timeout: REMOTE_GIT_LOOKUP_TIMEOUT_MS,
    }).trim();
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
