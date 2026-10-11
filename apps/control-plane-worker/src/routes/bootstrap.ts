import { HTTP_HEADER_NAMES } from "../../../../shared/constants/http-headers.js";
import { createLogger } from "../logger";
import { withRouteSpan } from "../observability/route-span";
import { assembleBootstrap } from "../services/bootstrap";
import { UserRowMissingError } from "../settings/db";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

const log = createLogger({ bindings: { component: "bootstrap" } });

export const bootstrapRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/bootstrap"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      if (!auth?.user) {
        return jsonResponse({ authenticated: false });
      }

      return withRouteSpan("bootstrap.assemble", { auth }, async (span) => {
        const payload = await assembleBootstrap(env, request, auth);
        // `repos.list` structured logs don't ship to Datadog; tag the span so the
        // repo-defer rate is measurable for post-deploy verification.
        span.setAttribute("repos.pending", payload.reposPending);
        return jsonResponse(payload);
      }).catch((err) => {
        // Stale KV-cached session for a deleted/renumbered user: fail closed
        // with 401 (client re-auths) instead of a generic 500.
        if (err instanceof UserRowMissingError) {
          log.warn(
            {
              event: "bootstrap_user_row_missing",
              userId: Number(auth.userId),
              requestId: request.headers.get(HTTP_HEADER_NAMES.REQUEST_ID),
            },
            "Bootstrap rejected: no users row for cached session",
          );
          return jsonErrorResponse("Authentication required", 401);
        }
        return jsonErrorResponse("Bootstrap assembly failed", 500);
      });
    },
  },
];
