import { useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useOutletContext } from "react-router";

import {
  ONBOARDING_STEP_STATUS,
  type OnboardingStep,
  type OnboardingStepId,
} from "../../../../shared/constants/onboarding";
import type { BootstrapCapabilities } from "../../../../shared/types/bootstrap";
import { fetchOnboardingStatus } from "../api/onboarding";
import type { LayoutContext } from "../components/Layout";
import { SettingsSkeleton } from "../components/settings/SettingsLayout";
import { SettingsSearchInput, SettingsSearchResults } from "../components/settings/SettingsSearch";
import { useMountEffect } from "../hooks/useEffects";

type SettingsTab = {
  label: string;
  to: string;
  // Absent capability hides the tab entirely (admin-only surfaces we don't
  // advertise to members, e.g. Diagnostics).
  hideWithoutCapability?: keyof BootstrapCapabilities;
  // Absent capability keeps the tab visible but disabled with an "Admins only"
  // hint. Workspace-scoped settings members can see but not open.
  adminOnlyCapability?: keyof BootstrapCapabilities;
};

type SettingsGroup = {
  label: string;
  tabs: SettingsTab[];
};

export type SettingsTabAccess = "enabled" | "disabled" | "hidden";

// One writer for nav visibility so the render and any tests agree. Workspace
// admin surfaces stay visible-but-disabled for members; capability-gated
// system/repo tabs disappear entirely.
export function getSettingsTabAccess(
  tab: SettingsTab,
  capabilities: BootstrapCapabilities | null | undefined,
): SettingsTabAccess {
  if (tab.hideWithoutCapability && capabilities?.[tab.hideWithoutCapability] !== true) return "hidden";
  if (tab.adminOnlyCapability && capabilities?.[tab.adminOnlyCapability] !== true) return "disabled";
  return "enabled";
}

// Static nav: one concern per route, nav label == page H1. "Getting started"
// stays at the top of the Account group even after setup completes (it hosts
// next-steps content), and its label no longer flips so returning users see a
// stable nav. Workspace tabs are visible to every member; non-admins see them
// disabled with an "Admins only" hint.
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Account",
    tabs: [
      { label: "Getting started", to: "/settings/get-started" },
      { label: "Preferences", to: "/settings/preferences" },
      { label: "Connected accounts", to: "/settings/integrations" },
      { label: "Model API keys", to: "/settings/api-keys" },
      { label: "Personal secrets", to: "/settings/personal-secrets" },
      { label: "CLI tokens", to: "/settings/cli-tokens" },
      { label: "Usage", to: "/settings/usage" },
    ],
  },
  {
    label: "Repositories",
    tabs: [
      // Visible and enabled for every member: the per-repo review checklist is
      // member-usable even though the env-var and sandbox sections gate to admins
      // in-page.
      { label: "Repositories", to: "/settings/repositories" },
    ],
  },
  {
    label: "Workspace",
    tabs: [
      {
        label: "Workspace policies",
        to: "/settings/workspace-policies",
        adminOnlyCapability: "canManageBusinessIntegrations",
      },
      {
        label: "Workspace integrations",
        to: "/settings/workspace-integrations",
        adminOnlyCapability: "canManageBusinessIntegrations",
      },
      {
        label: "Slack memory",
        to: "/settings/slack-memory",
        adminOnlyCapability: "canManageBusinessIntegrations",
      },
      {
        label: "MCP servers",
        to: "/settings/mcp-servers",
        adminOnlyCapability: "canManageBusinessIntegrations",
      },
    ],
  },
  {
    label: "System",
    tabs: [
      {
        label: "Diagnostics",
        to: "/settings/diagnostics",
        hideWithoutCapability: "canAccessIntegrationDebug",
      },
    ],
  },
];

// New-user critical-path: must match GetStartedSettings so the index redirect
// and checklist agree on what "complete" means.
//
// We rely on the onboarding endpoint for sign-in and api-key state (which it can
// determine without a repo context), but for app-install and repo-access we use
// `repos.length > 0` - the cheapest accurate signal that "Cycloid can see at
// least one repo for this user." The endpoint's app-install / repo-access checks
// need a `?owner=&repo=` query, which a brand-new user usually doesn't have yet.
const ENDPOINT_REQUIRED_STEP_IDS: ReadonlyArray<OnboardingStepId> = ["github_login", "openai_key"];

