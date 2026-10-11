import { getAutomationRunHistory } from "../automation/run-history-service";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { getRequestSearchParams, parsePattern, requireRouteAuth, type Route } from "./shared";

function decodeCursor(value: string | null): { createdAt: number; id: string; source: string } | null | "invalid" {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      typeof parsed[0] !== "number" ||
      typeof parsed[1] !== "string" ||
      typeof parsed[2] !== "string"
    )
      return "invalid";
    return { createdAt: parsed[0], id: parsed[1], source: parsed[2] };
  } catch {
    return "invalid";
  }
}

function encodeCursor(row: { created_at: number; id: string; source: string }): string {
  return btoa(JSON.stringify([row.created_at, row.id, row.source]));
}

export const automationRunRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/automations/runs"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessId = routeAuth.user?.businessId;
      if (!businessId) return jsonErrorResponse("Business membership is required", 403);
      const cursor = decodeCursor(getRequestSearchParams(request).get("cursor"));
      if (cursor === "invalid") return jsonErrorResponse("Invalid cursor", 400);
      const rows = await getAutomationRunHistory({ db: env.DB, businessId, cursor, limit: 51 });
      const items = rows.slice(0, 50).map((row) => ({
        source: row.source,
        id: row.id,
        ruleId: row.rule_id,
        ruleName: row.rule_name,
        triggerProvider: row.trigger_provider,
        orchestrationStatus: row.phase,
        failureCode: row.failure_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sessionId: row.session_id,
        sessionStatus: row.session_status,
        executionOutcome: row.execution_outcome,
        executionCompletedAt: row.execution_completed_at,
        executionReason: row.execution_reason,
      }));
      return jsonResponse({ ok: true, items, nextCursor: rows.length > 50 ? encodeCursor(rows[49]!) : null });
    },
  },
];
