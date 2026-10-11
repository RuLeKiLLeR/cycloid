import { apiCacheKeys, invalidate, swr } from "./cache";
import { JSON_HEADERS, requestJson, requestVoid } from "./client";

export type CliToken = {
  id: number;
  tokenPrefix: string;
  scope: CliTokenScope;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
};

export type CliTokenScope = "read" | "write";

type CreateCliTokenRequest = {
  expiresInDays?: number;
  scope?: CliTokenScope;
};

export async function fetchCliTokens(): Promise<{ data: CliToken[]; nextCursor: string | null }> {
  // NOTE: route-coverage test parses this fetch path statically -- keep it as a plain string literal
  const result = await swr(
    apiCacheKeys.cliTokens(),
    () =>
      requestJson<{ data: CliToken[]; nextCursor: string | null }>(
        "/api/cli-tokens",
        undefined,
        "Failed to fetch CLI tokens",
      ),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function createCliToken(
  params: CreateCliTokenRequest = {},
): Promise<{ ok: boolean; token: string; id: number; scope: CliTokenScope }> {
  const body: CreateCliTokenRequest & { scope: CliTokenScope } = { scope: params.scope ?? "read" };
  if (params.expiresInDays !== undefined) body.expiresInDays = params.expiresInDays;

  const result = await requestJson<{ ok: boolean; token: string; id: number; scope: CliTokenScope }>(
    "/api/cli-tokens",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    },
    "Failed to create CLI token",
  );
  invalidate(apiCacheKeys.cliTokens());
  return result;
}

export async function revokeCliToken(id: number): Promise<void> {
  await requestVoid(`/api/cli-tokens/${id}/revoke`, { method: "POST" }, "Failed to revoke CLI token");
  invalidate(apiCacheKeys.cliTokens());
}

export async function deleteCliToken(id: number): Promise<void> {
  await requestVoid(`/api/cli-tokens/${id}`, { method: "DELETE" }, "Failed to delete CLI token");
  invalidate(apiCacheKeys.cliTokens());
}
