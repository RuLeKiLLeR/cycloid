import type { ProviderApiKeyState } from "../../../../shared/constants/onboarding";
import type { PrReviewExpectedBot } from "../../../../shared/constants/pr-review-bots";
import type { OpenAIGatewayUsage, UserSettings, UserSettingsUpdate } from "../types";
import { apiCacheKeys, invalidate, swr } from "./cache";
import { JSON_HEADERS, requestJson } from "./client";

export async function fetchSettings(options?: { scope?: "full" }): Promise<UserSettings> {
  // NOTE: route-coverage test parses this fetch path statically -- keep string literals in requestJson calls
  if (options?.scope === "full") {
    const result = await swr(
      apiCacheKeys.settings(options),
      () => requestJson<UserSettings>("/api/settings?scope=full", undefined, "Failed to fetch settings"),
      { staleMs: 30_000 },
    );
    return result.value;
  }
  const result = await swr(
    apiCacheKeys.settings(options),
    () => requestJson<UserSettings>("/api/settings", undefined, "Failed to fetch settings"),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function updateSettings(settings: UserSettingsUpdate): Promise<UserSettings> {
  const result = await requestJson<UserSettings>(
    "/api/settings",
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(settings),
    },
    "Failed to update settings",
  );
  invalidate(apiCacheKeys.settings());
  invalidate(apiCacheKeys.bootstrap());
  return result;
}

export async function setProviderApiKey(provider: string, apiKey: string): Promise<ProviderApiKeyState> {
  const result = await requestJson<ProviderApiKeyState>(
    `/api/settings/api-keys/${provider}`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ apiKey }),
    },
    "Failed to set API key",
  );
  invalidate(apiCacheKeys.models());
  invalidate(apiCacheKeys.settings());
  invalidate(apiCacheKeys.bootstrap());
  return result;
}

export async function clearProviderApiKey(provider: string): Promise<ProviderApiKeyState> {
  const result = await requestJson<ProviderApiKeyState>(
    `/api/settings/api-keys/${provider}`,
    { method: "DELETE" },
    "Failed to clear API key",
  );
  invalidate(apiCacheKeys.models());
  invalidate(apiCacheKeys.settings());
  invalidate(apiCacheKeys.bootstrap());
  return result;
}

export type CodexSubscriptionState = {
  eligible: boolean;
  credential: ProviderApiKeyState;
};

export async function fetchCodexSubscriptionState(): Promise<CodexSubscriptionState> {
  return requestJson<CodexSubscriptionState>(
    "/api/settings/codex-subscription",
    undefined,
    "Failed to fetch Codex subscription auth state",
  );
}

export async function setCodexSubscriptionAuthJson(authJson: string): Promise<ProviderApiKeyState> {
  const result = await requestJson<ProviderApiKeyState>(
    "/api/settings/codex-subscription/auth-json",
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ authJson }),
    },
    "Failed to save Codex auth.json",
  );
  invalidate(apiCacheKeys.models());
  invalidate(apiCacheKeys.settings());
  invalidate(apiCacheKeys.bootstrap());
  return result;
}

export async function clearCodexSubscriptionAuthJson(): Promise<ProviderApiKeyState> {
  const result = await requestJson<ProviderApiKeyState>(
    "/api/settings/codex-subscription/auth-json",
    { method: "DELETE" },
    "Failed to clear Codex auth.json",
  );
  invalidate(apiCacheKeys.models());
  invalidate(apiCacheKeys.settings());
  invalidate(apiCacheKeys.bootstrap());
  return result;
}

export async function fetchOpenAIGatewayUsage(): Promise<OpenAIGatewayUsage> {
  const result = await swr(
    apiCacheKeys.openAiUsage(),
    () =>
      requestJson<OpenAIGatewayUsage>("/api/settings/openai-usage", undefined, "Failed to fetch OpenAI gateway usage"),
    { staleMs: 30_000 },
  );
  return result.value;
}

type PrReviewBotSettingsResponse = {
  expectedBots: PrReviewExpectedBot[];
  mergeConflictResolutionEnabled: boolean;
};

export type PrReviewBotSettingsListResponse = {
  repositories: Array<{
    repoOwner: string;
    repoName: string;
    expectedBots: PrReviewExpectedBot[];
    mergeConflictResolutionEnabled: boolean;
  }>;
  nextCursor: string | null;
};

export async function fetchPrReviewBotSettings(owner: string, repo: string): Promise<PrReviewBotSettingsResponse> {
  return requestJson<PrReviewBotSettingsResponse>(
    `/api/settings/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pr-review-bots`,
    undefined,
    "Failed to fetch PR review bot settings",
  );
}

export async function updatePrReviewBotSettings(
  owner: string,
  repo: string,
  input: {
    expectedBots: PrReviewExpectedBot[];
    mergeConflictResolutionEnabled: boolean;
  },
): Promise<PrReviewBotSettingsResponse> {
  const result = await requestJson<PrReviewBotSettingsResponse>(
    `/api/settings/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pr-review-bots`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
    "Failed to update PR review bot settings",
  );
  invalidate(apiCacheKeys.settings({ scope: "full" }));
  return result;
}

export async function listPrReviewBotSettings(cursor?: string | null): Promise<PrReviewBotSettingsListResponse> {
  if (cursor) {
    return requestJson<PrReviewBotSettingsListResponse>(
      `/api/settings/repositories/pr-review-bots?cursor=${encodeURIComponent(cursor)}`,
      undefined,
      "Failed to list PR review bot settings",
    );
  }
  return requestJson<PrReviewBotSettingsListResponse>(
    "/api/settings/repositories/pr-review-bots",
    undefined,
    "Failed to list PR review bot settings",
  );
}
