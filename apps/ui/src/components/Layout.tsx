import { type Dispatch, type SetStateAction, startTransition, useCallback, useMemo, useRef, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate, useOutletContext } from "react-router";

import type { BootstrapCapabilities, BootstrapResponse, SsoOrg } from "../../../../shared/types/bootstrap";
import type { UploadedFile, UploadedImage } from "../../../../shared/types/sandbox";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { fetchUser, logoutUser } from "../api/auth";
import type { AuthProbeResult } from "../api/auth-probe";
import { fetchBootstrap } from "../api/bootstrap";
import { clearApiCache } from "../api/cache";
import { ApiError } from "../api/client";
import { HOME_SNAPSHOT_KEY_PREFIX, readHomeSnapshot, writeHomeSnapshot } from "../api/home-snapshot";
import { fetchModels } from "../api/models";
import { fetchRepoFiles } from "../api/repos";
import {
  archiveSession,
  createSessionAndSend,
  fetchSessions,
  type FetchSessionsOptions,
  type FetchSessionsResult,
  stopSession,
} from "../api/sessions";
import {
  SESSION_LIST_POLL_MS,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
} from "../constants";
import { applyFeedDelta, feedDeltaMatchesScope } from "../hooks/applyFeedDelta";
import { useAttentionSignal } from "../hooks/useAttentionSignal";
import { useMountEffect, useOnChange, useSyncEffect } from "../hooks/useEffects";
import { useMobile } from "../hooks/useMobile";
import { useParentTitleStore } from "../hooks/useParentTitleStore";
import { useRefetchOnActive } from "../hooks/useRefetchOnActive";
import { useSessionFeed } from "../hooks/useSessionFeed";
import { useSessionState } from "../hooks/useSessionState";
import type {
  ModelSelection,
  PlanModeSetting,
  Provider,
  Repo,
  SessionMetadata,
  SessionStatus,
  User,
  UserSettings,
} from "../types";
import { rememberConnectedPersonalIntegrations } from "../utils/integration-disconnect-warning";
import { isNewSessionShortcut } from "../utils/keyboard";
import { parseModelSelection } from "../utils/models";
import { parseRepoFullNameFromUrl, prioritizeDefaultRepo, resolveBootstrapReposState } from "../utils/repos";
import { useConfirm } from "./ConfirmDialog";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { Sidebar } from "./layout/Sidebar";
import {
  type LayoutAuthOrchestration,
  loadInitialLayoutAuthState,
  logoutLayoutUser,
  type PrefetchedAuthenticatedHydration,
  refreshLayoutAuthState,
  refreshLayoutUser,
} from "./layout-auth-orchestration";
import { mergeSessionSnapshotWithLivePatches } from "./sessionSnapshotMerge";
import { useToast } from "./Toast";
import { buttonClasses } from "./ui";

function resolveSessionBaseBranch(
  repo: Repo | null,
  requestedBaseBranch: string,
  requestedBaseBranchRepoUrl: string | null,
): string {
  if (!repo) return "";
  const trimmedBranch = requestedBaseBranch?.trim();
  if (!trimmedBranch) return repo.defaultBranch;
  if (requestedBaseBranchRepoUrl === repo.url) return trimmedBranch;
  return repo.defaultBranch;
}

const AUTH_HINT_KEY = "layout.authenticated_hint";
const SESSION_SYNC_CHANNEL_NAME = "cycloid-sessions";
const SESSION_SYNC_MESSAGE_TYPE = "refresh-sessions";

function readSidebarCollapsedPreference() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

