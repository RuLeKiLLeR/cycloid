import { describe, expect, it, vi } from "vitest";

import type { AuthProbeResult } from "../../apps/ui/src/api/auth-probe";
import {
  type LayoutAuthOrchestration,
  loadInitialLayoutAuthState,
  logoutLayoutUser,
  type PrefetchedAuthenticatedHydration,
  refreshLayoutAuthState,
  refreshLayoutUser,
} from "../../apps/ui/src/components/layout-auth-orchestration";
import type { User } from "../../apps/ui/src/types";
import type { BootstrapResponse } from "../../shared/types/bootstrap";

const AUTH_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const MOCK_USER: User = {
  id: 1,
  login: "layout-user",
  name: "Layout User",
  email: "layout@example.com",
  avatarUrl: "https://example.com/avatar.png",
  businessId: "biz-1",
  businessRole: "admin",
  sharedSessions: false,
  linearConnected: false,
  jiraConnected: false,
  jiraSiteName: null,
  notionConnected: false,
  slackConnected: false,
  slackNeedsReconnect: false,
};

function authenticatedUser(user: User = MOCK_USER): AuthProbeResult<User> {
  return { status: "authenticated", value: user };
}

function unauthenticatedUser(): AuthProbeResult<User> {
  return { status: "unauthenticated" };
}

function transientUser(): AuthProbeResult<User> {
  return { status: "transient" };
}

function createPrefetchedHydration(): PrefetchedAuthenticatedHydration {
  const bootstrap: BootstrapResponse = {
    authenticated: true,
    user: {
      id: MOCK_USER.id,
      login: MOCK_USER.login,
      name: MOCK_USER.name,
      email: MOCK_USER.email,
      avatarUrl: MOCK_USER.avatarUrl,
      businessId: MOCK_USER.businessId,
      businessRole: MOCK_USER.businessRole,
      sharedSessions: MOCK_USER.sharedSessions,
      linearConnected: MOCK_USER.linearConnected,
      jiraConnected: MOCK_USER.jiraConnected,
      jiraSiteName: MOCK_USER.jiraSiteName,
      notionConnected: MOCK_USER.notionConnected,
      slackConnected: MOCK_USER.slackConnected,
      slackNeedsReconnect: MOCK_USER.slackNeedsReconnect,
      egressAllowlist: null,
      isCycloidAdmin: false,
    },
    capabilities: {
      canAccessIntegrationDebug: true,
      canManageBusinessIntegrations: true,
      canManageCliTokens: true,
      canUseBusinessSessions: false,
      canAdminPendingSignups: false,
      canStartSupportView: false,
      canUseInternalModelProviderKeys: false,
      computerUse: false,
      canUseControlRoom: false,
      planApproval: false,
    },
    models: [],
    repos: [],
    reposPending: false,
    ssoOrgs: [],
    settings: {
      defaultPrDraft: false,
      autoVerifyEnabled: true,
      automaticReviewsEnabled: false,
      planMode: "off",
      planApprovalRequired: false,
      settingsProfile: "custom",
      useCodexSubscription: false,
      defaultModel: null,
      defaultRepo: null,
      apiKeys: {},
    },
    warnings: [],
  };

  return {
    bootstrapPromise: Promise.resolve(bootstrap),
    sessionsPromise: Promise.resolve({ sessions: [], nextCursor: null }),
    sessionsScope: "personal",
    sessionsStatus: null,
  };
}