function isSetupComplete(
  steps: OnboardingStep[] | null,
  reposLoaded: boolean,
  repos: { fullName: string }[],
  defaultRepo: string | null,
): boolean {
  if (!steps || !reposLoaded) return false;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const endpointDone = ENDPOINT_REQUIRED_STEP_IDS.every((id) => {
    const step = byId.get(id);
    if (!step) return false;
    return step.status === ONBOARDING_STEP_STATUS.CONNECTED || step.status === ONBOARDING_STEP_STATUS.BUSINESS_MANAGED;
  });
  // Default-repo is a UI-only required slot in GetStartedSettings; mirror that
  // here so the `/settings` redirect agrees with the checklist.
  const defaultRepoDone = !!defaultRepo && repos.some((repo) => repo.fullName === defaultRepo);
  return endpointDone && repos.length > 0 && defaultRepoDone;
}

function useOnboardingSteps(): { steps: OnboardingStep[] | null; loaded: boolean } {
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useMountEffect(() => {
    fetchOnboardingStatus()
      .then((fetched) => setSteps(fetched))
      .catch(() => {
        // Soft-fail: when the status check breaks we keep the nav stable rather than
        // hiding the user's primary settings surface behind a redirect loop.
        setSteps(null);
      })
      .finally(() => setLoaded(true));
  });

  return { steps, loaded };
}

// Routed at `/settings` (index). Decides whether to drop the user on the
// checklist or on Preferences, based on whether all required steps are
// connected. While the status check is in flight we render a skeleton so a slow
// network doesn't strand users on the wrong page mid-redirect.
export function SettingsIndexRedirect() {
  const context = useOutletContext<LayoutContext>();
  const { steps, loaded } = useOnboardingSteps();
  if (!loaded || !context.reposLoaded) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <SettingsSkeleton />
      </div>
    );
  }
  const complete = isSetupComplete(steps, context.reposLoaded, context.repos, context.settings?.defaultRepo ?? null);
  return <Navigate to={complete ? "/settings/preferences" : "/settings/get-started"} replace />;
}

