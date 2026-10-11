import {
  detectSlackAlertAutomationSenders,
  listSlackAlertAutomationSettings,
  removeSlackAlertAutomationRule,
  saveSlackAlertAutomationRule,
  SlackChannelAutomationAdminError,
  updateSlackAlertAutomationRule,
} from "../automation/slack-channel-admin-service";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse } from "../utils";
import type { Route } from "./shared";
import { getRequestSearchParams, parseBody, parsePattern, requireBusinessAdmin } from "./shared";

const CreateAlertRuleBody = z.record(z.string(), z.unknown());
const UpdateAlertRuleBody = z
  .object({
    business_id: z.string().trim().min(1),
    name: z.string().nullable().optional(),
    repo_owner: z.string().optional(),
    repo_name: z.string().optional(),
    model_id: z.string().nullable().optional(),
    prompt_template: z.string().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function renderAdminError(err: unknown): Response {
  if (err instanceof SlackChannelAutomationAdminError) {
    return jsonErrorResponse(err.publicMessage, err.status, { code: err.code, details: err.details });
  }
  throw err;
}

export const slackChannelAutomationRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/slack-channel-automation"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const businessId = getRequestSearchParams(request).get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const rules = await listSlackAlertAutomationSettings(db, businessId);
      return jsonResponse({ ok: true, rules });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/slack-channel-automation/detect-senders"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const params = getRequestSearchParams(request);
      const businessId = params.get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      try {
        const candidates = await detectSlackAlertAutomationSenders(env, {
          businessId,
          teamId: params.get("team_id"),
          channelId: params.get("channel_id"),
          provider: params.get("provider"),
        });
        return jsonResponse({ ok: true, candidates });
      } catch (err) {
        return renderAdminError(err);
      }
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/slack-channel-automation"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const parsedBody = await parseBody(request, CreateAlertRuleBody);
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.value;
      const businessId = optionalString(body.business_id ?? body.businessId);
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      try {
        const rule = await saveSlackAlertAutomationRule(env, {
          callerUserId: auth!.userId,
          businessId,
          teamId: body.team_id ?? body.teamId,
          channelId: body.channel_id ?? body.channelId,
          provider: body.provider,
          appIds: body.app_ids ?? body.appIds,
          botIds: body.bot_ids ?? body.botIds,
          repoOwner: body.repo_owner ?? body.repoOwner,
          repoName: body.repo_name ?? body.repoName,
          modelId: body.model_id ?? body.modelId,
          promptTemplate: body.prompt_template ?? body.promptTemplate,
          name: body.name,
          enabled: body.enabled,
        });
        return jsonResponse({ ok: true, rule });
      } catch (err) {
        return renderAdminError(err);
      }
    },
  },
  {
    method: "PATCH",
    pattern: parsePattern("/api/admin/slack-channel-automation/:ruleId"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const parsedBody = await parseBody(request, UpdateAlertRuleBody);
      if (!parsedBody.ok) return parsedBody.response;
      const body = parsedBody.value;
      const db = assertDatabase(env);
      const guard = await requireBusinessAdmin(db, auth!, body.business_id);
      if (guard) return guard;
      try {
        const rule = await updateSlackAlertAutomationRule(env, {
          callerUserId: auth!.userId,
          businessId: body.business_id,
          ruleId: match.groups!.ruleId,
          name: body.name,
          repoOwner: body.repo_owner,
          repoName: body.repo_name,
          modelId: body.model_id,
          promptTemplate: body.prompt_template,
          enabled: body.enabled,
        });
        return jsonResponse({ ok: true, rule });
      } catch (err) {
        return renderAdminError(err);
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/admin/slack-channel-automation/:ruleId"),
    auth: "authenticated",
    handler: async (request, env, match, auth) => {
      const db = assertDatabase(env);
      const businessId = getRequestSearchParams(request).get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      try {
        await removeSlackAlertAutomationRule(db, { businessId, ruleId: match.groups!.ruleId });
        return jsonResponse({ ok: true });
      } catch (err) {
        return renderAdminError(err);
      }
    },
  },
];
import { z } from "zod";
