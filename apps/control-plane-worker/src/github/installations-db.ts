import { stringifyError } from "../../../../shared/utils/errors.js";
import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";

export interface InstallationRow {
  installation_id: number;
  owner_login: string;
  owner_id: number;
  owner_type: string;
  repository_selection: string | null;
  permissions_json: string | null;
  events_json: string | null;
  created_at: number;
  suspended_at: number | null;
}

const INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS = 100;

// Per-isolate read-through cache for the hottest installation read
// (getInstallationByOwner runs on every credential resolution). Every
// installation-mutating DAO function clears it, so the handling isolate is
// always fresh; other isolates serve at most TTL-stale rows, which is
// accepted because GitHub rejects token minting for uninstalled/suspended
// installations downstream (fail-closed holds).
const INSTALLATION_BY_OWNER_CACHE_TTL_MS = 60 * 60 * 1000;
// Misses cache briefly: an owner who installs the GitHub App right after a
// failed attempt must not be locked out on other isolates for the full TTL
// (only the isolate handling the installation.created webhook gets the
// DAO-level invalidation). DB errors share the same short TTL
// (retry-storm protection per docs/conventions.md).
const INSTALLATION_BY_OWNER_MISS_TTL_MS = 60 * 1000;
const INSTALLATION_BY_OWNER_ERROR_TTL_MS = 60 * 1000;
const installationByOwnerCache = createBoundedTtlMemoryCache<string, { row: InstallationRow | null }>(1000);
// Bumped on every invalidation so an in-flight read that started before a
// mutation cannot repopulate the cache with a pre-mutation row afterwards.
let installationByOwnerCacheGeneration = 0;

function installationOwnerCacheKey(ownerLogin: string): string {
  // Case-only fold, matching the COLLATE NOCASE lookup semantics exactly
  // (NOCASE does not strip whitespace, so neither does this key).
  return ownerLogin.toLowerCase();
}

function invalidateInstallationByOwnerCache(): void {
  // Mutations are rare (org installs); clearing the whole cache is cheap and
  // avoids owner-rename / id-vs-login mapping bugs.
  installationByOwnerCacheGeneration += 1;
  installationByOwnerCache.clear();
}

export function resetInstallationByOwnerCacheForTests(): void {
  installationByOwnerCache.clear();
}

interface InstallationReposCacheRow {
  installation_id: number;
  repositories_json: string;
}

interface UpsertInstallationParams {
  installationId: number;
  ownerLogin: string;
  ownerId: number;
  ownerType: string;
  repositorySelection?: string | null;
  permissions?: Record<string, string> | null;
  events?: string[] | null;
}

type UpdateInstallationPermissionsParams = UpsertInstallationParams;

export function isInstallationOwnerUniqueConstraintError(error: unknown): boolean {
  const message = stringifyError(error);
  return message.includes("UNIQUE constraint failed: github_installations.owner_login");
}

function bindUpsertInstallationStatement(db: D1Database, params: UpsertInstallationParams): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO github_installations (
         installation_id, owner_login, owner_id, owner_type, repository_selection, permissions_json, events_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (installation_id) DO UPDATE SET
         owner_login = excluded.owner_login,
         owner_id = excluded.owner_id,
         owner_type = excluded.owner_type,
         repository_selection = excluded.repository_selection,
         permissions_json = excluded.permissions_json,
         events_json = excluded.events_json,
         suspended_at = NULL`,
    )
    .bind(
      params.installationId,
      params.ownerLogin,
      params.ownerId,
      params.ownerType,
      params.repositorySelection ?? null,
      params.permissions ? JSON.stringify(params.permissions) : null,
      params.events ? JSON.stringify(params.events) : null,
    );
}

export async function upsertInstallation(db: D1Database, params: UpsertInstallationParams): Promise<void> {
  await bindUpsertInstallationStatement(db, params).run();
  invalidateInstallationByOwnerCache();
}

export async function replaceConflictingInstallation(
  db: D1Database,
  conflictingInstallationId: number,
  params: UpsertInstallationParams,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM github_installations WHERE installation_id = ?").bind(conflictingInstallationId),
    bindUpsertInstallationStatement(db, params),
  ]);
  invalidateInstallationByOwnerCache();
}

export async function updateInstallationPermissions(
  db: D1Database,
  params: UpdateInstallationPermissionsParams,
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_installations
       SET owner_login = ?,
           owner_id = ?,
           owner_type = ?,
           repository_selection = ?,
           permissions_json = ?,
           events_json = ?
       WHERE installation_id = ?`,
    )
    .bind(
      params.ownerLogin,
      params.ownerId,
      params.ownerType,
      params.repositorySelection ?? null,
      params.permissions ? JSON.stringify(params.permissions) : null,
      params.events ? JSON.stringify(params.events) : null,
      params.installationId,
    )
    .run();
  invalidateInstallationByOwnerCache();
}

