import { isBusinessAdmin } from "../business/service";
import type { AuthInfo } from "../types";

export async function canAdministerCompanyMemory(db: D1Database, auth: AuthInfo, businessId: string): Promise<boolean> {
  if (auth.canAccessAllSessions) return true;
  const userId = Number(auth.userId);
  return Number.isSafeInteger(userId) && (await isBusinessAdmin(db, userId, businessId));
}