function readSidebarWidthPreference() {
  const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (stored) {
    const parsed = Number(stored);
    if (!Number.isNaN(parsed) && parsed >= SIDEBAR_MIN_WIDTH && parsed <= SIDEBAR_MAX_WIDTH) return parsed;
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

function buildFetchSessionsOptions(
  scope: "personal" | "business",
  status: SessionStatus | null,
  cursor?: string | null,
  query?: string | null,
): FetchSessionsOptions {
  const trimmedQuery = query?.trim();
  return {
    scope,
    ...(cursor ? { cursor } : {}),
    ...(status ? { status } : {}),
    ...(trimmedQuery ? { query: trimmedQuery } : {}),
  };
}

function readAuthenticatedHint() {
  try {
    return localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeAuthenticatedHint(isAuthenticated: boolean) {
  try {
    if (isAuthenticated) localStorage.setItem(AUTH_HINT_KEY, "1");
    else localStorage.removeItem(AUTH_HINT_KEY);
  } catch {
    // Ignore storage failures; they should not block app startup.
  }
}

type CapabilitiesStatus = "loading" | "ready" | "unavailable";

type SessionListContext = {
  scope: "personal" | "business";
  status: SessionStatus | null;
};

type PendingArchiveRollback = SessionListContext & {
  authStateVersion: number;
  rollbackIndex: number;
  rollbackSession: SessionMetadata;
};

const ARCHIVE_CONFIRM_PHASES = new Set<SessionMetadata["phase"]>([
  "running",
  "waiting_for_input",
  "finalizing",
  "review_listening",
]);

function sessionListContextMatches(left: SessionListContext, right: SessionListContext) {
  return left.scope === right.scope && left.status === right.status;
}

function sessionMetadataShallowEqual(left: SessionMetadata, right: SessionMetadata) {
  const keys = new Set<keyof SessionMetadata>([...Object.keys(left), ...Object.keys(right)] as Array<
    keyof SessionMetadata
  >);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

export type LayoutContext = {
  user: User | null | undefined;
  capabilities: BootstrapCapabilities | null;
  capabilitiesStatus: CapabilitiesStatus;
  repos: Repo[];
  reposLoaded: boolean;
  reposError: string | null;
  ssoOrgs: SsoOrg[];
  userFreshValidated: boolean;
  refreshingRepos: boolean;
  refreshRepos: () => Promise<void>;
  settings: UserSettings | null;
  settingsLoaded: boolean;
  settingsError: string | null;
  setSettings: Dispatch<SetStateAction<UserSettings | null>>;
  selectedRepo: Repo | null;
  setSelectedRepo: (r: Repo | null) => void;
  selectedRepoFreshValidated: boolean;
  models: Provider[];
  selectedModel: ModelSelection | null;
  setSelectedModel: Dispatch<SetStateAction<ModelSelection | null>>;
  selectModelForNewSession: (model: ModelSelection) => void;
  sessions: SessionMetadata[];
  sessionsLoaded: boolean;
  setSessions: Dispatch<SetStateAction<SessionMetadata[]>>;
  patchSession: (sessionId: string, patch: Partial<SessionMetadata>) => void;
  creating: boolean;
  setCreating: (c: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;
  handleNewSessionPrompt: (payload: {
    prompt: string;
    skills?: string[];
    files?: string[];
    uploadedFiles?: UploadedFile[];
    uploadedImages?: UploadedImage[];
    reasoningEffort?: string;
    baseBranch?: string;
    planMode?: PlanModeSetting;
    takeoverPrUrl?: string;
  }) => Promise<void>;
  loadFilesForHomePage: () => Promise<string[]>;
  onLinearChange: (connected: boolean) => void;
  onJiraChange: (connected: boolean, siteName?: string | null) => void;
  onNotionChange: (connected: boolean) => void;
  onSlackChange: (connected: boolean) => void;
  onDefaultModelChange: (model: string | null) => void;
  refreshModels: () => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  endSession: (id: string) => Promise<void>;
  notifySessionListSync: () => void;
};

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

export function Layout({ initialUser }: { initialUser?: User | null } = {}) {
  const navigate = useNavigate();
  const sessionSyncChannelRef = useRef<BroadcastChannel | null>(null);

  const {
    state: { sessions },
    setSessions,
  } = useSessionState({ sessionId: "__layout__" });
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  useAttentionSignal(sessions);
  const { resetParentTitles } = useParentTitleStore(sessions);

  const patchSession = useCallback((sessionId: string, patch: Partial<SessionMetadata>) => {
    setSessions((prev) => {
      const index = prev.findIndex((session) => session.sessionId === sessionId);
      if (index === -1) return prev;

      const current = prev[index];
      let changed = false;
      for (const key of Object.keys(patch) as Array<keyof SessionMetadata>) {
        if (current[key] !== patch[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;

      const next = prev.slice();
      next[index] = { ...current, ...patch };
      return next;
    });
  }, []);
  const notifySessionListSync = useCallback(() => {
    sessionSyncChannelRef.current?.postMessage({ type: SESSION_SYNC_MESSAGE_TYPE });
  }, []);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // True once the user has paginated past the first page. The focus/visibility
  // refetch fetches page 1 and replaces the list, which would silently drop the
  // loaded-more pages, so it is skipped while this is set.
  const hasLoadedMoreRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null | undefined>(() => initialUser ?? undefined);
  const [userFreshValidated, setUserFreshValidated] = useState(false);
  const [capabilities, setCapabilities] = useState<BootstrapCapabilities | null>(null);
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CapabilitiesStatus>("loading");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [reposFreshValidated, setReposFreshValidated] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [ssoOrgs, setSsoOrgs] = useState<SsoOrg[]>([]);
  const [refreshingRepos, setRefreshingRepos] = useState(false);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [selectedBaseBranch, setSelectedBaseBranch] = useState("");
  const [selectedBaseBranchRepoUrl, setSelectedBaseBranchRepoUrl] = useState<string | null>(null);
  const [models, setModels] = useState<Provider[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelSelection | null>(null);
  const [sessionScope, setSessionScope] = useState<"personal" | "business">("personal");
  const location = useLocation();
  const isMobile = useMobile();
  const confirm = useConfirm();
  const toast = useToast();
  const userRef = useRef<User | null | undefined>(undefined);
  userRef.current = user;
  const reposRef = useRef<Repo[]>([]);
  reposRef.current = repos;
  const reposFreshValidatedRef = useRef(false);
  reposFreshValidatedRef.current = reposFreshValidated;
  const selectedRepoRef = useRef<Repo | null>(null);
  selectedRepoRef.current = selectedRepo;
  const selectedBaseBranchRef = useRef("");
  selectedBaseBranchRef.current = selectedBaseBranch;
  const selectedBaseBranchRepoUrlRef = useRef<string | null>(null);
  selectedBaseBranchRepoUrlRef.current = selectedBaseBranchRepoUrl;
  const lastAuthRefreshAtRef = useRef(0);
  const authRefreshInFlightRef = useRef<Promise<AuthProbeResult<User>> | null>(null);
  const authStateVersionRef = useRef(0);
  const pendingArchiveRollbacksRef = useRef<Map<string, PendingArchiveRollback>>(new Map());
  const layoutAuthOrchestrationRef = useRef<LayoutAuthOrchestration>({
    fetchUser,
    logoutUser,
    applyUserState: () => false,
    syncUserContext: async (_nextUser: User | null, _authStateVersion: number) => {},
    hydrateAuthenticatedLayout: async (_prefetched: PrefetchedAuthenticatedHydration | undefined, _v: number) => {},
    refreshStartupData: async (_bootstrapPromise: Promise<BootstrapResponse> | undefined, _v: number) => {},
    prefetchAuthenticatedHydration: () => {
      throw new Error("layout auth orchestration not initialized");
    },
    shouldPrefetchAuthenticatedStartupData: (_pathname: string) => false,
    getUser: () => userRef.current,
    getAuthStateVersion: () => authStateVersionRef.current,
    clearRequestCache: () => {},
    invalidateAuthStateRequests: () => {},
    getRefreshInFlight: () => authRefreshInFlightRef.current,
    setRefreshInFlight: (promise: Promise<AuthProbeResult<User>> | null) => {
      authRefreshInFlightRef.current = promise;
    },
    getLastAuthRefreshAt: () => lastAuthRefreshAtRef.current,
    setLastAuthRefreshAt: (value: number) => {
      lastAuthRefreshAtRef.current = value;
    },
    setUserFreshValidated: (_value: boolean) => {},
    writeAuthenticatedHint: (_isAuthenticated: boolean) => {},
    resetAuthenticatedState: () => {},
    now: () => Date.now(),
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const isSupportView = Boolean(user?.impersonation?.readOnly);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidthPreference);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(SIDEBAR_DEFAULT_WIDTH);
  const pendingSidebarWidthRef = useRef(sidebarWidth);
  const sidebarResizeRafIdRef = useRef<number | null>(null);

  useSyncEffect(() => {
    pendingSidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    pendingSidebarWidthRef.current = Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, startWidth.current + (e.clientX - startX.current)),
    );
    if (sidebarResizeRafIdRef.current !== null) return;
    sidebarResizeRafIdRef.current = requestAnimationFrame(() => {
      sidebarResizeRafIdRef.current = null;
      setSidebarWidth((current) => {
        const nextWidth = pendingSidebarWidthRef.current;
        return current === nextWidth ? current : nextWidth;
      });
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    delete document.body.dataset.sidebarResizing;
    if (sidebarResizeRafIdRef.current !== null) {
      cancelAnimationFrame(sidebarResizeRafIdRef.current);
      sidebarResizeRafIdRef.current = null;
    }
    // Persist outside the state updater: React treats updaters as pure
    // reducers and double-invokes them in StrictMode, which would double-write.
    const nextWidth = pendingSidebarWidthRef.current;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
    setSidebarWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  useSyncEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (sidebarResizeRafIdRef.current !== null) {
        cancelAnimationFrame(sidebarResizeRafIdRef.current);
        sidebarResizeRafIdRef.current = null;
      }
      // A drag interrupted by unmount never reaches handleMouseUp; clear the
      // transition-suppression flag so .sidebar-collapse stays animated.
      delete document.body.dataset.sidebarResizing;
    };
  }, [handleMouseMove, handleMouseUp]);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    if (isDragging.current) return;
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = pendingSidebarWidthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Suppress .sidebar-collapse's width transition while dragging (App.css).
    document.body.dataset.sidebarResizing = "true";
  }

  // Global keyboard shortcut: Alt+N (Option+N on macOS) -> navigate to home page for new session
  useSyncEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!isNewSessionShortcut(e)) return;
      e.preventDefault();
      if (isSupportView) return;
      navigate("/");
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSupportView, navigate]);

  const selectedRepoFreshValidated =
    Boolean(selectedRepo) &&
    reposFreshValidated &&
    repos.some((repo) => repo.url === selectedRepo?.url && repo.defaultBranch === selectedRepo.defaultBranch);
  const selectedRepoFreshValidatedRef = useRef(false);
  selectedRepoFreshValidatedRef.current = selectedRepoFreshValidated;

  const selectRepo = useCallback(
    (repo: Repo | null) => {
      setSelectedRepo(repo);
    },
    [setSelectedRepo],
  );

  useSyncEffect(() => {
    if (!selectedRepo) {
      setSelectedBaseBranch("");
      setSelectedBaseBranchRepoUrl(null);
      return;
    }
    setSelectedBaseBranch(selectedRepo.defaultBranch);
    setSelectedBaseBranchRepoUrl(selectedRepo.url);
  }, [selectedRepo?.url, selectedRepo?.defaultBranch]);

  useSyncEffect(() => {
    if (user) rememberConnectedPersonalIntegrations(user);
  }, [user]);

  useSyncEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SESSION_SYNC_CHANNEL_NAME);
    sessionSyncChannelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type !== SESSION_SYNC_MESSAGE_TYPE) return;
      refreshSessionsForScope(sessionScopeRef.current, undefined, authStateVersionRef.current, undefined, {
        force: true,
      }).catch((error) => {
        console.error("[Layout] cross-tab refresh sessions failed", error);
      });
    };
    return () => {
      if (sessionSyncChannelRef.current === channel) sessionSyncChannelRef.current = null;
      channel.close();
    };
  }, []);

  const autoSelectModel = useCallback((providers: Provider[], defaultModel?: string | null) => {
    const usable = providers.filter((p) => p.hasApiKey !== false);
    if (defaultModel) {
      const preferred = parseModelSelection(defaultModel, providers);
      const provider = preferred ? usable.find((candidate) => candidate.id === preferred.providerID) : undefined;
      if (preferred && provider?.models.some((model) => model.id === preferred.modelID)) {
        setSelectedModel(preferred);
        return;
      }
    }
    setSelectedModel((cur) => {
      if (cur) {
        const currentProvider = usable.find((candidate) => candidate.id === cur.providerID);
        if (currentProvider?.models.some((model) => model.id === cur.modelID)) return cur;
      }
      const first = usable[0];
      if (first?.models.length) return { providerID: first.id, modelID: first.models[0].id };
      return null;
    });
  }, []);

  const selectModelForNewSession = useCallback((model: ModelSelection) => {
    setSelectedModel(model);
  }, []);

  const refreshModels = useCallback(async () => {
    const nextModels = await fetchModels();
    setModels(nextModels);
    autoSelectModel(nextModels, settings?.defaultModel);
  }, [autoSelectModel, settings?.defaultModel]);

  const writeFreshHomeSnapshot = useCallback(
    (repoList: Repo[], defaultRepoUrl: string | null, nextSsoOrgs: SsoOrg[]) => {
      const currentUser = userRef.current;
      if (!currentUser) return;
      writeHomeSnapshot(String(currentUser.id), {
        businessId: currentUser.businessId,
        repos: repoList,
        ssoOrgs: nextSsoOrgs,
        defaultRepoUrl,
      });
    },
    [],
  );

  const applyFetchedRepos = useCallback(
    (repoList: Repo[], defaultRepoUrl: string | null, nextSsoOrgs?: SsoOrg[]) => {
      const { repos: ordered, defaultRepo } = prioritizeDefaultRepo(repoList, defaultRepoUrl);
      const resolvedSsoOrgs = nextSsoOrgs ?? [];
      setRepos(ordered);
      // Keep the selection only if it still exists in the fresh list; otherwise
      // fall back to the default so a removed repo cannot stay submittable.
      setSelectedRepo((prev) =>
        prev && ordered.some((r) => r.url === prev.url && r.defaultBranch === prev.defaultBranch)
          ? prev
          : (defaultRepo ?? null),
      );
      setSsoOrgs(resolvedSsoOrgs);
      setReposLoaded(true);
      setReposFreshValidated(true);
      setReposError(null);
      writeFreshHomeSnapshot(ordered, defaultRepoUrl, resolvedSsoOrgs);
    },
    [writeFreshHomeSnapshot],
  );

  const applyHomeSnapshot = useCallback(
    (
      nextUser: User,
      authStateVersion: number,
      options?: { freshValidated?: boolean; preserveFreshRepos?: boolean },
    ) => {
      if (options?.preserveFreshRepos && reposFreshValidatedRef.current) return;
      const snapshot = readHomeSnapshot(String(nextUser.id));
      if (!snapshot) return;
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      if (snapshot.userId !== String(nextUser.id) || snapshot.businessId !== nextUser.businessId) return;
      const { repos: ordered, defaultRepo } = prioritizeDefaultRepo(snapshot.repos, snapshot.defaultRepoUrl);
      setRepos(ordered);
      setSsoOrgs(snapshot.ssoOrgs);
      setSelectedRepo(defaultRepo ?? ordered[0] ?? null);
      setReposLoaded(true);
      setReposFreshValidated(options?.freshValidated ?? false);
      setReposError(null);
    },
    [],
  );

  useSyncEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.storageArea !== localStorage) return;
      if (event.key === SIDEBAR_WIDTH_KEY) {
        setSidebarWidth(readSidebarWidthPreference());
        return;
      }
      const currentUser = userRef.current;
      const currentSnapshotKey = currentUser ? `${HOME_SNAPSHOT_KEY_PREFIX}${currentUser.id}` : null;
      if (event.key === currentSnapshotKey) {
        if (event.newValue === null) {
          setRepos([]);
          setReposLoaded(false);
          setReposFreshValidated(false);
          setReposError(null);
          setSsoOrgs([]);
          setSelectedRepo(null);
        } else if (currentUser) {
          applyHomeSnapshot(currentUser, authStateVersionRef.current, { freshValidated: true });
        }
        return;
      }
      if (event.key !== SIDEBAR_COLLAPSED_KEY) return;
      setSidebarCollapsed(readSidebarCollapsedPreference());
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [applyHomeSnapshot]);

  // Cache-bypassing repo refetch behind the visible "Refresh repositories"
  // control. Lets a user who just authorized SAML SSO pull the now-visible org
  // repos without the hidden `?refresh=1` trick. `refreshingRepos` disables the
  // control while in flight so repeated clicks can't burn the GitHub rate limit.
  const refreshRepos = useCallback(async () => {
    setRefreshingRepos(true);
    try {
      const { fetchRepos } = await import("../api/repos");
      const { repos: repoList, ssoOrgs: nextSsoOrgs } = await fetchRepos({ refresh: true });
      applyFetchedRepos(repoList, settings?.defaultRepo ?? null, nextSsoOrgs);
    } catch (error) {
      console.error("[Layout] refresh repos failed", error);
      setReposError("Failed to refresh repositories. GitHub may be unavailable.");
    } finally {
      setRefreshingRepos(false);
    }
  }, [applyFetchedRepos, settings?.defaultRepo]);

  // Deferred repo load for the bootstrap `reposPending` path: the server skipped
  // the GitHub repo-list fetch on app load (cache miss/stale), so fetch it now
  // WITHOUT `refresh` -- a non-bypass `/api/repos` hits the warmed cache instead
  // of spending the GitHub rate limit again. `defaultRepoUrl` is passed
  // explicitly (not read from a possibly-stale `settings` closure) so the user's
  // default repo is still auto-selected once the list arrives. Always settles
  // `reposLoaded` (success or failure) so the picker never spins forever.
  const loadDeferredRepos = useCallback(
    async (defaultRepoUrl: string | null, authStateVersion: number) => {
      try {
        const { fetchRepos } = await import("../api/repos");
        const { repos: repoList, ssoOrgs: nextSsoOrgs } = await fetchRepos();
        // A logout, account switch, or newer bootstrap can complete while this
        // request is in flight; bail so a stale response never overwrites the
        // current user's layout (mirrors refreshStartupData/applySessionList).
        if (authStateVersionRef.current !== authStateVersion) return;
        applyFetchedRepos(repoList, defaultRepoUrl, nextSsoOrgs);
      } catch (error) {
        if (authStateVersionRef.current !== authStateVersion) return;
        console.error("[Layout] deferred repos load failed", error);
        setReposLoaded(true);
        setReposFreshValidated(false);
        setReposError("Failed to load repositories. GitHub may be unavailable.");
      }
    },
    [applyFetchedRepos],
  );

  const sessionScopeRef = useRef(sessionScope);
  sessionScopeRef.current = sessionScope;
  const selectedStatusFilterRef = useRef<SessionStatus | null>(null);
  const serverFilterTextRef = useRef("");
  const sessionListRequestIdRef = useRef(0);

  function getCurrentSessionListContext(): SessionListContext {
    return { scope: sessionScopeRef.current, status: selectedStatusFilterRef.current };
  }

  function reconcileArchivedSessions(result: FetchSessionsResult, context: SessionListContext) {
    const fetchedIds = new Set(result.sessions.map((session) => session.sessionId));
    for (const [sessionId, pending] of pendingArchiveRollbacksRef.current) {
      const fetchedSession = result.sessions.find((session) => session.sessionId === sessionId);
      if (fetchedSession?.phase === "archived") {
        pendingArchiveRollbacksRef.current.delete(sessionId);
        continue;
      }
      if (sessionListContextMatches(pending, context) && !fetchedIds.has(sessionId)) {
        pendingArchiveRollbacksRef.current.delete(sessionId);
      }
    }

    // The first loop already deletes any pending entry whose server truth came
    // back as archived (or whose context-matched fetch confirmed it's gone), so
    // here we only need to mask sessions that still have a live pending entry
    // under matching context.
    return result.sessions.filter((session) => {
      const pending = pendingArchiveRollbacksRef.current.get(session.sessionId);
      if (!pending) return true;
      return !sessionListContextMatches(pending, context);
    });
  }

  function loadMoreSessions() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const scope = sessionScopeRef.current;
    const status = selectedStatusFilterRef.current;
    const query = serverFilterTextRef.current;
    fetchSessions(buildFetchSessionsOptions(scope, status, nextCursor, query))
      .then((result) => {
        if (
          sessionScopeRef.current !== scope ||
          selectedStatusFilterRef.current !== status ||
          serverFilterTextRef.current !== query
        )
          return;
        hasLoadedMoreRef.current = true;
        startTransition(() => {
          setSessions((prev) => {
            const existingIds = new Set(prev.map((s) => s.sessionId));
            const newSessions = result.sessions.filter((s) => !existingIds.has(s.sessionId));
            return [...prev, ...newSessions];
          });
          setNextCursor(result.nextCursor);
        });
      })
      .catch((e) => {
        console.error("[Layout] load more sessions failed", e);
        setError(e instanceof Error ? e.message : "Failed to load more sessions");
      })
      .finally(() => setLoadingMore(false));
  }

  function prefetchAuthenticatedHydration(): PrefetchedAuthenticatedHydration {
    const scope = sessionScopeRef.current;
    const status = selectedStatusFilterRef.current;
    const query = serverFilterTextRef.current;
    const sessionsPromise = fetchSessions(buildFetchSessionsOptions(scope, status, undefined, query));
    const bootstrapPromise = fetchStartupBootstrap();
    // The initial auth probe may determine we are logged out after these requests
    // start; attach handlers immediately so abandoned prefetched promises do not
    // surface as unhandled rejections.
    void sessionsPromise.catch(() => {});
    void bootstrapPromise.catch(() => {});
    return { sessionsPromise, bootstrapPromise, sessionsScope: scope, sessionsStatus: status };
  }

  function isCurrentAuthStateVersion(authStateVersion: number) {
    return authStateVersionRef.current === authStateVersion;
  }

  function invalidateAuthStateRequests() {
    authStateVersionRef.current += 1;
    authRefreshInFlightRef.current = null;
    clearApiCache();
  }

  function clearRequestCache() {
    clearApiCache();
  }

  function applyUserState(nextUser: User | null, authStateVersion = authStateVersionRef.current) {
    if (!isCurrentAuthStateVersion(authStateVersion)) return false;
    const previousUser = userRef.current;
    userRef.current = nextUser;
    setUser(nextUser);
    if (!nextUser || previousUser?.id !== nextUser.id) setUserFreshValidated(false);
    writeAuthenticatedHint(!!nextUser);
    if (nextUser) {
      applyHomeSnapshot(nextUser, authStateVersion, { preserveFreshRepos: previousUser?.id === nextUser.id });
    }
    return true;
  }

  async function syncUserContext(nextUser: User | null, authStateVersion = authStateVersionRef.current) {
    if (!isCurrentAuthStateVersion(authStateVersion)) return;
    if (nextUser) {
      const { setDatadogUser } = await import("../datadog");
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      setDatadogUser(nextUser);

      const { setSentryUser } = await import("../sentry");
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      setSentryUser(nextUser);
      return;
    }

    const { clearSentryUser } = await import("../sentry");
    if (!isCurrentAuthStateVersion(authStateVersion)) return;
    clearSentryUser();
  }

  function applyBootstrapData(
    bootstrap: BootstrapResponse,
    authStateVersion = authStateVersionRef.current,
    options?: { capabilitiesOnly?: boolean },
  ) {
    if (!isCurrentAuthStateVersion(authStateVersion)) return;
    const currentUser = userRef.current;
    if (!currentUser || bootstrap.user.id !== currentUser.id) return;
    for (const w of bootstrap.warnings) console.warn(`[Layout] bootstrap warning: ${w}`);

    // bootstrap.user is intentionally NOT applied here. BootstrapUser is a
    // strict subset of User (missing slackWorkspaceInstalled,
    // availableIntegrations, integrationScopes, etc.), so applying it would
    // clobber /auth/me-only fields. Callers always run /auth/me first
    // (loadInitialLayoutAuthState, refreshLayoutAuthState) and apply the
    // canonical user before any bootstrap fetch.
    setCapabilities(bootstrap.capabilities);
    setCapabilitiesStatus("ready");

    setSettings(bootstrap.settings);
    setSettingsLoaded(true);
    setSettingsError(bootstrap.settings ? null : "Failed to load settings.");

    setSsoOrgs(bootstrap.ssoOrgs);

    if (bootstrap.models) {
      setModels(bootstrap.models);
      autoSelectModel(bootstrap.models, bootstrap.settings?.defaultModel);
    }

    if (options?.capabilitiesOnly) {
      // Throttled focus refresh: skip the repos rehydrate (expensive GitHub
      // join). A changed repo set is picked up by the next non-throttled
      // refresh or by an explicit setup=complete / sso=complete return.
      return;
    }

    const reposState = resolveBootstrapReposState(bootstrap);
    if (reposState.kind === "loaded") {
      const { repos: repoList, defaultRepo } = prioritizeDefaultRepo(reposState.repos, reposState.defaultRepoUrl);
      if (defaultRepo)
        setSelectedRepo((prev) =>
          prev?.url === defaultRepo.url && prev?.defaultBranch === defaultRepo.defaultBranch ? prev : defaultRepo,
        );
      setRepos(repoList);
      setReposLoaded(true);
      setReposFreshValidated(true);
      setReposError(null);
      writeFreshHomeSnapshot(repoList, reposState.defaultRepoUrl, bootstrap.ssoOrgs);
    } else if (reposState.kind === "pending") {
      // Repo list deferred off the critical path: show a loading state (not an
      // error) and lazy-load via a non-bypass `/api/repos` fetch.
      setReposError(null);
      setReposLoaded(reposRef.current.length > 0);
      setReposFreshValidated(false);
      void loadDeferredRepos(reposState.defaultRepoUrl, authStateVersion);
    } else {
      setReposLoaded(true);
      setReposFreshValidated(false);
      setReposError("Failed to load repositories. GitHub may be unavailable.");
    }
  }

  function applySessionList(
    result: FetchSessionsResult,
    authStateVersion = authStateVersionRef.current,
    scope = sessionScopeRef.current,
    status = selectedStatusFilterRef.current,
    options?: { requestId?: number; requestIssuedAt?: number; query?: string },
  ) {
    const requestId = options?.requestId;
    const requestIssuedAt = options?.requestIssuedAt ?? 0;
    const query = options?.query ?? serverFilterTextRef.current;
    if (!isCurrentAuthStateVersion(authStateVersion)) return;
    if (sessionScopeRef.current !== scope || selectedStatusFilterRef.current !== status) return;
    if (serverFilterTextRef.current !== query) return;
    if (requestId !== undefined && sessionListRequestIdRef.current !== requestId) return;
    const reconciledSessions = reconcileArchivedSessions(result, { scope, status });
    setSessions((prev) => {
      const localById = new Map(prev.map((session) => [session.sessionId, session] as const));
      const nextSessions = reconciledSessions.map((session) => {
        const local = localById.get(session.sessionId);
        const merged = mergeSessionSnapshotWithLivePatches(session, local, requestIssuedAt);
        return local && sessionMetadataShallowEqual(local, merged) ? local : merged;
      });
      if (nextSessions.length === prev.length && nextSessions.every((session, index) => session === prev[index])) {
        return prev;
      }
      return nextSessions;
    });
    setNextCursor(result.nextCursor);
    // Applying a fresh first page collapses pagination back to page 1, so any
    // prior loaded-more state no longer holds. Covers every page-1 (re)fetch:
    // initial load, scope/filter change, create-session, and the focus/poll refetch.
    hasLoadedMoreRef.current = false;
  }

  async function refreshSessionsForScope(
    scope: "personal" | "business",
    sessionsPromise?: Promise<FetchSessionsResult>,
    authStateVersion = authStateVersionRef.current,
    status = selectedStatusFilterRef.current,
    options?: { force?: boolean; query?: string },
  ) {
    const requestedStatus = status;
    const requestedQuery = options?.query ?? serverFilterTextRef.current;
    const requestId = sessionListRequestIdRef.current + 1;
    const requestIssuedAt = Date.now();
    sessionListRequestIdRef.current = requestId;
    const requestedSessionsPromise =
      sessionsPromise ??
      fetchSessions({
        ...buildFetchSessionsOptions(scope, requestedStatus, undefined, requestedQuery),
        force: options?.force,
        onRevalidate: (fresh) => {
          if (!isCurrentAuthStateVersion(authStateVersion)) return;
          if (hasLoadedMoreRef.current) return;
          applySessionList(fresh, authStateVersion, scope, requestedStatus, {
            requestIssuedAt,
            query: requestedQuery,
          });
        },
        isEqual: (prev, next) =>
          prev.nextCursor === next.nextCursor &&
          prev.sessions.length === next.sessions.length &&
          prev.sessions.every(
            (session, index) =>
              session.sessionId === next.sessions[index]?.sessionId && session.phase === next.sessions[index]?.phase,
          ),
      });
    try {
      const result = await requestedSessionsPromise;
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      applySessionList(result, authStateVersion, scope, requestedStatus, {
        requestId,
        requestIssuedAt,
        query: requestedQuery,
      });
    } catch (error) {
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      if (sessionListRequestIdRef.current !== requestId) return;
      throw error;
    } finally {
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      if (sessionListRequestIdRef.current !== requestId) return;
      if (sessionScopeRef.current !== scope || selectedStatusFilterRef.current !== requestedStatus) return;
      if (serverFilterTextRef.current !== requestedQuery) return;
      setSessionsLoaded(true);
    }
  }

  function refreshSessions() {
    return refreshSessionsForScope(sessionScopeRef.current);
  }

  function shouldRefreshReposForGithubSetup() {
    const params = new URLSearchParams(location.search);
    // `setup=complete`: returning from GitHub App installation.
    // `sso=complete`: returning from the SAML SSO + OAuth re-auth chain.
    // Both mean GitHub-side access just changed, so bypass the repos cache.
    return params.get("setup") === "complete" || params.get("sso") === "complete";
  }

  function fetchStartupBootstrap(options?: { force?: boolean }) {
    return fetchBootstrap({ refreshRepos: shouldRefreshReposForGithubSetup(), force: options?.force });
  }

  async function refreshStartupData(
    bootstrapPromise: Promise<BootstrapResponse> | undefined = undefined,
    authStateVersion = authStateVersionRef.current,
    options?: { capabilitiesOnly?: boolean },
  ) {
    try {
      const requestedBootstrapPromise =
        bootstrapPromise ?? fetchStartupBootstrap({ force: options?.capabilitiesOnly === true });
      const bootstrap = await requestedBootstrapPromise;
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      applyBootstrapData(bootstrap, authStateVersion, options);
    } catch (error) {
      if (!isCurrentAuthStateVersion(authStateVersion)) return;
      console.error("[Layout] fetch bootstrap failed", error);
      // A throttled background refresh must not wipe already-loaded
      // capabilities/settings/repos on a transient failure; leave current
      // state in place and let the next full refresh recover.
      if (options?.capabilitiesOnly) return;
      setSettings(null);
      setSettingsLoaded(true);
      setSettingsError("Failed to load settings.");
      setCapabilities(null);
      setCapabilitiesStatus("unavailable");
      setReposLoaded(true);
      setReposError("Failed to load repositories. GitHub may be unavailable.");
    }
  }

  async function hydrateAuthenticatedLayout(
    prefetched?: PrefetchedAuthenticatedHydration,
    authStateVersion = authStateVersionRef.current,
  ) {
    const scope = sessionScopeRef.current;
    const sessionsScope = prefetched?.sessionsScope ?? scope;
    const sessionsStatus = prefetched?.sessionsStatus ?? selectedStatusFilterRef.current;
    await Promise.allSettled([
      refreshSessionsForScope(sessionsScope, prefetched?.sessionsPromise, authStateVersion, sessionsStatus).catch(
        (error) => {
          console.error("[Layout] fetch sessions failed", error);
        },
      ),
      refreshStartupData(prefetched?.bootstrapPromise, authStateVersion),
    ]);
  }

  function shouldPrefetchAuthenticatedStartupData(pathname: string) {
    if (readAuthenticatedHint()) return true;
    // The auth cookie is HttpOnly, so the browser cannot inspect it here.
    // Speculatively fetch only on routes that already imply an authenticated session.
    return pathname !== "/";
  }

  function resetAuthenticatedState() {
    clearApiCache();
    pendingArchiveRollbacksRef.current.clear();
    setUser(null);
    setUserFreshValidated(false);
    setCapabilities(null);
    setCapabilitiesStatus("loading");
    setRepos([]);
    setReposLoaded(false);
    setReposFreshValidated(false);
    setReposError(null);
    setSsoOrgs([]);
    setRefreshingRepos(false);
    setSettings(null);
    setSettingsLoaded(false);
    setSettingsError(null);
    setSelectedRepo(null);
    setModels([]);
    setSelectedModel(null);
    setSessions([]);
    setSessionsLoaded(false);
    setNextCursor(null);
    hasLoadedMoreRef.current = false;
    resetParentTitles();
    setSidebarOpen(false);
  }

  layoutAuthOrchestrationRef.current = {
    fetchUser,
    logoutUser,
    applyUserState,
    syncUserContext,
    hydrateAuthenticatedLayout,
    refreshStartupData,
    prefetchAuthenticatedHydration,
    shouldPrefetchAuthenticatedStartupData,
    getUser: () => userRef.current,
    getAuthStateVersion: () => authStateVersionRef.current,
    clearRequestCache,
    invalidateAuthStateRequests,
    getRefreshInFlight: () => authRefreshInFlightRef.current,
    setRefreshInFlight: (promise: Promise<AuthProbeResult<User>> | null) => {
      authRefreshInFlightRef.current = promise;
    },
    getLastAuthRefreshAt: () => lastAuthRefreshAtRef.current,
    setLastAuthRefreshAt: (value: number) => {
      lastAuthRefreshAtRef.current = value;
    },
    setUserFreshValidated,
    writeAuthenticatedHint,
    resetAuthenticatedState,
    clearLoggedOutUserContext: () => import("../sentry").then(({ clearSentryUser }) => clearSentryUser()),
    onClearLoggedOutUserContextError: (e) => {
      console.error("[Layout] clear logged out user context failed", e);
    },
    now: () => Date.now(),
    onInitialLoadError: (e) => {
      console.error("[Layout] fetch user failed", e);
    },
    onSyncAuthenticatedUserError: (e) => {
      console.error("[Layout] sync authenticated user context failed", e);
    },
    onLoadAuthenticatedUserError: (e) => {
      console.error("[Layout] load authenticated user data failed", e);
    },
  };

  function buildOptimisticSession(
    sessionId: string,
    prompt: string,
    options: { model?: ModelSelection | null; title?: string | null } = {},
  ): SessionMetadata {
    const normalizedTitle = prompt.trim().split("\n")[0]?.trim() ?? "";
    return {
      sessionId,
      phase: "running",
      displayStatus: "working",
      sandboxSubstate: "creating",
      closeReason: null,
      prUrl: null,
      createdAt: Date.now(),
      model: options.model ?? selectedModel,
      title: options.title ?? (normalizedTitle || null),
    };
  }

  useMountEffect(() => {
    void loadInitialLayoutAuthState(layoutAuthOrchestrationRef.current, {
      initialUser,
      pathname: location.pathname,
    });
    window.addEventListener("focus", refreshAuthState);
    return () => window.removeEventListener("focus", refreshAuthState);
  });

  // Refetch the sidebar list when the tab returns to the foreground (sleep/resume,
  // tab switch, app switch) and on a low-frequency visible-only poll, so the list
  // does not go stale while backgrounded. Independent of the auth-refresh focus
  // listener above, which is throttled and never touches the session list.
  useRefetchOnActive({
    enabled: !!user,
    pollMs: SESSION_LIST_POLL_MS,
    onActive: (source) => {
      // A page-1 refetch would replace the list and drop any loaded-more pages;
      // leave a paginated view alone (scope/filter changes still reset it).
      if (hasLoadedMoreRef.current) return;
      refreshSessionsForScope(
        sessionScopeRef.current,
        undefined,
        authStateVersionRef.current,
        selectedStatusFilterRef.current,
        { force: source === "poll" },
      ).catch((e) => console.error("[Layout] focus/visibility refetch sessions failed", e));
    },
  });

  // Per-business realtime sidebar feed (ARC-1322). One always-on socket,
  // independent of any open session detail, that streams list deltas for ALL of
  // the user's sessions — so new sessions appear and status/PR/verification
  // changes show live, with no detail view open and no manual refresh. Each
  // delta flows through the pure reducer; a (re)connect debounces a refetch to
  // close any gap accumulated while disconnected.
  const feedReconnectRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useSessionFeed({
    enabled: !!user,
    onDelta: (delta) => {
      // Personal scope must not show teammates' sessions the business-scoped
      // feed also delivers (see feedDeltaMatchesScope).
      if (!feedDeltaMatchesScope(delta, sessionScopeRef.current, user ? String(user.id) : undefined)) return;
      setSessions((prev) => applyFeedDelta(prev, delta));
      // Do NOT cross-tab broadcast here. The per-business realtime feed (ARC-1322)
      // is always-on in every tab, so every tab already receives and applies this
      // same delta over its own socket. Broadcasting it would only force every
      // other tab into a redundant `refreshSessionsForScope({ force: true })`
      // against /api/sessions — a per-delta, per-tab fetch storm during active
      // streaming. Cross-tab sync is only needed for local mutations a tab
      // performs itself (create/archive/end) and SessionDetail phase/PR changes,
      // which broadcast at their own call sites.
    },
    onReconnect: () => {
      if (feedReconnectRefetchTimerRef.current) clearTimeout(feedReconnectRefetchTimerRef.current);
      feedReconnectRefetchTimerRef.current = setTimeout(() => {
        if (hasLoadedMoreRef.current) return;
        refreshSessionsForScope(
          sessionScopeRef.current,
          undefined,
          authStateVersionRef.current,
          selectedStatusFilterRef.current,
          { force: true },
        ).catch((e) => console.error("[Layout] feed reconnect refetch sessions failed", e));
      }, 300);
    },
  });
  // Cancel a pending feed-reconnect refetch if Layout unmounts mid-debounce.
  useSyncEffect(
    () => () => {
      if (feedReconnectRefetchTimerRef.current) clearTimeout(feedReconnectRefetchTimerRef.current);
    },
    [],
  );

  // Refetch sessions when scope changes (skip initial mount -- handled above).
  useOnChange([sessionScope], () => {
    setNextCursor(null);
    setSessions([]);
    setSessionsLoaded(false);
    refreshSessionsForScope(sessionScope, undefined, authStateVersionRef.current, null).catch((e) =>
      console.error("[Layout] fetch sessions failed", e),
    );
  });

  useOnChange([location.pathname], () => {
    setSidebarOpen(false);
    setError(null);
  });

  useSyncEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  useSyncEffect(() => {
    if (!isMobile || !sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isMobile, sidebarOpen]);

  async function handleArchive(id: string) {
    if (isSupportView) return;
    const session = sessions.find((candidate) => candidate.sessionId === id);
    if (!session) return;
    const closePr = Boolean(session.prUrl);
    const active = ARCHIVE_CONFIRM_PHASES.has(session.phase);
    if (
      !(await confirm({
        title: active ? "Archive active session?" : closePr ? "Archive and close PR?" : "Archive session?",
        message: active
          ? closePr
            ? "Archive this session and close its GitHub PR? Any current work will stop."
            : "Archive this session? Any current work will stop."
          : closePr
            ? "Archive this session and close its GitHub PR? This cannot be undone."
            : "Archive this session? This cannot be undone.",
        confirmLabel: closePr ? "Archive and close PR" : "Archive session",
        destructive: true,
      }))
    )
      return;
    // Optimistically remove the row, then reconcile against the network result.
    // If the request fails AND scope/filter/auth still match (no refetch landed
    // between optimistic remove and failure), restore the row at its original
    // index; otherwise drop the rollback because a fresh list already
    // re-resolved the truth.
    const archiveContext = getCurrentSessionListContext();
    const rollbackIndex = sessions.findIndex((session) => session.sessionId === id);
    const rollbackSession = rollbackIndex >= 0 ? sessions[rollbackIndex] : null;
    if (rollbackSession) {
      pendingArchiveRollbacksRef.current.set(id, {
        ...archiveContext,
        authStateVersion: authStateVersionRef.current,
        rollbackIndex,
        rollbackSession,
      });
      startTransition(() => {
        setSessions((prev) => prev.filter((session) => session.sessionId !== id));
      });
    }
    try {
      await archiveSession(id, { closePr });
      notifySessionListSync();
      toast("Session archived", { variant: "success" });
    } catch (e) {
      const pendingRollback = pendingArchiveRollbacksRef.current.get(id);
      pendingArchiveRollbacksRef.current.delete(id);
      // Note: we intentionally do not gate on `sessionListVersionRef`. An
      // intervening page-1 refetch under the matching context bumps that
      // counter while `reconcileArchivedSessions` keeps the still-pending row
      // hidden; if the archive then fails, gating on listVersion would leave
      // the row hidden forever. Auth-version + context match are sufficient:
      // a context change (scope/status/auth) drops the rollback so a fresh
      // server truth wins, while a same-context refetch never invalidates a
      // still-unconfirmed archive.
      const shouldRollback =
        pendingRollback &&
        pendingRollback.authStateVersion === authStateVersionRef.current &&
        sessionListContextMatches(pendingRollback, getCurrentSessionListContext());
      if (shouldRollback) {
        startTransition(() => {
          setSessions((prev) => {
            if (prev.some((session) => session.sessionId === id)) return prev;
            const next = [...prev];
            next.splice(Math.min(pendingRollback.rollbackIndex, next.length), 0, pendingRollback.rollbackSession);
            return next;
          });
        });
      }
      console.error("[Layout] archive session failed", e);
      toast("Could not archive session", { variant: "error" });
    }
  }

  async function handleEndSession(id: string) {
    if (isSupportView) return;
    if (
      !(await confirm({
        title: "End session?",
        message: "End session? Any open PR stays open.",
        confirmLabel: "End session",
        destructive: true,
      }))
    )
      return;
    try {
      await stopSession(id);
      patchSession(id, { phase: "stopped", stopMode: "user" });
      notifySessionListSync();
      toast("Session ended", { variant: "success" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to end session", { variant: "error" });
    }
  }

  const loadFilesForHomePage = useCallback(async (): Promise<string[]> => {
    if (!selectedRepoFreshValidatedRef.current) return [];
    const currentSelectedRepo = selectedRepoRef.current;
    const parsed = currentSelectedRepo ? parseRepoFullNameFromUrl(currentSelectedRepo.fullName) : null;
    if (!parsed) return [];
    const branch = resolveSessionBaseBranch(
      currentSelectedRepo,
      selectedBaseBranchRef.current,
      selectedBaseBranchRepoUrlRef.current,
    );
    return fetchRepoFiles(parsed.owner, parsed.repo, branch);
  }, []);

  async function handleNewSessionPrompt(payload: {
    prompt: string;
    skills?: string[];
    files?: string[];
    uploadedFiles?: UploadedFile[];
    uploadedImages?: UploadedImage[];
    reasoningEffort?: string;
    baseBranch?: string;
    planMode?: PlanModeSetting;
    takeoverPrUrl?: string;
  }) {
    if (isSupportView) return;
    if (!selectedRepo) return;
    if (!selectedRepoFreshValidated) {
      const message = "Repository access is still refreshing. Try again in a moment.";
      setError(message);
      throw new Error(message);
    }
    setCreating(true);
    setError(null);
    try {
      const baseBranch = resolveSessionBaseBranch(
        selectedRepo,
        payload.baseBranch ?? selectedBaseBranch,
        selectedBaseBranchRepoUrl,
      );
      const sessionOptions = payload.takeoverPrUrl
        ? { takeoverPrUrl: payload.takeoverPrUrl, planMode: payload.planMode }
        : payload.planMode !== undefined
          ? { planMode: payload.planMode }
          : undefined;
      const result = await createSessionAndSend(
        payload.prompt,
        { url: selectedRepo.url, baseBranch: payload.takeoverPrUrl ? undefined : baseBranch },
        selectedModel ?? undefined,
        payload.files,
        payload.uploadedFiles,
        payload.uploadedImages,
        undefined,
        payload.reasoningEffort,
        payload.skills,
        ...(sessionOptions ? [sessionOptions] : []),
      );
      const id = result.sessionId;
      navigate(`/sessions/${id}`);
      const optimisticSession = buildOptimisticSession(id, payload.prompt);
      startTransition(() => {
        setSessions((prev) => [optimisticSession, ...prev.filter((session) => session.sessionId !== id)]);
      });
      notifySessionListSync();
      void refreshSessionsForScope(sessionScope).catch((fetchError) => {
        console.error("[Layout] background fetch sessions failed", fetchError);
      });
    } catch (e) {
      if (payload.takeoverPrUrl && e instanceof ApiError) {
        const data = e.data as { code?: string; sessionUrl?: string } | undefined;
        const message =
          data?.code === "pr_takeover_conflict"
            ? `This PR already has an active Cycloid session${data.sessionUrl ? `: ${data.sessionUrl}` : "."}`
            : data?.code === "fork_pr"
              ? "Fork PRs cannot be taken over yet."
              : data?.code === "closed_pr"
                ? "This PR is closed and cannot be taken over."
                : data?.code === "start_branch_mismatch" || data?.code === "base_branch_mismatch"
                  ? "The PR branch or base changed before takeover. Refresh and try again."
                  : data?.code === "unsafe_head_ref"
                    ? "This PR has an unsafe or missing head branch."
                    : stringifyError(e);
        setError(message);
        throw new Error(message);
      } else {
        setError(stringifyError(e));
      }
      throw e;
    } finally {
      setCreating(false);
    }
  }

  function onLinearChange(connected: boolean) {
    if (user) setUser({ ...user, linearConnected: connected });
  }

  function onJiraChange(connected: boolean, siteName: string | null = null) {
    if (user) setUser({ ...user, jiraConnected: connected, jiraSiteName: connected ? siteName : null });
  }

  function onNotionChange(connected: boolean) {
    if (user) setUser({ ...user, notionConnected: connected });
  }

  function onSlackChange(connected: boolean) {
    if (user) setUser({ ...user, slackConnected: connected, slackLinked: false, slackNeedsReconnect: false });
  }

  function onDefaultModelChange(value: string | null) {
    if (value) {
      const selection = parseModelSelection(value, models);
      if (selection) {
        setSelectedModel(selection);
      }
    }
  }

  async function refreshUser() {
    await refreshLayoutUser(layoutAuthOrchestrationRef.current);
  }

  async function refreshAuthState() {
    await refreshLayoutAuthState(layoutAuthOrchestrationRef.current);
  }

  async function handleLogout() {
    await logoutLayoutUser(layoutAuthOrchestrationRef.current);
  }

  const context: LayoutContext = useMemo(
    () => ({
      user,
      capabilities,
      capabilitiesStatus,
      repos,
      reposLoaded,
      reposError,
      ssoOrgs,
      userFreshValidated,
      refreshingRepos,
      refreshRepos,
      settings,
      settingsLoaded,
      settingsError,
      setSettings,
      selectedRepo,
      setSelectedRepo: selectRepo,
      selectedRepoFreshValidated,
      models,
      selectedModel,
      setSelectedModel,
      selectModelForNewSession,
      sessions,
      sessionsLoaded,
      setSessions,
      patchSession,
      creating,
      setCreating,
      error,
      setError,
      handleNewSessionPrompt,
      loadFilesForHomePage,
      onLinearChange,
      onJiraChange,
      onNotionChange,
      onSlackChange,
      onDefaultModelChange,
      refreshModels,
      refreshUser,
      refreshSessions,
      endSession: handleEndSession,
      notifySessionListSync,
    }),
    [
      user,
      capabilities,
      capabilitiesStatus,
      repos,
      reposLoaded,
      reposError,
      ssoOrgs,
      userFreshValidated,
      refreshingRepos,
      refreshRepos,
      settings,
      settingsLoaded,
      settingsError,
      selectedRepo,
      selectRepo,
      selectedRepoFreshValidated,
      models,
      selectedModel,
      selectModelForNewSession,
      sessions,
      sessionsLoaded,
      patchSession,
      creating,
      error,
      handleNewSessionPrompt,
      loadFilesForHomePage,
      refreshModels,
      notifySessionListSync,
    ],
  );

  // Auth guard: redirect deep links to home when unauthenticated
  if (user === null && location.pathname !== "/") {
    return <Navigate to="/" replace />;
  }

  // Unauthenticated or loading: render only the page content (no header/sidebar)
  if (!user) {
    return (
      <main className="flex-1 h-full bg-surface-0">
        <Outlet context={context} />
      </main>
    );
  }

  function renderSidebar(mobile: boolean) {
    return (
      <Sidebar
        mobile={mobile}
        collapsed={!mobile && sidebarCollapsed}
        width={sidebarWidth}
        user={user ?? null}
        capabilities={capabilities}
        isSupportView={isSupportView}
        sessionsLoaded={sessionsLoaded}
        sessions={sessions}
        hasMoreSessions={Boolean(nextCursor)}
        loadingMoreSessions={loadingMore}
        onLoadMoreSessions={loadMoreSessions}
        onNavigate={() => setSidebarOpen(false)}
        onToggleCollapsed={toggleSidebarCollapsed}
        onArchiveSession={(sessionId) => void handleArchive(sessionId)}
        onLogout={() => void handleLogout()}
        onResizeStart={handleResizeStart}
      />
    );
  }

  return (
    <div
      className="flex flex-1 min-h-0 flex-col bg-surface-0"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-accent focus:text-surface-0 focus:text-sm"
      >
        Skip to content
      </a>
      {user?.impersonation ? <ImpersonationBanner impersonation={user.impersonation} targetLogin={user.login} /> : null}
      {isMobile && (
        <header className="border-b border-border bg-surface-0 relative z-10">
          <div className="flex items-center justify-between gap-3 px-5 py-4 md:px-8 md:py-5">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSidebarOpen((open) => !open)}
                aria-label="Toggle navigation"
                aria-expanded={sidebarOpen}
                className="inline-flex items-center justify-center control-lg min-w-[44px] text-text-muted hover:text-text-primary transition-colors duration-200 cursor-pointer"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <Link
                to="/"
                className="flex items-center cursor-pointer transition-opacity duration-200 hover:opacity-70"
                aria-label="Cycloid home"
              >
                <span className="font-display-tight text-xl text-text-primary leading-none">Cycloid</span>
              </Link>
            </div>
            <div className="flex items-center gap-3 sm:gap-4 md:gap-5 min-w-0">
              <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                {capabilities?.canStartSupportView && !isSupportView && (
                  // "Support view", matching the destination page — this is a
                  // nav link for support staff, not a state banner. Kit button
                  // classes: text controls are Geist (DESIGN.md grouping rule).
                  <Link to="/admin/support-view" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    Support view
                  </Link>
                )}
                <Link
                  to="/settings"
                  aria-label="Open settings"
                  className="inline-flex items-center justify-center control-lg min-w-[44px] text-text-muted hover:text-accent transition-colors duration-200 cursor-pointer"
                  title="Settings"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </Link>
              </div>
            </div>
          </div>
          {error && (
            <div
              className="editorial-fade flex items-start gap-3 border-t border-error-soft-border bg-error-soft px-4 py-2 text-xs text-error"
              role="alert"
            >
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss"
                className="-mr-1 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
              >
                <svg viewBox="0 0 12 12" fill="none" aria-hidden className="h-3 w-3">
                  <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </header>
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && renderSidebar(false)}
        <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 overflow-y-auto relative contain-strict">
          <div className={isMobile ? "h-full min-h-full px-5 py-6" : "h-full min-h-full p-0"}>
            <Outlet context={context} />
          </div>
        </main>
      </div>
      {isMobile && sidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 bg-surface-0/70 editorial-fade"
          />
          <div className="relative h-full editorial-slide-in">{renderSidebar(true)}</div>
        </div>
      )}
    </div>
  );
}
