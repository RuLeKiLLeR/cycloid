import { computeSha256Hex } from "../crypto";
import { claimIdempotencyKey, commitIdempotencyKey, releaseIdempotencyKey } from "../db/idempotency-db";

/**
 * Idempotency state machine shared by POST /api/sessions and the prompt-enqueue
 * route. Sits between the route and the `idempotency_keys` DAO (routes ->
 * services -> DAOs). The header is optional: when absent the request proceeds
 * untracked, preserving the legacy (no-key) behavior.
 *
 * Flow for a claimed request:
 *   1. `beginIdempotentRequest` claims the key `pending`.
 *      - first claim          -> { kind: "proceed", token }
 *      - committed, same hash  -> { kind: "replay", resolvedId }
 *      - any claim, diff hash  -> { kind: "reject", 409 } (same key, new payload)
 *      - still pending         -> { kind: "reject", 409 } (retry in progress)
 *   2. On the proceed branch the route creates the resource, then calls
 *      `commitIdempotentRequest(token, resolvedId)` once it durably lands, or
 *      `releaseIdempotentRequest(token)` on a create failure so a retry re-claims.
 */

const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export interface IdempotencyToken {
  ownerUserId: string;
  key: string;
  route: string;
}

export type IdempotencyDecision =
  | { kind: "disabled" }
  | { kind: "proceed"; token: IdempotencyToken }
  | { kind: "replay"; resolvedId: string; token: IdempotencyToken }
  | { kind: "reject"; status: number; reason: string; token: IdempotencyToken };

/** Case-insensitive read of the Idempotency-Key header, trimmed and length-bounded. */
export function readIdempotencyKeyHeader(request: Request): string | null {
  const raw = request.headers.get("Idempotency-Key");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return null;
  return trimmed;
}

/** Deterministic JSON serialization (sorted object keys) so the request hash is stable. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.reduce<Record<string, unknown>>((acc, [k, v]) => {
      acc[k] = canonicalize(v);
      return acc;
    }, {});
  }
  return value;
}

export async function computeRequestHash(body: unknown): Promise<string> {
  return computeSha256Hex(JSON.stringify(canonicalize(body ?? {})));
}

export async function beginIdempotentRequest(
  db: D1Database,
  params: { key: string | null; ownerUserId: string; route: string; requestBody: unknown },
): Promise<IdempotencyDecision> {
  if (!params.key) return { kind: "disabled" };

  const token: IdempotencyToken = { ownerUserId: params.ownerUserId, key: params.key, route: params.route };
  const requestHash = await computeRequestHash(params.requestBody);
  const { created, row } = await claimIdempotencyKey(db, { ...token, requestHash });

  if (created) return { kind: "proceed", token };

  // Same key, different payload: never replay another request's result.
  if (row.requestHash !== requestHash) {
    return { kind: "reject", status: 409, reason: "payload_mismatch", token };
  }
  // Committed: idempotent replay. The row is scoped to this owner, so a found
  // committed row is provably the caller's own prior resource.
  if (row.status === "committed" && row.resolvedId) {
    return { kind: "replay", resolvedId: row.resolvedId, token };
  }
  // Still pending (or committed without a resolved id, which should not happen):
  // a retry is in flight. Tell the client to retry rather than spawn a duplicate.
  return { kind: "reject", status: 409, reason: "in_progress", token };
}

export async function commitIdempotentRequest(
  db: D1Database,
  token: IdempotencyToken,
  resolvedId: string,
): Promise<boolean> {
  return commitIdempotencyKey(db, { ...token, resolvedId });
}

export async function releaseIdempotentRequest(db: D1Database, token: IdempotencyToken): Promise<void> {
  await releaseIdempotencyKey(db, token);
}
