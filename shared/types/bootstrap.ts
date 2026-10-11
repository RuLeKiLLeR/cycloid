/**
 * Bootstrap DTO: the minimum payload the browser needs to initialize the app shell.
 *
 * This is the single source of truth for the GET /api/bootstrap contract.
 * Both the control-plane-worker (producer) and UI (consumer) import from here.
 *
 * Fields deliberately excluded from bootstrap (belong on lazy settings endpoints):
 *   - availableIntegrations, integrationTools, integrationScopes
 */

import type { ProviderApiKeyState } from "../constants/onboarding.js";
import type { PlanModeSetting } from "../plan-mode.js";

// -- User (narrowed: no integration scopes/tools) -----------------------------

export type BootstrapUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  businessId: string;
  businessRole: "admin" | "member" | null;
  sharedSessions: boolean;
  egressAllowlist: string[] | null;
  isCycloidAdmin: boolean;
  linearConnected: boolean;
  jiraConnected: boolean;
  jiraSiteName: string | null;
  notionConnected: boolean;
  slackConnected: boolean;
  slackNeedsReconnect: boolean;
  impersonation?: {
    impersonationId: string;
    actor: { id: number; login: string | null } | null;
    readOnly: true;
  };
};

// -- Capabilities -------------------------------------------------------------

/**
 * Server-authoritative UI exposure flags.
 *
 * The browser uses these only to decide which authenticated route modules to
 * register and lazy-load. Server routes remain the authorization boundary.
 */
export type BootstrapCapabilities = {
  canAccessIntegrationDebug: boolean;
  canManageBusinessIntegrations: boolean;
  canManageCliTokens: boolean;
  canUseBusinessSessions: boolean;
  /** True only for admins in the Cycloid-owned business. */
  canAdminPendingSignups: boolean;
  /** True only for admins in the Cycloid-owned business while not already in support view. */
  canStartSupportView: boolean;
  /** True for members of the Cycloid-owned business. */
  canUseInternalModelProviderKeys: boolean;
  /** True for members of a Cycloid-owned business while computer use is internal-only. */
  computerUse: boolean;
  /**
   * True for members of the Cycloid-owned business (prod or QA), excluding
   * impersonation. Gates the internal control-room surfaces (activity feed, PR
   * inbox, repo context). Exposure only; the routes remain the security boundary.
   */
  canUseControlRoom: boolean;
  /** True when the interactive plan approval flow is available. */
  planApproval: boolean;
};

// -- Settings -----------------------------------------------------------------

export type BootstrapSettings = {
  defaultPrDraft: boolean;
  autoVerifyEnabled: boolean;
  automaticReviewsEnabled: boolean;
  planMode: PlanModeSetting;
  planApprovalRequired: boolean;
  settingsProfile: "manual" | "autonomous" | "custom";
  useCodexSubscription: boolean;
  defaultModel: string | null;
  defaultRepo: string | null;
  apiKeys: Record<string, ProviderApiKeyState>;
};

// -- Models (display-safe chooser fields) -------------------------------------

export type BootstrapModelOption = {
  id: string;
  name: string;
  label: string;
  // Agent runtime backends that can run this model ("codex" | "claude_code").
  // Informational metadata for UI display/scoping only: the UI sends just the
  // model id, and the CONTROL PLANE derives the session's agentRuntimeBackend
  // from it (and re-validates the pair fail-closed). Do not derive or send the
  // backend client-side.
  backends?: string[];
  contextWindow?: number;
  reasoning?: {
    efforts: string[];
    default?: string;
  };
};

export type BootstrapModelGroup = {
  id: string;
  name: string;
  models: BootstrapModelOption[];
  hasApiKey?: boolean;
};

// -- Repos (unchanged from existing shape) ------------------------------------

export type BootstrapRepo = {
  fullName: string;
  url: string;
  private: boolean;
  defaultBranch: string;
  ownerType: "User" | "Organization";
};

// -- SSO-withheld orgs --------------------------------------------------------

/**
 * A GitHub org whose repos GitHub silently omitted from `/user/repos` because
 * the user's token is not SAML-SSO-authorized for it. GitHub signals this with
 * an `X-GitHub-SSO: partial-results; organizations=<id,...>` response header
 * (HTTP 200, repos missing). Surfaced so the user can authorize instead of
 * facing an unexplained empty repo selector.
 *
 * `login`/`authorizeUrl` are null when we only have the org ID and no
 * installation row maps it to a login (the org login lookup is itself
 * SSO-gated). The UI then shows a generic prompt instead of a deep link.
 */
export type SsoOrg = {
  orgId: number;
  login: string | null;
  /** Same-origin path (`/auth/github/sso?org=...`) starting the SSO + OAuth re-auth chain. */
  authorizeUrl: string | null;
};

// -- Response -----------------------------------------------------------------

export type BootstrapResponse = {
  authenticated: true;
  user: BootstrapUser;
  capabilities: BootstrapCapabilities;
  models: BootstrapModelGroup[] | null;
  repos: BootstrapRepo[] | null;
  /**
   * True when `repos` is null because the repo list was a cache miss/stale and
   * the GitHub fetch was deferred off the app-load critical path (not a
   * failure). The client lazy-loads `/api/repos` and shows a loading state
   * rather than the "failed to load" error. False when `repos` is populated or
   * genuinely failed (the latter also carries a `warnings` entry).
   */
  reposPending: boolean;
  /** Orgs whose repos GitHub withheld pending SAML SSO authorization. Empty when none. */
  ssoOrgs: SsoOrg[];
  settings: BootstrapSettings | null;
  warnings: string[];
};
