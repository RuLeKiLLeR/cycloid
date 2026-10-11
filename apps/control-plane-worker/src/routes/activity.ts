import { ACTIVITY_DEFAULT_WINDOW_DAYS, type ActivityWindowDays, isActivityWindowDays } from "../constants/control-room";
import { createLogger } from "../logger";
import { getActivity } from "../services/activity";
import { verifyCycloidMember } from "../services/internal-feature-gate";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { getRequestSearchParams, getTrimmedQueryParam, parsePattern, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "activity-route" } });

export const activityRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/activity"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);

      // Internal-only surface: the Activity page is gated to the Cycloid
      // business. Fail closed here — the UI capability (canUseControlRoom)
      // is exposure control only, not a security boundary.
      if (!(await verifyCycloidMember(env.DB, auth))) {
        return jsonErrorResponse("Forbidden", 403);
      }

      const params = getRequestSearchParams(request);

      let windowDays: ActivityWindowDays = ACTIVITY_DEFAULT_WINDOW_DAYS;
      const rawWindow = getTrimmedQueryParam(params, "windowDays");
      if (rawWindow !== null) {
        const parsed = Number(rawWindow);
        if (!Number.isFinite(parsed) || !isActivityWindowDays(parsed)) {
          return jsonErrorResponse("Invalid windowDays (allowed: 7, 30)", 400);
        }
        windowDays = parsed;
      }

      const rawScope = getTrimmedQueryParam(params, "scope") ?? "user";
      if (rawScope !== "user" && rawScope !== "organization") {
        return jsonErrorResponse("Invalid scope (allowed: user, organization)", 400);
      }
      if (rawScope === "organization" && routeAuth.user?.businessRole !== "admin") {
        return jsonErrorResponse("Organization activity requires business admin access", 403);
      }
      if (!routeAuth.user?.businessId) {
        return jsonErrorResponse("Business membership required", 403);
      }

      const db = assertDatabase(env);
      try {
        const summary = await getActivity(db, { auth: routeAuth, windowDays, scope: rawScope });
        return jsonResponse({ ok: true, data: summary });
      } catch (err) {
        log.error({ userId: routeAuth.userId, error: String(err) }, "activity_get_unexpected_error");
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
];