function createOrchestration(overrides: Partial<LayoutAuthOrchestration> = {}) {
  let authStateVersion = 0;
  let currentUser: User | null | undefined = undefined;
  let refreshInFlight: Promise<AuthProbeResult<User>> | null = null;
  let lastAuthRefreshAt = 0;
  let now = 1_000;

  const orchestration: LayoutAuthOrchestration = {
    fetchUser: vi.fn(async () => unauthenticatedUser()),
    logoutUser: vi.fn(async () => undefined),
    applyUserState: vi.fn((nextUser: User | null) => {
      currentUser = nextUser;
      return true;
    }),
    syncUserContext: vi.fn(async () => undefined),
    hydrateAuthenticatedLayout: vi.fn(async () => undefined),
    refreshStartupData: vi.fn(async () => undefined),
    prefetchAuthenticatedHydration: vi.fn(createPrefetchedHydration),
    shouldPrefetchAuthenticatedStartupData: vi.fn(() => false),
    getUser: vi.fn(() => currentUser),
    getAuthStateVersion: vi.fn(() => authStateVersion),
    clearRequestCache: vi.fn(),
    invalidateAuthStateRequests: vi.fn(() => {
      authStateVersion += 1;
      refreshInFlight = null;
    }),
    getRefreshInFlight: vi.fn(() => refreshInFlight),
    setRefreshInFlight: vi.fn((promise: Promise<AuthProbeResult<User>> | null) => {
      refreshInFlight = promise;
    }),
    getLastAuthRefreshAt: vi.fn(() => lastAuthRefreshAt),
    setLastAuthRefreshAt: vi.fn((value: number) => {
      lastAuthRefreshAt = value;
    }),
    setUserFreshValidated: vi.fn(),
    writeAuthenticatedHint: vi.fn(),
    resetAuthenticatedState: vi.fn(() => {
      currentUser = null;
    }),
    clearLoggedOutUserContext: vi.fn(async () => undefined),
    onClearLoggedOutUserContextError: vi.fn(),
    now: vi.fn(() => now),
    onInitialLoadError: vi.fn(),
    onSyncAuthenticatedUserError: vi.fn(),
    onLoadAuthenticatedUserError: vi.fn(),
  };

  Object.assign(orchestration, overrides);

  return {
    orchestration,
    setNow(value: number) {
      now = value;
    },
    setUser(value: User | null | undefined) {
      currentUser = value;
    },
    setLastAuthRefreshAt(value: number) {
      lastAuthRefreshAt = value;
    },
  };
}

