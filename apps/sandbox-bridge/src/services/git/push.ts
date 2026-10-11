import { SANDBOX_NOT_ACTIVE_ERROR_CODE } from "../../../../../shared/constants/session.js";
import type { AgentTimelineStatus } from "../../../../../shared/types/agent-timeline.js";
import { sleep } from "../../../../../shared/utils/timing.js";
import { CLONE_TOKEN_REFRESH_TIMEOUT_MS } from "../../constants/bridge.js";
import type { BridgeLogger } from "../../logger.js";
import { emitPushErrorEvent } from "./events.js";
import { execRepoGitSync } from "./exec.js";
import type { GitOperationsConfig, TimelineRecord } from "./types.js";

const TIMELINE_STARTED = "started" satisfies AgentTimelineStatus;
const TIMELINE_COMPLETED = "completed" satisfies AgentTimelineStatus;
const TIMELINE_FAILED = "failed" satisfies AgentTimelineStatus;

/** Hard timeout for a single `git push` invocation. */
const GIT_PUSH_TIMEOUT_MS = 60_000;
/** Base delay for exponential backoff between clone-token refresh retries. */
const CLONE_TOKEN_RETRY_BASE_BACKOFF_MS = 1_000;
/** Base delay for exponential backoff between push retries. */
const PUSH_RETRY_BASE_BACKOFF_MS = 2_000;

/**
 * Result of re-resolving the force-with-lease sha after a stale-lease
 * rejection. `fetch_failed` falls back to the normal retry behavior;
 * `diverged` means the remote branch was rewritten to something the local
 * HEAD does not descend from, so force-pushing over it must abort.
 */
export type LeaseRefreshResult = { ok: true; sha: string } | { ok: false; reason: "fetch_failed" | "diverged" };
export type PushSessionBranchResult = { ok: true } | { ok: false; reason: "branch_name_taken" | "other" };

export type WorkflowsPermissionRejection = {
  workflowPaths: string[];
};

type PushSessionBranchOptions = {
  config: GitOperationsConfig;
  currentBranch: string;
  messageId: string;
  promptLog: BridgeLogger;
  recordTimeline: TimelineRecord;
  commitCompletedAtMs?: number;
  commitSha?: string;
  forceWithLeaseSha?: string;
  refreshLeaseSha?: () => LeaseRefreshResult;
  fetchFreshCloneToken?: () => Promise<string | null>;
  delay?: (ms: number) => Promise<void>;
};

