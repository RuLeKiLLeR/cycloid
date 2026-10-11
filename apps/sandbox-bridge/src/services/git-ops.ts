import type { AgentTimelineEntry } from "../../../../shared/types/agent-timeline.js";
import {
  appendCollisionSuffix,
  buildCycloidBranchCollisionSuffix,
} from "../../../../shared/utils/cycloid-branch-name.js";
import type { BridgeLogger } from "../logger.js";
import { ensureSessionBranch as ensureGitSessionBranch, readCurrentBranch } from "./git/branch.js";
import { createCommit } from "./git/commit.js";
import { computeDiffPreparation } from "./git/diff.js";
import { emitPushErrorEvent } from "./git/events.js";
import { execRepoGitSync } from "./git/exec.js";
import {
  captureRepoSnapshot,
  createTimelineRecorder,
  didRepoProgress,
  readCurrentGitState,
  readHeadSha,
} from "./git/progress.js";
import { type LeaseRefreshResult, pushSessionBranch } from "./git/push.js";
import { stageChangedFiles } from "./git/staging.js";
import type { GitDiffPreparation, GitOperationsConfig, RepoSnapshot } from "./git/types.js";

export type { GitDiffPreparation, GitOperationsConfig, RepoSnapshot };

/** Timeout for a network-bound `git fetch` against origin. */
const GIT_FETCH_TIMEOUT_MS = 60_000;
const BRANCH_COLLISION_RENAME_ATTEMPTS = 3;

export class GitOperations {
  private config: GitOperationsConfig;

  constructor(config: GitOperationsConfig) {
    this.config = config;
  }

  /**
   * Commits on HEAD that are not on the publish base — i.e. agent-authored work
   * that would be lost if the publish fails closed. 0 when the base cannot be
   * resolved (fail-closed callers keep their existing behavior).
   */
  private countCommitsAheadOfBase(promptLog: BridgeLogger): number {
    const base = this.config.baseBranch;
    if (!base) return 0;
    for (const ref of [`origin/${base}`, base]) {
      try {
        const count = execRepoGitSync(["rev-list", "--count", `${ref}..HEAD`], {
          cwd: this.config.cwd,
        }).trim();
        return Number.parseInt(count, 10) || 0;
      } catch {
        // ref not resolvable; try the next candidate.
      }
    }
    promptLog.warn({ baseBranch: base }, "Could not resolve any base ref to count commits ahead");
    return 0;
  }

  stageAndComputeDiffs(promptLog: BridgeLogger): GitDiffPreparation | undefined {
    const staged = stageChangedFiles({
      cwd: this.config.cwd,
      getModifiedFiles: this.config.getModifiedFiles,
      promptLog,
    });
    if (!staged) return undefined;

    return computeDiffPreparation({
      cwd: this.config.cwd,
      baseBranch: this.config.baseBranch,
      // HEAD's branch is the publish branch at diff time: commitAndPush only
      // derives (and may create) the session branch after diff prep, so the
      // current checkout is the only truthful source here.
      publishBranch: this.currentPublishBranch(),
      maxFullDiffBytes: this.config.maxFullDiffBytes,
      truncatedFullDiffBytes: this.config.truncatedFullDiffBytes,
      status: staged.status,
      hasStagedFiles: staged.hasStagedFiles,
      stagedFiles: staged.stagedFiles,
      diffStat: staged.diffStat,
      promptLog,
    });
  }

