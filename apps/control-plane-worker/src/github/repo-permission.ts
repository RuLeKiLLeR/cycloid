import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { assertGithubOk } from "./errors";
import { createInstallationToken } from "./octokit";

export type RepoPermissionLevel = "admin" | "maintain" | "write" | "triage" | "read" | "none";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "Cycloid-Control-Plane";

const ROLE_NAME_LEVELS = new Set<RepoPermissionLevel>(["admin", "maintain", "write", "triage", "read"]);
const PERMISSION_LEVELS = new Set<RepoPermissionLevel>(["admin", "write", "read", "none"]);

function parseRepoPermissionLevel(value: unknown): RepoPermissionLevel | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const response = value as Record<string, unknown>;
  if (typeof response.role_name === "string" && ROLE_NAME_LEVELS.has(response.role_name as RepoPermissionLevel)) {
    return response.role_name as RepoPermissionLevel;
  }
  if (typeof response.permission === "string" && PERMISSION_LEVELS.has(response.permission as RepoPermissionLevel)) {
    return response.permission as RepoPermissionLevel;
  }
  return null;
}

export async function getActorRepoPermissionLevel(
  env: Env,
  args: {
    installationId: number;
    repoOwner: string;
    repoName: string;
    actorLogin: string;
  },
): Promise<RepoPermissionLevel | null> {
  try {
    const token = await createInstallationToken(env, args.installationId);
    const response = await tracedFetch(
      `${GITHUB_API}/repos/${encodeURIComponent(args.repoOwner)}/${encodeURIComponent(args.repoName)}/collaborators/${encodeURIComponent(args.actorLogin)}/permission`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      },
      "github.getActorRepoPermissionLevel",
    );

    if (response.status === 404) return "none";
    await assertGithubOk(response, "GitHub collaborator permission lookup");
    return parseRepoPermissionLevel(await response.json());
  } catch {
    return null;
  }
}

export function actorCanWriteToRepo(level: RepoPermissionLevel | null): boolean {
  return level === "admin" || level === "maintain" || level === "write";
}
