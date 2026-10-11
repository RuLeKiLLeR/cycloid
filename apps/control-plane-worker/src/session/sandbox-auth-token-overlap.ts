/**
 * Pure logic for the sandbox HTTP auth-token grace overlap.
 *
 * On every WS accept (including a transport reconnect) the control plane mints a
 * fresh `sandbox_auth_token_hash`. A still-running bridge whose transport
 * reconnected but that has not yet adopted the new token keeps presenting the
 * prior token on its in-flight REST calls; we accept that prior token for a
 * bounded window instead of 403-ing the work.
 *
 * A deploy/network storm can roll the token through several generations in quick
 * succession, so a single prior slot is not enough: an in-flight call against a
 * 2-generations-old token would still be rejected. We therefore retain up to
 * `SANDBOX_AUTH_TOKEN_OVERLAP_GENERATIONS` prior hashes, each with its own
 * expiry, newest-first. Only hashes are stored (never the token value), every
 * entry expires within the overlap window, and the list is hard-capped so the
 * accepted-token surface stays bounded.
 */

export interface SandboxAuthTokenGeneration {
  /** SHA-256 hex of a prior live auth token. */
  hash: string;
  /** Unix ms after which this generation is no longer accepted. */
  expiresAt: number;
}

function isGeneration(value: unknown): value is SandboxAuthTokenGeneration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SandboxAuthTokenGeneration).hash === "string" &&
    (value as SandboxAuthTokenGeneration).hash.length > 0 &&
    typeof (value as SandboxAuthTokenGeneration).expiresAt === "number" &&
    Number.isFinite((value as SandboxAuthTokenGeneration).expiresAt)
  );
}

/**
 * Parse the JSON-encoded prior-generation list. Tolerates null / legacy / empty
 * / malformed values by returning an empty list (fail toward "no grace"), never
 * throwing on a bad row.
 */
export function parseAuthTokenGenerations(raw: string | null | undefined): SandboxAuthTokenGeneration[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isGeneration);
}

/** Serialize a prior-generation list for storage. */
export function serializeAuthTokenGenerations(list: SandboxAuthTokenGeneration[]): string {
  return JSON.stringify(list);
}

/** Drop already-expired generations (eager expiry on every read/write). */
export function selectValidAuthTokenGenerations(
  list: SandboxAuthTokenGeneration[],
  now: number,
): SandboxAuthTokenGeneration[] {
  return list.filter((gen) => gen.expiresAt > now);
}

/**
 * Roll the outgoing live hash into the prior-generation list.
 *
 * - prunes already-expired entries,
 * - prepends `outgoingHash` (newest-first) when it is non-null and not already
 *   the newest entry (dedupe rapid no-op rotations),
 * - caps the list at `maxGenerations`, dropping the oldest.
 *
 * Returns the new list. With a null `outgoingHash` it just prunes expired
 * entries (hygiene on writes that are not a real rotation).
 */
export function rollAuthTokenGenerations(args: {
  existing: SandboxAuthTokenGeneration[];
  outgoingHash: string | null;
  now: number;
  overlapMs: number;
  maxGenerations: number;
}): SandboxAuthTokenGeneration[] {
  const { existing, outgoingHash, now, overlapMs, maxGenerations } = args;
  const pruned = selectValidAuthTokenGenerations(existing, now);
  if (!outgoingHash || pruned[0]?.hash === outgoingHash) {
    return pruned.slice(0, Math.max(0, maxGenerations));
  }
  // Re-rolling a hash that already exists deeper in the list should refresh it to
  // the newest slot rather than keep a duplicate.
  const withoutDup = pruned.filter((gen) => gen.hash !== outgoingHash);
  const next: SandboxAuthTokenGeneration[] = [{ hash: outgoingHash, expiresAt: now + overlapMs }, ...withoutDup];
  return next.slice(0, Math.max(0, maxGenerations));
}
