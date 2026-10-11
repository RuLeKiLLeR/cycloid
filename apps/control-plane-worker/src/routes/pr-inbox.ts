import {
  isPrInboxBucket,
  isPrInboxLaneFilter,
  PR_INBOX_MAX_SEARCH_LENGTH,
  PR_INBOX_MAX_SEARCH_TERMS,
} from "../constants/control-room";
import { createLogger } from "../logger";
import { verifyCycloidMember } from "../services/internal-feature-gate";
import { listPrInbox } from "../services/pr-inbox";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { getRequestSearchParams, getTrimmedQueryParam, parsePattern, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "pr-inbox-route" } });

function normalizeRepoSlug(value: string | null): string | null {
  if (!value) return null;
  let slug = value.trim().toLowerCase();
  slug = slug.replace(/^https?:\/\/github\.com\//, "").replace(/^git@github\.com:/, "");
  slug = slug.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  return slug.length > 0 ? slug.slice(0, 160) : null;
}

export const prInboxRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/pr-inbox"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);

      // Internal-only surface: fail closed before any service work.
      if (!(await verifyCycloidMember(env.DB, auth))) {
        return jsonErrorResponse("Forbidden", 403);
      }

      const params = getRequestSearchParams(request);

      const bucketParam = getTrimmedQueryParam(params, "bucket");
      if (bucketParam !== null && !isPrInboxBucket(bucketParam)) {
        return jsonErrorResponse("Invalid bucket filter", 400);
      }

      const laneParam = getTrimmedQueryParam(params, "lane");
      if (laneParam !== null && !isPrInboxLaneFilter(laneParam)) {
        return jsonErrorResponse("Invalid lane filter", 400);
      }

      const searchParam = getTrimmedQueryParam(params, "search");
      if (searchParam !== null && searchParam.length > PR_INBOX_MAX_SEARCH_LENGTH) {
        return jsonErrorResponse("Search filter is too long", 400);
      }
      if (searchParam !== null && searchParam.split(/\s+/).length > PR_INBOX_MAX_SEARCH_TERMS) {
        return jsonErrorResponse("Search filter has too many terms", 400);
      }

      const rawLimit = getTrimmedQueryParam(params, "limit");
      let limit: number | null = null;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isFinite(parsed) || parsed <= 0) return jsonErrorResponse("Invalid limit", 400);
        limit = Math.floor(parsed);
      }

      const db = assertDatabase(env);
      try {
        const page = await listPrInbox(db, {
          auth: routeAuth,
          repoSlug: normalizeRepoSlug(getTrimmedQueryParam(params, "repo")),
          bucket: bucketParam,
          lane: laneParam,
          search: searchParam,
          cursor: getTrimmedQueryParam(params, "cursor"),
          limit,
        });
        return jsonResponse({ ok: true, data: page });
      } catch (err) {
        log.error({ userId: routeAuth.userId, error: String(err) }, "pr_inbox_list_unexpected_error");
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
];
