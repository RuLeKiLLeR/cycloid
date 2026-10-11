import { d1Changed } from "../db/errors";
export interface RepoEnvBlobMetadataRow {
  id: string;
  owner_user_id: number;
  business_id: string;
  name: string;
  key_names_json: string;
  entry_meta_json: string;
  created_at: number;
  updated_at: number;
  repo_owner: string;
  repo_name: string;
}

export interface PersonalEnvBlobMetadataRow {
  id: string;
  owner_user_id: number;
  business_id: string | null;
  name: string;
  key_names_json: string;
  entry_meta_json: string;
  created_at: number;
  updated_at: number;
}

export interface RepoEnvBlobStoredRow extends RepoEnvBlobMetadataRow {
  env_text: string;
  encrypted: number;
}

export interface RepoEnvBlobStaleCleanupResult {
  staleDeletedCount: number;
  keptBlobStillCurrentWinner: boolean;
}

interface RepoEnvBlobCurrentWinnerRow {
  kept_blob_still_current_winner: boolean | number;
}

export async function getRepoEnvBlobForRepo(
  db: D1Database,
  businessId: string,
  name: string,
  repoOwner: string,
  repoName: string,
): Promise<RepoEnvBlobStoredRow | null> {
  const row = await db
    .prepare(
      `SELECT b.id, b.owner_user_id, b.business_id, b.name, b.env_text, b.encrypted, b.key_names_json,
              COALESCE(b.entry_meta_json, '{}') AS entry_meta_json,
              b.created_at, b.updated_at, r.repo_owner, r.repo_name
       FROM env_blobs b
       INNER JOIN env_blob_repos r ON r.env_blob_id = b.id
       WHERE b.business_id = ? AND b.name = ? AND b.is_global = 0
         AND r.repo_owner = ? AND r.repo_name = ?
       ORDER BY b.updated_at DESC, b.id DESC
       LIMIT 1`,
    )
    .bind(businessId, name, repoOwner, repoName)
    .first<RepoEnvBlobStoredRow>();
  return row ?? null;
}