export async function pushSessionBranch({
  config,
  currentBranch,
  messageId,
  promptLog,
  recordTimeline,
  commitCompletedAtMs,
  commitSha,
  forceWithLeaseSha,
  refreshLeaseSha,
  fetchFreshCloneToken = () => fetchCloneToken(config),
  delay = sleep,
}: PushSessionBranchOptions): Promise<PushSessionBranchResult> {
  // Refresh the push credential before pushing. The origin remote is scrubbed
  // to a token-less public URL after clone (scrub_origin_remote in
  // start-bridge.sh), so a push without a fresh token always fails with
  // "could not read Username". Retry the token fetch a bounded number of
  // times: 401/403 means the sandbox auth token was rejected (e.g. rotated
  // out from under a reconnected bridge); timeouts, network errors, and 5xx
  // are transient tail latency on the token mint. Non-auth 4xx (e.g. the
  // control plane's 400 "No installation_id for session") is permanent, so
  // fail fast instead of burning retries. A 403 carrying
  // `code: "sandbox_not_active"` is the session DO saying the session stopped
  // (or the sandbox left ready/reconnecting) while this push was in flight —
  // a lifecycle race, not an auth failure, and never retryable.
  const maxTokenAttempts = 6;
  let freshToken: string | null = null;
  let refreshFailure: "auth" | "refresh" | "session_not_active" | null = null;
  for (let attempt = 1; attempt <= maxTokenAttempts; attempt++) {
    try {
      freshToken = await fetchFreshCloneToken();
      refreshFailure = freshToken ? null : "refresh";
      break;
    } catch (err) {
      const status = err instanceof CloneTokenError ? err.status : undefined;
      if (err instanceof CloneTokenError && status === 403 && err.code === SANDBOX_NOT_ACTIVE_ERROR_CODE) {
        refreshFailure = "session_not_active";
        break;
      }
      const isAuthRejection = status === 401 || status === 403;
      // An auth rejection on any attempt is the load-bearing signal: keep the
      // "auth" label even if a later attempt fails with a transient error.
      if (isAuthRejection) {
        refreshFailure = "auth";
      } else if (refreshFailure !== "auth") {
        refreshFailure = "refresh";
      }
      if (!isAuthRejection && status !== undefined && status >= 400 && status < 500) {
        promptLog.error(
          { error: String(err), status, branch: currentBranch },
          "clone-token refresh failed with a permanent error",
        );
        break;
      }
      if (attempt < maxTokenAttempts) {
        const backoffMs = CLONE_TOKEN_RETRY_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        promptLog.warn(
          { attempt, maxAttempts: maxTokenAttempts, backoffMs, status, error: String(err), branch: currentBranch },
          isAuthRejection ? "clone-token auth rejected, retrying" : "clone-token refresh failed, retrying",
        );
        await delay(backoffMs);
      }
    }
  }

  if (refreshFailure === "session_not_active") {
    // No push_error here: the session DO treats push_error as a terminal
    // publish failure (it persists pushStatus=failed and re-runs the stop
    // boundary), which must not fire for a session that already stopped.
    // The timeline record and this log line are the truthful surface. The
    // message must not contain the substrings the push-failure Datadog
    // monitor matches on (see infra/datadog-monitors.tf push_to_origin_failed).
    // Resolve the push_attempt durably so crash recovery honors this same
    // suppression instead of synthesizing the push_error we just skipped.
    config.recordPushAttemptResolved?.({ messageId, reason: "session_not_active" });
    promptLog.error({ branch: currentBranch }, "clone-token refresh rejected: session no longer active; skipping push");
    recordTimeline(
      "git.push",
      TIMELINE_FAILED,
      "Push skipped: the session was stopped before the branch could be pushed.",
      {
        branch: currentBranch,
        reason: "session_not_active",
      },
    );
    return { ok: false, reason: "other" };
  }

  if (refreshFailure === "auth") {
    promptLog.error(
      { branch: currentBranch },
      "clone-token auth persistently rejected; aborting push instead of pushing with a stale token",
    );
    emitPushErrorEvent(config, {
      messageId,
      branchName: currentBranch,
      error: "clone_token_auth_failed",
    });
    recordTimeline(
      "git.push",
      TIMELINE_FAILED,
      "Push aborted: the sandbox auth token was rejected when refreshing the push credential.",
      {
        branch: currentBranch,
        reason: "clone_token_auth_failed",
      },
    );
    // Resolve the durable push_attempt, matching the session_not_active contract
    // above. The live push_error we just sent is the terminal outcome; resolving
    // the attempt stops crash recovery (bridge.ts) from synthesizing a second,
    // redundant push_error for this same messageId on a later restart.
    config.recordPushAttemptResolved?.({ messageId, reason: "clone_token_auth_failed" });
    return { ok: false, reason: "other" };
  }

  if (refreshFailure !== null || !freshToken) {
    promptLog.error(
      { branch: currentBranch },
      "clone-token refresh failed; aborting push because origin has no credential",
    );
    emitPushErrorEvent(config, {
      messageId,
      branchName: currentBranch,
      error: "clone_token_refresh_failed",
    });
    recordTimeline("git.push", TIMELINE_FAILED, "Push aborted: refreshing the push credential failed.", {
      branch: currentBranch,
      reason: "clone_token_refresh_failed",
    });
    // Resolve the durable push_attempt (see the auth abort above) so crash
    // recovery does not synthesize a redundant push_error for this messageId.
    config.recordPushAttemptResolved?.({ messageId, reason: "clone_token_refresh_failed" });
    return { ok: false, reason: "other" };
  }

  const repoOwner = process.env.REPO_OWNER || "";
  const repoName = process.env.REPO_NAME || "";
  const publicRepoUrl = `https://github.com/${repoOwner}/${repoName}.git`;
  const pushUrl = `https://x-access-token:${freshToken}@github.com/${repoOwner}/${repoName}.git`;
  execRepoGitSync(["remote", "set-url", "origin", pushUrl], { cwd: config.cwd });
  promptLog.info({}, "Refreshed installation token for push");
  try {
    return await runPushAttempts();
  } finally {
    // The push URL above writes the installation token into .git/config; reset
    // origin to the token-less public URL so no credential outlives the push.
    try {
      execRepoGitSync(["remote", "set-url", "origin", publicRepoUrl], { cwd: config.cwd });
    } catch (err) {
      promptLog.warn({ error: String(err) }, "Failed to re-scrub origin remote after push");
    }
  }

  async function runPushAttempts(): Promise<PushSessionBranchResult> {
    const maxPushAttempts = 5;
    let lastPushErr: unknown;
    let workflowsPermissionRejection: WorkflowsPermissionRejection | null = null;
    let pushAttempts = 0;
    let leaseSha = forceWithLeaseSha;
    let pushAttemptRecorded = false;
    const recordPushAttemptOnce = (): void => {
      if (pushAttemptRecorded) return;
      config.recordPushAttempt?.({ messageId, branch: currentBranch, commitSha });
      pushAttemptRecorded = true;
    };
    const pushStartedAtMs = Date.now();
    const commitToPushStartMs =
      commitCompletedAtMs !== undefined ? Math.max(0, pushStartedAtMs - commitCompletedAtMs) : undefined;
    recordTimeline("git.push", TIMELINE_STARTED, "Started pushing the session branch to origin.", {
      branch: currentBranch,
      ...(commitToPushStartMs !== undefined ? { commitToPushStartMs } : {}),
    });
    for (let attempt = 1; attempt <= maxPushAttempts; attempt++) {
      pushAttempts = attempt;
      try {
        const pushArgs = leaseSha
          ? [
              "push",
              "--no-verify",
              "-u",
              "origin",
              `HEAD:refs/heads/${currentBranch}`,
              `--force-with-lease=refs/heads/${currentBranch}:${leaseSha}`,
            ]
          : // No lease sha means the primary publish path could not resolve a
            // remote-tracking head for this branch (the common first-push case).
            // Create-only push: the remote ref must be absent. A plain push would
            // silently fast-forward an unrelated same-name branch whose tip is an
            // ancestor of this session's HEAD.
            [
              "push",
              "--no-verify",
              "-u",
              "origin",
              `HEAD:refs/heads/${currentBranch}`,
              `--force-with-lease=refs/heads/${currentBranch}:`,
            ];
        recordPushAttemptOnce();
        execRepoGitSync(pushArgs, {
          cwd: config.cwd,
          timeout: GIT_PUSH_TIMEOUT_MS,
        });
        promptLog.info({ branch: currentBranch }, "Pushed to origin");
        lastPushErr = undefined;
        break;
      } catch (err: unknown) {
        lastPushErr = err;
        const workflowsRejection = isWorkflowsPermissionRejection(err);
        if (workflowsRejection) {
          workflowsPermissionRejection = workflowsRejection;
          promptLog.warn(
            {
              branch: currentBranch,
              workflowPaths: workflowsRejection.workflowPaths,
              attempt,
            },
            "GitHub rejected the workflow file update because the App installation token lacks workflows permission",
          );
          break;
        }
        const execErr = err as { message?: string };
        // A lease rejection retried with the same sha is guaranteed to fail
        // again: the lease was read from the local tracking ref, which only
        // moves on fetch. Refresh it (at most once per attempt — one call per
        // catch) and let the bounded retry loop push with the updated sha.
        // Skipped on the final attempt: there is no retry left to use the
        // refreshed sha, so the fetch would be wasted.
        if (attempt < maxPushAttempts && leaseSha && refreshLeaseSha && isLeaseRejection(err)) {
          const refreshed = refreshLeaseSha();
          if (refreshed.ok) {
            promptLog.warn(
              { staleLeaseSha: leaseSha, refreshedLeaseSha: refreshed.sha, attempt, branch: currentBranch },
              "force-with-lease rejected with a stale lease; fetched remote head and refreshed the lease sha",
            );
            leaseSha = refreshed.sha;
          } else if (refreshed.reason === "diverged") {
            promptLog.error(
              { staleLeaseSha: leaseSha, attempt, branch: currentBranch },
              "Remote branch was rewritten while pushing; refusing to force over it",
            );
            emitPushErrorEvent(config, {
              messageId,
              branchName: currentBranch,
              error: "remote_branch_diverged",
            });
            recordTimeline(
              "git.push",
              TIMELINE_FAILED,
              "Push aborted: the remote branch was rewritten and no longer matches this session's history.",
              {
                branch: currentBranch,
                reason: "remote_branch_diverged",
              },
            );
            // Resolve the durable attempt so crash recovery in bridge.ts does not
            // synthesize a duplicate push_error for this messageId, matching the
            // session_not_active / clone_token_* terminal paths.
            recordPushAttemptOnce();
            config.recordPushAttemptResolved?.({ messageId, reason: "remote_branch_diverged" });
            return { ok: false, reason: "other" };
          }
          // fetch_failed: fall through to the normal retry behavior.
        }
        if (!leaseSha && isBranchNameTakenRejection(err, currentBranch)) {
          config.recordPushAttemptResolved?.({ messageId, branch: currentBranch, reason: "branch_name_taken" });
          promptLog.warn(
            { branch: currentBranch, attempt },
            "Session branch name is already present on origin; caller may retry with a disambiguated name",
          );
          return { ok: false, reason: "branch_name_taken" };
        }
        if (attempt < maxPushAttempts) {
          const backoffMs = PUSH_RETRY_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          promptLog.warn(
            {
              error: execErr.message || String(err),
              attempt,
              maxAttempts: maxPushAttempts,
              backoffMs,
              branch: currentBranch,
            },
            "Push to origin failed, retrying",
          );
          await delay(backoffMs);
        }
      }
    }

    if (lastPushErr) {
      const execErr = lastPushErr as { stderr?: string; stdout?: string; message?: string };
      if (workflowsPermissionRejection) {
        const message = formatWorkflowsPermissionPushError(workflowsPermissionRejection.workflowPaths);
        emitPushErrorEvent(config, {
          messageId,
          branchName: currentBranch,
          error: message,
        });
        recordTimeline("git.push", TIMELINE_FAILED, message, {
          branch: currentBranch,
          attempts: pushAttempts,
          reason: "workflows_permission_required",
          workflowPaths: workflowsPermissionRejection.workflowPaths,
        });
        recordPushAttemptOnce();
        config.recordPushAttemptResolved?.({ messageId, reason: "workflows_permission_required" });
        return { ok: false, reason: "other" };
      }
      recordPushAttemptOnce();
      promptLog.error(
        {
          error: execErr.message || String(lastPushErr),
          stderr: execErr.stderr || "",
          stdout: execErr.stdout || "",
          branch: currentBranch,
          attempts: maxPushAttempts,
        },
        "Failed to push to origin after retries",
      );
      emitPushErrorEvent(config, {
        messageId,
        branchName: currentBranch,
        // The origin URL carries the installation token during the push and
        // git prints it in `fatal: unable to access '<url>'` errors; the helper
        // redacts before the error leaves the bridge.
        error: String(lastPushErr),
      });
      recordTimeline("git.push", TIMELINE_FAILED, "Push to origin failed after retries.", {
        branch: currentBranch,
        attempts: maxPushAttempts,
      });
      return { ok: false, reason: "other" };
    }

    // Advance the local remote-tracking ref to the tip we just pushed. In a
    // single-branch clone the fetch refspec covers only the cloned branch, so
    // `git push -u` does NOT move refs/remotes/origin/<branch> for a
    // session-created branch — and both the next prompt's publish diff
    // baseline (computeDiffPreparation) and crash recovery
    // (readRemoteTrackingBranchHead) read that ref. Best-effort: a failure
    // only degrades the next prompt's baseline to the base-ref walk.
    try {
      execRepoGitSync(["update-ref", `refs/remotes/origin/${currentBranch}`, `refs/heads/${currentBranch}`], {
        cwd: config.cwd,
      });
    } catch (err) {
      promptLog.warn(
        { error: String(err), branch: currentBranch },
        "Failed to advance the remote-tracking ref after push",
      );
    }

    // Durably record the successful push BEFORE emitting push_complete. The crash
    // window opens the instant `git push` returns above; persisting here (not back
    // in the runner) means a death before push_complete is still recoverable into
    // a PR. Fail-open: the checkpoint callback never throws.
    config.recordPushCheckpoint?.({ messageId, branch: currentBranch, commitSha });

    const pushCompletedAtMs = Date.now();
    config.sendEvent({
      type: "push_complete",
      messageId,
      branchName: currentBranch,
      ...(commitSha ? { commitSha } : {}),
      sandboxId: config.sandboxId,
      timestamp: pushCompletedAtMs,
    });
    const commitToPushMs =
      commitCompletedAtMs !== undefined ? Math.max(0, pushCompletedAtMs - commitCompletedAtMs) : undefined;
    const pushDurationMs = Math.max(0, pushCompletedAtMs - pushStartedAtMs);
    recordTimeline("git.push", TIMELINE_COMPLETED, "Pushed the session branch to origin.", {
      branch: currentBranch,
      attempts: pushAttempts,
      pushDurationMs,
      ...(commitToPushMs !== undefined ? { commitToPushMs } : {}),
    });
    if (commitToPushMs !== undefined) {
      promptLog.info(
        {
          event: "git.commit_to_push.completed",
          prompt_id: messageId,
          sessionId: config.sessionId,
          branch: currentBranch,
          commit_to_push_ms: commitToPushMs,
          commit_to_push_start_ms: commitToPushStartMs ?? 0,
          push_duration_ms: pushDurationMs,
          attempts: pushAttempts,
        },
        "Commit-to-push latency recorded",
      );
    }

    return { ok: true };
  }
}

