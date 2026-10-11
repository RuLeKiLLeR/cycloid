import type { BootstrapResponse } from "../../../../shared/types/bootstrap";
import type { AuthProbeResult } from "../api/auth-probe";
import type { User } from "../types";

const AUTH_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

export type PrefetchedAuthenticatedHydration = {
  bootstrapPromise: Promise<BootstrapResponse>;
  sessionsPromise: Promise<import("../api/sessions").FetchSessionsResult>;
  sessionsScope: "personal" | "business";
  sessionsStatus: import("../types").SessionStatus | null;
};

type FetchUserOptions = {
  fresh?: boolean;
};

export type LayoutAuthOrchestration = {
  fetchUser: (options?: FetchUserOptions) => Promise<AuthProbeResult<User>>;
  logoutUser: () => Promise<void>;
  applyUserState: (nextUser: User | null, authStateVersion: number) => boolean;
  syncUserContext: (nextUser: User | null, authStateVersion: number) => Promise<void>;
  hydrateAuthenticatedLayout: (
    prefetched: PrefetchedAuthenticatedHydration | undefined,
    authStateVersion: number,
  ) => Promise<void>;
  refreshStartupData: (
    bootstrapPromise: Promise<BootstrapResponse> | undefined,
    authStateVersion: number,
    options?: { capabilitiesOnly?: boolean },
  ) => Promise<void>;
  prefetchAuthenticatedHydration: () => PrefetchedAuthenticatedHydration;
  shouldPrefetchAuthenticatedStartupData: (pathname: string) => boolean;
  getUser: () => User | null | undefined;
  getAuthStateVersion: () => number;
  clearRequestCache: () => void;
  invalidateAuthStateRequests: () => void;
  getRefreshInFlight: () => Promise<AuthProbeResult<User>> | null;
  setRefreshInFlight: (promise: Promise<AuthProbeResult<User>> | null) => void;
  getLastAuthRefreshAt: () => number;
  setLastAuthRefreshAt: (value: number) => void;
  setUserFreshValidated: (value: boolean) => void;
  writeAuthenticatedHint: (isAuthenticated: boolean) => void;
  resetAuthenticatedState: () => void;
  clearLoggedOutUserContext?: () => Promise<void> | void;
  onClearLoggedOutUserContextError?: (error: unknown) => void;
  now: () => number;
  onInitialLoadError?: (error: unknown) => void;
  onSyncAuthenticatedUserError?: (error: unknown) => void;
  onLoadAuthenticatedUserError?: (error: unknown) => void;
};

function isCurrentAuthStateVersion(orchestration: LayoutAuthOrchestration, authStateVersion: number) {
  return orchestration.getAuthStateVersion() === authStateVersion;
}

export async function loadInitialLayoutAuthState(
  orchestration: LayoutAuthOrchestration,
  { initialUser, pathname }: { initialUser?: User | null; pathname: string },
) {
  // Initial auth state may come from a cached /auth/me response. Only explicit
  // fresh probes may validate integration fields for HomePage reconnect alerts.
  if (initialUser) {
    const authStateVersion = orchestration.getAuthStateVersion();
    try {
      if (!orchestration.applyUserState(initialUser, authStateVersion)) return;
      orchestration.setLastAuthRefreshAt(orchestration.now());
      try {
        await orchestration.syncUserContext(initialUser, authStateVersion);
      } catch (error) {
        orchestration.onSyncAuthenticatedUserError?.(error);
      }
      if (!isCurrentAuthStateVersion(orchestration, authStateVersion)) return;
      await orchestration.hydrateAuthenticatedLayout(undefined, authStateVersion);
    } catch (error) {
      orchestration.onLoadAuthenticatedUserError?.(error);
    }
    return;
  }

  if (initialUser === null) {
    orchestration.applyUserState(null, orchestration.getAuthStateVersion());
    return;
  }

  const authStateVersion = orchestration.getAuthStateVersion();
  const prefetchedHydration = orchestration.shouldPrefetchAuthenticatedStartupData(pathname)
    ? orchestration.prefetchAuthenticatedHydration()
    : undefined;

  try {
    const result = await orchestration.fetchUser();
    if (result.status === "transient") {
      orchestration.onInitialLoadError?.(new Error("Initial auth state unavailable"));
      return;
    }
    const nextUser = result.status === "authenticated" ? result.value : null;
    if (!orchestration.applyUserState(nextUser, authStateVersion) || !nextUser) return;
    orchestration.setLastAuthRefreshAt(orchestration.now());
    await orchestration.syncUserContext(nextUser, authStateVersion);
    if (!isCurrentAuthStateVersion(orchestration, authStateVersion)) return;
    await orchestration.hydrateAuthenticatedLayout(prefetchedHydration, authStateVersion);
  } catch (error) {
    orchestration.onInitialLoadError?.(error);
  }
}