export function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const context = useOutletContext<LayoutContext>();
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileSectionsOpen, setMobileSectionsOpen] = useState(false);
  const isImpersonating = context.user?.impersonation?.readOnly === true;

  if (!context.user) return null;

  if (isImpersonating) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <button
          onClick={() => navigate("/")}
          className="btn-press inline-flex control-sm cursor-pointer items-center gap-2 eyebrow text-text-muted transition-colors duration-200 hover:text-text-primary"
        >
          <span aria-hidden>←</span> Back to dashboard
        </button>
        <div className="mt-6 border border-border bg-surface-1 px-5 py-4">
          <p className="eyebrow mb-2">Read only</p>
          <h1 className="text-xl font-medium text-text-primary">Settings are unavailable in support view.</h1>
        </div>
      </div>
    );
  }

  const visibleGroups = SETTINGS_GROUPS.map((group) => ({
    label: group.label,
    tabs: group.tabs
      .map((tab) => ({ tab, access: getSettingsTabAccess(tab, context.capabilities) }))
      .filter((entry) => entry.access !== "hidden"),
  })).filter((group) => group.tabs.length > 0);

  // Route → access for search results, so search mirrors the nav exactly:
  // hidden tabs are absent from the map (and from results), disabled tabs
  // render with the same "Admins only" hint.
  const accessByRoute: Record<string, "enabled" | "disabled"> = {};
  for (const group of visibleGroups) {
    for (const { tab, access } of group.tabs) {
      if (access !== "hidden") accessByRoute[tab.to] = access;
    }
  }
  const searchActive = searchQuery.trim().length > 0;
  const currentTab = visibleGroups
    .flatMap((group) => group.tabs)
    .find(({ tab }) => location.pathname === tab.to || location.pathname.startsWith(`${tab.to}/`));
  const currentSectionLabel =
    currentTab?.tab.label ?? (location.pathname === "/settings/general" ? "Preferences" : "Choose a section");

  return (
    <div className="control-room-canvas control-room-page">
      <div className="control-room-content max-w-[1280px]">
        <header className="editorial-rise editorial-rise-1 mb-8 pb-2">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="btn-press inline-flex control-sm cursor-pointer items-center gap-2 eyebrow text-text-muted transition-colors duration-200 hover:text-text-primary"
          >
            <span aria-hidden>←</span> Back to dashboard
          </button>
        </header>

        {/* Beat 2 shared with the desktop sidebar: both are the section-nav band. */}
        <div className="editorial-rise editorial-rise-2 relative mb-8 lg:hidden">
          <button
            type="button"
            aria-expanded={mobileSectionsOpen}
            aria-controls="mobile-settings-sections"
            onClick={() => setMobileSectionsOpen((open) => !open)}
            className="control-lg flex w-full items-center justify-between border border-border-strong bg-surface-1 px-3 text-left text-base text-text-primary transition-colors hover:border-border-hover"
          >
            <span className="min-w-0 truncate">{currentSectionLabel}</span>
            <span
              aria-hidden
              className={`text-text-muted transition-transform ${mobileSectionsOpen ? "rotate-180" : ""}`}
            >
              ↓
            </span>
          </button>
          {mobileSectionsOpen && (
            <nav
              id="mobile-settings-sections"
              aria-label="Settings section selector"
              className="menu-pop absolute inset-x-0 top-[calc(100%+4px)] z-dropdown max-h-[min(70dvh,32rem)] overflow-y-auto border border-border bg-surface-3 p-2"
            >
              {visibleGroups.map((group, groupIndex) => (
                <div key={group.label} className={groupIndex > 0 ? "mt-4" : ""}>
                  <p className="eyebrow px-2 py-1">{group.label}</p>
                  <ul className="flex flex-col">
                    {group.tabs.map(({ tab, access }) => (
                      <li key={tab.to} className="min-w-0">
                        {access === "disabled" ? (
                          <div
                            aria-disabled="true"
                            title="Admins only"
                            className="flex cursor-not-allowed items-center justify-between gap-2 border-l-2 border-transparent px-2 py-2 text-base text-text-muted"
                          >
                            <span className="min-w-0 truncate">{tab.label}</span>
                            <span className="eyebrow shrink-0">Admins only</span>
                          </div>
                        ) : (
                          <NavLink
                            to={tab.to}
                            onClick={() => setMobileSectionsOpen(false)}
                            className={({ isActive }) =>
                              `block border-l-2 px-2 py-2 text-base transition-colors ${
                                isActive
                                  ? "border-border-focus bg-surface-2 font-medium text-text-primary"
                                  : "border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                              }`
                            }
                          >
                            {tab.label}
                          </NavLink>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          )}
        </div>

        <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="editorial-rise editorial-rise-2 hidden lg:sticky lg:top-6 lg:block lg:self-start">
            <div className="mb-4 px-4 lg:px-0">
              <SettingsSearchInput value={searchQuery} onChange={setSearchQuery} />
            </div>
            {searchActive ? (
              <SettingsSearchResults
                query={searchQuery}
                accessByRoute={accessByRoute}
                onNavigate={() => setSearchQuery("")}
              />
            ) : (
              <nav aria-label="Settings sections">
                {visibleGroups.map((group, groupIndex) => (
                  <div key={group.label} className={groupIndex > 0 ? "mt-7" : ""}>
                    <p className="eyebrow px-4">{group.label}</p>
                    <ul className="mt-2.5 flex flex-col">
                      {group.tabs.map(({ tab, access }) => (
                        <li key={tab.to} className="min-w-0">
                          {access === "disabled" ? (
                            <div
                              aria-disabled="true"
                              title="Admins only"
                              className="flex cursor-not-allowed items-center justify-between gap-2 border-l-2 border-transparent px-4 py-2 text-base leading-snug text-text-muted"
                            >
                              <span className="min-w-0 truncate">{tab.label}</span>
                              <span className="eyebrow shrink-0">Admins only</span>
                            </div>
                          ) : (
                            <NavLink
                              to={tab.to}
                              className={({ isActive }) =>
                                `block border-l-2 px-4 py-2 text-base leading-snug transition-colors duration-150 ${
                                  isActive
                                    ? "border-border-focus bg-surface-2 font-medium text-text-primary"
                                    : "border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                                }`
                              }
                            >
                              {tab.label}
                            </NavLink>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
            )}
          </aside>

          <div className="editorial-rise editorial-rise-3 min-w-0">
            <div className="mx-auto w-full max-w-4xl">
              <Outlet context={context} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
