import { apiCacheKeys, invalidate, swr } from "./cache";
import { JSON_HEADERS, requestJson } from "./client";

export type PendingSignup = {
  id: number;
  githubId: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  requestedAt: number;
  deniedAt: number | null;
  deniedByUserId: number | null;
};

export type AdminBusiness = {
  id: string;
  name: string;
  createdAt: number;
};

type ApprovePendingSignupBody =
  | { kind: "new"; businessName: string; role?: "admin" | "member" }
  | { kind: "existing"; businessId: string; role: "admin" | "member" };

export async function fetchPendingSignups(): Promise<PendingSignup[]> {
  const result = await swr(
    apiCacheKeys.pendingSignups(),
    () =>
      requestJson<{ ok: boolean; signups: PendingSignup[] }>(
        "/api/admin/pending-signups",
        undefined,
        "Failed to fetch pending signups",
      ).then((data) => data.signups),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function fetchAdminBusinesses(): Promise<AdminBusiness[]> {
  const result = await swr(
    apiCacheKeys.adminBusinesses(),
    () =>
      requestJson<{ ok: boolean; businesses: AdminBusiness[] }>(
        "/api/admin/businesses",
        undefined,
        "Failed to fetch businesses",
      ).then((data) => data.businesses),
    { staleMs: 30_000 },
  );
  return result.value;
}

export async function approvePendingSignup(
  id: number,
  body: ApprovePendingSignupBody,
): Promise<{ userId: number; businessId: string }> {
  const result = await requestJson<{ ok: boolean; userId: number; businessId: string }>(
    `/api/admin/pending-signups/${id}/approve`,
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) },
    "Failed to approve pending signup",
  );
  invalidate(apiCacheKeys.pendingSignups());
  invalidate(apiCacheKeys.adminBusinesses());
  invalidate(apiCacheKeys.adminConsoleBusinesses());
  return { userId: result.userId, businessId: result.businessId };
}

export async function denyPendingSignup(id: number): Promise<void> {
  await requestJson<{ ok: boolean }>(
    `/api/admin/pending-signups/${id}/deny`,
    { method: "POST", headers: JSON_HEADERS },
    "Failed to deny pending signup",
  );
  invalidate(apiCacheKeys.pendingSignups());
  invalidate(apiCacheKeys.adminBusinesses());
  invalidate(apiCacheKeys.adminConsoleBusinesses());
}
