import { verifyUserRepoAccess } from "../auth/repo-authorization";
import { fetchRepoSkills } from "../github/skills";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

export const skillRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/repos/:owner/:repo/skills"),
    auth: "authenticated",
    handler: async (_req, env, match, auth) => {
      const userId = auth!.userId;
      if (!userId) return jsonErrorResponse("Authentication required", 401);

      const owner = match.groups!.owner;
      const repo = match.groups!.repo;
      if (!owner || !repo) return jsonErrorResponse("Missing owner or repo", 400);

      const decodedOwner = decodeURIComponent(owner);
      const decodedRepo = decodeURIComponent(repo);
      let hasAccess: boolean;
      try {
        hasAccess = await verifyUserRepoAccess(env.DB, userId, decodedOwner, decodedRepo, {
          githubTokenEnv: env,
          reposCacheEnv: env,
        });
      } catch {
        return jsonErrorResponse("Unable to verify repository access. Please try again.", 503);
      }
      if (!hasAccess) return jsonErrorResponse("Repository not found", 404);

      const skills = (await fetchRepoSkills(env, userId, decodedOwner, decodedRepo)).map(
        ({ name, description, argument, path }) => ({
          name,
          description,
          ...(argument ? { argument } : {}),
          path,
        }),
      );
      return jsonResponse({ skills });
    },
  },
];
