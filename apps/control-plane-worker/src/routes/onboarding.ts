import { createLogger } from "../logger";
import { getOnboardingStatus } from "../onboarding/service";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

const log = createLogger({ bindings: { component: "onboarding-routes" } });

export const onboardingRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/onboarding/status"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const userId = Number(auth!.userId);
      if (!Number.isFinite(userId)) {
        return jsonErrorResponse("Invalid user", 400);
      }
      const businessRole = auth!.user?.businessRole ?? null;
      if (businessRole !== "admin" && businessRole !== "member") {
        log.warn(
          { userId, businessId: auth!.user?.businessId ?? null, reason: "missing_business_membership" },
          "Onboarding status denied: missing business membership",
        );
        return jsonErrorResponse("Access unavailable. Contact your administrator.", 403);
      }

      const url = new URL(request.url);
      const repoOwner = url.searchParams.get("owner") || null;
      const repoName = url.searchParams.get("repo") || null;
      const githubAppSetupComplete = url.searchParams.get("setup") === "complete";

      const db = assertDatabase(env);
      const steps = await getOnboardingStatus({
        db,
        githubTokenEnv: env,
        userId,
        repoOwner,
        repoName,
        githubAppSetupComplete,
        reposCacheEnv: env.REPOS_CACHE ? { REPOS_CACHE: env.REPOS_CACHE } : null,
      });

      return jsonResponse({ ok: true, steps });
    },
  },
];
