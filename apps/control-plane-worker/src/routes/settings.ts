import { withRouteSpan } from "../observability/route-span";
import {
  handleDeleteApiKey,
  handleDeleteCodexSubscriptionAuthJson,
  handleGetCodexSubscription,
  handleGetOpenAIUsage,
  handleGetPrReviewBotSettings,
  handleGetSettings,
  handleListPrReviewBotSettings,
  handlePutApiKey,
  handlePutCodexSubscriptionAuthJson,
  handlePutCodexSubscriptionEnabled,
  handlePutPrReviewBotSettings,
  handlePutSettings,
  handleValidateApiKey,
} from "../settings/routes";
import type { Route } from "./shared";
import { parsePattern } from "./shared";

export const settingsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/api/settings"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) =>
      withRouteSpan("settings.get", { auth: auth! }, async () => handleGetSettings(request, env, auth!)),
  },

  {
    method: "GET",
    pattern: parsePattern("/api/settings/repositories/pr-review-bots"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) =>
      withRouteSpan("settings.pr_review_bots.list", { auth: auth! }, async () =>
        handleListPrReviewBotSettings(request, env, auth!),
      ),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/settings/repositories/:owner/:repo/pr-review-bots"),
    auth: "authenticated",
    handler: async (request, env, match, auth) =>
      withRouteSpan("settings.pr_review_bots.get", { auth: auth! }, async () =>
        handleGetPrReviewBotSettings(request, env, auth!, match.groups!.owner, match.groups!.repo),
      ),
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/settings/repositories/:owner/:repo/pr-review-bots"),
    auth: "authenticated",
    handler: async (request, env, match, auth) =>
      withRouteSpan("settings.pr_review_bots.put", { auth: auth! }, async () =>
        handlePutPrReviewBotSettings(request, env, auth!, match.groups!.owner, match.groups!.repo),
      ),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/settings/codex-subscription"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) =>
      withRouteSpan("settings.codex_subscription.get", { auth: auth! }, async () =>
        handleGetCodexSubscription(env, auth!),
      ),
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/settings/codex-subscription/auth-json"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) =>
      withRouteSpan("settings.codex_subscription.put", { auth: auth! }, async () =>
        handlePutCodexSubscriptionAuthJson(request, env, auth!),
      ),
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/settings/codex-subscription/auth-json"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) =>
      withRouteSpan("settings.codex_subscription.delete", { auth: auth! }, async () =>
        handleDeleteCodexSubscriptionAuthJson(env, auth!),
      ),
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/settings/codex-subscription/enabled"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) =>
      withRouteSpan("settings.codex_subscription.enabled", { auth: auth! }, async () =>
        handlePutCodexSubscriptionEnabled(request, env, auth!),
      ),
  },
  {
    method: "GET",
    pattern: parsePattern("/api/settings/openai-usage"),
    auth: "authenticated",
    handler: async (_request, env, _match, auth) =>
      withRouteSpan("settings.openai_usage.get", { auth: auth! }, async () => handleGetOpenAIUsage(env, auth!)),
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/settings"),
    auth: "authenticated",
    handler: async (request, env, _match, auth) =>
      withRouteSpan("settings.put", { auth: auth! }, async () => handlePutSettings(request, env, auth!)),
  },
  {
    method: "PUT",
    pattern: parsePattern("/api/settings/api-keys/:provider"),
    auth: "authenticated",
    handler: async (request, env, match, auth) =>
      withRouteSpan("settings.api_key.put", { auth: auth! }, async () =>
        handlePutApiKey(request, env, auth!, match.groups!.provider),
      ),
  },
  {
    method: "POST",
    pattern: parsePattern("/api/settings/api-keys/:provider/validate"),
    auth: "authenticated",
    handler: async (request, env, match, auth) =>
      withRouteSpan("settings.api_key.validate", { auth: auth! }, async () =>
        handleValidateApiKey(request, env, auth!, match.groups!.provider),
      ),
  },
  {
    method: "DELETE",
    pattern: parsePattern("/api/settings/api-keys/:provider"),
    auth: "authenticated",
    handler: async (_req, env, match, auth) =>
      withRouteSpan("settings.api_key.delete", { auth: auth! }, async () =>
        handleDeleteApiKey(env, auth!, match.groups!.provider),
      ),
  },
];