export async function getPersonalEnvBlobForUser(
  db: D1Database,
  ownerUserId: number,
  name: string,
): Promise<(PersonalEnvBlobMetadataRow & { env_text: string; encrypted: number }) | null> {
  const row = await db
    .prepare(
      `SELECT id, owner_user_id, business_id, name, env_text, encrypted, key_names_json,
              COALESCE(entry_meta_json, '{}') AS entry_meta_json, created_at, updated_at
       FROM env_blobs
       WHERE owner_user_id = ? AND name = ? AND is_global = 1
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(ownerUserId, name)
    .first<PersonalEnvBlobMetadataRow & { env_text: string; encrypted: number }>();
  return row ?? null;
}

export async function insertRepoEnvBlobForRepo(
  db: D1Database,
  params: {
    id: string;
    ownerUserId: number;
    businessId: string;
    name: string;
    envText: string;
    encrypted: boolean;
    keyNamesJson: string;
    entryMetaJson: string;
    repoOwner: string;
    repoName: string;
    now: number;
  },
): Promise<void> {
  const insertBlob = db
    .prepare(
      `INSERT INTO env_blobs (
         id, owner_user_id, business_id, name, env_text, encrypted, key_names_json,
         entry_meta_json, is_global, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(
      params.id,
      params.ownerUserId,
      params.businessId,
      params.name,
      params.envText,
      params.encrypted ? 1 : 0,
      params.keyNamesJson,
      params.entryMetaJson,
      params.now,
      params.now,
    );
  const insertRepo = db
    .prepare(
      `INSERT INTO env_blob_repos (env_blob_id, repo_owner, repo_name, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(params.id, params.repoOwner, params.repoName, params.now);

  await db.batch([insertBlob, insertRepo]);
}

export async function insertPersonalEnvBlob(
  db: D1Database,
  params: {
    id: string;
    ownerUserId: number;
    name: string;
    envText: string;
    encrypted: boolean;
    keyNamesJson: string;
    entryMetaJson: string;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO env_blobs (
         id, owner_user_id, business_id, name, env_text, encrypted, key_names_json,
         entry_meta_json, is_global, created_at, updated_at
       )
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      params.id,
      params.ownerUserId,
      params.name,
      params.envText,
      params.encrypted ? 1 : 0,
      params.keyNamesJson,
      params.entryMetaJson,
      params.now,
      params.now,
    )
    .run();
}

// Winner predicate: the row a read selects is ordered by (updated_at DESC, id DESC).
// `id` is a random UUID, so the id tiebreak is positional, not temporal; "newer" means
// "the row a read would currently pick". The optimistic-concurrency version is the pair
// (updated_at, id), never updated_at alone. A blob is newer than (expectedUpdatedAt, keepId)
// iff: updated_at > expectedUpdatedAt OR (updated_at = expectedUpdatedAt AND id > keepId).

// Builds the guarded stale-cleanup DELETE: removes every blob for the repo except `keepId`,
// but only when `keepId` at `winnerUpdatedAt` is still the current winner (no newer blob
// exists). Returned as an unrun prepared statement so it can either run standalone or be
// folded into the same db.batch() as a preceding mutation. Within a batch the cleanup self-
// guards: if the preceding UPDATE changed zero rows, no row matches (keepId, winnerUpdatedAt)
// and the EXISTS guard fails, so nothing is deleted.
function buildGuardedStaleCleanupStatement(
  db: D1Database,
  params: {
    businessId: string;
    name: string;
    repoOwner: string;
    repoName: string;
    keepId: string;
    winnerUpdatedAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM env_blobs
       WHERE business_id = ? AND name = ? AND is_global = 0
         AND id IN (
           SELECT b.id
           FROM env_blobs b
           INNER JOIN env_blob_repos r ON r.env_blob_id = b.id
           WHERE b.business_id = ? AND b.name = ? AND b.is_global = 0
             AND r.repo_owner = ? AND r.repo_name = ? AND b.id <> ?
         )
         AND EXISTS (
           SELECT 1
           FROM env_blobs winner
           INNER JOIN env_blob_repos winner_repo ON winner_repo.env_blob_id = winner.id
           WHERE winner.id = ? AND winner.business_id = ? AND winner.name = ? AND winner.is_global = 0
             AND winner.updated_at = ? AND winner_repo.repo_owner = ? AND winner_repo.repo_name = ?
             AND NOT EXISTS (
               SELECT 1
               FROM env_blobs newer
               INNER JOIN env_blob_repos newer_repo ON newer_repo.env_blob_id = newer.id
               WHERE newer.business_id = winner.business_id
                 AND newer.name = winner.name
                 AND newer.is_global = 0
                 AND newer_repo.repo_owner = winner_repo.repo_owner
                 AND newer_repo.repo_name = winner_repo.repo_name
                 AND (newer.updated_at > winner.updated_at OR (newer.updated_at = winner.updated_at AND newer.id > winner.id))
             )
         )`,
    )
    .bind(
      params.businessId,
      params.name,
      params.businessId,
      params.name,
      params.repoOwner,
      params.repoName,
      params.keepId,
      params.keepId,
      params.businessId,
      params.name,
      params.winnerUpdatedAt,
      params.repoOwner,
      params.repoName,
    );
}

function buildCurrentWinnerStatement(
  db: D1Database,
  params: {
    businessId: string;
    name: string;
    repoOwner: string;
    repoName: string;
    keepId: string;
    expectedUpdatedAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT EXISTS (
         SELECT 1
         FROM env_blobs winner
         INNER JOIN env_blob_repos winner_repo ON winner_repo.env_blob_id = winner.id
         WHERE winner.id = ? AND winner.business_id = ? AND winner.name = ? AND winner.is_global = 0
           AND winner.updated_at = ? AND winner_repo.repo_owner = ? AND winner_repo.repo_name = ?
           AND NOT EXISTS (
             SELECT 1
             FROM env_blobs newer
             INNER JOIN env_blob_repos newer_repo ON newer_repo.env_blob_id = newer.id
             WHERE newer.business_id = winner.business_id
               AND newer.name = winner.name
               AND newer.is_global = 0
               AND newer_repo.repo_owner = winner_repo.repo_owner
               AND newer_repo.repo_name = winner_repo.repo_name
               AND (newer.updated_at > winner.updated_at OR (newer.updated_at = winner.updated_at AND newer.id > winner.id))
           )
       ) AS kept_blob_still_current_winner`,
    )
    .bind(params.keepId, params.businessId, params.name, params.expectedUpdatedAt, params.repoOwner, params.repoName);
}

// Standalone winner-guarded cleanup for paths that did not mutate the winning row this call
// (idempotent upsert, missing-key delete, post-insert create). Deletes other duplicates only
// when `keepId` at `expectedUpdatedAt` is still the current winner, closing the read-then-
// cleanup race for those paths. The follow-up winner check distinguishes "no stale rows to
// delete" from "keepId lost the winner race" so no-op callers can avoid stale metadata.
export async function deleteStaleRepoEnvBlobsForRepoIfCurrentWinner(
  db: D1Database,
  params: {
    businessId: string;
    name: string;
    repoOwner: string;
    repoName: string;
    keepId: string;
    expectedUpdatedAt: number;
  },
): Promise<RepoEnvBlobStaleCleanupResult> {
  const cleanupStale = buildGuardedStaleCleanupStatement(db, {
    businessId: params.businessId,
    name: params.name,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    keepId: params.keepId,
    winnerUpdatedAt: params.expectedUpdatedAt,
  });
  const currentWinner = buildCurrentWinnerStatement(db, params);

  const [cleanupResult, currentWinnerResult] = await db.batch<RepoEnvBlobCurrentWinnerRow>([
    cleanupStale,
    currentWinner,
  ]);
  const currentWinnerValue = currentWinnerResult.results?.[0]?.kept_blob_still_current_winner;
  return {
    staleDeletedCount: cleanupResult.meta?.changes ?? 0,
    keptBlobStillCurrentWinner: currentWinnerValue === true || currentWinnerValue === 1,
  };
}

// Atomic update + stale cleanup. The UPDATE applies only when the expected row still matches
// (id, expectedUpdatedAt) and no newer blob has won the repo. The cleanup runs in the same
// batch and is self-guarded on the just-updated row (keepId, now), so a concurrent winner is
// never removed by a follow-up cleanup. Returns whether the UPDATE changed a row.
//
// INVARIANT: callers must pass `now > expectedUpdatedAt`. The cleanup self-guard matches the
// just-updated winner at `updated_at = now`; if `now <= expectedUpdatedAt` it could match the
// pre-update row even when the UPDATE changed nothing, weakening the guard. The sole caller
// (env-blobs/service.ts) upholds this with `now = Math.max(Date.now(), existing.updatedAt + 1)`.
export async function updateRepoEnvBlobByIdIfUnchangedAndCleanupStale(
  db: D1Database,
  params: {
    id: string;
    expectedUpdatedAt: number;
    ownerUserId: number;
    businessId: string;
    name: string;
    envText: string;
    encrypted: boolean;
    keyNamesJson: string;
    entryMetaJson: string;
    repoOwner: string;
    repoName: string;
    now: number;
  },
): Promise<boolean> {
  const updateCurrent = db
    .prepare(
      `UPDATE env_blobs
       SET owner_user_id = ?, env_text = ?, encrypted = ?, key_names_json = ?, entry_meta_json = ?, updated_at = ?
       WHERE id = ? AND business_id = ? AND name = ? AND is_global = 0 AND updated_at = ?
         AND EXISTS (
           SELECT 1
           FROM env_blob_repos
           WHERE env_blob_id = env_blobs.id AND repo_owner = ? AND repo_name = ?
         )
         AND NOT EXISTS (
           SELECT 1
           FROM env_blobs newer
           INNER JOIN env_blob_repos newer_repo ON newer_repo.env_blob_id = newer.id
           WHERE newer.business_id = env_blobs.business_id
             AND newer.name = env_blobs.name
             AND newer.is_global = 0
             AND newer_repo.repo_owner = ?
             AND newer_repo.repo_name = ?
             AND (newer.updated_at > env_blobs.updated_at OR (newer.updated_at = env_blobs.updated_at AND newer.id > env_blobs.id))
         )`,
    )
    .bind(
      params.ownerUserId,
      params.envText,
      params.encrypted ? 1 : 0,
      params.keyNamesJson,
      params.entryMetaJson,
      params.now,
      params.id,
      params.businessId,
      params.name,
      params.expectedUpdatedAt,
      params.repoOwner,
      params.repoName,
      params.repoOwner,
      params.repoName,
    );
  const cleanupStale = buildGuardedStaleCleanupStatement(db, {
    businessId: params.businessId,
    name: params.name,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    keepId: params.id,
    winnerUpdatedAt: params.now,
  });

  const [updateResult] = await db.batch([updateCurrent, cleanupStale]);
  return d1Changed(updateResult);
}

// Atomic delete + stale cleanup for the empty-env case. Deletes the expected row and every
// older duplicate for the repo in one statement, but only when the expected row
// (id, expectedUpdatedAt) is still the current winner. If a newer blob has won, the EXISTS
// guard fails and nothing is deleted (returns false), so the caller retries and re-resolves
// the now-non-empty env. Newer blobs are never removed.
export async function deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale(
  db: D1Database,
  params: {
    id: string;
    expectedUpdatedAt: number;
    businessId: string;
    name: string;
    repoOwner: string;
    repoName: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM env_blobs
       WHERE business_id = ? AND name = ? AND is_global = 0
         AND id IN (
           SELECT b.id
           FROM env_blobs b
           INNER JOIN env_blob_repos r ON r.env_blob_id = b.id
           WHERE b.business_id = ? AND b.name = ? AND b.is_global = 0
             AND r.repo_owner = ? AND r.repo_name = ?
             AND (b.updated_at < ? OR (b.updated_at = ? AND b.id <= ?))
         )
         AND EXISTS (
           SELECT 1
           FROM env_blobs current
           INNER JOIN env_blob_repos current_repo ON current_repo.env_blob_id = current.id
           WHERE current.id = ? AND current.business_id = ? AND current.name = ? AND current.is_global = 0
             AND current.updated_at = ? AND current_repo.repo_owner = ? AND current_repo.repo_name = ?
             AND NOT EXISTS (
               SELECT 1
               FROM env_blobs newer
               INNER JOIN env_blob_repos newer_repo ON newer_repo.env_blob_id = newer.id
               WHERE newer.business_id = current.business_id
                 AND newer.name = current.name
                 AND newer.is_global = 0
                 AND newer_repo.repo_owner = current_repo.repo_owner
                 AND newer_repo.repo_name = current_repo.repo_name
                 AND (newer.updated_at > current.updated_at OR (newer.updated_at = current.updated_at AND newer.id > current.id))
             )
         )`,
    )
    .bind(
      params.businessId,
      params.name,
      params.businessId,
      params.name,
      params.repoOwner,
      params.repoName,
      params.expectedUpdatedAt,
      params.expectedUpdatedAt,
      params.id,
      params.id,
      params.businessId,
      params.name,
      params.expectedUpdatedAt,
      params.repoOwner,
      params.repoName,
    )
    .run();
  return d1Changed(result);
}

// Version-guarded delete of a just-inserted create-loser blob. Deletes the row only while it is
// still the row this call inserted (id + updated_at unchanged), so a blob that another writer has
// since adopted/updated in place (new updated_at) is preserved instead of being clobbered. Unlike
// deleteRepoEnvBlobByIdIfUnchangedAndCleanupStale there is no "no newer exists" guard: the caller
// deletes precisely when a newer blob already won, and deleting its own unchanged, never-returned
// insert is always safe. env_blob_repos cascades on env_blob_id (migration 0069, ON DELETE CASCADE).
export async function deleteRepoEnvBlobByIdIfVersion(
  db: D1Database,
  params: { businessId: string; name: string; id: string; expectedUpdatedAt: number },
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM env_blobs WHERE id = ? AND business_id = ? AND name = ? AND is_global = 0 AND updated_at = ?")
    .bind(params.id, params.businessId, params.name, params.expectedUpdatedAt)
    .run();
  return d1Changed(result);
}

export async function updatePersonalEnvBlobByIdIfUnchanged(
  db: D1Database,
  params: {
    id: string;
    expectedUpdatedAt: number;
    ownerUserId: number;
    name: string;
    envText: string;
    encrypted: boolean;
    keyNamesJson: string;
    entryMetaJson: string;
    now: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE env_blobs
       SET env_text = ?, encrypted = ?, key_names_json = ?, entry_meta_json = ?, updated_at = ?
       WHERE id = ? AND owner_user_id = ? AND name = ? AND is_global = 1 AND updated_at = ?
         AND NOT EXISTS (
           SELECT 1
           FROM env_blobs newer
           WHERE newer.owner_user_id = env_blobs.owner_user_id
             AND newer.name = env_blobs.name
             AND newer.is_global = 1
             AND (newer.updated_at > env_blobs.updated_at OR (newer.updated_at = env_blobs.updated_at AND newer.id > env_blobs.id))
         )`,
    )
    .bind(
      params.envText,
      params.encrypted ? 1 : 0,
      params.keyNamesJson,
      params.entryMetaJson,
      params.now,
      params.id,
      params.ownerUserId,
      params.name,
      params.expectedUpdatedAt,
    )
    .run();
  return d1Changed(result);
}

// Atomic delete + stale cleanup for personal blobs when deleting the last secret. Deletes the
// expected winner row and every older duplicate in one statement, but only while the expected row
// (id, expectedUpdatedAt) is still the current winner for the user. If a newer blob has won,
// nothing is deleted (returns false) so the caller retries against the new winner.
export async function deletePersonalEnvBlobByIdIfUnchangedAndCleanupStale(
  db: D1Database,
  params: {
    id: string;
    expectedUpdatedAt: number;
    ownerUserId: number;
    name: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM env_blobs
       WHERE owner_user_id = ? AND name = ? AND is_global = 1
         AND id IN (
           SELECT blob.id
           FROM env_blobs blob
           WHERE blob.owner_user_id = ? AND blob.name = ? AND blob.is_global = 1
             AND (blob.updated_at < ? OR (blob.updated_at = ? AND blob.id <= ?))
         )
         AND EXISTS (
           SELECT 1
           FROM env_blobs current
           WHERE current.id = ? AND current.owner_user_id = ? AND current.name = ? AND current.is_global = 1
             AND current.updated_at = ?
             AND NOT EXISTS (
               SELECT 1
               FROM env_blobs newer
               WHERE newer.owner_user_id = current.owner_user_id
                 AND newer.name = current.name
                 AND newer.is_global = 1
                 AND (newer.updated_at > current.updated_at OR (newer.updated_at = current.updated_at AND newer.id > current.id))
             )
         )`,
    )
    .bind(
      params.ownerUserId,
      params.name,
      params.ownerUserId,
      params.name,
      params.expectedUpdatedAt,
      params.expectedUpdatedAt,
      params.id,
      params.id,
      params.ownerUserId,
      params.name,
      params.expectedUpdatedAt,
    )
    .run();
  return d1Changed(result);
}

export async function deletePersonalEnvBlobByIdIfUnchanged(
  db: D1Database,
  params: {
    id: string;
    expectedUpdatedAt: number;
    ownerUserId: number;
    name: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM env_blobs
       WHERE id = ? AND owner_user_id = ? AND name = ? AND is_global = 1 AND updated_at = ?
         AND NOT EXISTS (
           SELECT 1
           FROM env_blobs newer
           WHERE newer.owner_user_id = ?
             AND newer.name = ?
             AND newer.is_global = 1
             AND (newer.updated_at > ? OR (newer.updated_at = ? AND newer.id > ?))
         )`,
    )
    .bind(
      params.id,
      params.ownerUserId,
      params.name,
      params.expectedUpdatedAt,
      params.ownerUserId,
      params.name,
      params.expectedUpdatedAt,
      params.expectedUpdatedAt,
      params.id,
    )
    .run();
  return d1Changed(result);
}

export async function deleteStalePersonalEnvBlobsIfCurrentWinner(
  db: D1Database,
  params: {
    ownerUserId: number;
    name: string;
    keepId: string;
    expectedUpdatedAt: number;
  },
): Promise<{ staleDeletedCount: number; keptBlobStillCurrentWinner: boolean }> {
  const cleanup = db
    .prepare(
      `DELETE FROM env_blobs
       WHERE owner_user_id = ? AND name = ? AND is_global = 1 AND id <> ?
         AND EXISTS (
           SELECT 1
           FROM env_blobs winner
           WHERE winner.id = ? AND winner.owner_user_id = ? AND winner.name = ? AND winner.is_global = 1
             AND winner.updated_at = ?
             AND NOT EXISTS (
               SELECT 1
               FROM env_blobs newer
               WHERE newer.owner_user_id = winner.owner_user_id
                 AND newer.name = winner.name
                 AND newer.is_global = 1
                 AND (newer.updated_at > winner.updated_at OR (newer.updated_at = winner.updated_at AND newer.id > winner.id))
             )
         )`,
    )
    .bind(
      params.ownerUserId,
      params.name,
      params.keepId,
      params.keepId,
      params.ownerUserId,
      params.name,
      params.expectedUpdatedAt,
    );
  const currentWinner = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1
         FROM env_blobs winner
         WHERE winner.id = ? AND winner.owner_user_id = ? AND winner.name = ? AND winner.is_global = 1
           AND winner.updated_at = ?
           AND NOT EXISTS (
             SELECT 1
             FROM env_blobs newer
             WHERE newer.owner_user_id = winner.owner_user_id
               AND newer.name = winner.name
               AND newer.is_global = 1
               AND (newer.updated_at > winner.updated_at OR (newer.updated_at = winner.updated_at AND newer.id > winner.id))
           )
       ) AS kept_blob_still_current_winner`,
    )
    .bind(params.keepId, params.ownerUserId, params.name, params.expectedUpdatedAt);

  const [cleanupResult, currentWinnerResult] = await db.batch<{ kept_blob_still_current_winner: boolean | number }>([
    cleanup,
    currentWinner,
  ]);
  const currentWinnerValue = currentWinnerResult.results?.[0]?.kept_blob_still_current_winner;
  return {
    staleDeletedCount: cleanupResult.meta?.changes ?? 0,
    keptBlobStillCurrentWinner: currentWinnerValue === true || currentWinnerValue === 1,
  };
}

// Version-guarded delete of a just-inserted create-loser personal blob. See
// deleteRepoEnvBlobByIdIfVersion for the rationale: deletes only while the row is unchanged since
// this call inserted it, so a blob adopted/updated by another writer is preserved. This matters
// most for personal blobs, whose cleanup-sensitive delete path must avoid clobbering a row another
// writer has since adopted in place.
export async function deletePersonalEnvBlobByIdIfVersion(
  db: D1Database,
  params: { ownerUserId: number; name: string; id: string; expectedUpdatedAt: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      "DELETE FROM env_blobs WHERE id = ? AND owner_user_id = ? AND name = ? AND is_global = 1 AND updated_at = ?",
    )
    .bind(params.id, params.ownerUserId, params.name, params.expectedUpdatedAt)
    .run();
  return d1Changed(result);
}
