/**
 * Provider-agnostic classification of an authenticated provider API failure,
 * used by the reactive integration-health path to decide whether a failure is a
 * durable installer-auth problem (the integration is broken until the installer
 * reconnects) or something that must NOT disconnect the integration (a transient
 * 5xx, a 429 storm, or a resource-scoped 403 on a single object).
 *
 * Why a flag instead of "401/403 always means token revoked": the scheduled
 * health probe hits a fixed token-scoped endpoint, where 401/403 is unambiguous.
 * But the reactive call sites also include resource endpoints (e.g. fetching one
 * Jira issue), where a 403 usually means "this token can't see this object", not
 * "this token is dead". Degrading on those would produce false disconnects, so
 * resource-scoped callers pass `resourceScoped: true` and only a 401 is treated
 * as durable auth.
 */
export type ProviderFailureDurability =
  | "durable_auth" // installer token rejected/expired/revoked -> reconnect required
  | "resource_scope" // 403 on a resource endpoint -> object permission, not token death
  | "rate_limited" // 429
  | "transient" // 5xx / upstream unavailable
  | "client_error"; // other 4xx (request-shape problems, not token state)

export interface ProviderHttpFailure {
  durability: ProviderFailureDurability;
  /** Stable diagnostic tag, safe for logs/metrics (no provider payloads). */
  diagnostic: string;
}

/**
 * Classify a non-2xx HTTP status from an authenticated provider call.
 *
 * `resourceScoped` distinguishes token/app-scoped endpoints (webhook
 * registration, refresh, accessible-resources) from object-scoped endpoints
 * (fetching a single issue). On resource endpoints a 403 is treated as a
 * resource-permission failure, not a durable auth failure.
 */
export function classifyProviderHttpFailure(status: number, opts: { resourceScoped: boolean }): ProviderHttpFailure {
  if (status === 401) return { durability: "durable_auth", diagnostic: "provider_auth_rejected" };
  if (status === 403) {
    return opts.resourceScoped
      ? { durability: "resource_scope", diagnostic: "provider_resource_forbidden" }
      : { durability: "durable_auth", diagnostic: "provider_auth_rejected" };
  }
  if (status === 429) return { durability: "rate_limited", diagnostic: "provider_rate_limited" };
  if (status >= 500) return { durability: "transient", diagnostic: "provider_unavailable" };
  return { durability: "client_error", diagnostic: "provider_client_error" };
}