describe("layout auth orchestration", () => {
  it("prefetches authenticated hydration before the initial auth probe resolves", async () => {
    const fetchUserResult = deferred<AuthProbeResult<User>>();
    const prefetchedHydration = createPrefetchedHydration();
    const { orchestration } = createOrchestration({
      fetchUser: vi.fn(() => fetchUserResult.promise),
      prefetchAuthenticatedHydration: vi.fn(() => prefetchedHydration),
      shouldPrefetchAuthenticatedStartupData: vi.fn(() => true),
    });

    const loadPromise = loadInitialLayoutAuthState(orchestration, {
      pathname: "/sessions/sess-1",
    });

    expect(orchestration.prefetchAuthenticatedHydration).toHaveBeenCalledTimes(1);
    expect(orchestration.hydrateAuthenticatedLayout).not.toHaveBeenCalled();

    fetchUserResult.resolve(authenticatedUser());
    await loadPromise;

    expect(orchestration.applyUserState).toHaveBeenCalledWith(MOCK_USER, 0);
    expect(orchestration.setUserFreshValidated).not.toHaveBeenCalled();
    expect(orchestration.hydrateAuthenticatedLayout).toHaveBeenCalledWith(prefetchedHydration, 0);
  });

  it("preserves unknown user state on initial transient auth probe failures", async () => {
    const { orchestration } = createOrchestration({
      fetchUser: vi.fn(async () => transientUser()),
    });

    await loadInitialLayoutAuthState(orchestration, {
      pathname: "/sessions/sess-1",
    });

    expect(orchestration.applyUserState).not.toHaveBeenCalled();
    expect(orchestration.resetAuthenticatedState).not.toHaveBeenCalled();
    expect(orchestration.hydrateAuthenticatedLayout).not.toHaveBeenCalled();
    expect(orchestration.onInitialLoadError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rehydrates sessions and bootstrap on focus after an auth transition", async () => {
    const { orchestration } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
      getUser: vi.fn(() => null),
    });

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.applyUserState).toHaveBeenCalledWith(MOCK_USER, 0);
    expect(orchestration.setUserFreshValidated).toHaveBeenCalledWith(true);
    expect(orchestration.hydrateAuthenticatedLayout).toHaveBeenCalledWith(undefined, 0);
    expect(orchestration.clearRequestCache).not.toHaveBeenCalled();
    expect(orchestration.refreshStartupData).not.toHaveBeenCalled();
  });

  it("clears request cache before hydrating after an identity change", async () => {
    const previousUser: User = { ...MOCK_USER, id: 2, login: "previous-user" };
    const { orchestration } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
      getUser: vi.fn(() => previousUser),
    });

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.clearRequestCache).toHaveBeenCalledTimes(1);
    expect(orchestration.hydrateAuthenticatedLayout).toHaveBeenCalledWith(undefined, 0);
    expect(orchestration.refreshStartupData).not.toHaveBeenCalled();
    expect(vi.mocked(orchestration.clearRequestCache).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(orchestration.hydrateAuthenticatedLayout).mock.invocationCallOrder[0],
    );
  });

  it("keeps request cache when focus refresh stays on the same identity", async () => {
    const { orchestration, setLastAuthRefreshAt, setNow } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
      getUser: vi.fn(() => MOCK_USER),
    });
    setLastAuthRefreshAt(5_000);
    setNow(5_000 + AUTH_REFRESH_MIN_INTERVAL_MS + 1);

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.clearRequestCache).not.toHaveBeenCalled();
    expect(orchestration.refreshStartupData).toHaveBeenCalledWith(undefined, 0);
    expect(orchestration.hydrateAuthenticatedLayout).not.toHaveBeenCalled();
  });

  it("always re-pulls /auth/me on focus so admin/teammate-flipped fields propagate", async () => {
    const { orchestration, setLastAuthRefreshAt, setNow } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
      getUser: vi.fn(() => MOCK_USER),
    });
    setLastAuthRefreshAt(5_000);
    setNow(5_000 + AUTH_REFRESH_MIN_INTERVAL_MS - 1);

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.fetchUser).toHaveBeenCalledWith({ fresh: true });
    expect(orchestration.applyUserState).toHaveBeenCalledWith(MOCK_USER, 0);
    expect(orchestration.setUserFreshValidated).toHaveBeenCalledWith(true);
  });

  it("throttles only the bootstrap join (capabilitiesOnly) inside the debounce window", async () => {
    // /auth/me always runs; the repos rehydrate stays gated so focus events
    // don't repeatedly hit the heavy GitHub join.
    const { orchestration, setLastAuthRefreshAt, setNow } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
      getUser: vi.fn(() => MOCK_USER),
    });
    setLastAuthRefreshAt(5_000);
    setNow(5_000 + AUTH_REFRESH_MIN_INTERVAL_MS - 1);

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.refreshStartupData).toHaveBeenCalledWith(undefined, 0, { capabilitiesOnly: true });
  });

  it("coalesces overlapping throttled focus refreshes through the in-flight guard", async () => {
    const startupRefresh = deferred<void>();
    const { orchestration, setLastAuthRefreshAt, setNow } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
      getUser: vi.fn(() => MOCK_USER),
      refreshStartupData: vi.fn(() => startupRefresh.promise),
    });
    setLastAuthRefreshAt(5_000);
    setNow(5_000 + AUTH_REFRESH_MIN_INTERVAL_MS - 1);

    // Two focus events fire while the first refresh is still in flight.
    const first = refreshLayoutAuthState(orchestration);
    const second = refreshLayoutAuthState(orchestration);

    startupRefresh.resolve();
    await Promise.all([first, second]);

    // The second call awaited the in-flight refresh instead of issuing its own.
    expect(orchestration.refreshStartupData).toHaveBeenCalledTimes(1);
  });

  it("refreshes bootstrap state after refreshUser updates the user", async () => {
    const { orchestration } = createOrchestration({
      fetchUser: vi.fn(async () => authenticatedUser()),
    });

    await refreshLayoutUser(orchestration);

    expect(orchestration.applyUserState).toHaveBeenCalledWith(MOCK_USER, 0);
    expect(orchestration.syncUserContext).toHaveBeenCalledWith(MOCK_USER, 0);
    expect(orchestration.setUserFreshValidated).toHaveBeenCalledWith(true);
    expect(orchestration.refreshStartupData).toHaveBeenCalledWith(undefined, 0);
  });

  it("leaves authenticated state untouched when refreshUser hits a transient auth probe failure", async () => {
    const { orchestration, setUser } = createOrchestration({
      fetchUser: vi.fn(async () => transientUser()),
    });
    setUser(MOCK_USER);

    await expect(refreshLayoutUser(orchestration)).resolves.toBeUndefined();

    expect(orchestration.applyUserState).not.toHaveBeenCalled();
    expect(orchestration.syncUserContext).not.toHaveBeenCalled();
    expect(orchestration.setUserFreshValidated).not.toHaveBeenCalled();
    expect(orchestration.resetAuthenticatedState).not.toHaveBeenCalled();
    expect(orchestration.refreshStartupData).not.toHaveBeenCalled();
  });

  it("resets authenticated state when refreshUser loses the user", async () => {
    const { orchestration } = createOrchestration({
      fetchUser: vi.fn(async () => unauthenticatedUser()),
    });

    await refreshLayoutUser(orchestration);

    expect(orchestration.applyUserState).toHaveBeenCalledWith(null, 0);
    expect(orchestration.syncUserContext).toHaveBeenCalledWith(null, 0);
    expect(orchestration.resetAuthenticatedState).toHaveBeenCalledTimes(1);
    expect(orchestration.refreshStartupData).not.toHaveBeenCalled();
  });

  it("leaves authenticated state untouched when focus refresh hits a transient auth probe failure", async () => {
    const { orchestration, setLastAuthRefreshAt, setNow } = createOrchestration({
      fetchUser: vi.fn(async () => transientUser()),
      getUser: vi.fn(() => MOCK_USER),
    });
    setLastAuthRefreshAt(0);
    setNow(AUTH_REFRESH_MIN_INTERVAL_MS + 1);

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.applyUserState).not.toHaveBeenCalled();
    expect(orchestration.syncUserContext).not.toHaveBeenCalled();
    expect(orchestration.resetAuthenticatedState).not.toHaveBeenCalled();
    expect(orchestration.hydrateAuthenticatedLayout).not.toHaveBeenCalled();
    expect(orchestration.refreshStartupData).not.toHaveBeenCalled();
  });

  it("resets authenticated state when focus refresh loses an authenticated user", async () => {
    const { orchestration, setLastAuthRefreshAt, setNow } = createOrchestration({
      fetchUser: vi.fn(async () => unauthenticatedUser()),
      getUser: vi.fn(() => MOCK_USER),
    });
    setLastAuthRefreshAt(0);
    setNow(AUTH_REFRESH_MIN_INTERVAL_MS + 1);

    await refreshLayoutAuthState(orchestration);

    expect(orchestration.applyUserState).toHaveBeenCalledWith(null, 0);
    expect(orchestration.syncUserContext).toHaveBeenCalledWith(null, 0);
    expect(orchestration.resetAuthenticatedState).toHaveBeenCalledTimes(1);
    expect(orchestration.hydrateAuthenticatedLayout).not.toHaveBeenCalled();
    expect(orchestration.refreshStartupData).not.toHaveBeenCalled();
  });

  it("invalidates auth state and resets layout state on logout", async () => {
    const { orchestration, setUser } = createOrchestration();
    setUser(MOCK_USER);

    await logoutLayoutUser(orchestration);

    expect(orchestration.invalidateAuthStateRequests).toHaveBeenCalledTimes(1);
    expect(orchestration.logoutUser).toHaveBeenCalledTimes(1);
    expect(orchestration.clearLoggedOutUserContext).toHaveBeenCalledTimes(1);
    expect(orchestration.writeAuthenticatedHint).toHaveBeenCalledWith(false);
    expect(orchestration.resetAuthenticatedState).toHaveBeenCalledTimes(1);
  });

  it("still resets logout state when clearing logged out user context fails", async () => {
    const clearError = new Error("sentry import failed");
    const { orchestration } = createOrchestration({
      clearLoggedOutUserContext: vi.fn(async () => {
        throw clearError;
      }),
    });

    await logoutLayoutUser(orchestration);

    expect(orchestration.onClearLoggedOutUserContextError).toHaveBeenCalledWith(clearError);
    expect(orchestration.writeAuthenticatedHint).toHaveBeenCalledWith(false);
    expect(orchestration.resetAuthenticatedState).toHaveBeenCalledTimes(1);
  });
});
