import { JSON_HEADERS, requestJson } from "./client";

export type ImpersonationSearchSession = {
  sessionId: string;
  title: string | null;
  updatedAt: string | number | null;
  owner: { id: number; login: string | null; name: string | null; email: string | null };
  businessId: string;
  businessName: string | null;
};

type ImpersonationSearchResult = {
  ok: true;
  sessions: ImpersonationSearchSession[];
};

export type ImpersonationDirectoryUser = {
  id: number;
  login: string | null;
  name: string | null;
  businessId: string;
  businessName: string | null;
};

export type ImpersonationDirectoryBusiness = {
  id: string;
  name: string | null;
  users: ImpersonationDirectoryUser[];
};

type ImpersonationDirectoryResult = {
  ok: true;
  truncated: boolean;
  businesses: ImpersonationDirectoryBusiness[];
};

export async function listImpersonationDirectory(): Promise<ImpersonationDirectoryResult> {
  return requestJson<ImpersonationDirectoryResult>(
    "/api/admin/impersonation/directory",
    undefined,
    "Failed to load support-view customers",
  );
}

export async function searchImpersonationTargets(query: string): Promise<ImpersonationSearchResult> {
  return requestJson<ImpersonationSearchResult>(
    `/api/admin/impersonation/search?q=${encodeURIComponent(query)}`,
    undefined,
    "Failed to search support-view targets",
  );
}

export async function startImpersonation(params: {
  targetUserId: number;
  reason: string;
}): Promise<{ ok: true; impersonationId: string; expiresAt: number }> {
  return requestJson<{ ok: true; impersonationId: string; expiresAt: number }>(
    "/api/admin/impersonation",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(params),
    },
    "Failed to start support view",
  );
}

export async function stopImpersonation(impersonationId: string): Promise<{ ok: true }> {
  return requestJson<{ ok: true }>(
    `/api/admin/impersonation/${impersonationId}`,
    { method: "DELETE" },
    "Failed to stop support view",
  );
}