export async function getConflictingInstallationByOwner(
  db: D1Database,
  ownerLogin: string,
  installationId: number,
): Promise<InstallationRow | null> {
  return db
    .prepare("SELECT * FROM github_installations WHERE owner_login = ? COLLATE NOCASE AND installation_id != ? LIMIT 1")
    .bind(ownerLogin, installationId)
    .first<InstallationRow>();
}

export async function deleteInstallation(db: D1Database, installationId: number): Promise<void> {
  await db.prepare("DELETE FROM github_installations WHERE installation_id = ?").bind(installationId).run();
  invalidateInstallationByOwnerCache();
}

export async function suspendInstallation(db: D1Database, installationId: number, suspendedAt: number): Promise<void> {
  await db
    .prepare("UPDATE github_installations SET suspended_at = ? WHERE installation_id = ?")
    .bind(suspendedAt, installationId)
    .run();
  invalidateInstallationByOwnerCache();
}

export async function unsuspendInstallation(db: D1Database, installationId: number): Promise<void> {
  await db
    .prepare("UPDATE github_installations SET suspended_at = NULL WHERE installation_id = ?")
    .bind(installationId)
    .run();
  invalidateInstallationByOwnerCache();
}

export async function getInstallationByOwner(db: D1Database, ownerLogin: string): Promise<InstallationRow | null> {
  const key = installationOwnerCacheKey(ownerLogin);
  const cached = installationByOwnerCache.get(key);
  if (cached) return cached.row;

  const generation = installationByOwnerCacheGeneration;
  let row: InstallationRow | null;
  try {
    row = await db
      .prepare("SELECT * FROM github_installations WHERE owner_login = ? COLLATE NOCASE LIMIT 1")
      .bind(ownerLogin)
      .first<InstallationRow>();
  } catch (err) {
    if (generation === installationByOwnerCacheGeneration) {
      installationByOwnerCache.set(key, { row: null }, INSTALLATION_BY_OWNER_ERROR_TTL_MS);
    }
    throw err;
  }
  // Skip the write if a mutation invalidated the cache while this read was
  // in flight: the row may already be stale.
  if (generation === installationByOwnerCacheGeneration) {
    installationByOwnerCache.set(
      key,
      { row },
      row ? INSTALLATION_BY_OWNER_CACHE_TTL_MS : INSTALLATION_BY_OWNER_MISS_TTL_MS,
    );
  }
  return row;
}

