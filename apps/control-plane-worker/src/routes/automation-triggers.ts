import { listConnectedTriggers } from "../automation/connected-triggers-service";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { parsePattern, requireRouteAuth, type Route } from "./shared";

export const automationTriggerRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/automations/connected-triggers"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessId = routeAuth.user?.businessId;
      const userId = Number(routeAuth.userId);
      if (!businessId || !Number.isFinite(userId)) return jsonErrorResponse("Business membership is required", 403);
      const triggers = await listConnectedTriggers({
        db: env.DB,
        businessId,
        userId,
        publicBaseUrl: new URL(request.url).origin,
      });
      return jsonResponse({ ok: true, triggers });
    },
  },
];
