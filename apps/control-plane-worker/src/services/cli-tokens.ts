import {
  deleteCliTokenRow,
  deleteExpiredCliTokens,
  findCliTokenByHash,
  findCliTokenByUserAndId,
  insertCliTokenIfBelowLimit,
  setRevokedAt,
  updateLastUsedAt,
} from "../auth/cli-tokens";
import { CLI_TOKEN_LAST_USED_THROTTLE_MS, MAX_ACTIVE_CLI_TOKENS } from "../constants/cli-tokens";
import { createLogger } from "../logger";
import { runWithSentryTag } from "../observability/run-with-sentry-tag";
import type { CliTokenScope, UserInfo } from "../types";
import { computeSha256Hex, generateRandomHex } from "../utils";

const log = createLogger({ bindings: { component: "cli-tokens" } });

const ACTIVE_TOKEN_LIMIT_ERROR = `You already have ${MAX_ACTIVE_CLI_TOKENS} active CLI tokens. Revoke one before creating a new token.`;

type CreateCliTokenResult =
  { ok: true; token: string; id: number; scope: CliTokenScope } | { ok: false; error: string };

type ResolveCliTokenResult =
  { status: "ok"; scope: CliTokenScope; tokenId: number; user: UserInfo } | { status: "invalid" };

export async function createCliToken(
  db: D1Database,
  userId: number,
  scope: CliTokenScope,
  expiresAt?: number,
): Promise<CreateCliTokenResult> {
  await deleteExpiredCliTokens(db, userId);

  const rawToken = `arc_${generateRandomHex(32)}`;
  const tokenHash = await computeSha256Hex(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);
  // Enforce the cap in-statement so N concurrent creates cannot each pass a
  // separate count-then-insert and overshoot MAX_ACTIVE_CLI_TOKENS.
  const id = await insertCliTokenIfBelowLimit(
    db,
    userId,
    tokenHash,
    tokenPrefix,
    scope,
    MAX_ACTIVE_CLI_TOKENS,
    expiresAt,
  );
  if (id === null) {
    return { ok: false, error: ACTIVE_TOKEN_LIMIT_ERROR };
  }
  log.info({ userId, tokenId: id, prefix: tokenPrefix, scope }, "CLI token created");
  return { ok: true, token: rawToken, id, scope };
}

export async function resolveCliToken(db: D1Database, rawToken: string): Promise<ResolveCliTokenResult> {
  const tokenHash = await computeSha256Hex(rawToken);
  const resolved = await findCliTokenByHash(db, tokenHash);

  if (!resolved) {
    log.warn({}, "CLI token resolution failed");
    return { status: "invalid" };
  }

  // Throttle the touch: skip the write entirely when `last_used_at` is still fresh.
  // This is what removes the bulk of per-request `cli_tokens` writes — the common
  // case reads a recent value and never touches the single writer. `null` (never
  // used) counts as stale and triggers the first write. Fire-and-forget: a purely
  // informational write must not block auth.
  const now = Date.now();
  const staleBeforeMs = now - CLI_TOKEN_LAST_USED_THROTTLE_MS;
  if (resolved.lastUsedAt === null || resolved.lastUsedAt < staleBeforeMs) {
    void runWithSentryTag(
      "cli_token_touch_last_used",
      () => updateLastUsedAt(db, resolved.tokenId, staleBeforeMs),
      log,
      { message: "Failed to update last_used_at", logFields: { tokenId: resolved.tokenId } },
    );
  }

  return {
    status: "ok",
    scope: resolved.scope,
    tokenId: resolved.tokenId,
    user: resolved.user,
  };
}

export async function revokeCliToken(db: D1Database, userId: number, tokenId: number): Promise<void> {
  await setRevokedAt(db, userId, tokenId);
  log.info({ userId, tokenId }, "CLI token revoked");
}

export async function getCliTokenForUser(
  db: D1Database,
  userId: number,
  tokenId: number,
): Promise<{ id: number; scope: CliTokenScope } | null> {
  return findCliTokenByUserAndId(db, userId, tokenId);
}

export async function deleteCliToken(db: D1Database, userId: number, tokenId: number): Promise<void> {
  await deleteCliTokenRow(db, userId, tokenId);
  log.info({ userId, tokenId }, "CLI token deleted");
}
