import { useMemo } from "react";
import { Link, NavLink, useLocation } from "react-router";

import type { BootstrapCapabilities } from "../../../../../shared/types/bootstrap";
import { DOCS_URL, SIDEBAR_RAIL_WIDTH } from "../../constants";
import type { SessionMetadata, User } from "../../types";
import { compactTimeAgo } from "../../utils/session-grouping";
import { orderSessionsForSidebar } from "../../utils/session-list-order";
import { ArchiveIcon, CloseIcon } from "../icons";
import { Button, buttonClasses, IconButton } from "../ui";

// Compact currentColor icons for the grouped product nav. icons.tsx is owned by
// another surface and lacks most of these glyphs, so they live inline here at
// the sidebar's 15px dense size. The shared icon set draws at stroke 1.6 on a
// 16 grid (relative weight 0.10); these glyphs use a 24 grid, so they carry a
// stroke of 2 (relative weight 0.083) to read as one icon family instead of
// thinner, cheaper hairlines.
const NAV_ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function HomeNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}

function PrNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 15.5v-4a3 3 0 0 0-3-3h-3" />
      <path d="M14 6.5 12 8.5l2 2" />
    </svg>
  );
}

function SessionsNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <path d="M5 5h14M5 12h14M5 19h14" />
      <circle cx="3" cy="5" r=".5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r=".5" fill="currentColor" stroke="none" />
      <circle cx="3" cy="19" r=".5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ActivityNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </svg>
  );
}

function AutomationNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z" />
    </svg>
  );
}

function ContextNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <path d="M5 4.5C5 3.67 5.67 3 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5V4.5Z" />
      <path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5Z" />
    </svg>
  );
}

function SettingsNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function DocsNavIcon() {
  return (
    <svg {...NAV_ICON_PROPS}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function CollapseToggleIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

// Product navigation stays flat and direct so the rail feels like a cockpit,
// not an admin sitemap. `end` restricts active matching to the exact path
// (Home would otherwise light up for every nested route).
type ProductNavItem = {
  to: string;
  label: string;
  icon: () => React.ReactElement;
  end?: boolean;
  // When set, the item is only rendered if the capability is true. Server routes
  // remain the security boundary; this only hides the affordance.
  capability?: keyof BootstrapCapabilities;
};

const PRODUCT_NAV_ITEMS: ProductNavItem[] = [
  { to: "/", label: "Dashboard", icon: HomeNavIcon, end: true },
  { to: "/sessions", label: "Sessions", icon: SessionsNavIcon, end: true },
  { to: "/prs", label: "PRs", icon: PrNavIcon, capability: "canUseControlRoom" },
  { to: "/automations", label: "Automations", icon: AutomationNavIcon },
  { to: "/activity", label: "Activity", icon: ActivityNavIcon, capability: "canUseControlRoom" },
  { to: "/context", label: "Context", icon: ContextNavIcon, capability: "canUseControlRoom" },
];

export type SidebarProps = {
  mobile: boolean;
  /** Desktop-only: minimized to an icon rail. Ignored for the mobile drawer. */
  collapsed?: boolean;
  width: number;
  user: User | null;
  capabilities: BootstrapCapabilities | null;
  isSupportView: boolean;
  sessionsLoaded: boolean;
  sessions: SessionMetadata[];
  hasMoreSessions: boolean;
  loadingMoreSessions: boolean;
  onLoadMoreSessions: () => void;
  /** Called on any in-app navigation so the mobile drawer can close. */
  onNavigate: () => void;
  onToggleCollapsed: () => void;
  onArchiveSession: (sessionId: string) => void;
  onLogout: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
};

export function Sidebar({
  mobile,
  collapsed = false,
  width,
  user,
  capabilities,
  isSupportView,
  sessionsLoaded,
  sessions,
  hasMoreSessions,
  loadingMoreSessions,
  onLoadMoreSessions,
  onNavigate,
  onToggleCollapsed,
  onArchiveSession,
  onLogout,
  onResizeStart,
}: SidebarProps) {
  const location = useLocation();
  const isSessionRoute = location.pathname.startsWith("/sessions/");
  const orderedSessions = useMemo(() => orderSessionsForSidebar(sessions), [sessions]);
  const visibleNavItems = PRODUCT_NAV_ITEMS.filter(
    (item) => !item.capability || capabilities?.[item.capability] === true,
  );

  // Rail and expanded trees swap inside the same root <aside>, so React keeps
  // the DOM node and `.sidebar-collapse` transitions its width between the
  // two states; each body fades in over the reflow.
  if (!mobile && collapsed) {
    return (
      <aside
        data-testid="sidebar-rail"
        className="sidebar-collapse relative flex shrink-0 flex-col overflow-x-clip border-r border-border bg-surface-1"
        style={{ width: SIDEBAR_RAIL_WIDTH }}
        aria-label="Session navigation"
      >
        <div className="editorial-fade flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 justify-center pb-3 pt-4">
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Expand navigation"
              aria-expanded={false}
              title="Expand navigation"
              className="control-sm inline-flex min-w-8 items-center justify-center rounded-md px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <CollapseToggleIcon />
            </button>
          </div>

          {!isSupportView && (
            <div className="flex shrink-0 justify-center pb-2">
              <Link
                to="/"
                onClick={onNavigate}
                aria-label="New task"
                title="New task"
                // Kit button variants: primary on non-session routes, quieter
                // secondary while a session is active.
                className={buttonClasses({
                  variant: isSessionRoute ? "secondary" : "primary",
                  size: "md",
                  className: "min-w-8 px-0",
                })}
              >
                <span aria-hidden>+</span>
              </Link>
            </div>
          )}

          <nav aria-label="Product navigation" className="shrink-0 pb-3 pt-1">
            <div className="flex flex-col gap-0.5">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    aria-label={item.label}
                    title={item.label}
                    className={({ isActive }) =>
                      `flex items-center justify-center border-l-2 py-2 transition-colors duration-150 ${
                        isActive
                          ? "border-border-focus text-text-primary"
                          : "border-transparent text-text-muted hover:bg-surface-2 hover:text-text-primary"
                      }`
                    }
                  >
                    <Icon />
                  </NavLink>
                );
              })}
            </div>
          </nav>

          <div className="min-h-0 flex-1" />

          <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border py-3">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Docs"
              title="Docs"
              className="control-sm inline-flex min-w-8 items-center justify-center rounded-md px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <DocsNavIcon />
            </a>
            <Link
              to="/settings"
              aria-label="Settings"
              title="Settings"
              className="control-sm inline-flex min-w-8 items-center justify-center rounded-md px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <SettingsNavIcon />
            </Link>
            <button
              type="button"
              onClick={onLogout}
              aria-label="Sign out"
              title="Sign out"
              className="control-sm inline-flex min-w-8 items-center justify-center rounded-md px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <SignOutIcon />
            </button>
          </div>
        </div>
      </aside>
    );
  }

  const sidebarAccountLabel = user?.name || user?.login || "Account";
  return (
    <aside
      className={
        mobile
          ? "h-full w-[85vw] max-w-[22rem] border-r border-border bg-surface-1 flex flex-col @container/sidebar"
          : "sidebar-collapse border-r border-border bg-surface-1 flex flex-col shrink-0 relative overflow-x-clip @container/sidebar"
      }
      style={
        mobile
          ? {
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
            }
          : { width }
      }
      role={mobile ? "dialog" : undefined}
      aria-modal={mobile ? true : undefined}
      aria-label="Session navigation"
    >
      {/* Fixed-width body on desktop: while the aside's width transitions from
          the rail, content stays laid out at its target width and clips
          instead of squishing. */}
      <div
        className={mobile ? "flex min-h-0 flex-1 flex-col" : "editorial-fade flex min-h-0 flex-1 flex-col"}
        style={mobile ? undefined : { width }}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-4">
          <Link
            to="/"
            onClick={onNavigate}
            className="font-display-tight min-w-0 truncate text-xl leading-none text-text-primary transition-opacity duration-150 hover:opacity-75"
            aria-label="Cycloid home"
          >
            Cycloid
          </Link>
          {mobile ? (
            <button
              type="button"
              onClick={onNavigate}
              aria-label="Close navigation"
              title="Close navigation"
              className="control-sm inline-flex min-w-8 items-center justify-center px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <CloseIcon className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse navigation"
              aria-expanded={true}
              title="Collapse navigation"
              className="control-sm inline-flex min-w-8 items-center justify-center rounded-md px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <CollapseToggleIcon />
            </button>
          )}
        </div>

        {!isSupportView && (
          <div className="flex shrink-0 gap-2 px-3 pb-2">
            <Link
              to="/"
              onClick={onNavigate}
              // Kit button variants: primary on non-session routes, quieter
              // secondary while a session is active.
              className={buttonClasses({
                variant: isSessionRoute ? "secondary" : "primary",
                size: "md",
                className: "min-w-0 grow",
              })}
            >
              <span aria-hidden>+</span>
              <span>New task</span>
            </Link>
          </div>
        )}

        <nav aria-label="Product navigation" className="shrink-0 px-2 pb-3 pt-1">
          <div className="flex flex-col gap-0.5">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 border-l-2 pl-2.5 pr-2.5 py-2 text-sm transition-colors duration-150 ${
                      isActive
                        ? "border-border-focus text-text-primary font-medium"
                        : "border-transparent text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className={`shrink-0 ${isActive ? "text-text-primary" : "text-text-muted"}`}>
                        <Icon />
                      </span>
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        </nav>

        <div className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-5">
          <span className="text-sm font-medium text-text-muted">Recents</span>
        </div>

        {/* The one scrollable region: top nav above and the bottom cluster below
          stay pinned while long session lists scroll independently. min-h-0
          lets this flex child shrink below its content height. */}
        <div data-testid="sidebar-session-scroll" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 contain-strict">
          {!sessionsLoaded ? (
            <div className="space-y-2 px-2 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-surface-1 motion-safe:animate-pulse" />
              ))}
            </div>
          ) : orderedSessions.length === 0 ? (
            <div className="px-2 py-2 text-sm text-text-muted">No recent sessions</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {orderedSessions.map((session) => {
                const status = session.displayStatus;
                const dotClass =
                  status === "working"
                    ? "bg-live review-loop-breathe"
                    : status === "waiting_for_input"
                      ? "bg-warning"
                      : "bg-text-muted";
                const repo =
                  session.repoOwner && session.repoName
                    ? `${session.repoOwner}/${session.repoName}`
                    : (session.repoName ?? null);
                return (
                  <div key={session.sessionId} className="group flex min-w-0 items-start gap-1 rounded-md">
                    <Link
                      to={`/sessions/${session.sessionId}`}
                      onClick={onNavigate}
                      className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
                        <span className="min-w-0 flex-1 truncate">{session.title ?? "Untitled session"}</span>
                        <span className="shrink-0 font-mono-tabular text-xs text-text-muted">
                          {compactTimeAgo(session.createdAt)}
                        </span>
                      </span>
                      {repo && (
                        <span className="mt-0.5 truncate pl-3.5 font-mono-tabular text-xs text-text-muted">{repo}</span>
                      )}
                    </Link>
                    {!isSupportView && (
                      // Hidden until the row is hovered or anything in it (the
                      // row link or this button) holds focus.
                      <IconButton
                        label={`Archive ${session.title ?? "session"}`}
                        size="sm"
                        onClick={() => onArchiveSession(session.sessionId)}
                        className="mt-1 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                      >
                        <ArchiveIcon />
                      </IconButton>
                    )}
                  </div>
                );
              })}
              {hasMoreSessions && (
                <div className="flex justify-center pt-1">
                  <Button size="sm" onClick={onLoadMoreSessions} disabled={loadingMoreSessions}>
                    {loadingMoreSessions ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
        {mobile && (
          <div className="shrink-0 border-t border-border p-3 md:hidden">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              onClick={onNavigate}
              className="mb-0.5 flex items-center gap-2.5 px-2 py-2 text-sm text-text-secondary transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <span className="text-text-muted">
                <DocsNavIcon />
              </span>
              <span className="truncate">Docs</span>
            </a>
            <Link
              to="/settings"
              onClick={onNavigate}
              className="mb-2 flex items-center gap-2.5 px-2 py-2 text-sm text-text-secondary transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <span className="text-text-muted">
                <SettingsNavIcon />
              </span>
              <span className="truncate">Settings</span>
            </Link>
            <button
              type="button"
              onClick={onLogout}
              className="control-lg w-full cursor-pointer border border-border px-3 py-2 text-sm text-text-muted transition-colors duration-150 hover:border-border-hover hover:text-text-primary"
            >
              Sign out
            </button>
          </div>
        )}
        {!mobile && (
          <div className="shrink-0 border-t border-border p-3">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="mb-0.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <span className="text-text-muted">
                <DocsNavIcon />
              </span>
              <span className="truncate">Docs</span>
            </a>
            <Link
              to="/settings"
              className="mb-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
            >
              <span className="text-text-muted">
                <SettingsNavIcon />
              </span>
              <span className="truncate">Settings</span>
            </Link>
            <div className="flex items-center gap-2 px-2 py-1">
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="size-5 shrink-0 rounded-md" referrerPolicy="no-referrer" />
              ) : null}
              <Link
                to="/settings"
                className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary transition-colors duration-150 hover:text-text-secondary"
              >
                {sidebarAccountLabel}
              </Link>
              <button
                type="button"
                onClick={onLogout}
                aria-label="Sign out"
                title="Sign out"
                className="control-sm inline-flex min-w-8 items-center justify-center rounded-md px-0 text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
              >
                <SignOutIcon />
              </button>
            </div>
          </div>
        )}
      </div>
      {!mobile && (
        // Fully inside the aside (no straddling translate) so overflow-x-clip
        // cannot shave the grab area during the collapse transition.
        <div
          aria-hidden="true"
          onMouseDown={onResizeStart}
          className="absolute top-0 right-0 w-3 h-full cursor-col-resize group z-10"
        >
          <div className="absolute inset-y-0 right-0 w-px bg-transparent group-hover:bg-border-hover transition-colors duration-150" />
        </div>
      )}
    </aside>
  );
}
