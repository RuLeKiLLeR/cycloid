import { z } from "zod";

import {
  createGithubCheckAutomationRule,
  deleteGithubCheckAutomationRule,
  GithubCheckAutomationError,
  listGithubCheckRules,
  patchGithubCheckAutomationRule,
} from "../automation/github-check-service";
import { jsonErrorResponse, jsonResponse } from "../utils";
import { parseBody, parsePattern, requireBusinessAdmin, requireRouteAuth, type Route } from "./shared";

const CreateBody = z
  .object({
    repoOwner: z.string(),
    repoName: z.string(),
    checkName: z.string().nullable().default(null),
    modelId: z.string().nullable().default(null),
    promptTemplate: z.string(),
    name: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict();
export const GithubCheckAutomationPatchBody = z
  .object({
    checkName: z.string().nullable(),
    modelId: z.string().nullable(),
    promptTemplate: z.string(),
    name: z.string().nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();
function shape(rule: Awaited<ReturnType<typeof createGithubCheckAutomationRule>>) {
  return {
    id: rule.id,
    triggerKind: "github_check_failure" as const,
    repoOwner: rule.repoOwner,
    repoName: rule.repoName,
    checkName: rule.checkName,
    modelId: rule.modelId,
    promptTemplate: rule.promptTemplate,
    name: rule.name,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}
function render(error: unknown) {
  return error instanceof GithubCheckAutomationError
    ? jsonErrorResponse(error.publicMessage, error.status, { code: error.code })
    : jsonErrorResponse("Internal server error", 500);
}
export const githubCheckAutomationRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/automations/github-checks"),
    auth: "authenticated",
    handler: async (_r, env, _m, auth) => {
      const a = requireRouteAuth(auth);
      const b = a.user?.businessId;
      if (!b) return jsonErrorResponse("Business membership required", 403);
      return jsonResponse({ ok: true, items: (await listGithubCheckRules(env.DB, b)).map(shape) });
    },
  },
  {
    method: "POST",
    pattern: parsePattern("/api/automations/github-checks"),
    auth: "authenticated",
    handler: async (r, env, _m, auth) => {
      const a = requireRouteAuth(auth);
      const b = a.user?.businessId;
      if (!b) return jsonErrorResponse("Business membership required", 403);
      const guard = await requireBusinessAdmin(env.DB, a, b);
      if (guard) return guard;
      const parsed = await parseBody(r, CreateBody);
      if (!parsed.ok) return parsed.response;
      try {
        return jsonResponse(
          {
            ok: true,
            data: shape(
              await createGithubCheckAutomationRule(env, { businessId: b, userId: a.userId, ...parsed.value }),
            ),
          },
          201,
        );
      } catch (e) {
        return render(e);
      }
    },
  },
  {
    method: "PATCH",
    pattern: parsePattern("/api/automations/github-checks/:id"),
    auth: "authenticated",
    handler: async (r, env, m, auth) => {
      const a = requireRouteAuth(auth);
      const b = a.user?.businessId;
      if (!b) return jsonErrorResponse("Business membership required", 403);
      const guard = await requireBusinessAdmin(env.DB, a, b);
      if (guard) return guard;
      const parsed = await parseBody(r, GithubCheckAutomationPatchBody);
      if (!parsed.ok) return parsed.response;
      try {
        return jsonResponse({
          ok: true,
          data: shape(await patchGithubCheckAutomationRule(env, { businessId: b, id: m.groups!.id, ...parsed.value })),
        });
      } catch (e) {
        return render(e);
      }
    },
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/automations/github-checks/:id"),
    auth: "authenticated",
    handler: async (_r, env, m, auth) => {
      const a = requireRouteAuth(auth);
      const b = a.user?.businessId;
      if (!b) return jsonErrorResponse("Business membership required", 403);
      const guard = await requireBusinessAdmin(env.DB, a, b);
      if (guard) return guard;
      try {
        await deleteGithubCheckAutomationRule(env, b, m.groups!.id);
        return new Response(null, { status: 204 });
      } catch (e) {
        return render(e);
      }
    },
  },
];
