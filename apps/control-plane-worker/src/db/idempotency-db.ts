import { D1_RETRY_SAFE_MARKER, d1Changed } from "./errors";

/**
 * DAO for the `idempotency_keys` claim-before-create primitive (migration
 * 0162). The state machine lives in the idempotency service; this module owns
 * only the atomic SQL. All three writes are single-statement and key on the
 * `(owner_user_id, key, route)` primary key, so concurrent retries serialize on
 * the conflict / CAS rather than a read-then-write TOCTOU.
 */

export type IdempotencyStatus = "pending" | "committed";

export interface IdempotencyRecord {
  ownerUserId: string;
  key: string;
  route: string;
  requestHash: string;
  resolvedId: string | null;
  status: IdempotencyStatus;
  createdAt: number;
  updatedAt: number;
}

interface IdempotencyRow {
  owner_user_id: string;
  key: string;
  route: string;
  request_hash: string;
  resolved_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface IdempotencyKeyIdentity {
  ownerUserId: string;
  key: string;
  route: string;
}

function mapRow(row: IdempotencyRow): IdempotencyRecord {
  return {
    ownerUserId: String(row.owner_user_id),
    key: String(row.key),
    route: String(row.route),
    requestHash: String(row.request_hash),
    resolvedId: row.resolved_id === null ? null : String(row.resolved_id),
    status: (row.status as IdempotencyStatus) ?? "pending",
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getIdempotencyKey(
  db: D1Database,
  identity: IdempotencyKeyIdentity,
): Promise<IdempotencyRecord | null> {
  const row = await db
    .prepare(
      `SELECT owner_user_id, "key", route, request_hash, resolved_id, status, created_at, updated_at
       FROM idempotency_keys
       WHERE owner_user_id = ? AND "key" = ? AND route = ?
       LIMIT 1`,
    )
    .bind(identity.ownerUserId, identity.key, identity.route)
    .first<IdempotencyRow>();
  return row ? mapRow(row) : null;
}

/**
 * Atomically claim a key. Returns `created: true` only for the first caller;
 * a concurrent or replayed claim returns `created: false` with the existing
 * row so the caller's state machine can decide replay vs. reject. The insert
 * is idempotent on the primary key, so a transient-error retry is safe.
 */
export async function claimIdempotencyKey(
  db: D1Database,
  params: { ownerUserId: string; key: string; route: string; requestHash: string; now?: number },
): Promise<{ created: boolean; row: IdempotencyRecord }> {
  const now = params.now ?? Date.now();
  const result = await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} INSERT INTO idempotency_keys (
         owner_user_id, "key", route, request_hash, resolved_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 'pending', ?, ?)
       ON CONFLICT(owner_user_id, "key", route) DO NOTHING`,
    )
    .bind(params.ownerUserId, params.key, params.route, params.requestHash, now, now)
    .run();

  const created = d1Changed(result);
  if (created) {
    return {
      created: true,
      row: {
        ownerUserId: params.ownerUserId,
        key: params.key,
        route: params.route,
        requestHash: params.requestHash,
        resolvedId: null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  const existing = await getIdempotencyKey(db, params);
  if (existing) return { created: false, row: existing };
  // The conflicting row vanished between the insert and the re-read (a
  // concurrent release). Re-claim: the slot is free again.
  return claimIdempotencyKey(db, params);
}

/**
 * CAS the pending claim to `committed` with the resolved resource id. Returns
 * true only when a still-`pending` row was transitioned, so a double-commit or
 * a commit racing a release reports false instead of overwriting.
 */
export async function commitIdempotencyKey(
  db: D1Database,
  params: { ownerUserId: string; key: string; route: string; resolvedId: string; now?: number },
): Promise<boolean> {
  const now = params.now ?? Date.now();
  const result = await db
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'committed', resolved_id = ?, updated_at = ?
       WHERE owner_user_id = ? AND "key" = ? AND route = ? AND status = 'pending'`,
    )
    .bind(params.resolvedId, now, params.ownerUserId, params.key, params.route)
    .run();
  return d1Changed(result);
}

/**
 * Release a pending claim after a create failure so a later retry re-claims
 * instead of hitting a poisoned `pending` row. Only deletes while still
 * `pending`: a row that committed in the meantime is left intact. The delete
 * is idempotent, so retrying the release is safe.
 */
export async function releaseIdempotencyKey(db: D1Database, identity: IdempotencyKeyIdentity): Promise<void> {
  await db
    .prepare(
      `${D1_RETRY_SAFE_MARKER} DELETE FROM idempotency_keys
       WHERE owner_user_id = ? AND "key" = ? AND route = ? AND status = 'pending'`,
    )
    .bind(identity.ownerUserId, identity.key, identity.route)
    .run();
}
