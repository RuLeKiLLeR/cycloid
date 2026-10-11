import { z } from "zod";

import type { ScheduledRule } from "../automation/db";
import {
  canManageScheduledRule,
  createScheduledRule,
  deleteScheduledRule,
  duplicateScheduledRule,
  listScheduledRuleRunsForBusiness,
  listScheduledRulesForBusiness,
  runScheduledRuleNow,
  ScheduledRuleServiceError,
  setScheduledRuleEnabled,
  updateScheduledRule,
} from "../automation/service";
import { canAdministerCompanyMemory } from "../company-memory/admin-auth";
import { AUTOMATION_RUNS_MAX_LIMIT } from "../constants/automation";
import { createLogger } from "../logger";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { paginateQueryFromRequest, parseBody, parsePattern, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "automation-schedules-route" } });

function requiredStringField(field: string) {
  return z.unknown().transform((value, ctx) => {
    if (value === undefined) return "";
    if (typeof value !== "string") {
      ctx.addIssue({ code: "custom", message: `${field} must be a string` });
      return z.NEVER;
    }
    return value;
  });
}

function optionalNullableStringField(field: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") {
        ctx.addIssue({ code: "custom", message: `${field} must be a string or null` });
        return z.NEVER;
      }
      return value;
    });
}

const CreateAutomationScheduleBodySchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    repoOwner: requiredStringField("repoOwner"),
    repoName: requiredStringField("repoName"),
    cron: requiredStringField("cron"),
    prompt: requiredStringField("prompt"),
    name: optionalNullableStringField("name"),
    slackTeamId: optionalNullableStringField("slackTeamId"),
    slackChannelId: optionalNullableStringField("slackChannelId"),
    modelId: optionalNullableStringField("modelId"),
  }),
);

const AutomationSchedulePatchBodySchema = z.record(z.string(), z.unknown());

function toApiShape(rule: ScheduledRule, canManage: boolean): Record<string, unknown> {
  return {
    id: rule.id,
    businessId: rule.businessId,
    configuredByUserId: rule.configuredByUserId,
    repoOwner: rule.repoOwner,
    repoName: rule.repoName,
    installationId: rule.installationId,
    modelId: rule.modelId,
    promptTemplate: rule.promptTemplate,
    cron: rule.cronExpression,
    normalizedCron: rule.normalizedCron,
    name: rule.name,
    enabled: rule.enabled,
    nextFireAt: rule.nextFireAt,
    lastEnqueuedAt: rule.lastEnqueuedAt,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    slackTeamId: rule.slackTeamId,
    slackChannelId: rule.slackChannelId,
    lastDeliveredAt: rule.lastDeliveredAt,
    lastDeliveryError: rule.lastDeliveryError,
    canManage,
    canDelete: canManage,
  };
}

function requireBusinessId(auth: ReturnType<typeof requireRouteAuth>): Response | string {
  const businessId = auth.user?.businessId ?? null;
  if (!businessId) {
    return jsonErrorResponse("Business membership required", 403);
  }
  return businessId;
}

