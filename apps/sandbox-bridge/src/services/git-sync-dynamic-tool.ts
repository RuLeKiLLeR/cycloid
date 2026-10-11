import { isSafeGitRef } from "../../../../shared/utils/git-ref.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { isCancellationError } from "./cancellation.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import {
  createDynamicToolFailure as failure,
  createDynamicToolJsonSuccess as success,
  DYNAMIC_TOOL_ERROR_CODES,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import { execRepoGit } from "./git/exec.js";
import { CYCLOID_DYNAMIC_TOOL_NAMESPACE } from "./memory-dynamic-tool.js";

export const GIT_SYNC_DYNAMIC_TOOL_NAME = "git_sync";

const GIT_SYNC_TIMEOUT_MS = 60_000;
const GIT_REMOTE_SET_URL_TIMEOUT_MS = 30_000;
const CLONE_TOKEN_TIMEOUT_MS = 15_000;
const GITHUB_REPO_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const TOKEN_REDACTION_PATTERN = /x-access-token:[^@]+@/g;

type GitSyncOperation = "force_push_current_branch";

type GitSyncInput = {
  operation: GitSyncOperation;
  baseBranch: string | null;
};

type GitSyncDeps = {
  execGit: typeof execRepoGit;
  fetchCloneToken: (context: FirstPartyDynamicToolExecuteContext) => Promise<string>;
  /**
   * Best-effort pre-push report of the head about to be force-pushed, so the control plane records it
   * as the session's OWN push (the review-loop reply gate and head-change carry-forward key off the
   * record; without it the agent's mid-prompt fix push stale-blocks its own review epoch as
   * `head_changed` and its verdict replies are rejected). Called BEFORE the actual `git push` so the
   * `synchronize` webhook can never beat the record; a record for a push that then fails is inert.
   * Returns whether the record landed — a failure never blocks the push itself.
   */
  recordSelfPush?: (
    context: FirstPartyDynamicToolExecuteContext,
    input: { pushedHead: string; branch: string },
  ) => Promise<boolean>;
};

function envString(env: NodeJS.ProcessEnv | Record<string, string>, key: string): string {
  return env[key]?.trim() ?? "";
}

function normalizeInput(args: unknown): GitSyncInput | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const raw = args as Record<string, unknown>;
  const operation = raw.operation;
  if (operation !== "force_push_current_branch") return null;
  const baseBranch = typeof raw.baseBranch === "string" && raw.baseBranch.trim() ? raw.baseBranch.trim() : null;
  return { operation, baseBranch };
}

function resolveBaseBranch(input: GitSyncInput, env: NodeJS.ProcessEnv | Record<string, string>): string {
  return (input.baseBranch ?? envString(env, "BRANCH")) || "main";
}

function resolveTrustedProtectedBaseBranch(env: NodeJS.ProcessEnv | Record<string, string>): string {
  return envString(env, "BRANCH") || "main";
}

function validateRepoContext(env: NodeJS.ProcessEnv | Record<string, string>): { owner: string; repo: string } | null {
  const owner = envString(env, "REPO_OWNER");
  const repo = envString(env, "REPO_NAME");
  if (!GITHUB_REPO_COMPONENT_PATTERN.test(owner) || !GITHUB_REPO_COMPONENT_PATTERN.test(repo)) return null;
  return { owner, repo };
}

function redactGitError(error: unknown, token: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const tokenRedacted = token ? raw.replaceAll(token, "[redacted]") : raw;
  return tokenRedacted.replace(TOKEN_REDACTION_PATTERN, "x-access-token:[redacted]@");
}