  async commitAndPush(
    promptLog: BridgeLogger,
    messageId: string,
    commitMessage?: string,
  ): Promise<{ branch: string; commitSha?: string; agentTimeline?: AgentTimelineEntry[] } | undefined> {
    const timeline = createTimelineRecorder(this.config, promptLog, messageId);
    let currentBranch = readCurrentBranch(this.config.cwd);
    if (!currentBranch) {
      promptLog.warn({}, "Failed to get current branch");
      return undefined;
    }

    const branchForPush = this.ensureSessionBranch(promptLog, currentBranch);
    if (!branchForPush) return undefined;
    currentBranch = branchForPush;
    let publishBranch = currentBranch;

    const commitResult = createCommit({
      cwd: this.config.cwd,
      currentBranch: publishBranch,
      commitMessage,
      promptLog,
      recordTimeline: timeline.record,
    });
    if (commitResult.status === "failed") {
      // The sweep commit (leftover uncommitted files) can be rejected by the
      // customer's own hooks — e.g. commitlint refusing the fallback message.
      // When the agent already authored commits on this branch, losing them by
      // failing the whole publish closed is strictly worse than publishing
      // without the sweep files: push what exists and record the rejection.
      const aheadOfBase = this.countCommitsAheadOfBase(promptLog);
      if (aheadOfBase > 0) {
        promptLog.warn(
          { error: commitResult.errorSummary, branch: publishBranch, aheadOfBase },
          "Sweep commit failed; pushing the session's existing commits without it",
        );
        timeline.record(
          "git.commit",
          "failed",
          "Sweep commit for leftover uncommitted files was rejected; pushing the session's existing commits without them.",
          { branch: currentBranch, error: commitResult.errorSummary, aheadOfBase },
        );
      } else {
        emitPushErrorEvent(this.config, {
          messageId,
          branchName: publishBranch,
          error: commitResult.errorSummary,
        });
        timeline.record("git.push", "skipped", "Skipped pushing because git commit failed.", {
          branch: publishBranch,
          commitError: commitResult.errorSummary,
        });
        return undefined;
      }
    }

    let commitShaForPushEvent: string | undefined =
      commitResult.status === "committed" ? commitResult.commitSha : undefined;
    if (!commitShaForPushEvent) {
      try {
        commitShaForPushEvent = readHeadSha(this.config.cwd);
      } catch (err) {
        promptLog.warn({ error: String(err), branch: publishBranch }, "Failed to read HEAD SHA before push");
      }
    }

    // Lease-protect the primary publish push. The session branch is
    // deterministic per session, so a disconnect re-run, a second reconnected
    // bridge, or a human/CI commit could have advanced the remote branch since
    // this sandbox last fetched. Resolve the remote-tracking head and hand it to
    // pushSessionBranch as a force-with-lease, mirroring the verifier path
    // (commitAndPushCurrentBranch): if the remote diverged the publish fails
    // closed (remote_branch_diverged) instead of clobbering it. When no tracking
    // ref resolves (first push of a session-created branch), pushSessionBranch
    // falls back to a non-forced create push that still refuses a divergent
    // pre-existing branch.
    const remoteBranchHeadSha = readRemoteBranchHead(this.config.cwd, publishBranch);
    // Ancestry gate before the first leased push. `--force-with-lease` only
    // guarantees the remote head has not moved since we read it; it does NOT
    // require our HEAD to descend from that head. So a session branch that was
    // reset/recreated from the base branch (its tracking ref still current)
    // would pass the lease and clobber the remote PR branch on the very first
    // push, never reaching the post-rejection `refreshLeaseSha` divergence
    // check. Mirror the verifier path (commitAndPushCurrentBranch) and fail
    // closed instead. Skipped when HEAD is unreadable (the lease + post-rejection
    // refresh remain as a second line of defense).
    if (remoteBranchHeadSha && commitShaForPushEvent) {
      const headMatchesRemote = commitShaForPushEvent === remoteBranchHeadSha;
      if (!headMatchesRemote && !isAncestorCommit(this.config.cwd, remoteBranchHeadSha, commitShaForPushEvent)) {
        promptLog.error(
          { remoteBranchHeadSha, headSha: commitShaForPushEvent, branch: publishBranch },
          "Local HEAD is not based on the remote branch head; refusing to force over it",
        );
        emitPushErrorEvent(this.config, {
          messageId,
          branchName: publishBranch,
          error: "remote_branch_diverged",
        });
        timeline.record(
          "git.push",
          "failed",
          "Push aborted: the local HEAD is not based on the remote branch head, so a force-with-lease would replace unrelated history.",
          { branch: publishBranch, reason: "remote_branch_diverged" },
        );
        this.config.recordPushAttemptResolved?.({ messageId, reason: "remote_branch_diverged" });
        return undefined;
      }
    }
    const refreshLeaseSha = (): LeaseRefreshResult => {
      try {
        // Explicit refspec: a single-branch clone's default refspec would leave
        // the tracking ref stale, so fetch the branch head directly.
        execRepoGitSync(["fetch", "origin", `+refs/heads/${publishBranch}:refs/remotes/origin/${publishBranch}`], {
          cwd: this.config.cwd,
          timeout: GIT_FETCH_TIMEOUT_MS,
        });
      } catch (err) {
        promptLog.warn(
          { error: String(err), branch: publishBranch },
          "Fetch failed while refreshing the force-with-lease sha",
        );
        return { ok: false, reason: "fetch_failed" };
      }
      const refreshedRemoteHead = readRemoteBranchHead(this.config.cwd, publishBranch);
      if (!refreshedRemoteHead) return { ok: false, reason: "fetch_failed" };
      let headSha: string;
      try {
        headSha = readHeadSha(this.config.cwd);
      } catch {
        return { ok: false, reason: "fetch_failed" };
      }
      if (headSha !== refreshedRemoteHead && !isAncestorCommit(this.config.cwd, refreshedRemoteHead, headSha)) {
        return { ok: false, reason: "diverged" };
      }
      return { ok: true, sha: refreshedRemoteHead };
    };

    let pushResult = await pushSessionBranch({
      config: this.config,
      currentBranch: publishBranch,
      messageId,
      promptLog,
      recordTimeline: timeline.record,
      commitCompletedAtMs: commitResult.status === "committed" ? commitResult.committedAtMs : undefined,
      commitSha: commitShaForPushEvent,
      forceWithLeaseSha: remoteBranchHeadSha,
      refreshLeaseSha,
      delay: this.config.pushDelay,
    });
    if (!pushResult.ok && pushResult.reason === "branch_name_taken" && !remoteBranchHeadSha) {
      for (let salt = 0; salt < BRANCH_COLLISION_RENAME_ATTEMPTS; salt++) {
        const renamedBranch = appendCollisionSuffix(
          branchForPush,
          buildCycloidBranchCollisionSuffix(this.config.sessionId, salt),
        );
        try {
          execRepoGitSync(["branch", "-m", publishBranch, renamedBranch], { cwd: this.config.cwd });
        } catch (err) {
          promptLog.error(
            { error: String(err), branch: publishBranch, renamedBranch },
            "Failed to rename session branch after branch-name collision",
          );
          emitPushErrorEvent(this.config, {
            messageId,
            branchName: publishBranch,
            error: String(err),
          });
          timeline.record("git.push", "failed", "Push aborted: failed to rename the colliding branch.", {
            branch: publishBranch,
            renamedBranch,
            reason: "branch_name_taken_rename_failed",
          });
          return undefined;
        }
        promptLog.info(
          { previousBranch: publishBranch, branch: renamedBranch, salt },
          "Renamed session branch after branch-name collision",
        );
        publishBranch = renamedBranch;
        pushResult = await pushSessionBranch({
          config: this.config,
          currentBranch: publishBranch,
          messageId,
          promptLog,
          recordTimeline: timeline.record,
          commitCompletedAtMs: commitResult.status === "committed" ? commitResult.committedAtMs : undefined,
          commitSha: commitShaForPushEvent,
          forceWithLeaseSha: undefined,
          delay: this.config.pushDelay,
        });
        if (pushResult.ok || pushResult.reason !== "branch_name_taken") break;
      }
      if (!pushResult.ok && pushResult.reason === "branch_name_taken") {
        promptLog.error(
          { branch: publishBranch, attempts: BRANCH_COLLISION_RENAME_ATTEMPTS },
          "Failed to find an available session branch name after branch-name collision retries",
        );
        emitPushErrorEvent(this.config, {
          messageId,
          branchName: publishBranch,
          error: "branch_name_taken",
        });
        timeline.record("git.push", "failed", "Push aborted: every branch name retry was already present on origin.", {
          branch: publishBranch,
          attempts: BRANCH_COLLISION_RENAME_ATTEMPTS,
          reason: "branch_name_taken",
        });
        return undefined;
      }
    }
    if (!pushResult.ok) return undefined;

    let commitSha: string | undefined;
    try {
      commitSha = readHeadSha(this.config.cwd);
    } catch (err) {
      promptLog.warn({ error: String(err), branch: publishBranch }, "Push succeeded but failed to read HEAD SHA");
    }

    return { branch: publishBranch, commitSha, agentTimeline: timeline.entries };
  }

