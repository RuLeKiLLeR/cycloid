import {
  buildConnectIntegrationStatement,
  buildConnectIntegrationStatementForGithubUser,
  buildGithubCredentialData,
} from "../integrations/db";
import type { GitHubUser } from "../types";
import { computeSha256Hex } from "../utils";
import {
  buildInsertUserStatement,
  buildUpdateUserProfileStatementByGithubId,
  buildUpsertBusinessMembershipStatement,
  buildUpsertBusinessMembershipStatementForGithubUser,
  getAuthSessionTokensForBusiness,
  getUserBusinessId,
  getUserByGithubId,
} from "./db";

const USER_BUSINESS_IMMUTABLE_ERROR = "users.business_id is immutable";
const MEMBER_BUSINESS_IMMUTABLE_ERROR = "business_members.business_id is immutable";
const MEMBER_BUSINESS_MISMATCH_ERROR = "business_members.business_id must match users.business_id";

export class BusinessMismatchError extends Error {
  readonly storedBusinessId: string;
  readonly requestedBusinessId: string;

  constructor(storedBusinessId: string, requestedBusinessId: string) {
    super(`GitHub user is already assigned to business ${storedBusinessId}`);
    this.name = "BusinessMismatchError";
    this.storedBusinessId = storedBusinessId;
    this.requestedBusinessId = requestedBusinessId;
  }
}

export function authSessionCacheKey(tokenHash: string): string {
  return `auth:session:${tokenHash}`;
}

export async function invalidateAuthSessionCache(token: string, kvCache: KVNamespace | undefined): Promise<void> {
  if (!kvCache) return;
  try {
    const hash = await computeSha256Hex(token);
    await kvCache.delete(authSessionCacheKey(hash));
  } catch {
    // Best-effort: cache will expire naturally via TTL.
  }
}

export async function invalidateBusinessAuthSessionCache(
  db: D1Database,
  businessId: string,
  kvCache: KVNamespace | undefined,
): Promise<void> {
  if (!kvCache) return;
  try {
    const tokens = await getAuthSessionTokensForBusiness(db, businessId);
    await Promise.all(tokens.map((token) => invalidateAuthSessionCache(token, kvCache)));
  } catch {
    // Best-effort: cache will expire naturally via TTL.
  }
}

function isImmutableBusinessWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [USER_BUSINESS_IMMUTABLE_ERROR, MEMBER_BUSINESS_IMMUTABLE_ERROR, MEMBER_BUSINESS_MISMATCH_ERROR].some(
    (message) => error.message.includes(message),
  );
}

function assertUserBusinessUnchanged(storedBusinessId: string, requestedBusinessId: string): void {
  if (storedBusinessId !== requestedBusinessId) {
    throw new BusinessMismatchError(storedBusinessId, requestedBusinessId);
  }
}

interface GithubOAuthCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export async function persistAuthenticatedGitHubUser(
  db: D1Database,
  ghUser: GitHubUser,
  credentials: GithubOAuthCredentials,
  businessId: string,
  encryptionKey: string | undefined,
): Promise<number> {
  const existingUser = await getUserByGithubId(db, ghUser.id);
  const now = Date.now();
  const credentialData = await buildGithubCredentialData(
    credentials.accessToken,
    credentials.refreshToken,
    credentials.expiresAt,
    encryptionKey,
  );

  if (existingUser) {
    const storedBusinessId = await getUserBusinessId(db, existingUser.id);
    // Business ownership is immutable. Historical session and telemetry isolation depends on this.
    assertUserBusinessUnchanged(storedBusinessId, businessId);

    await db.batch([
      buildUpdateUserProfileStatementByGithubId(db, ghUser, now),
      buildUpsertBusinessMembershipStatement(db, businessId, existingUser.id, now),
      buildConnectIntegrationStatement(db, existingUser.id, "github", credentialData, now),
    ]);

    return existingUser.id;
  }

  try {
    await db.batch([
      buildInsertUserStatement(db, ghUser, businessId, now),
      buildUpdateUserProfileStatementByGithubId(db, ghUser, now),
      buildUpsertBusinessMembershipStatementForGithubUser(db, businessId, ghUser.id, now),
      buildConnectIntegrationStatementForGithubUser(db, ghUser.id, "github", credentialData, now),
    ]);
  } catch (error) {
    const userAfterConflict = await getUserByGithubId(db, ghUser.id);
    if (userAfterConflict) {
      const storedBusinessId = await getUserBusinessId(db, userAfterConflict.id);
      if (storedBusinessId !== businessId || isImmutableBusinessWriteError(error)) {
        throw new BusinessMismatchError(storedBusinessId, businessId);
      }
    }
    throw error;
  }

  const user = await getUserByGithubId(db, ghUser.id);
  if (!user) {
    throw new Error(`GitHub user ${ghUser.id} was not persisted`);
  }

  return user.id;
}