async function fetchCloneToken(context: FirstPartyDynamicToolExecuteContext): Promise<string> {
  const controlPlaneUrl = normalizeControlPlaneUrl(context.env["CONTROL_PLANE_URL"] ?? context.env["ARCANIST_API_URL"]);
  const sessionId = envString(context.env, "SESSION_ID");
  const sandboxAuthToken = envString(context.env, "SANDBOX_AUTH_TOKEN");
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) {
    throw new Error("Git sync is not configured for this session.");
  }

  const response = await (context.fetchImpl ?? fetch)(
    `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}/clone-token`,
    {
      headers: {
        authorization: `Bearer ${sandboxAuthToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal: createTimeoutAwareSignal(context.signal, CLONE_TOKEN_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`clone-token request failed with HTTP ${response.status}`);
  const payload = (await response.json()) as { ok?: unknown; token?: unknown; error?: unknown };
  if (payload.ok !== true || typeof payload.token !== "string" || payload.token.trim().length === 0) {
    throw new Error(typeof payload.error === "string" ? payload.error : "No token in clone-token response.");
  }
  return payload.token;
}

const RECORD_SELF_PUSH_TIMEOUT_MS = 5_000;

async function recordSelfPushWithControlPlane(
  context: FirstPartyDynamicToolExecuteContext,
  input: { pushedHead: string; branch: string },
): Promise<boolean> {
  try {
    const controlPlaneUrl = normalizeControlPlaneUrl(
      context.env["CONTROL_PLANE_URL"] ?? context.env["ARCANIST_API_URL"],
    );
    const sessionId = envString(context.env, "SESSION_ID");
    const sandboxAuthToken = envString(context.env, "SANDBOX_AUTH_TOKEN");
    if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) return false;
    const response = await (context.fetchImpl ?? fetch)(
      `${controlPlaneUrl}/api/sessions/${encodeURIComponent(sessionId)}/review-loop/record-push`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(input),
        signal: createTimeoutAwareSignal(context.signal, RECORD_SELF_PUSH_TIMEOUT_MS),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function withTokenizedOrigin<T>(
  context: FirstPartyDynamicToolExecuteContext,
  deps: GitSyncDeps,
  repo: { owner: string; repo: string },
  token: string,
  callback: () => Promise<T>,
): Promise<T> {
  const cwd = context.cwd;
  if (!cwd) throw new Error("Git sync requires a repository working directory.");
  const publicRepoUrl = `https://github.com/${repo.owner}/${repo.repo}.git`;
  const tokenizedRepoUrl = `https://x-access-token:${token}@github.com/${repo.owner}/${repo.repo}.git`;
  await deps.execGit(["remote", "set-url", "origin", tokenizedRepoUrl], {
    cwd,
    timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
    signal: context.signal,
  });

  let callbackResult: T | undefined;
  let callbackCompleted = false;
  let callbackError: unknown;
  try {
    callbackResult = await callback();
    callbackCompleted = true;
  } catch (error) {
    callbackError = error;
  }

  try {
    await deps.execGit(["remote", "set-url", "origin", publicRepoUrl], {
      cwd,
      timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
    });
  } catch (scrubError) {
    throw new Error(`Git sync failed to scrub origin remote: ${redactGitError(scrubError, token)}`, {
      cause: scrubError,
    });
  }

  if (!callbackCompleted) throw callbackError;
  return callbackResult as T;
}

async function fetchBaseBranch(
  context: FirstPartyDynamicToolExecuteContext,
  deps: GitSyncDeps,
  baseBranch: string,
): Promise<{ baseBranch: string; fetchedSha: string }> {
  if (!context.cwd) throw new Error("Git sync requires a repository working directory.");
  await deps.execGit(["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], {
    cwd: context.cwd,
    timeout: GIT_SYNC_TIMEOUT_MS,
    signal: context.signal,
  });
  const fetchedSha = (
    await deps.execGit(["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}`], {
      cwd: context.cwd,
      timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
      signal: context.signal,
    })
  )
    .trim()
    .toLowerCase();
  return { baseBranch, fetchedSha };
}

async function forcePushCurrentBranch(
  context: FirstPartyDynamicToolExecuteContext,
  deps: GitSyncDeps,
  protectedBaseBranch: string,
): Promise<{ branch: string; remoteHeadBefore: string; pushedHead: string; pushRecorded: boolean }> {
  if (!context.cwd) throw new Error("Git sync requires a repository working directory.");
  const branch = (
    await deps.execGit(["branch", "--show-current"], {
      cwd: context.cwd,
      timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
      signal: context.signal,
    })
  ).trim();
  if (!branch) throw new Error("Cannot force-push from a detached HEAD.");
  if (!isSafeGitRef(branch)) throw new Error(`Current branch is not a safe git ref: ${branch}`);
  if (branch === protectedBaseBranch || branch === "main" || branch === "master") {
    throw new Error(`Refusing to force-push protected branch '${branch}'.`);
  }

  await deps.execGit(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: context.cwd,
    timeout: GIT_SYNC_TIMEOUT_MS,
    signal: context.signal,
  });
  const remoteHeadBefore = (
    await deps.execGit(["rev-parse", "--verify", `refs/remotes/origin/${branch}`], {
      cwd: context.cwd,
      timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
      signal: context.signal,
    })
  )
    .trim()
    .toLowerCase();

  try {
    await deps.execGit(["merge-base", "--is-ancestor", remoteHeadBefore, "HEAD"], {
      cwd: context.cwd,
      timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
      signal: context.signal,
    });
  } catch (error) {
    throw new Error("Refusing to force-push because the remote branch contains commits not present in local HEAD.", {
      cause: error,
    });
  }

  // Report the head we are ABOUT to push (local HEAD) so the control plane records it as the
  // session's own push before the `synchronize` webhook can observe the advance. Best-effort: a
  // failed record must never block the push, but it is surfaced in the tool payload.
  const headToPush = (
    await deps.execGit(["rev-parse", "--verify", "HEAD"], {
      cwd: context.cwd,
      timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
      signal: context.signal,
    })
  )
    .trim()
    .toLowerCase();
  const recordSelfPush = deps.recordSelfPush ?? recordSelfPushWithControlPlane;
  const pushRecorded = await recordSelfPush(context, { pushedHead: headToPush, branch });

  await deps.execGit(
    [
      "push",
      "--no-verify",
      "-u",
      "origin",
      `HEAD:refs/heads/${branch}`,
      `--force-with-lease=refs/heads/${branch}:${remoteHeadBefore}`,
    ],
    {
      cwd: context.cwd,
      timeout: GIT_SYNC_TIMEOUT_MS,
      signal: context.signal,
    },
  );
  await deps.execGit(["update-ref", `refs/remotes/origin/${branch}`, `refs/heads/${branch}`], {
    cwd: context.cwd,
    timeout: GIT_REMOTE_SET_URL_TIMEOUT_MS,
    signal: context.signal,
  });
  return { branch, remoteHeadBefore, pushedHead: headToPush, pushRecorded };
}

export function buildGitSyncDynamicToolSpec(
  _env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  return [
    {
      namespace: CYCLOID_DYNAMIC_TOOL_NAMESPACE,
      name: GIT_SYNC_DYNAMIC_TOOL_NAME,
      description:
        "Use operation 'force_push_current_branch' only after local conflict resolution is complete and the current PR branch must be updated immediately; ordinary git fetch supplies base refs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: { type: "string", enum: ["force_push_current_branch"] },
          baseBranch: { type: "string", minLength: 1 },
        },
        required: ["operation"],
      },
    },
  ];
}