/**
 * Carries the HTTP status so callers can distinguish auth rejection (401/403),
 * plus the structured `code` from the control plane's JSON error body so a
 * lifecycle 403 (`sandbox_not_active`) is distinguishable from a real one.
 */
export class CloneTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CloneTokenError";
  }
}

async function fetchCloneToken(
  config: Pick<GitOperationsConfig, "controlPlaneUrl" | "sessionId" | "getAuthToken">,
): Promise<string | null> {
  const base = config.controlPlaneUrl.startsWith("http") ? config.controlPlaneUrl : `https://${config.controlPlaneUrl}`;
  const url = `${base}/api/sessions/${config.sessionId}/clone-token`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.getAuthToken()}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(CLONE_TOKEN_REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortSignalTimeout(err)) {
      throw new Error(`clone-token request timed out after ${CLONE_TOKEN_REFRESH_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new CloneTokenError(`clone-token request failed (${res.status}): ${body}`, res.status, parseErrorCode(body));
  }
  const data = (await res.json()) as { ok: boolean; token?: string; error?: string };
  if (!data.ok || !data.token) {
    throw new Error(data.error || "No token in response");
  }
  return data.token;
}

/**
 * Matches git's force-with-lease rejection output: `! [rejected] ... (stale
 * info)`. With `--force-with-lease` in use, a stale lease is the only local
 * rejection git emits, so "stale info" alone is the precise signal; matching
 * the broader "[rejected]" would misclassify other rejection lines.
 */
function isLeaseRejection(err: unknown): boolean {
  const execErr = err as { stderr?: string; message?: string };
  const text = `${execErr.stderr ?? ""}\n${execErr.message ?? ""}`;
  return text.includes("stale info");
}

export function isNonFastForwardRejection(err: unknown, branch?: string): boolean {
  const execErr = err as { stderr?: string; message?: string };
  const text = `${execErr.stderr ?? ""}\n${execErr.message ?? ""}`;
  if (!text.includes("[rejected]")) return false;
  if (!text.includes("non-fast-forward") && !text.includes("fetch first")) return false;
  if (branch && !text.includes(branch)) return false;
  return true;
}

function isBranchNameTakenRejection(err: unknown, branch: string): boolean {
  return isCreateOnlyLeaseRejection(err) || isNonFastForwardRejection(err, branch);
}

function isCreateOnlyLeaseRejection(err: unknown): boolean {
  const execErr = err as { stderr?: string; message?: string };
  const text = `${execErr.stderr ?? ""}\n${execErr.message ?? ""}`;
  return text.includes("[rejected]") && text.includes("stale info");
}

export function isWorkflowsPermissionRejection(err: unknown): WorkflowsPermissionRejection | null {
  const execErr = err as { stderr?: string; message?: string };
  const text = `${execErr.stderr ?? ""}\n${execErr.message ?? ""}`;
  if (
    !text.includes("refusing to allow a GitHub App to create or update workflow") ||
    !text.includes("without `workflows` permission")
  ) {
    return null;
  }

  const workflowPaths = new Set<string>();
  for (const match of text.matchAll(
    /workflow\s+[`'"]?([^`'"\s]+)[`'"]?\s+without\s+[`'"]?workflows[`'"]?\s+permission/g,
  )) {
    const path = match[1];
    if (path) workflowPaths.add(path);
  }
  for (const match of text.matchAll(/\.github\/workflows\/[^\s`'")]+/g)) {
    workflowPaths.add(match[0]);
  }
  return { workflowPaths: [...workflowPaths] };
}

function formatWorkflowsPermissionPushError(workflowPaths: string[]): string {
  const pathText =
    workflowPaths.length === 0
      ? "files under `.github/workflows/`"
      : workflowPaths.length === 1
        ? `\`${workflowPaths[0]}\``
        : `workflow files ${workflowPaths.map((path) => `\`${path}\``).join(", ")}`;
  return `updating ${pathText} requires the \`workflows\` permission, which the Cycloid GitHub App does not hold for this repo.`;
}

/** Defensive: error bodies are usually `{ ok, error, code? }` JSON, but proxies can return anything. */
function parseErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string") {
      return (parsed as { code: string }).code;
    }
  } catch {
    // Non-JSON body: no structured code.
  }
  return undefined;
}

function isAbortSignalTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}
