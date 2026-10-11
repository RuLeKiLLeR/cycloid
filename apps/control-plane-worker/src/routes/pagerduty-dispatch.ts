import {
  getPagerDutyDispatchInstallationSummary,
  PagerDutyDispatchAdminError,
  removePagerDutyDispatchInstallation,
  savePagerDutyDispatchInstallation,
} from "../automation/pagerduty-dispatch-admin-service";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { Route } from "./shared";
import { getRequestSearchParams, parsePattern, requireBusinessAdmin } from "./shared";

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function renderAdminError(err: unknown): Response {
  if (err instanceof PagerDutyDispatchAdminError) {
    return jsonErrorResponse(err.publicMessage, err.status, { code: err.code, details: err.details });
  }
  throw err;
}

export const pagerDutyDispatchRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/pagerduty-dispatch"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const businessId = getRequestSearchParams(request).get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;

      const installation = await getPagerDutyDispatchInstallationSummary(db, businessId, new URL(request.url).origin);
      return jsonResponse({ ok: true, installation });
    },
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/admin/pagerduty-dispatch"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const body = await parseJsonBody(request);
      if (!body) return jsonErrorResponse("Invalid JSON body", 400);

      const businessId = optionalString(body.business_id ?? body.businessId);
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      if (auth!.authMode !== "user_session") {
        return jsonErrorResponse("A user session is required to configure PagerDuty dispatch", 400);
      }

      try {
        const installation = await savePagerDutyDispatchInstallation(env, {
          callerUserId: auth!.userId,
          businessId,
          repoOwner: body.repo_owner ?? body.repoOwner,
          repoName: body.repo_name ?? body.repoName,
          modelId: body.model_id ?? body.modelId,
          webhookSigningSecret: body.webhook_signing_secret ?? body.webhookSigningSecret,
          rotateToken: body.rotate_token === true || body.rotateToken === true,
          publicBaseUrl: new URL(request.url).origin,
        });
        return jsonResponse({ ok: true, installation });
      } catch (err) {
        return renderAdminError(err);
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/admin/pagerduty-dispatch"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const businessId = getRequestSearchParams(request).get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;

      const result = await removePagerDutyDispatchInstallation(db, businessId);
      return jsonResponse({ ok: true, ...result });
    },
  },
];
