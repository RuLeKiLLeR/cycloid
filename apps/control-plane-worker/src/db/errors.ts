import { stringifyError } from "../../../../shared/utils/errors.js";

/**
 * Opt-in marker enabling the transient-error retry loop on `run` terminals in
 * the traced D1 wrapper (observability/wrappers.ts). Adding it to a statement
 * asserts the DAO author verified the statement is idempotent under replay AND
 * tolerant of `meta.changes` ambiguity (a retry of a committed INSERT OR
 * IGNORE reports changes = 0, i.e. "duplicate"). Lives here (not in the
 * wrapper module) so DAO files do not depend on the observability layer.
 */
export const D1_RETRY_SAFE_MARKER = "/* d1-retry-safe */";

/**
 * Thrown when a request's user_id no longer has a row in `users` (e.g. a stale
 * KV-cached session for a user a repair migration deleted or renumbered). The
 * authoritative detection point is any query that joins `users` (auth extras,
 * lazy user_settings insert). Routes map this to 401 so the client
 * re-authenticates; we fail closed rather than resurrect the user. Lives here
 * (shared) so both the auth and settings layers throw the same class and route
 * `instanceof` checks resolve consistently.
 */
export class UserRowMissingError extends Error {
  constructor(readonly userId: number) {
    super(`No users row for user_id ${userId}; request rejected`);
    this.name = "UserRowMissingError";
  }
}

export function d1Changed(result: D1Result): boolean {
  if ((result as { success?: boolean }).success === false) return false;
  const changes = (result.meta as { changes?: number } | undefined)?.changes;
  return typeof changes === "number" ? changes > 0 : false;
}

function transientStorageMatchText(error: unknown): string {
  const parts = [stringifyError(error)];
  if (error instanceof Error && error.cause !== undefined && error.cause !== null) {
    parts.push(error.cause instanceof Error ? error.cause.message : String(error.cause));
  }
  return parts.join(" ").toLowerCase();
}

// Load-shed is never transient: retrying amplifies a saturated single-writer, and
// scheduled-task suppression must not mask sustained pressure.
function isLoadShedText(message: string): boolean {
  return message.includes("overloaded") || message.includes("queued for too long");
}

function hasTransientD1StorageSubstring(message: string): boolean {
  // "storage operation exceeded timeout" is only transient when paired with a
  // reset; the timeout alone can accompany a non-retryable fault.
  if (message.includes("storage operation exceeded timeout") && message.includes("reset")) return true;
  return message.includes("network connection lost");
}

export function isTransientD1StorageError(error: unknown): boolean {
  const message = transientStorageMatchText(error);
  const isD1Error = message.includes("d1_error") || message.includes("d1 db");
  if (!isD1Error) return false;

  if (isLoadShedText(message)) return false;

  // `internal error` is a transient platform fault that is safe to retry on idempotent
  // writes (D1 does not auto-retry writes; it already auto-retries reads). The bare
  // `internal error` match is safe here because it is gated behind the d1_error/d1 db
  // prefix above.
  return (
    hasTransientD1StorageSubstring(message) ||
    message.includes("internal error") ||
    // Wrapper-generated per-attempt timeout (observability/wrappers.ts): a hung
    // read attempt is treated as the same transient platform-stall class.
    message.includes("synthetic per-attempt timeout")
  );
}

/**
 * A bare Cloudflare platform fault of the form `internal error; reference = <id>`,
 * surfaced by a Durable Object / subrequest call (not a D1 statement, so it carries
 * no `d1_error` prefix and `isTransientD1StorageError` deliberately ignores it). It is
 * a transient platform blip that succeeds on a later attempt, so callers driving
 * idempotent work should defer-and-retry rather than treat it as a permanent failure.
 * Load-shed (`overloaded` / `queued for too long`) is excluded: retrying amplifies a
 * saturated backend, matching the D1 classifier's stance.
 */
export function isTransientDurableObjectInternalError(error: unknown): boolean {
  const message = transientStorageMatchText(error);
  if (isLoadShedText(message)) return false;
  return /internal error;\s*reference\s*=/.test(message);
}
