import type { BusinessEgressPolicy } from "../../../../shared/types/business-egress-policy.js";
import type { AuthInfo } from "../types";
import type { BusinessEgressAllowlistSource } from "./db";
import {
  type BusinessRecord,
  getBusiness,
  getBusinessForAdmin,
  getBusinessForMember,
  updateBusinessEgressAllowlistSource,
  updateBusinessEgressPolicy,
  updateBusinessSharedSessions,
} from "./db";

/**
 * Check if a user is an admin of the given business.
 * API token callers (canAccessAllSessions) bypass this check.
 */
export async function isBusinessAdmin(db: D1Database, userId: number, businessId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT role FROM business_members WHERE business_id = ? AND user_id = ? LIMIT 1")
    .bind(businessId, userId)
    .first<{ role: string }>();
  return row?.role === "admin";
}

export async function loadBusinessForAuth(
  db: D1Database,
  auth: AuthInfo,
  businessId: string,
  opts: { allowMember?: boolean } = {},
): Promise<BusinessRecord | null> {
  if (auth.canAccessAllSessions) return getBusiness(db, businessId);

  const userId = Number(auth.userId);
  if (!Number.isFinite(userId)) return null;

  const adminBusiness = await getBusinessForAdmin(db, businessId, userId);
  if (adminBusiness || !opts.allowMember) return adminBusiness;

  return getBusinessForMember(db, businessId, userId);
}

/**
 * Enable or disable the `shared_sessions` flag for a business. Returns true if
 * a row was updated, false if no business matched `businessId`.
 *
 * This is the canonical entry point for route handlers — routes should not call
 * the DAO directly (see docs/conventions.md).
 */
export async function setBusinessSharedSessions(
  db: D1Database,
  businessId: string,
  sharedSessions: boolean,
): Promise<boolean> {
  return updateBusinessSharedSessions(db, businessId, sharedSessions);
}

export async function setBusinessEgressPolicy(
  db: D1Database,
  businessId: string,
  policy: BusinessEgressPolicy | null,
): Promise<boolean> {
  return updateBusinessEgressPolicy(db, businessId, policy);
}

export async function setBusinessEgressAllowlistSource(
  db: D1Database,
  businessId: string,
  source: BusinessEgressAllowlistSource | null,
): Promise<boolean> {
  return updateBusinessEgressAllowlistSource(db, businessId, source);
}
