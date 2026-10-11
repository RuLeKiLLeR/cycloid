import { z } from "zod";

import type { CredentialValidationStatus } from "../../../../shared/constants/onboarding";
import type { BusinessIntegrationInfo } from "../../../../shared/types/integrations";
import type { McpServerInput, McpServerRecord } from "../../../../shared/types/mcp";
import type { UserIntegrations } from "../types";
import { apiCacheKeys, invalidate, swr } from "./cache";
import { JSON_HEADERS, requestJson, requestJson as requestValidatedJson, requestVoid } from "./client";

export type { BusinessIntegrationInfo };

export async function fetchUserIntegrations(): Promise<UserIntegrations> {
  // NOTE: route-coverage test parses this fetch path statically -- keep string literals in requestJson calls
  const result = await swr(
    apiCacheKeys.integrations(),
    () => requestJson<UserIntegrations>("/api/user/integrations", undefined, "Failed to fetch integration data"),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function updateBusinessSharedSessions(businessId: string, sharedSessions: boolean): Promise<void> {
  await requestVoid(
    `/api/businesses/${businessId}`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sharedSessions }),
    },
    "Failed to update shared sessions",
  );
  invalidate(apiCacheKeys.integrations());
  invalidate(apiCacheKeys.bootstrap());
}

export type BusinessEgressAllowlistSourceResponse = {
  ok: boolean;
  source: { sourceRepoOwner: string; sourceRepoName: string } | null;
  path: string;
  defaultBranch?: string;
  fileExists?: boolean;
  domains: string[];
  error?: string;
  code?: string;
};

type BusinessEgressAllowlistPullRequestResponse = {
  ok: boolean;
  source: { sourceRepoOwner: string; sourceRepoName: string };
  path: string;
  defaultBranch: string;
  fileExists?: boolean;
  domains: string[];
  addedDomains: string[];
  prUrl: string | null;
  prNumber: number | null;
  branchName: string | null;
  status: "created" | "updated" | "unchanged";
};

const businessEgressAllowlistSourceResponseSchema: z.ZodType<BusinessEgressAllowlistSourceResponse> = z.object({
  ok: z.boolean(),
  source: z.object({ sourceRepoOwner: z.string(), sourceRepoName: z.string() }).nullable(),
  path: z.string(),
  defaultBranch: z.string().optional(),
  fileExists: z.boolean().optional(),
  domains: z.array(z.string()),
  error: z.string().optional(),
  code: z.string().optional(),
});

const businessEgressAllowlistPullRequestResponseSchema: z.ZodType<BusinessEgressAllowlistPullRequestResponse> =
  z.object({
    ok: z.boolean(),
    source: z.object({ sourceRepoOwner: z.string(), sourceRepoName: z.string() }),
    path: z.string(),
    defaultBranch: z.string(),
    fileExists: z.boolean().optional(),
    domains: z.array(z.string()),
    addedDomains: z.array(z.string()),
    prUrl: z.string().nullable(),
    prNumber: z.number().nullable(),
    branchName: z.string().nullable(),
    status: z.union([z.literal("created"), z.literal("updated"), z.literal("unchanged")]),
  });

type BusinessEgressAllowlistSyncResponse = {
  ok: boolean;
  applied: boolean;
  egressAllowlist: string[];
  domains: string[];
  fileExists: boolean;
};

const businessEgressAllowlistSyncResponseSchema: z.ZodType<BusinessEgressAllowlistSyncResponse> = z.object({
  ok: z.boolean(),
  applied: z.boolean(),
  egressAllowlist: z.array(z.string()),
  domains: z.array(z.string()),
  fileExists: z.boolean(),
});

export async function fetchBusinessEgressAllowlistSource(
  businessId: string,
): Promise<BusinessEgressAllowlistSourceResponse> {
  return requestValidatedJson(
    `/api/businesses/${businessId}/egress-allowlist/source`,
    undefined,
    "Failed to load egress allowlist source",
    { schema: businessEgressAllowlistSourceResponseSchema },
  );
}

export async function createBusinessEgressAllowlistPr(
  businessId: string,
  domains: string[],
  reason?: string,
): Promise<BusinessEgressAllowlistPullRequestResponse> {
  return requestValidatedJson(
    `/api/businesses/${businessId}/egress-allowlist/pull-request`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ domains, ...(reason ? { reason } : {}) }),
    },
    "Failed to create egress allowlist PR",
    { schema: businessEgressAllowlistPullRequestResponseSchema },
  );
}

export async function syncBusinessEgressAllowlistFromSource(
  businessId: string,
): Promise<BusinessEgressAllowlistSyncResponse> {
  return requestValidatedJson(
    `/api/businesses/${businessId}/egress-allowlist/sync`,
    { method: "POST" },
    "Failed to refresh egress allowlist from repo",
    { schema: businessEgressAllowlistSyncResponseSchema },
  );
}