  async commitAndPushCurrentBranch(
    promptLog: BridgeLogger,
    messageId: string,
    opts: { expectedBranch: string; commitMessage: string },
  ): Promise<
    | { ok: true; branch: string; commitSha?: string; agentTimeline?: AgentTimelineEntry[] }
    | {
        ok: false;
        branch?: string;
        commitSha?: string;
        reason:
          | "branch_unavailable"
          | "branch_mismatch"
          | "remote_head_unavailable"
          | "head_mismatch"
          | "commit_skipped"
          | "commit_failed"
          | "push_failed";
        error?: string;
        agentTimeline?: AgentTimelineEntry[];
      }
  > {
    const timeline = createTimelineRecorder(this.config, promptLog, messageId);
    const currentBranch = readCurrentBranch(this.config.cwd);
    if (!currentBranch) {
      promptLog.warn({}, "Failed to get current branch for same-branch verifier push");
      return { ok: false, reason: "branch_unavailable", agentTimeline: timeline.entries };
    }

    if (currentBranch !== opts.expectedBranch) {
      const error = `Verifier is on branch ${currentBranch}, expected PR branch ${opts.expectedBranch}`;
      promptLog.warn({ currentBranch, expectedBranch: opts.expectedBranch }, "Refusing verifier push to non-PR branch");
      timeline.record("git.push", "failed", "Verifier push blocked because the current branch is not the PR branch.", {
        currentBranch,
        expectedBranch: opts.expectedBranch,
      });
      emitPushErrorEvent(this.config, {
        messageId,
        branchName: currentBranch,
        error,
      });
      return { ok: false, branch: currentBranch, reason: "branch_mismatch", error, agentTimeline: timeline.entries };
    }

    let currentHeadSha: string | undefined;
    try {
      currentHeadSha = readHeadSha(this.config.cwd);
    } catch (err) {
      const error = `Failed to read current HEAD before verifier push: ${String(err)}`;
      promptLog.warn({ error, currentBranch }, "Refusing verifier push");
      timeline.record("git.push", "failed", "Verifier push blocked because the current HEAD could not be read.", {
        currentBranch,
      });
      emitPushErrorEvent(this.config, {
        messageId,
        branchName: currentBranch,
        error,
      });
      return { ok: false, branch: currentBranch, reason: "head_mismatch", error, agentTimeline: timeline.entries };
    }

    const remoteBranchHeadSha = readRemoteBranchHead(this.config.cwd, opts.expectedBranch);
    if (!remoteBranchHeadSha) {
      const error = `Could not resolve origin/${opts.expectedBranch} before verifier push`;
      promptLog.warn({ currentBranch, currentHeadSha, expectedBranch: opts.expectedBranch }, "Refusing verifier push");
      timeline.record(
        "git.push",
        "failed",
        "Verifier push blocked because the PR branch remote head could not be resolved.",
        {
          currentBranch,
          currentHeadSha,
          expectedBranch: opts.expectedBranch,
        },
      );
      emitPushErrorEvent(this.config, {
        messageId,
        branchName: currentBranch,
        error,
      });
      return {
        ok: false,
        branch: currentBranch,
        commitSha: currentHeadSha,
        reason: "remote_head_unavailable",
        error,
        agentTimeline: timeline.entries,
      };
    }

    const headMatchesRemote = currentHeadSha === remoteBranchHeadSha;
    const headDescendsFromRemote =
      !headMatchesRemote && isAncestorCommit(this.config.cwd, remoteBranchHeadSha, currentHeadSha);
    if (!headMatchesRemote && !headDescendsFromRemote) {
      const error = `Verifier HEAD is not based on origin/${opts.expectedBranch}`;
      promptLog.warn(
        { currentBranch, currentHeadSha, remoteBranchHeadSha, expectedBranch: opts.expectedBranch },
        "Refusing verifier push from stale or unrelated PR branch head",
      );
      timeline.record(
        "git.push",
        "failed",
        "Verifier push blocked because the current HEAD is not based on the PR branch remote head.",
        {
          currentBranch,
          currentHeadSha,
          remoteBranchHeadSha,
          expectedBranch: opts.expectedBranch,
        },
      );
      emitPushErrorEvent(this.config, {
        messageId,
        branchName: currentBranch,
        error,
      });
      return { ok: false, branch: currentBranch, reason: "head_mismatch", error, agentTimeline: timeline.entries };
    }

    const commitResult = createCommit({
      cwd: this.config.cwd,
      currentBranch,
      commitMessage: opts.commitMessage,
      promptLog,
      recordTimeline: timeline.record,
    });
    if (commitResult.status === "failed") {
      emitPushErrorEvent(this.config, {
        messageId,
        branchName: currentBranch,
        error: commitResult.errorSummary,
      });
      timeline.record("git.push", "skipped", "Skipped verifier push because git commit failed.", {
        branch: currentBranch,
        commitError: commitResult.errorSummary,
      });
      return {
        ok: false,
        branch: currentBranch,
        reason: "commit_failed",
        error: commitResult.errorSummary,
        agentTimeline: timeline.entries,
      };
    }
    if (commitResult.status === "skipped") {
      if (headDescendsFromRemote) {
        promptLog.info(
          {
            branch: currentBranch,
            reason: commitResult.reason,
            currentHeadSha,
            remoteBranchHeadSha,
          },
          "Pushing verifier-created local commit without creating another commit",
        );
      } else {
        const error = `Verifier commit skipped: ${commitResult.reason}`;
        promptLog.warn({ branch: currentBranch, reason: commitResult.reason }, "Verifier commit was skipped");
        timeline.record("git.push", "skipped", "Skipped verifier push because no verifier commit was created.", {
          branch: currentBranch,
          reason: commitResult.reason,
        });
        return {
          ok: false,
          branch: currentBranch,
          reason: "commit_skipped",
          error,
          agentTimeline: timeline.entries,
        };
      }
    }

    let commitShaForPushEvent: string | undefined =
      commitResult.status === "committed" ? commitResult.commitSha : undefined;
    if (!commitShaForPushEvent) {
      try {
        commitShaForPushEvent = readHeadSha(this.config.cwd);
      } catch (err) {
        promptLog.warn({ error: String(err), branch: currentBranch }, "Failed to read HEAD SHA before verifier push");
      }
    }

    // Re-resolves the lease sha after a stale-lease rejection: the lease above
    // was read from the local tracking ref without fetching, so a remote that
    // moved since the last fetch makes every retry with the same sha fail.
    // Re-runs the same HEAD-descends-from-remote safety check as the gate
    // above before handing back a sha to force over.
    const refreshLeaseSha = (): LeaseRefreshResult => {
      try {
        // Explicit refspec: in a single-branch clone the fetch refspec covers
        // only the cloned branch, so a plain `fetch origin <branch>` updates
        // only FETCH_HEAD and the tracking-ref read below would stay stale.
        execRepoGitSync(
          ["fetch", "origin", `+refs/heads/${opts.expectedBranch}:refs/remotes/origin/${opts.expectedBranch}`],
          {
            cwd: this.config.cwd,
            timeout: GIT_FETCH_TIMEOUT_MS,
          },
        );
      } catch (err) {
        promptLog.warn(
          { error: String(err), branch: currentBranch },
          "Fetch failed while refreshing the force-with-lease sha",
        );
        return { ok: false, reason: "fetch_failed" };
      }
      const refreshedRemoteHead = readRemoteBranchHead(this.config.cwd, opts.expectedBranch);
      if (!refreshedRemoteHead) return { ok: false, reason: "fetch_failed" };
      let headSha: string;
      try {
        headSha = readHeadSha(this.config.cwd);
      } catch {
        return { ok: false, reason: "fetch_failed" };
      }
      if (headSha !== refreshedRemoteHead && !isAncestorCommit(this.config.cwd, refreshedRemoteHead, headSha)) {
        return { ok: false, reason: "diverged" };
      }
      return { ok: true, sha: refreshedRemoteHead };
    };

    const pushed = await pushSessionBranch({
      config: this.config,
      currentBranch,
      messageId,
      promptLog,
      recordTimeline: timeline.record,
      commitCompletedAtMs: commitResult.status === "committed" ? commitResult.committedAtMs : undefined,
      commitSha: commitShaForPushEvent,
      forceWithLeaseSha: remoteBranchHeadSha,
      refreshLeaseSha,
      delay: this.config.pushDelay,
    });
    if (!pushed.ok) {
      return {
        ok: false,
        branch: currentBranch,
        commitSha: commitShaForPushEvent,
        reason: "push_failed",
        error: "Verifier commit could not be pushed to the PR branch.",
        agentTimeline: timeline.entries,
      };
    }

    let commitSha: string | undefined;
    try {
      commitSha = readHeadSha(this.config.cwd);
    } catch (err) {
      promptLog.warn({ error: String(err), branch: currentBranch }, "Verifier push succeeded but failed to read HEAD");
    }

    return {
      ok: true,
      branch: currentBranch,
      commitSha: commitSha ?? commitShaForPushEvent,
      agentTimeline: timeline.entries,
    };
  }

