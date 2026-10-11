import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BootstrapCapabilities } from "../../../../../shared/types/bootstrap";
import { DOCS_URL, SIDEBAR_RAIL_WIDTH } from "../../constants";
import type { SessionMetadata, User } from "../../types";
import { Sidebar, type SidebarProps } from "./Sidebar";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function makeUser(): User {
  return {
    id: 1,
    login: "shivam",
    name: "Shivam",
    email: "shivam@example.com",
    avatarUrl: null,
    businessId: "biz_1",
    businessRole: "admin",
    sharedSessions: false,
    linearConnected: false,
    jiraConnected: false,
    jiraSiteName: null,
    notionConnected: false,
    slackConnected: false,
    slackNeedsReconnect: false,
  };
}

function makeSessions(count: number): SessionMetadata[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `session-${i}`,
    phase: "running" as const,
    displayStatus: "working" as const,
    closeReason: null,
    prUrl: null,
    createdAt: Date.now() - i * 60_000,
    model: null,
    title: `Session ${i}`,
  }));
}

function makeCapabilities(overrides: Partial<BootstrapCapabilities> = {}): BootstrapCapabilities {
  return {
    canAccessIntegrationDebug: false,
    canManageBusinessIntegrations: false,
    canManageCliTokens: false,
    canUseBusinessSessions: false,
    canAdminPendingSignups: false,
    canStartSupportView: false,
    canUseInternalModelProviderKeys: false,
    computerUse: false,
    canUseControlRoom: false,
    planApproval: false,
    ...overrides,
  };
}

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    mobile: false,
    collapsed: false,
    width: 288,
    user: makeUser(),
    capabilities: null,
    isSupportView: false,
    sessionsLoaded: true,
    sessions: makeSessions(3),
    hasMoreSessions: false,
    loadingMoreSessions: false,
    onLoadMoreSessions: vi.fn(),
    onNavigate: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onArchiveSession: vi.fn(),
    onLogout: vi.fn(),
    onResizeStart: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(
      <MemoryRouter>
        <Sidebar {...props} />
      </MemoryRouter>,
    );
  });
  return props;
}

