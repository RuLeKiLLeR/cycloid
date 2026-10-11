import { ENVIRONMENT, type Environment } from "../../../../shared/constants/environment.js";
import type {
  SandboxRuntimeBackend,
  SandboxRuntimeProvider,
  SandboxRuntimeState,
} from "../../../../shared/types/sandbox.js";

export const E2B_CLOUD_RUNTIME_BACKEND = "e2b_cloud" as const satisfies SandboxRuntimeBackend;

export const FREESTYLE_RUNTIME_BACKEND = "freestyle" as const satisfies SandboxRuntimeBackend;

export type RuntimeBackend = SandboxRuntimeBackend;

export function parsePersistedRuntimeBackend(value: unknown): RuntimeBackend {
  if (value == null || value === "") return E2B_CLOUD_RUNTIME_BACKEND;
  if (isValidRuntimeBackend(value)) return value;
  throw new Error(`Invalid runtime backend: ${String(value)}`);
}

export function parsePersistedRuntimeBackendOrNull(value: unknown): RuntimeBackend | null {
  try {
    return parsePersistedRuntimeBackend(value);
  } catch {
    return null;
  }
}

export function runtimeBackendOrNull(value: unknown): RuntimeBackend | null {
  if (isValidRuntimeBackend(value)) return value;
  return null;
}

/**
 * Single source of truth for the set of recognized `runtime_provider` vendor tags.
 * Everything that enumerates providers — the {@link runtimeProviderOrNull} /
 * {@link isKnownRuntimeProvider} guards and the cron-cleanup SQL `IN (...)` list —
 * derives from this array, so adding a provider here (alongside its backend in
 * {@link providerForRuntimeBackend}) is the one edit that widens every lifecycle path.
 */
export const KNOWN_RUNTIME_PROVIDERS = ["e2b", "freestyle"] as const satisfies readonly SandboxRuntimeProvider[];

export function runtimeProviderOrNull(value: unknown): SandboxRuntimeProvider | null {
  return KNOWN_RUNTIME_PROVIDERS.includes(value as SandboxRuntimeProvider) ? (value as SandboxRuntimeProvider) : null;
}

/**
 * Single source of truth for deriving the persisted `runtime_provider` vendor tag
 * from the routing/config discriminant `runtime_backend`. The PROVIDER is a derived
 * vendor label (what VM fleet a row belongs to); the BACKEND is the discriminant the
 * control plane uses to pick a client and config. Every `runtime_provider` WRITE must
 * flow through here so a row's provider always equals `providerForRuntimeBackend(backend)`.
 * The switch is exhaustive on `RuntimeBackend`, so adding a future backend is a
 * compile error here (forcing an explicit provider mapping) rather than a silent
 * mislabel downstream.
 */
export function providerForRuntimeBackend(backend: RuntimeBackend): SandboxRuntimeProvider {
  switch (backend) {
    case E2B_CLOUD_RUNTIME_BACKEND:
      return "e2b";
    case FREESTYLE_RUNTIME_BACKEND:
      return "freestyle";
  }
}

/**
 * "Has a managed runtime" predicate: true iff `value` is a recognized
 * `runtime_provider` vendor tag. Consistent with {@link runtimeProviderOrNull}
 * (both admit exactly `"e2b"` and `"freestyle"`). Lifecycle guards use this as the
 * provider-agnostic replacement for the legacy `runtimeProvider === "e2b"` literal —
 * a row for ANY known provider must be admitted to idle-pause, refresh, cleanup,
 * resume, and projection paths, or its VM leaks / wedges with no error. A cleared row
 * (`runtime_provider IS NULL`) or a session that never had a managed runtime is
 * correctly excluded.
 */
export function isKnownRuntimeProvider(value: unknown): value is SandboxRuntimeProvider {
  return runtimeProviderOrNull(value) != null;
}

export function runtimeStateOrNull(value: unknown): SandboxRuntimeState | null {
  return value === "running" || value === "paused" || value === "killed" ? value : null;
}

export function resolveRuntimeBackendForRepoSession(options: {
  inheritedRuntimeBackend?: string | null;
}): RuntimeBackend {
  if (options.inheritedRuntimeBackend != null && options.inheritedRuntimeBackend !== "") {
    return parsePersistedRuntimeBackend(options.inheritedRuntimeBackend);
  }
  return E2B_CLOUD_RUNTIME_BACKEND;
}

export function isValidRuntimeBackend(value: unknown): value is RuntimeBackend {
  return value === E2B_CLOUD_RUNTIME_BACKEND || value === FREESTYLE_RUNTIME_BACKEND;
}

const OVERRIDE_ORG_PREFIX = "org:";

/**
 * Freestyle routing override. `rawOverride` is the literal `all` (local only) or a
 * comma-separated list where each entry is either a numeric owner user ID or
 * `org:<repo-owner>` (matched case-insensitively against the session repo's owner —
 * e.g. `org:trycycloid` routes only sessions on trycycloid repos). Returns the
 * freestyle backend when any entry selects this session, otherwise `null` (caller
 * falls back to e2b_cloud). Fails closed on every ambiguous input: unset/empty
 * override, ANY malformed list entry (empty segment, non-numeric id, empty/invalid
 * org slug) — a typo disables the whole override rather than silently routing the
 * entries that do parse — and entries whose subject cannot be resolved (no owner id /
 * no repo owner) simply never match. New-session-only — callers must only consult
 * this on the unpinned-affinity path so live/resumed sessions are never re-routed.
 *
 * `all` routes EVERY session to freestyle and is honored ONLY when `environment` is
 * local. A fat-fingered `all` in a deployed `[vars]` would route all customer traffic
 * onto the single shared Freestyle team — the exact env-isolation blast radius the
 * org-locked rollout gates. Outside local it is treated as invalid config: the
 * override degrades to UNSET (this session keeps default e2b_cloud routing) and
 * `onRejectAllOutsideLocal` fires so the caller can emit a loud structured error. This
 * is deliberately a silent fall-through, NOT a hard throw — throwing would convert a
 * one-line config typo into an outage on every session, the opposite failure mode.
 */
export function resolveDogfoodFreestyleOverride(
  rawOverride: string | null | undefined,
  ownerUserId: string | null | undefined,
  repoOwner: string | null | undefined,
  environment: Environment,
  onRejectAllOutsideLocal?: () => void,
): RuntimeBackend | null {
  const trimmed = rawOverride?.trim();
  if (!trimmed) return null;
  if (trimmed === "all") {
    if (environment === ENVIRONMENT.Local) return FREESTYLE_RUNTIME_BACKEND;
    onRejectAllOutsideLocal?.();
    return null;
  }
  const entries = trimmed.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    const isOrg = entry.toLowerCase().startsWith(OVERRIDE_ORG_PREFIX);
    const valid = isOrg
      ? /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(entry.slice(OVERRIDE_ORG_PREFIX.length))
      : /^\d+$/.test(entry);
    if (!valid) return null;
  }
  const owner = ownerUserId != null && ownerUserId !== "" ? String(ownerUserId) : null;
  const repo = repoOwner?.trim().toLowerCase() || null;
  const matched = entries.some((entry) =>
    entry.toLowerCase().startsWith(OVERRIDE_ORG_PREFIX)
      ? repo !== null && entry.slice(OVERRIDE_ORG_PREFIX.length).toLowerCase() === repo
      : owner !== null && entry === owner,
  );
  return matched ? FREESTYLE_RUNTIME_BACKEND : null;
}