  ensureSessionBranch(promptLog: BridgeLogger, currentBranch: string): string | undefined {
    return ensureGitSessionBranch({
      cwd: this.config.cwd,
      sessionId: this.config.sessionId,
      branchNameHint: this.config.getBranchNameHint?.(),
      baseBranch: this.config.baseBranch,
      currentBranch,
      promptLog,
    });
  }

  readCurrentGitState(promptLog: BridgeLogger): { branch?: string; commitSha?: string } {
    return readCurrentGitState(this.config.cwd, promptLog);
  }

  /** The checked-out branch, or undefined when detached or unreadable. */
  private currentPublishBranch(): string | undefined {
    const branch = readCurrentBranch(this.config.cwd);
    return branch && branch !== "HEAD" ? branch : undefined;
  }

  currentChangedFiles(promptLog: BridgeLogger): string[] {
    const files = new Set<string>();
    const addFiles = (output: string): void => {
      for (const filePath of output.split("\n")) {
        const trimmed = filePath.trim();
        if (trimmed.length > 0) files.add(trimmed);
      }
    };

    // Same baseline preference as computeDiffPreparation: the publish branch's
    // remote tip yields the per-prompt delta; origin/<base> is the fallback.
    const publishBranch = this.currentPublishBranch();
    const baselineRefs: string[] = [];
    if (publishBranch && publishBranch !== this.config.baseBranch) {
      baselineRefs.push(`origin/${publishBranch}`);
    }
    if (this.config.baseBranch) baselineRefs.push(`origin/${this.config.baseBranch}`);

    let baselineDiffed = false;
    for (const ref of baselineRefs) {
      try {
        addFiles(execRepoGitSync(["diff", "--name-only", ref], { cwd: this.config.cwd }));
        baselineDiffed = true;
        break;
      } catch {
        // Ref unresolvable; try the next baseline.
      }
    }
    if (!baselineDiffed) {
      try {
        addFiles(execRepoGitSync(["diff", "--name-only"], { cwd: this.config.cwd }));
      } catch (err) {
        promptLog.warn({ error: String(err) }, "Failed to list changed files from git diff");
      }
    }

    try {
      addFiles(execRepoGitSync(["diff", "--cached", "--name-only"], { cwd: this.config.cwd }));
    } catch {
      // Best-effort only; unstaged branch diff still covers the normal path.
    }

    try {
      addFiles(
        execRepoGitSync(["ls-files", "--others", "--exclude-standard"], {
          cwd: this.config.cwd,
        }),
      );
    } catch {
      // Best-effort only; prompt-local files remain as a fallback in bridge.
    }

    return Array.from(files);
  }