describe("Sidebar", () => {
  it("wraps the session list in an independently scrollable region between pinned nav and bottom cluster", () => {
    renderSidebar({ sessions: makeSessions(40) });
    const scroll = container.querySelector('[data-testid="sidebar-session-scroll"]');
    expect(scroll).not.toBeNull();
    // min-h-0 + flex-1 + overflow-y-auto is what makes a flex child actually
    // scroll instead of stretching the sidebar; assert the full pattern.
    for (const cls of ["min-h-0", "flex-1", "overflow-y-auto"]) {
      expect(scroll?.classList.contains(cls), cls).toBe(true);
    }
    // The nav and bottom cluster live outside the scroll region so they stay pinned.
    expect(scroll?.querySelector("nav")).toBeNull();
    expect(scroll?.querySelector('a[href="/settings"]')).toBeNull();
  });

  it("renders every session row instead of capping the list", () => {
    renderSidebar({ sessions: makeSessions(40) });
    const scroll = container.querySelector('[data-testid="sidebar-session-scroll"]');
    expect(scroll?.querySelectorAll('a[href^="/sessions/"]').length).toBe(40);
  });

  it("offers load more inside the scroll region when more pages exist", () => {
    const props = renderSidebar({ sessions: makeSessions(5), hasMoreSessions: true });
    const buttons = Array.from(container.querySelectorAll("button"));
    const loadMore = buttons.find((button) => button.textContent === "Load more");
    expect(loadMore).not.toBeUndefined();
    act(() => loadMore?.click());
    expect(props.onLoadMoreSessions).toHaveBeenCalledTimes(1);
  });

  it("links to the docs in a new tab directly above Settings in the bottom cluster", () => {
    renderSidebar();
    const docs = container.querySelector(`a[href="${DOCS_URL}"]`);
    expect(docs).not.toBeNull();
    expect(docs?.getAttribute("target")).toBe("_blank");
    expect(docs?.getAttribute("rel")).toBe("noreferrer noopener");
    // Docs sits in the pinned bottom cluster, immediately before Settings.
    const cluster = docs?.parentElement;
    const settings = cluster?.querySelector('a[href="/settings"]');
    expect(settings).not.toBeNull();
    expect(docs?.nextElementSibling).toBe(settings);
  });

  it("collapses to an icon rail that keeps nav and bottom-cluster affordances but hides the session list", () => {
    renderSidebar({ collapsed: true, sessions: makeSessions(10) });
    const rail = container.querySelector('[data-testid="sidebar-rail"]') as HTMLElement | null;
    expect(rail).not.toBeNull();
    expect(rail?.style.width).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    // Session list section is hidden in the rail.
    expect(container.querySelector('[data-testid="sidebar-session-scroll"]')).toBeNull();
    expect(container.querySelectorAll('a[href^="/sessions/"]').length).toBe(0);
    // Icon-only nav items keep accessible names.
    expect(rail?.querySelector('a[aria-label="Dashboard"]')).not.toBeNull();
    expect(rail?.querySelector('a[aria-label="New task"]')).not.toBeNull();
    // Bottom cluster: docs, settings, sign out as icons.
    expect(rail?.querySelector(`a[href="${DOCS_URL}"][aria-label="Docs"]`)).not.toBeNull();
    expect(rail?.querySelector('a[href="/settings"][aria-label="Settings"]')).not.toBeNull();
    expect(rail?.querySelector('button[aria-label="Sign out"]')).not.toBeNull();
    // The toggle re-expands.
    expect(rail?.querySelector('button[aria-label="Expand navigation"]')).not.toBeNull();
  });

  it("re-expands from the rail via the toggle", () => {
    const props = renderSidebar({ collapsed: true });
    const toggle = container.querySelector('button[aria-label="Expand navigation"]') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());
    expect(props.onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  it("hides capability-gated nav items when capabilities are absent", () => {
    renderSidebar();
    expect(container.querySelector('a[href="/prs"]')).toBeNull();
    expect(container.querySelector('a[href="/activity"]')).toBeNull();
    expect(container.querySelector('a[href="/context"]')).toBeNull();
    expect(container.querySelector('a[href="/sessions"]')).not.toBeNull();
    expect(container.querySelector('a[href="/automations"]')).not.toBeNull();
  });

  it("makes Activity discoverable with the other control-room destinations", () => {
    renderSidebar({ capabilities: makeCapabilities({ canUseControlRoom: true }) });
    const nav = container.querySelector('nav[aria-label="Product navigation"]');
    expect(nav?.querySelector('a[href="/sessions"]')?.textContent).toContain("Sessions");
    expect(nav?.querySelector('a[href="/activity"]')?.textContent).toContain("Activity");
  });

  it("archives a session via an accessible icon button that reveals on hover and focus-within", () => {
    const props = renderSidebar({ sessions: makeSessions(1) });
    const archive = container.querySelector<HTMLButtonElement>('button[aria-label="Archive Session 0"]');
    expect(archive).not.toBeNull();
    // Icon glyph, not a bare "×" text glyph.
    expect(archive?.textContent).toBe("");
    expect(archive?.querySelector("svg")).not.toBeNull();
    // Hidden at rest, revealed on row hover and keyboard focus inside the row.
    expect(archive?.className).toContain("opacity-0");
    expect(archive?.className).toContain("group-hover:opacity-100");
    expect(archive?.className).toContain("group-focus-within:opacity-100");
    act(() => archive?.click());
    expect(props.onArchiveSession).toHaveBeenCalledWith("session-0");
  });

  it("gives the mobile drawer explicit close, Docs, and Settings actions", () => {
    const props = renderSidebar({ mobile: true });
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close navigation"]');
    const docs = container.querySelector<HTMLAnchorElement>(`a[href="${DOCS_URL}"]`);
    const settings = container.querySelector<HTMLAnchorElement>('a[href="/settings"]');

    expect(close).not.toBeNull();
    expect(docs?.target).toBe("_blank");
    expect(settings).not.toBeNull();

    act(() => close?.click());
    expect(props.onNavigate).toHaveBeenCalledTimes(1);
  });
});
