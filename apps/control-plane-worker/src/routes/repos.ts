import { getAppSlug } from "../github/octokit";
import { createLogger } from "../logger";
import { withRouteSpan } from "../observability/route-span";
import { listAccessibleRepos, listRepoBranchesForUser, listRepoFilesForUser } from "../services/repos";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

const log = createLogger({ bindings: { component: "repos-routes" } });

export const repoRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/repos"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => {
      const userId = auth!.userId;
      if (!userId) return jsonErrorResponse("Authentication required", 401);

      return withRouteSpan("repos.list", { auth: auth! }, async (span) => {
        const result = await listAccessibleRepos(env, _req, userId);
        if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
        span.setAttributes({
          "cache.status": result.cacheStatus,
          "db.rows_returned": result.repos.length,
          "repos.sso_withheld_orgs": result.ssoOrgs.length,
        });
        return jsonResponse({ repos: result.repos, ssoOrgs: result.ssoOrgs });
      });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/github/install-url"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) => {
      const userId = auth!.userId;
      if (!userId) return jsonErrorResponse("Authentication required", 401);

      const slug = await getAppSlug(env);
      const url = `https://github.com/apps/${slug}/installations/new`;
      log.info({ userId, url }, "Generated GitHub App install URL");
      return jsonResponse({ url });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/repos/:owner/:repo/branches"),
    auth: "authenticated",
    handler: async (_req, env, match, auth) => {
      const userId = auth!.userId;
      if (!userId) return jsonErrorResponse("Authentication required", 401);

      const owner = match.groups!.owner;
      const repo = match.groups!.repo;
      if (!owner || !repo) return jsonErrorResponse("Missing owner or repo", 400);

      return withRouteSpan("repos.branches", { auth: auth! }, async (span) => {
        const result = await listRepoBranchesForUser(env, userId, decodeURIComponent(owner), decodeURIComponent(repo));
        if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
        span.setAttributes({
          "db.rows_returned": result.branches.length,
          "repo.owner": owner,
          "repo.name": repo,
        });
        return jsonResponse({ branches: result.branches });
      });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/repos/:owner/:repo/files"),
    auth: "authenticated",
    handler: async (_req, env, match, auth) => {
      const userId = auth!.userId;
      if (!userId) return jsonErrorResponse("Authentication required", 401);

      const owner = match.groups!.owner;
      const repo = match.groups!.repo;
      if (!owner || !repo) return jsonErrorResponse("Missing owner or repo", 400);

      const branch = new URL(_req.url).searchParams.get("branch") ?? "main";
      return withRouteSpan("repos.files", { auth: auth! }, async (span) => {
        const result = await listRepoFilesForUser(
          env,
          userId,
          decodeURIComponent(owner),
          decodeURIComponent(repo),
          branch,
        );
        if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
        span.setAttributes({
          "db.rows_returned": result.files.length,
          "repo.owner": owner,
          "repo.name": repo,
        });
        return jsonResponse({ files: result.files });
      });
    },
  },
];
