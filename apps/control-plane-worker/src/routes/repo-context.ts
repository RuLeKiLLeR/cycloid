import { createLogger } from "../logger";
import { verifyCycloidMember } from "../services/internal-feature-gate";
import { getRepoContext } from "../services/repo-context";
import { verifyRepoAccessAndInstallation } from "../services/repo-gate";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { parsePattern, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "repo-context-route" } });

export const repoContextRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/repos/:owner/:repo/context"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);

      // Internal-only surface: fail closed before any service work.
      if (!(await verifyCycloidMember(env.DB, auth))) {
        return jsonErrorResponse("Forbidden", 403);
      }

      const owner = match.groups?.owner ? decodeURIComponent(match.groups.owner) : "";
      const repo = match.groups?.repo ? decodeURIComponent(match.groups.repo) : "";
      if (!owner || !repo) return jsonErrorResponse("Missing owner or repo", 400);

      // Fail closed: business membership required (the context is business + repo scoped).
      const businessId = routeAuth.user?.businessId ?? null;
      if (!businessId) return jsonErrorResponse("Business membership required", 403);

      const db = assertDatabase(env);

      // Fail closed: the caller must have GitHub access to the repo + an active installation.
      const gate = await verifyRepoAccessAndInstallation(
        db,
        {
          userId: routeAuth.userId,
          canAccessAllSessions: !!routeAuth.canAccessAllSessions,
          businessRole: routeAuth.user?.businessRole ?? null,
        },
        owner,
        repo,
        { githubTokenEnv: env, reposCacheEnv: env },
      );
      if (!gate.ok) return gate.response;

      try {
        const data = await getRepoContext(db, {
          businessId,
          userId: Number(routeAuth.userId),
          repoOwner: owner,
          repoName: repo,
        });
        return jsonResponse({ ok: true, data });
      } catch (err) {
        log.error(
          { userId: routeAuth.userId, repoOwner: owner, repoName: repo, error: String(err) },
          "repo_context_get_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
];
