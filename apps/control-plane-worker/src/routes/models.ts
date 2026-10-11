import { PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS } from "../../../../shared/constants/models.js";
import { withRouteSpan } from "../observability/route-span";
import { buildAndCacheModelsWithMetadata, toBootstrapModelGroup } from "../services/bootstrap";
import type { AuthInfo, Env } from "../types";
import { jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

async function handleModels(
  env: Env,
  auth: AuthInfo,
): Promise<{ response: Response; cacheStatus: string; rowCount?: number }> {
  const userId = Number(auth.userId);
  if (userId && Number.isFinite(userId)) {
    const result = await buildAndCacheModelsWithMetadata(env, userId);
    const response = jsonResponse(result.models);
    response.headers.set("cache-control", "private, max-age=60");
    return {
      response,
      cacheStatus: result.cacheStatus,
      rowCount: result.cacheStatus === "miss" ? result.models.length : undefined,
    };
  }
  const models = PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS.map(toBootstrapModelGroup);
  return { response: jsonResponse(models), cacheStatus: "n/a" };
}

export const modelRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/models"),
    auth: "authenticated",
    handler: async (_req, env, _match, auth) =>
      withRouteSpan("models.list", { auth: auth! }, async (span) => {
        const result = await handleModels(env, auth!);
        span.setAttribute("cache.status", result.cacheStatus);
        span.setAttribute("db.rows_returned", result.rowCount);
        return result.response;
      }),
  },
];