  captureRepoSnapshot(promptLog: BridgeLogger): RepoSnapshot {
    return captureRepoSnapshot(this.config.cwd, promptLog);
  }

  didRepoProgress(startSnapshot: RepoSnapshot, endSnapshot: RepoSnapshot): boolean {
    return didRepoProgress(startSnapshot, endSnapshot);
  }

  resetWorktreeForPromptRetry(promptLog: BridgeLogger, errorCode: string): boolean {
    try {
      execRepoGitSync(["reset", "--hard", "HEAD"], { cwd: this.config.cwd });
      execRepoGitSync(["clean", "-fd"], { cwd: this.config.cwd });
      promptLog.info({ errorCode }, "Reset worktree before retrying prompt");
      return true;
    } catch (err) {
      promptLog.error({ error: String(err), errorCode }, "Failed to reset worktree before retrying prompt");
      return false;
    }
  }

  resetDirtyWorktreeAfterPlanMode(promptLog: BridgeLogger): { dirty: boolean; reset: boolean; error?: string } {
    const changedFiles = this.currentChangedFiles(promptLog);
    if (changedFiles.length === 0) return { dirty: false, reset: false };
    try {
      execRepoGitSync(["reset", "--hard", "HEAD"], { cwd: this.config.cwd });
      execRepoGitSync(["clean", "-fd"], { cwd: this.config.cwd });
      promptLog.warn(
        {
          event: "arcanist.plan_mode.worktree_hygiene_violation",
          changedFileCount: changedFiles.length,
          reset: true,
        },
        "Reset dirty worktree after plan mode before implementation prompt",
      );
      return { dirty: true, reset: true };
    } catch (err) {
      const error = String(err);
      promptLog.error(
        {
          event: "arcanist.plan_mode.worktree_hygiene_violation",
          changedFileCount: changedFiles.length,
          reset: false,
          error,
        },
        "Failed to reset dirty worktree after plan mode",
      );
      return { dirty: true, reset: false, error };
    }
  }
}

function isAncestorCommit(cwd: string, ancestorSha: string, descendantSha: string): boolean {
  try {
    execRepoGitSync(["merge-base", "--is-ancestor", ancestorSha, descendantSha], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function readRemoteBranchHead(cwd: string, branch: string): string | undefined {
  try {
    return execRepoGitSync(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
      cwd,
    }).trim();
  } catch {
    return undefined;
  }
}