export async function fetchBusinessIntegrations(businessId: string): Promise<Record<string, BusinessIntegrationInfo>> {
  const data = await requestJson<{ integrations: Record<string, BusinessIntegrationInfo> }>(
    `/api/businesses/${businessId}/integrations`,
    undefined,
    "Failed to fetch business integrations",
  );
  return data.integrations;
}

export async function setBusinessIntegrationScope(
  businessId: string,
  integrationId: string,
  scope: string,
): Promise<void> {
  await requestVoid(
    `/api/businesses/${businessId}/integrations/${integrationId}`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope }),
    },
    "Failed to update integration scope",
  );
  invalidate(apiCacheKeys.integrations());
}

export async function disconnectBusinessLinearWorkspace(businessId: string): Promise<void> {
  await requestVoid(
    `/api/businesses/${businessId}/integrations/linear/workspace`,
    {
      method: "DELETE",
    },
    "Failed to disconnect Linear workspace",
  );
  invalidate(apiCacheKeys.integrations());
}

export async function disconnectBusinessJiraWorkspace(businessId: string): Promise<void> {
  await requestVoid(
    `/api/businesses/${businessId}/integrations/jira/workspace`,
    {
      method: "DELETE",
    },
    "Failed to disconnect Jira workspace",
  );
  invalidate(apiCacheKeys.integrations());
}

type JiraPendingSite = { cloudId: string; url: string; name: string | null };

export async function fetchJiraPendingSites(
  nonce: string,
): Promise<{ flow: "user" | "business"; sites: JiraPendingSite[] }> {
  return requestJson<{ flow: "user" | "business"; sites: JiraPendingSite[] }>(
    `/auth/jira/pending?nonce=${encodeURIComponent(nonce)}`,
    undefined,
    "Failed to load Jira site selection",
  );
}

export async function finalizeJiraSite(nonce: string, cloudId: string): Promise<{ ok: boolean; siteUrl?: string }> {
  return requestJson<{ ok: boolean; siteUrl?: string }>(
    "/auth/jira/finalize",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ nonce, cloudId }) },
    "Failed to finalize Jira site selection",
  );
}

export async function setBusinessCredentials(
  businessId: string,
  integrationId: string,
  data: { apiKey?: string; serviceUrl?: string; applicationKey?: string },
): Promise<{ validationStatus: CredentialValidationStatus | null }> {
  const result = await requestJson<{ validationStatus: CredentialValidationStatus | null }>(
    `/api/businesses/${businessId}/integrations/${integrationId}/credentials`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(data),
    },
    "Failed to save credentials",
  );
  invalidate(apiCacheKeys.integrations());
  return result;
}

export async function deleteBusinessCredentials(businessId: string, integrationId: string): Promise<void> {
  await requestVoid(
    `/api/businesses/${businessId}/integrations/${integrationId}/credentials`,
    {
      method: "DELETE",
    },
    "Failed to remove credentials",
  );
  invalidate(apiCacheKeys.integrations());
}

export async function validateBusinessCredentials(businessId: string, integrationId: string): Promise<void> {
  await requestVoid(
    `/api/businesses/${businessId}/integrations/${integrationId}/credentials/validate`,
    { method: "POST" },
    "Failed to validate credentials",
  );
  invalidate(apiCacheKeys.integrations());
}

export async function fetchMcpServers(): Promise<McpServerRecord[]> {
  const data = await requestJson<{ ok: true; servers: McpServerRecord[] }>(
    "/api/integrations/mcp-servers",
    undefined,
    "Failed to fetch MCP servers",
  );
  return data.servers;
}

export async function createMcpServer(input: McpServerInput): Promise<McpServerRecord> {
  const data = await requestJson<{ ok: true; server: McpServerRecord }>(
    "/api/integrations/mcp-servers",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
    "Failed to create MCP server",
  );
  return data.server;
}

export async function updateMcpServer(serverId: string, input: McpServerInput): Promise<McpServerRecord> {
  const data = await requestJson<{ ok: true; server: McpServerRecord }>(
    `/api/integrations/mcp-servers/${encodeURIComponent(serverId)}`,
    {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
    "Failed to update MCP server",
  );
  return data.server;
}

export async function deleteMcpServer(serverId: string): Promise<void> {
  await requestVoid(
    `/api/integrations/mcp-servers/${encodeURIComponent(serverId)}`,
    { method: "DELETE" },
    "Failed to delete MCP server",
  );
}

export async function validateMcpServer(serverId: string): Promise<McpServerRecord> {
  const data = await requestJson<{ ok: true; server: McpServerRecord }>(
    `/api/integrations/mcp-servers/${encodeURIComponent(serverId)}/validate`,
    { method: "POST" },
    "Failed to validate MCP server",
  );
  return data.server;
}
