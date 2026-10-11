import type { BusinessRole } from "../auth/business-role";
import { resolveCycloidAdminUser, resolveInternalFeatureGateUser } from "../auth/db";
import { isInternalCycloidBusinessId } from "../constants/businesses";
import type { AuthInfo, UserInfo } from "../types";

export type CycloidMemberUser = {
  businessId?: string | null;
};

export type CycloidAdminUser = {
  businessId?: string | null;
  businessRole?: BusinessRole | null;
};

// Internal-feature access and internal-admin status both derive solely from
// membership in a Cycloid-owned business (prod or QA). Membership is a
// deliberate, manually-controlled action, so it is the single source of truth;
// there is no separate hardcoded staff allowlist.
export function isCycloidMember(user: CycloidMemberUser | null | undefined): boolean {
  return user?.businessId != null && isInternalCycloidBusinessId(user.businessId);
}

export function isCycloidAdmin(user: CycloidAdminUser | null | undefined): boolean {
  return user?.businessRole === "admin" && user.businessId != null && isInternalCycloidBusinessId(user.businessId);
}

/**
 * When the request is an impersonated browser session, evaluate internal-feature
 * access against the operator's real identity (`actorUser`), not the customer
 * being impersonated.
 */
function effectiveInternalIdentity(
  auth: Pick<AuthInfo, "user" | "actorUser"> | null | undefined,
): UserInfo | null | undefined {
  return auth?.actorUser ?? auth?.user;
}

export async function verifyCycloidMember(
  db: D1Database,
  auth: Pick<AuthInfo, "user" | "actorUser"> | null | undefined,
): Promise<boolean> {
  const identity = effectiveInternalIdentity(auth);
  const userId = identity?.id;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return false;

  const resolvedUser = await resolveInternalFeatureGateUser(db, userId);
  return isCycloidMember(resolvedUser);
}

export async function verifyCycloidAdmin(
  db: D1Database,
  auth: Pick<AuthInfo, "user" | "actorUser"> | null | undefined,
): Promise<boolean> {
  const identity = effectiveInternalIdentity(auth);
  const userId = identity?.id;
  if (typeof userId !== "number" || !Number.isInteger(userId)) return false;
  const resolvedUser = await resolveCycloidAdminUser(db, userId);
  return isCycloidAdmin(resolvedUser);
}
