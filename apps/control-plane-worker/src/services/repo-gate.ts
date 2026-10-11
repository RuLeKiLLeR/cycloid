import type { BusinessRole } from "../auth/business-role";
import type { GithubTokenRefreshEnv } from "../auth/db";
import { verifyUserRepoAccess } from "../auth/repo-authorization";
import { getInstallationByOwner } from "../github/installations-db";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { jsonResponse } from "../utils";

const log = createLogger({ bindings: { component: "repo-gate" } });
const GENERIC_REPO_GATE_DENIAL = "Access unavailable. Contact your administrator.";
const GENERIC_REPO_GATE_RETRY = "Unable to continue. Please try again.";

/** Why the gate rejected, so callers can branch (e.g. notify only on true denial). */
export type RepoGateFailureReason =
  "repo_access_denied" | "access_unverifiable" | "installation_missing" | "installation_suspended";
type RepoGateSuccess = { ok: true; installationId: number };
type RepoGateFailure = { ok: false; reason: RepoGateFailureReason; response: Response };
type RepoGateResult = RepoGateSuccess | RepoGateFailure;

type RepoGateAuth = {
  userId: string;
  canAccessAllSessions: boolean;
  businessRole?: BusinessRole | null;
};

interface RepoGateOptions {
  /** Env needed to decrypt and refresh stored user OAuth credentials. */
  githubTokenEnv?: GithubTokenRefreshEnv;
  /** Include in log context when the gate is checked for an existing session. */
  sessionId?: string;
  /** KV namespace for the repo-access cache shortcut. */
  reposCacheEnv?: Pick<Env, "REPOS_CACHE"> | null;
}

function canShowDetailedRepoGateErrors(auth: RepoGateAuth): boolean {
  return auth.canAccessAllSessions || auth.businessRole === "admin" || auth.businessRole === "member";
}

function repoGateErrorResponse(auth: RepoGateAuth, detail: string, status: 403 | 503 = 403): Response {
  return jsonResponse(
    {
      ok: false,
      error: canShowDetailedRepoGateErrors(auth)
        ? detail
        : status === 503
          ? GENERIC_REPO_GATE_RETRY
          : GENERIC_REPO_GATE_DENIAL,
    },
    status,
  );
}

/**
 * Combined repo-access verification and GitHub App installation gate.
 *
 * 1. If the caller is not an API-token user, verifies the user has GitHub
 *    access to the repo via their OAuth token.
 * 2. Looks up the GitHub App installation for the repo owner.
 * 3. Checks the installation is not suspended.
 *
 * Returns the installation ID on success, or an HTTP error response on failure.
 * Used by session create, resume, and repo-change routes.
 */
export async function verifyRepoAccessAndInstallation(
  db: D1Database,
  auth: RepoGateAuth,
  owner: string,
  repo: string,
  options: RepoGateOptions,
): Promise<RepoGateResult> {
  const { githubTokenEnv, sessionId, reposCacheEnv } = options ?? {};

  // Step 1: Verify user has GitHub access to the repo
  if (!auth.canAccessAllSessions) {
    let hasAccess: boolean;
    try {
      hasAccess = await verifyUserRepoAccess(db, auth.userId, owner, repo, { githubTokenEnv, reposCacheEnv });
    } catch (err) {
      log.error(
        { sessionId, repoOwner: owner, repoName: repo, userId: auth.userId, error: String(err) },
        "Repo gate rejected: repo access verification unavailable",
      );
      return {
        ok: false,
        reason: "access_unverifiable",
        response: repoGateErrorResponse(auth, "Unable to verify repository access. Please try again.", 503),
      };
    }
    if (!hasAccess) {
      log.warn(
        { sessionId, repoOwner: owner, repoName: repo, userId: auth.userId },
        "Repo gate rejected: user does not have GitHub access to repo",
      );
      return {
        ok: false,
        reason: "repo_access_denied",
        response: repoGateErrorResponse(auth, "You do not have access to this repository on GitHub"),
      };
    }
  }

  // Step 2: Verify GitHub App installation exists and is active
  const installation = await getInstallationByOwner(db, owner);
  if (!installation) {
    log.warn({ sessionId, repoOwner: owner }, "Repo gate rejected: no GitHub App installation for repo owner");
    return {
      ok: false,
      reason: "installation_missing",
      response: repoGateErrorResponse(auth, "Cycloid is not installed on this GitHub organization"),
    };
  }
  if (installation.suspended_at) {
    log.warn(
      { sessionId, repoOwner: owner, installationId: installation.installation_id },
      "Repo gate rejected: installation suspended",
    );
    return {
      ok: false,
      reason: "installation_suspended",
      response: repoGateErrorResponse(auth, "Cycloid installation is suspended for this GitHub organization"),
    };
  }

  return { ok: true, installationId: installation.installation_id };
}