export const automationScheduleRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/automation/schedules"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;

      const parsedBody = await parseBody(request, CreateAutomationScheduleBodySchema);
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.value;

      try {
        const rule = await createScheduledRule(env, {
          callerUserId: routeAuth.userId,
          businessId,
          repoOwner: body.repoOwner,
          repoName: body.repoName,
          cron: body.cron,
          prompt: body.prompt,
          name: body.name,
          slackTeamId: body.slackTeamId,
          slackChannelId: body.slackChannelId,
          modelId: body.modelId,
        });
        // The creator can always delete their own rule.
        return jsonResponse({ ok: true, data: toApiShape(rule, true) }, 201);
      } catch (err) {
        if (err instanceof ScheduledRuleServiceError) {
          return jsonResponse({ ok: false, error: err.code, message: err.publicMessage }, err.status);
        }
        log.error(
          { businessId, userId: routeAuth.userId, error: String(err) },
          "automation_schedule_create_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/automation/schedules"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;

      const { cursor, limit } = paginateQueryFromRequest(request, 100);
      try {
        const requesterIsBusinessAdmin = await canAdministerCompanyMemory(env.DB, routeAuth, businessId);
        const result = await listScheduledRulesForBusiness(env, {
          businessId,
          cursor,
          limit: limit ?? null,
        });
        return jsonResponse({
          ok: true,
          data: {
            items: result.items.map((rule) =>
              toApiShape(rule, canManageScheduledRule(rule, routeAuth.userId, requesterIsBusinessAdmin)),
            ),
            nextCursor: result.nextCursor,
          },
        });
      } catch (err) {
        log.error(
          { businessId, userId: routeAuth.userId, error: String(err) },
          "automation_schedule_list_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
  {
    method: "PATCH",
    pattern: parsePattern("/api/automation/schedules/:id"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;
      const ruleId = match.groups?.id ?? "";
      const parsedBody = await parseBody(request, AutomationSchedulePatchBodySchema);
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.value;

      try {
        const requesterIsBusinessAdmin = await canAdministerCompanyMemory(env.DB, routeAuth, businessId);
        if (typeof body.enabled === "boolean") {
          const updateFields = ["cron", "prompt", "name", "slackTeamId", "slackChannelId"];
          if (updateFields.some((field) => body[field] !== undefined)) {
            return jsonResponse(
              { ok: false, error: "invalid_request", message: "enabled cannot be changed with other fields" },
              400,
            );
          }
          const rule = await setScheduledRuleEnabled(env, {
            callerUserId: routeAuth.userId,
            businessId,
            ruleId,
            requesterIsBusinessAdmin,
            enabled: body.enabled,
          });
          return jsonResponse({ ok: true, data: toApiShape(rule, true) });
        }

        // Partial PATCH: absent fields keep their stored values; nullable
        // fields (name, Slack target) clear on explicit null. Present fields
        // must carry the right type — no silent coercion into a full replace.
        const updateFields = ["cron", "prompt", "name", "slackTeamId", "slackChannelId"] as const;
        if (updateFields.every((field) => body[field] === undefined)) {
          return jsonResponse({ ok: false, error: "invalid_request", message: "no updatable fields provided" }, 400);
        }
        if (body.cron !== undefined && typeof body.cron !== "string") {
          return jsonResponse({ ok: false, error: "invalid_cron", message: "cron must be a string" }, 400);
        }
        if (body.prompt !== undefined && typeof body.prompt !== "string") {
          return jsonResponse({ ok: false, error: "invalid_prompt", message: "prompt must be a string" }, 400);
        }
        if (body.name !== undefined && body.name !== null && typeof body.name !== "string") {
          return jsonResponse({ ok: false, error: "invalid_name", message: "name must be a string or null" }, 400);
        }
        for (const field of ["slackTeamId", "slackChannelId"] as const) {
          if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
            return jsonResponse(
              { ok: false, error: "invalid_slack_target", message: `${field} must be a string or null` },
              400,
            );
          }
        }
        const rule = await updateScheduledRule(env, {
          callerUserId: routeAuth.userId,
          businessId,
          ruleId,
          requesterIsBusinessAdmin,
          cron: body.cron as string | undefined,
          prompt: body.prompt as string | undefined,
          name: body.name as string | null | undefined,
          slackTeamId: body.slackTeamId as string | null | undefined,
          slackChannelId: body.slackChannelId as string | null | undefined,
        });
        return jsonResponse({ ok: true, data: toApiShape(rule, true) });
      } catch (err) {
        if (err instanceof ScheduledRuleServiceError) {
          return jsonResponse({ ok: false, error: err.code, message: err.publicMessage }, err.status);
        }
        log.error(
          { businessId, userId: routeAuth.userId, ruleId, error: String(err) },
          "automation_schedule_update_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/automation/schedules/:id/duplicate"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;
      const ruleId = match.groups?.id ?? "";
      try {
        const requesterIsBusinessAdmin = await canAdministerCompanyMemory(env.DB, routeAuth, businessId);
        const rule = await duplicateScheduledRule(env, {
          callerUserId: routeAuth.userId,
          businessId,
          ruleId,
          requesterIsBusinessAdmin,
        });
        return jsonResponse({ ok: true, data: toApiShape(rule, true) }, 201);
      } catch (err) {
        if (err instanceof ScheduledRuleServiceError) {
          return jsonResponse({ ok: false, error: err.code, message: err.publicMessage }, err.status);
        }
        log.error(
          { businessId, userId: routeAuth.userId, ruleId, error: String(err) },
          "automation_schedule_duplicate_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/automation/schedules/:id/run-now"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;
      const ruleId = match.groups?.id ?? "";
      try {
        const requesterIsBusinessAdmin = await canAdministerCompanyMemory(env.DB, routeAuth, businessId);
        const job = await runScheduledRuleNow(env, {
          callerUserId: routeAuth.userId,
          businessId,
          ruleId,
          requesterIsBusinessAdmin,
        });
        return jsonResponse({
          ok: true,
          data: {
            jobKey: job.jobKey,
            sessionId: job.sessionId,
            phase: job.phase,
            outcome: job.terminalOutcome,
            failureReason: job.failureReason,
          },
        });
      } catch (err) {
        if (err instanceof ScheduledRuleServiceError) {
          return jsonResponse({ ok: false, error: err.code, message: err.publicMessage }, err.status);
        }
        log.error(
          { businessId, userId: routeAuth.userId, ruleId, error: String(err) },
          "automation_schedule_run_now_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/automation/schedules/:id/runs"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;
      const ruleId = match.groups?.id ?? "";

      const { cursor, limit } = paginateQueryFromRequest(request, AUTOMATION_RUNS_MAX_LIMIT);
      try {
        const result = await listScheduledRuleRunsForBusiness(env, {
          businessId,
          ruleId,
          cursor,
          limit: limit ?? null,
        });
        return jsonResponse({ ok: true, data: result });
      } catch (err) {
        if (err instanceof ScheduledRuleServiceError) {
          return jsonResponse({ ok: false, error: err.code, message: err.publicMessage }, err.status);
        }
        log.error(
          { businessId, userId: routeAuth.userId, ruleId, error: String(err) },
          "automation_schedule_runs_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/automation/schedules/:id"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const businessIdOrResponse = requireBusinessId(routeAuth);
      if (typeof businessIdOrResponse !== "string") return businessIdOrResponse;
      const businessId = businessIdOrResponse;
      const ruleId = match.groups?.id ?? "";

      try {
        const requesterIsBusinessAdmin = await canAdministerCompanyMemory(env.DB, routeAuth, businessId);
        await deleteScheduledRule(env, {
          callerUserId: routeAuth.userId,
          businessId,
          ruleId,
          requesterIsBusinessAdmin,
        });
        return new Response(null, { status: 204 });
      } catch (err) {
        if (err instanceof ScheduledRuleServiceError) {
          return jsonResponse({ ok: false, error: err.code, message: err.publicMessage }, err.status);
        }
        log.error(
          { businessId, userId: routeAuth.userId, ruleId, error: String(err) },
          "automation_schedule_delete_unexpected_error",
        );
        return jsonErrorResponse("Internal server error", 500);
      }
    },
  },
];
