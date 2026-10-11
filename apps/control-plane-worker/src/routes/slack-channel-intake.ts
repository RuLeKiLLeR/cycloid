import {
  disableSlackChannelMemoryIntake,
  getSlackChannelMemorySettings,
  getSlackWorkspaceMemoryChannels,
  saveSlackChannelMemoryIntake,
} from "../company-memory/slack-channel-intake-service";
import { COMPANY_MEMORY_CHANNEL_SCOPE_TYPES, type CompanyMemoryChannelScopeType } from "../constants/company-memory";
import { assertDatabase } from "../session/state";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import type { Route } from "./shared";
import { getRequestSearchParams, parsePattern, requireBusinessAdmin } from "./shared";

const SCOPE_TYPE_SET = new Set<string>(COMPANY_MEMORY_CHANNEL_SCOPE_TYPES);

// Every channel scope type except "generic" resolves to a bucket keyed by scope_id
// downstream (customer slug, incident id, etc.). Without a scope_id those memories fall
// through to the business/slack_thread fallback and can never be retrieved by their
// intended scope, so the API must reject them the way the UI already does.
const SCOPE_TYPES_REQUIRING_SCOPE_ID = new Set<string>(
  COMPANY_MEMORY_CHANNEL_SCOPE_TYPES.filter((type) => type !== "generic"),
);

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const slackChannelIntakeRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/slack-channel-intake"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const businessId = getRequestSearchParams(request).get("business_id")?.trim();
      if (!businessId) return jsonErrorResponse("business_id is required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const settings = await getSlackChannelMemorySettings(db, businessId);
      return jsonResponse({ ok: true, ...settings });
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/slack-channel-intake/channels"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const params = getRequestSearchParams(request);
      const businessId = params.get("business_id")?.trim();
      const teamId = params.get("team_id")?.trim();
      if (!businessId || !teamId) return jsonErrorResponse("business_id and team_id are required", 400);
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      const channels = await getSlackWorkspaceMemoryChannels(db, {
        businessId,
        teamId,
        tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
      });
      return jsonResponse({ ok: true, channels });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/slack-channel-intake"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const db = assertDatabase(env);
      const body = await parseJsonBody(request);
      if (!body) return jsonErrorResponse("Invalid JSON body", 400);
      const businessId = optionalString(body.business_id ?? body.businessId);
      const teamId = optionalString(body.team_id ?? body.teamId);
      const channelId = optionalString(body.channel_id ?? body.channelId);
      const scopeType = optionalString(body.scope_type ?? body.scopeType);
      const scopeId = optionalString(body.scope_id ?? body.scopeId);
      const enabled = body.enabled !== false;
      if (!businessId || !teamId || !channelId) {
        return jsonErrorResponse("business_id, team_id, and channel_id are required", 400);
      }
      const guard = await requireBusinessAdmin(db, auth!, businessId);
      if (guard) return guard;
      if (!enabled) {
        await disableSlackChannelMemoryIntake(db, { businessId, teamId, channelId });
        return jsonResponse({ ok: true, enabled: false });
      }
      if (!scopeType || !SCOPE_TYPE_SET.has(scopeType)) return jsonErrorResponse("Invalid scope_type", 400);
      if (SCOPE_TYPES_REQUIRING_SCOPE_ID.has(scopeType) && !scopeId) {
        return jsonErrorResponse("scope_id is required for non-generic scope types", 400);
      }
      const userId = Number(auth!.userId);
      const row = await saveSlackChannelMemoryIntake(db, {
        businessId,
        teamId,
        channelId,
        scopeType: scopeType as CompanyMemoryChannelScopeType,
        scopeId,
        enabledByUserId: Number.isSafeInteger(userId) ? userId : null,
      });
      return jsonResponse({ ok: true, intake: row });
    },
  },
];
