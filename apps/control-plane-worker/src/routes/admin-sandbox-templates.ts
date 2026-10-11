import { createLogger } from "../logger";
import {
  getCurrentSandboxBaseTemplate,
  registerSandboxBaseTemplates,
  SandboxBaseTemplateError,
} from "../sandbox/base-template-service";
import {
  createSandboxLayerRebuildCampaign,
  getSandboxLayerRebuildCampaign,
  SandboxLayerRebuildCampaignError,
} from "../sandbox/layer-rebuild-campaign-service";
import { E2B_CLOUD_RUNTIME_BACKEND } from "../sandbox/runtime-backend";
import { assertDatabase } from "../session/state";
import type { AuthInfo, Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";
import { parsePattern, requireCycloidAdmin, requireRouteAuth, type Route } from "./shared";

const log = createLogger({ bindings: { component: "admin-sandbox-template-routes" } });

function sandboxBaseErrorResponse(error: SandboxBaseTemplateError): Response {
  return jsonResponse({ ok: false, error: error.message, code: error.code }, error.status);
}

function campaignErrorResponse(error: SandboxLayerRebuildCampaignError): Response {
  return jsonResponse({ ok: false, error: error.message, code: error.code }, error.status);
}

async function handleRegisterBaseTemplates(request: Request, env: Env, auth: AuthInfo | null): Promise<Response> {
  const body = await parseJsonBody(request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonErrorResponse("Invalid JSON body", 400);
  }
  const registeredByKind =
    auth?.authMode === "admin_token" || auth?.authMode === "ci_automation_token" ? "automation" : "admin";
  const registeredByUserId = registeredByKind === "admin" ? Number(auth?.userId) : null;
  try {
    const bases = await registerSandboxBaseTemplates(assertDatabase(env), {
      provider: (body as Record<string, unknown>).provider,
      runtimeBackend: (body as Record<string, unknown>).runtimeBackend,
      bases: (body as Record<string, unknown>).bases,
      capabilities: (body as Record<string, unknown>).capabilities,
      registeredByKind,
      registeredByUserId: Number.isInteger(registeredByUserId) ? registeredByUserId : null,
      nowMs: Date.now(),
    });
    log.info(
      {
        authMode: auth?.authMode ?? null,
        tokenSource: auth?.tokenSource ?? null,
        registeredByKind,
        registeredByUserId: Number.isInteger(registeredByUserId) ? registeredByUserId : null,
        status: "registered",
        count: bases.length,
      },
      "Sandbox base template registration route completed",
    );
    return jsonResponse({
      ok: true,
      bases: bases.map((base) => ({
        id: base.id,
        provider: base.provider,
        runtimeBackend: base.runtime_backend,
        resourceProfileKey: base.resource_profile_key,
        baseTemplateRef: base.base_template_ref,
        baseVersion: base.base_version,
        smokeStatus: base.smoke_status,
        capabilities: base.capabilities,
        contentHash: base.content_hash,
        createdAt: base.created_at,
      })),
    });
  } catch (error) {
    if (error instanceof SandboxBaseTemplateError) return sandboxBaseErrorResponse(error);
    return jsonErrorResponse("Unable to register sandbox base templates", 500);
  }
}

async function handleGetCurrentBaseTemplate(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const resourceProfileKey = url.searchParams.get("resourceProfileKey")?.trim().toLowerCase();
  if (!resourceProfileKey) {
    return jsonResponse({ ok: false, error: "resourceProfileKey is required", code: "invalid_resource_profile" }, 400);
  }
  const runtimeBackend = url.searchParams.get("runtimeBackend")?.trim() || E2B_CLOUD_RUNTIME_BACKEND;
  if (runtimeBackend !== E2B_CLOUD_RUNTIME_BACKEND) {
    return jsonResponse({ ok: false, error: "runtimeBackend must be e2b_cloud", code: "invalid_runtime_backend" }, 400);
  }

  try {
    const base = await getCurrentSandboxBaseTemplate(assertDatabase(env), {
      runtimeBackend,
      resourceProfileKey,
    });
    return jsonResponse({
      ok: true,
      current: base
        ? {
            id: base.id,
            provider: base.provider,
            runtimeBackend: base.runtime_backend,
            resourceProfileKey: base.resource_profile_key,
            baseTemplateRef: base.base_template_ref,
            baseVersion: base.base_version,
            smokeStatus: base.smoke_status,
            capabilities: base.capabilities,
            contentHash: base.content_hash,
            createdAt: base.created_at,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof SandboxBaseTemplateError) return sandboxBaseErrorResponse(error);
    return jsonErrorResponse("Unable to load current sandbox base template", 500);
  }
}

export const adminSandboxTemplateRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/admin/sandbox-base-templates/current"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      if (routeAuth.authMode !== "admin_token" && routeAuth.authMode !== "ci_automation_token") {
        const guard = await requireCycloidAdmin(env, routeAuth, {
          logger: log,
          logContext: { route: "sandbox_base_templates_current" },
        });
        if (guard) return guard;
      }
      return handleGetCurrentBaseTemplate(request, env);
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/sandbox-base-templates/register"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      if (routeAuth.authMode !== "admin_token" && routeAuth.authMode !== "ci_automation_token") {
        const guard = await requireCycloidAdmin(env, routeAuth, {
          logger: log,
          logContext: { route: "sandbox_base_templates_register" },
        });
        if (guard) return guard;
      }
      return handleRegisterBaseTemplates(request, env, routeAuth);
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/admin/sandbox-layer/rebuild-campaigns"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const guard = await requireCycloidAdmin(env, routeAuth, {
        allowNonUserSession: true,
        logger: log,
        logContext: { route: "sandbox_layer_rebuild_campaigns_create" },
      });
      if (guard) return guard;
      const body = await parseJsonBody(request);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return jsonErrorResponse("Invalid JSON body", 400);
      }
      const record = body as Record<string, unknown>;
      try {
        const details = await createSandboxLayerRebuildCampaign(env, routeAuth, {
          scope: record.scope,
          businessId: record.businessId,
          reason: record.reason,
          dryRun: record.dryRun,
          processInline: record.dryRun === true,
        });
        return jsonResponse({ ok: true, ...details });
      } catch (error) {
        if (error instanceof SandboxLayerRebuildCampaignError) return campaignErrorResponse(error);
        return jsonErrorResponse("Unable to create sandbox layer rebuild campaign", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: parsePattern("/api/admin/sandbox-layer/rebuild-campaigns/:id"),
    auth: "authenticated",
    handler: async (_request, env, match, auth) => {
      const routeAuth = requireRouteAuth(auth);
      const guard = await requireCycloidAdmin(env, routeAuth, {
        allowNonUserSession: true,
        logger: log,
        logContext: { route: "sandbox_layer_rebuild_campaigns_get" },
      });
      if (guard) return guard;
      try {
        const details = await getSandboxLayerRebuildCampaign(assertDatabase(env), match.groups!.id);
        return jsonResponse({ ok: true, ...details });
      } catch (error) {
        if (error instanceof SandboxLayerRebuildCampaignError) return campaignErrorResponse(error);
        return jsonErrorResponse("Unable to load sandbox layer rebuild campaign", 500);
      }
    },
  },
];