export async function executeGitSyncDynamicToolCallWithDeps(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
  deps: GitSyncDeps,
): Promise<FirstPartyDynamicToolCallResult> {
  const input = normalizeInput(args);
  if (!input) {
    return failure(
      DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      "cycloid.git_sync requires { operation: 'force_push_current_branch', baseBranch?: string }.",
    );
  }
  const repo = validateRepoContext(context.env);
  if (!repo) {
    return failure(DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED, "Git sync is not configured with a valid session repo.");
  }
  const baseBranch = resolveBaseBranch(input, context.env);
  if (!isSafeGitRef(baseBranch)) {
    return failure(DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT, `Base branch is not a safe git ref: ${baseBranch}`);
  }
  const protectedBaseBranch = resolveTrustedProtectedBaseBranch(context.env);
  if (!isSafeGitRef(protectedBaseBranch)) {
    return failure(
      DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      `Session base branch is not a safe git ref: ${protectedBaseBranch}`,
    );
  }

  let token = "";
  try {
    token = await deps.fetchCloneToken(context);
    const payload = await withTokenizedOrigin(context, deps, repo, token, async () => {
      return {
        ok: true,
        operation: input.operation,
        baseBranch,
        ...(await forcePushCurrentBranch(context, deps, protectedBaseBranch)),
      };
    });
    return success(payload);
  } catch (error) {
    if (isCancellationError(error)) {
      return failure(DYNAMIC_TOOL_ERROR_CODES.CANCELLED, "Git sync request was cancelled.");
    }
    const redacted = redactGitError(error, token);
    const code =
      redacted.includes("not configured") || redacted.includes("requires a repository working directory")
        ? DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED
        : redacted.startsWith("Refusing to force-push")
          ? DYNAMIC_TOOL_ERROR_CODES.BLOCKED
          : DYNAMIC_TOOL_ERROR_CODES.EXECUTION_FAILED;
    return failure(code, `Git sync failed: ${redacted}`);
  }
}

export async function executeGitSyncDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  return executeGitSyncDynamicToolCallWithDeps(args, context, {
    execGit: execRepoGit,
    fetchCloneToken,
  });
}
