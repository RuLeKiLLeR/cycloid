import type { DisplayStatus } from "../../../shared/session/display-status";

// --- Sidebar ---

export const SIDEBAR_DEFAULT_WIDTH = 288; // matches Tailwind w-72
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
// Collapsed state minimizes to an icon-only rail instead of removing the sidebar.
export const SIDEBAR_RAIL_WIDTH = 52;
export const SIDEBAR_WIDTH_KEY = "cycloid-sidebar-width";
export const SIDEBAR_COLLAPSED_KEY = "cycloid-sidebar-collapsed";

// --- External links ---

export const DOCS_URL = "https://docs.trycycloid.com";

// --- Session status styling ---

export const STATUS_DISPLAY_DOT: Record<DisplayStatus, string> = {
  working: "bg-warning status-dot-pulse",
  waiting_for_input: "bg-accent rounded-full",
  completed: "bg-success rounded-full",
  failed: "bg-error rounded-full",
  stopped: "bg-text-muted rounded-full",
  archived: "bg-text-muted rounded-full",
};

// Status rail: a thin vertical bar painted along the left edge of a session
// card. Same color vocabulary as STATUS_DISPLAY_DOT, but spans the card height
// so users can scan status without reading. Opacity is per-status so neutral
// states recede and active-prompt states pop.
export const STATUS_DISPLAY_RAIL: Record<DisplayStatus, { bg: string; opacity: string }> = {
  working: { bg: "bg-warning", opacity: "opacity-90" },
  waiting_for_input: { bg: "bg-accent", opacity: "opacity-100" },
  completed: { bg: "bg-success", opacity: "opacity-90" },
  failed: { bg: "bg-error", opacity: "opacity-90" },
  stopped: { bg: "bg-text-muted", opacity: "opacity-40" },
  archived: { bg: "bg-text-muted", opacity: "opacity-30" },
};

// --- Session filtering & polling ---

export const SESSION_STATUS_CHIPS: DisplayStatus[] = [
  "working",
  "waiting_for_input",
  "completed",
  "failed",
  "stopped",
  "archived",
];

// Re-export the canonical terminal-phase set from shared so UI consumers
// don't drift from server-side checks. The previous UI-local Set has been
// removed; see shared/session/phase.ts for the single source of truth.
export { TERMINAL_FOR_FALLBACK_POLLING_PHASES, TERMINAL_PHASES } from "../../../shared/session/phase.js";

// Aggressive fallback polling (WS blocked/down) backs off exponentially from
// FALLBACK_POLL_INITIAL_MS to FALLBACK_POLL_MAX_MS with jitter; see
// utils/fallback-backoff.ts.
export const FALLBACK_POLL_INITIAL_MS = 1000;
export const FALLBACK_POLL_MAX_MS = 30_000;
export const FALLBACK_POLL_JITTER_RATIO = 0.2;
export const RESILIENCE_POLL_MS = 30_000;
// Sidebar session-list refetch cadence while the tab is visible. Matches the
// per-session resilience poll; the list poll is gated on document visibility.
export const SESSION_LIST_POLL_MS = 30_000;
export const WS_BOOTSTRAP_TIMEOUT_MS = 3_000;
export const WS_LIVENESS_THRESHOLD_MS = 90_000;
export const WS_WATCHDOG_INTERVAL_MS = 15_000;
export const WS_WATCHDOG_ESCALATION_THRESHOLD = 3;

// --- Admin console ---

// Debounce applied to admin-console search inputs before firing the query.
export const ADMIN_SEARCH_DEBOUNCE_MS = 200;
