import { SEEDED_BUSINESS_IDS } from "./businesses";

export const ARCANIST_BUSINESS_ID = SEEDED_BUSINESS_IDS.cycloid;

/** KV cache TTL for resolved auth sessions (seconds). Short enough to respect
 *  logout / session deletion within a reasonable window, long enough to
 *  deduplicate the 3–5 parallel auth queries fired on every page load.
 *  Note: Cloudflare KV requires a minimum expirationTtl of 60 seconds. */
export const AUTH_SESSION_CACHE_TTL = 60;
/** Module-local warm-worker cache for the enriched /auth/me response. */
export const AUTH_ME_USER_CACHE_TTL_MS = 30_000;

/** Browser cookie name used for read-only impersonation auth. */
export const IMPERSONATION_COOKIE_NAME = "impersonation_token";

/** TTL for an impersonation session (30 minutes). No auto-extension on use. */
export const IMPERSONATION_TTL_MS = 30 * 60 * 1000;

/** Maximum concurrent active impersonations per actor. */
export const IMPERSONATION_MAX_ACTIVE_PER_ACTOR = 5;

/** Maximum length of the optional reason string for impersonation creation. */
export const IMPERSONATION_REASON_MAX_LENGTH = 500;
