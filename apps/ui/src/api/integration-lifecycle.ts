import type { IntegrationLifecycleEvent, IntegrationLifecycleSummary } from "../../../../shared/types/integrations";
import { requestJson } from "./client";

export type GithubIntegrationSummary = IntegrationLifecycleSummary & { userMessage?: string | null };

type IntegrationLifecyclePageResponse = {
  ok: true;
  events: IntegrationLifecycleEvent[];
  nextCursor: string | null;
};

export async function fetchIntegrationLifecycleEvents(options?: {
  integrationId?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<{ events: IntegrationLifecycleEvent[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options?.cursor != null) params.set("cursor", String(options.cursor));
  if (options?.limit != null) params.set("limit", String(options.limit));

  const path = options?.integrationId
    ? `/api/integrations/debug/${encodeURIComponent(options.integrationId)}${params.size ? `?${params.toString()}` : ""}`
    : `/api/integrations/debug${params.size ? `?${params.toString()}` : ""}`;

  const data = await requestJson<IntegrationLifecyclePageResponse>(
    path,
    undefined,
    "Failed to load integration events",
  );
  return {
    events: Array.isArray(data.events) ? data.events : [],
    nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
  };
}

export async function fetchMyGithubIntegrationSummary(): Promise<GithubIntegrationSummary | null> {
  const data = await requestJson<{
    ok: true;
    integrations?: {
      github?: GithubIntegrationSummary | null;
    };
  }>("/api/integrations/me", undefined, "Failed to load integration status");
  return data.integrations?.github ?? null;
}