export async function getInstallationsByOwners(
  db: D1Database,
  ownerLogins: string[],
): Promise<Map<string, InstallationRow>> {
  const uniqueOwners = [...new Set(ownerLogins.map((owner) => owner.trim().toLowerCase()).filter(Boolean))];
  if (uniqueOwners.length === 0) return new Map();

  const rows: InstallationRow[] = [];
  for (let i = 0; i < uniqueOwners.length; i += INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS) {
    const batch = uniqueOwners.slice(i, i + INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM github_installations WHERE owner_login COLLATE NOCASE IN (${placeholders})`)
      .bind(...batch)
      .all<InstallationRow>();
    rows.push(...(result.results ?? []));
  }

  return new Map(rows.map((row) => [row.owner_login.trim().toLowerCase(), row]));
}

/**
 * Active (non-suspended) installations for a set of GitHub org/user numeric IDs.
 *
 * Used to map SAML-SSO-withheld org IDs (from the `X-GitHub-SSO` header) back to
 * an org login so the UI can deep-link to that org's authorize page. Filters
 * `suspended_at IS NULL` so a suspended install never produces an authorize link
 * for an org Cycloid is no longer on. `owner_id` is unindexed, but
 * `github_installations` holds roughly one row per installed org, so a scan over
 * a bounded `IN (...)` is cheap; batched to stay under the bind-variable limit.
 */
export async function getInstallationsByOwnerIds(db: D1Database, ownerIds: number[]): Promise<InstallationRow[]> {
  const uniqueIds = [...new Set(ownerIds.filter((id) => Number.isInteger(id)))];
  if (uniqueIds.length === 0) return [];

  const rows: InstallationRow[] = [];
  for (let i = 0; i < uniqueIds.length; i += INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS) {
    const batch = uniqueIds.slice(i, i + INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT * FROM github_installations WHERE suspended_at IS NULL AND owner_id IN (${placeholders})`)
      .bind(...batch)
      .all<InstallationRow>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

export async function getActiveInstallationsForOwners(
  db: D1Database,
  ownerLogins: string[],
): Promise<InstallationRow[]> {
  if (ownerLogins.length === 0) return [];

  const rows: InstallationRow[] = [];
  for (let i = 0; i < ownerLogins.length; i += INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS) {
    const batch = ownerLogins.slice(i, i + INSTALLATION_OWNER_BATCH_SELECT_MAX_BINDINGS);
    const placeholders = batch.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT * FROM github_installations WHERE suspended_at IS NULL AND owner_login COLLATE NOCASE IN (${placeholders})`,
      )
      .bind(...batch.map((o) => o.toLowerCase()))
      .all<InstallationRow>();
    rows.push(...result.results);
  }

  return rows;
}

export async function getCachedInstallationReposForInstallations(
  db: D1Database,
  userId: string,
  installationIds: number[],
  nowMs: number,
): Promise<Map<number, Set<string>>> {
  if (installationIds.length === 0) return new Map();
  const uniqueInstallationIds = [...new Set(installationIds)];
  const placeholders = uniqueInstallationIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT installation_id, repositories_json
       FROM github_installation_repositories_cache
       WHERE user_id = ? AND expires_at > ? AND installation_id IN (${placeholders})`,
    )
    .bind(userId, nowMs, ...uniqueInstallationIds)
    .all<InstallationReposCacheRow>();

  const cached = new Map<number, Set<string>>();
  for (const row of result.results) {
    try {
      const repoNames = JSON.parse(row.repositories_json) as unknown;
      if (!Array.isArray(repoNames) || repoNames.some((repoName) => typeof repoName !== "string")) {
        continue;
      }
      cached.set(
        row.installation_id,
        new Set(repoNames.map((repoName) => repoName.trim().toLowerCase()).filter(Boolean)),
      );
    } catch {
      continue;
    }
  }
  return cached;
}

export async function cacheInstallationRepos(
  db: D1Database,
  userId: string,
  entries: Array<{ installationId: number; repos: Iterable<string> }>,
  nowMs: number,
  ttlMs: number,
): Promise<void> {
  if (entries.length === 0) return;
  const expiresAt = nowMs + ttlMs;
  const statements = entries.map((entry) => {
    const repoNames = [...new Set([...entry.repos].map((repoName) => repoName.trim().toLowerCase()).filter(Boolean))];
    return db
      .prepare(
        `INSERT INTO github_installation_repositories_cache (
           user_id, installation_id, repositories_json, fetched_at, expires_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, installation_id) DO UPDATE SET
           repositories_json = excluded.repositories_json,
           fetched_at = excluded.fetched_at,
           expires_at = excluded.expires_at`,
      )
      .bind(userId, entry.installationId, JSON.stringify(repoNames), nowMs, expiresAt);
  });
  await db.batch(statements);
}

export async function deleteCachedInstallationRepos(db: D1Database, installationId: number): Promise<void> {
  await db
    .prepare("DELETE FROM github_installation_repositories_cache WHERE installation_id = ?")
    .bind(installationId)
    .run();
}

/**
 * Drop every per-installation repo-cache row for one user. Used by the repos
 * cache invalidator so a freshly (re)authorized user does not keep seeing the
 * pre-auth selected-installation repo set (the merged KV/memory cache alone is
 * not enough — selected installations cache here with their own TTL).
 */
export async function deleteCachedInstallationReposForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM github_installation_repositories_cache WHERE user_id = ?").bind(userId).run();
}