export async function refreshLayoutUser(orchestration: LayoutAuthOrchestration) {
  const authStateVersion = orchestration.getAuthStateVersion();
  const result = await orchestration.fetchUser({ fresh: true });
  if (result.status === "transient") return;
  const nextUser = result.status === "authenticated" ? result.value : null;
  if (!orchestration.applyUserState(nextUser, authStateVersion)) return;
  await orchestration.syncUserContext(nextUser, authStateVersion);
  if (!isCurrentAuthStateVersion(orchestration, authStateVersion)) return;
  if (!nextUser) {
    orchestration.resetAuthenticatedState();
    return;
  }
  orchestration.setUserFreshValidated(true);
  orchestration.setLastAuthRefreshAt(orchestration.now());
  await orchestration.refreshStartupData(undefined, authStateVersion);
}

// Coalesce overlapping focus-triggered refreshes through the shared in-flight
// guard: a refresh already running (throttled or full) is awaited rather than
// duplicated, so rapid focus events fire at most one request at a time.
async function runCoalescedAuthRefresh(
  orchestration: LayoutAuthOrchestration,
  run: () => Promise<AuthProbeResult<User>>,
): Promise<void> {
  const inFlight = orchestration.getRefreshInFlight();
  if (inFlight) {
    await inFlight;
    return;
  }

  const refreshPromise = run();
  orchestration.setRefreshInFlight(refreshPromise);
  try {
    await refreshPromise;
  } finally {
    if (orchestration.getRefreshInFlight() === refreshPromise) {
      orchestration.setRefreshInFlight(null);
    }
  }
}

export async function refreshLayoutAuthState(orchestration: LayoutAuthOrchestration) {
  const authStateVersion = orchestration.getAuthStateVersion();
  const prevUser = orchestration.getUser();
  const hadUser = !!prevUser;
  const withinThrottleWindow =
    hadUser && orchestration.now() - orchestration.getLastAuthRefreshAt() < AUTH_REFRESH_MIN_INTERVAL_MS;

  await runCoalescedAuthRefresh(orchestration, async () => {
    // Always re-pull /auth/me on focus. Fields like slackWorkspaceInstalled,
    // integration scopes, businessRole, and egressAllowlist flip when a
    // teammate/admin/webhook acts -- never via the viewer's own clicks --
    // so throttling this fetch silently strands the UI on stale state.
    // `fresh: true` (?fresh=1) bypasses the server-side AUTH_ME_USER_CACHE
    // because that cache lives per worker isolate, so an admin-side install
    // that invalidated one isolate may not have invalidated the one serving
    // this user. Cost is one batched D1 read per focus event, bounded
    // against bursts by runCoalescedAuthRefresh's in-flight guard.
    const result = await orchestration.fetchUser({ fresh: true });
    if (result.status === "transient") return result;
    const nextUser = result.status === "authenticated" ? result.value : null;
    if (!orchestration.applyUserState(nextUser, authStateVersion)) return result;
    await orchestration.syncUserContext(nextUser, authStateVersion);
    if (!isCurrentAuthStateVersion(orchestration, authStateVersion)) return result;

    if (!nextUser) {
      if (hadUser) orchestration.resetAuthenticatedState();
      return result;
    }

    const identityChanged = !!prevUser && prevUser.id !== nextUser.id;
    orchestration.setUserFreshValidated(true);
    if (identityChanged || !hadUser) {
      // Account switched (logout-in-other-tab, impersonation) or first
      // authenticated render -- full hydrate so sessions/repos/models rebuild
      // against the new identity rather than mixing with the old.
      if (identityChanged) orchestration.clearRequestCache();
      await orchestration.hydrateAuthenticatedLayout(undefined, authStateVersion);
      orchestration.setLastAuthRefreshAt(orchestration.now());
      return result;
    }

    // Bootstrap join (repos + models + ssoOrgs) stays throttled because it's
    // the expensive part. capabilitiesOnly still applies the lighter fields
    // (user, ssoOrgs, models, settings, capabilities) so teammate-driven
    // changes propagate.
    if (withinThrottleWindow) {
      await orchestration.refreshStartupData(undefined, authStateVersion, { capabilitiesOnly: true });
    } else {
      await orchestration.refreshStartupData(undefined, authStateVersion);
      orchestration.setLastAuthRefreshAt(orchestration.now());
    }
    return result;
  });
}

export async function logoutLayoutUser(orchestration: LayoutAuthOrchestration) {
  orchestration.invalidateAuthStateRequests();
  await orchestration.logoutUser();
  try {
    await orchestration.clearLoggedOutUserContext?.();
  } catch (error) {
    orchestration.onClearLoggedOutUserContextError?.(error);
  }
  orchestration.writeAuthenticatedHint(false);
  orchestration.resetAuthenticatedState();
}
