import { INTEGRATION_REGISTRY } from "./integrations.js";

// ---------------------------------------------------------------------------
// Onboarding step IDs
// ---------------------------------------------------------------------------

/**
 * Every onboarding step a user may need to complete.
 * Derived from INTEGRATION_REGISTRY plus GitHub-specific sub-steps.
 */
export const ONBOARDING_STEP_IDS = [
  // GitHub sub-steps (broken out from the single "github" integration)
  "github_login",
  "github_business_authorized",
  "github_app_installed",
  "github_repo_access",
  // Per-integration credential steps
  "openai_key",
  "linear_oauth",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

// ---------------------------------------------------------------------------
// Step status
// ---------------------------------------------------------------------------

export const ONBOARDING_STEP_STATUS = {
  CONNECTED: "connected",
  NOT_CONNECTED: "not_connected",
  NEEDS_RECONNECT: "needs_reconnect",
  VALIDATION_FAILED: "validation_failed",
  DISABLED: "disabled",
  BUSINESS_MANAGED: "business_managed",
  LOOKUP_FAILED: "lookup_failed",
} as const;

export type OnboardingStepStatus = (typeof ONBOARDING_STEP_STATUS)[keyof typeof ONBOARDING_STEP_STATUS];

// ---------------------------------------------------------------------------
// Credential validation state
// ---------------------------------------------------------------------------

export const CREDENTIAL_VALIDATION_STATUS = {
  VALIDATED: "validated",
  SAVED_UNVERIFIED: "saved_unverified",
  INVALID: "invalid",
} as const;

export type CredentialValidationStatus =
  (typeof CREDENTIAL_VALIDATION_STATUS)[keyof typeof CREDENTIAL_VALIDATION_STATUS];

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const ONBOARDING_REASON_CODES = {
  // General
  NONE: "none",
  CREDENTIALS_MISSING: "credentials_missing",
  CREDENTIALS_PRESENT: "credentials_present",
  CREDENTIALS_INVALID: "credentials_invalid",
  INTEGRATION_DISABLED: "integration_disabled",
  BUSINESS_MANAGED: "business_managed",
  NETWORK_VALIDATION_SKIPPED: "network_validation_skipped",

  // GitHub
  GITHUB_LOGGED_IN: "github_logged_in",
  GITHUB_NOT_LOGGED_IN: "github_not_logged_in",
  GITHUB_BUSINESS_AUTHORIZED: "github_business_authorized",
  GITHUB_BUSINESS_NOT_AUTHORIZED: "github_business_not_authorized",
  GITHUB_APP_INSTALLED: "github_app_installed",
  GITHUB_APP_NOT_INSTALLED: "github_app_not_installed",
  GITHUB_APP_INSTALL_PENDING_WEBHOOK_SYNC: "github_app_install_pending_webhook_sync",
  GITHUB_APP_SUSPENDED: "github_app_suspended",
  GITHUB_REPO_NOT_SELECTED: "github_repo_not_selected",
  GITHUB_REPO_ACCESS_VERIFIED: "github_repo_access_verified",
  GITHUB_REPO_ACCESS_DENIED: "github_repo_access_denied",
  GITHUB_REPO_ACCESS_CHECK_FAILED: "github_repo_access_check_failed",

  // OAuth
  OAUTH_CONNECTED: "oauth_connected",
  OAUTH_NOT_CONNECTED: "oauth_not_connected",
  OAUTH_TOKEN_EXPIRED: "oauth_token_expired",
  OAUTH_NO_REFRESH_TOKEN: "oauth_no_refresh_token",

  // Lookup failures
  DB_LOOKUP_FAILED: "db_lookup_failed",
} as const;

export type OnboardingReasonCode = (typeof ONBOARDING_REASON_CODES)[keyof typeof ONBOARDING_REASON_CODES];

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export const ONBOARDING_ACTION_TYPES = {
  CONNECT: "connect",
  RECONNECT: "reconnect",
  MANAGE_ACCESS: "manage_access",
  ASK_ADMIN: "ask_admin",
  NONE: "none",
} as const;

export type OnboardingActionType = (typeof ONBOARDING_ACTION_TYPES)[keyof typeof ONBOARDING_ACTION_TYPES];

// ---------------------------------------------------------------------------
// Step owner
// ---------------------------------------------------------------------------

export const ONBOARDING_STEP_OWNER = {
  USER: "user",
  ADMIN: "admin",
} as const;

export type OnboardingStepOwner = (typeof ONBOARDING_STEP_OWNER)[keyof typeof ONBOARDING_STEP_OWNER];

// ---------------------------------------------------------------------------
// Step object (API response shape)
// ---------------------------------------------------------------------------

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  owner: OnboardingStepOwner;
  required: boolean;
  status: OnboardingStepStatus;
  reasonCode: OnboardingReasonCode;
  actionType: OnboardingActionType;
  lastValidatedAt?: number | null;
  lastValidationStatus?: CredentialValidationStatus | null;
  lastValidationReasonCode?: OnboardingReasonCode | null;
}

export interface ProviderApiKeyState {
  isSet: boolean;
  lastValidatedAt: number | null;
  lastValidationStatus: CredentialValidationStatus | null;
  lastValidationReasonCode: OnboardingReasonCode | null;
}

// ---------------------------------------------------------------------------
// Step metadata (static, UI-facing)
// ---------------------------------------------------------------------------

export interface OnboardingStepMeta {
  title: string;
  /** Default owner; may be overridden at runtime when business scope applies */
  owner: OnboardingStepOwner;
  required: boolean;
}

// ---------------------------------------------------------------------------
// OAuth callback outcomes (user-facing flash messages after redirect)
// ---------------------------------------------------------------------------

/**
 * Codes emitted as `?error=<code>` or `?warning=<code>` query params by
 * OAuth callback handlers when redirecting back to the settings page.
 *
 * These are the wire values the backend stuffs into the URL on failure or
 * degraded success. The UI reads them via `useSearchParams()` and renders a
 * banner using the copy in `CALLBACK_MESSAGES` below. Keeping the codes here
 * as a const object gives us single-source-of-truth and type-safe refs on
 * both sides of the wire.
 */
export const OAUTH_CALLBACK_CODES = {
  LINEAR_CONNECT_FAILED: "linear_connect_failed",
  LINEAR_ACCOUNT_ALREADY_CONNECTED: "linear_account_already_connected",
  LINEAR_ID_FETCH_FAILED: "linear_id_fetch_failed",
  LINEAR_INTEGRATION_DISABLED: "linear_integration_disabled",
  LINEAR_BUSINESS_ADMIN_REQUIRED: "linear_business_admin_required",
  JIRA_CONNECT_FAILED: "jira_connect_failed",
  JIRA_ACCOUNT_ALREADY_CONNECTED: "jira_account_already_connected",
  JIRA_ID_FETCH_FAILED: "jira_id_fetch_failed",
  JIRA_INTEGRATION_DISABLED: "jira_integration_disabled",
  JIRA_BUSINESS_ADMIN_REQUIRED: "jira_business_admin_required",
  JIRA_SITE_FETCH_FAILED: "jira_site_fetch_failed",
  JIRA_SITE_ALREADY_BOUND: "jira_site_already_bound",
  NOTION_CONNECT_FAILED: "notion_connect_failed",
  SLACK_CONNECT_FAILED: "slack_connect_failed",
  SLACK_BUSINESS_ADMIN_REQUIRED: "slack_business_admin_required",
  SLACK_WORKSPACE_APPROVAL_REQUIRED: "slack_workspace_approval_required",
  SLACK_WORKSPACE_ALREADY_INSTALLED: "slack_workspace_already_installed",
  SLACK_INSTALL_SUCCESS: "slack_install_success",
  SLACK_LINK_SUCCESS: "slack_link_success",
  SLACK_LINK_ALREADY_BOUND: "slack_link_already_bound",
  SLACK_LINK_INVALID: "slack_link_invalid",
  SLACK_LINK_WORKSPACE_MISMATCH: "slack_link_workspace_mismatch",
} as const;

export type OAuthCallbackCode = (typeof OAUTH_CALLBACK_CODES)[keyof typeof OAUTH_CALLBACK_CODES];

export type CallbackSeverity = "error" | "warning" | "success";

export interface CallbackMessage {
  severity: CallbackSeverity;
  title: string;
  description: string;
}

/**
 * User-facing copy for each callback outcome. Keep descriptions short and
 * action-oriented: say what happened and what the user should do next.
 */
export const CALLBACK_MESSAGES: Record<OAuthCallbackCode, CallbackMessage> = {
  linear_connect_failed: {
    severity: "error",
    title: "Linear connection failed",
    description:
      "We couldn't complete the Linear OAuth flow. Try connecting again; if the problem persists, contact your admin.",
  },
  linear_account_already_connected: {
    severity: "error",
    title: "Linear account already in use",
    description:
      "This Linear account is already linked to another Cycloid user. Disconnect it from the other account first.",
  },
  linear_id_fetch_failed: {
    severity: "warning",
    title: "Linear connected with limitations",
    description:
      "Linear is connected, but we couldn't fetch your Linear user identity. Webhook actions tied to you may not resolve until you reconnect.",
  },
  linear_integration_disabled: {
    severity: "error",
    title: "Linear is disabled",
    description:
      "Linear is disabled for this business. Enable Linear in business integrations, then connect the Linear workspace again.",
  },
  linear_business_admin_required: {
    severity: "error",
    title: "Business admin required",
    description: "Only business admins can connect a Linear workspace for webhook automation.",
  },
  jira_connect_failed: {
    severity: "error",
    title: "Jira connection failed",
    description:
      "We couldn't complete the Jira OAuth flow. Try connecting again; if the problem persists, contact your admin.",
  },
  jira_account_already_connected: {
    severity: "error",
    title: "Jira account already in use",
    description:
      "This Atlassian account is already linked to another Cycloid user. Disconnect it from the other account first.",
  },
  jira_id_fetch_failed: {
    severity: "warning",
    title: "Jira connected with limitations",
    description:
      "Jira is connected, but we couldn't fetch your Atlassian account identity. Webhook actions tied to you may not resolve until you reconnect.",
  },
  jira_integration_disabled: {
    severity: "error",
    title: "Jira is disabled",
    description:
      "Jira is disabled for this business. Enable Jira in business integrations, then connect the Jira site again.",
  },
  jira_business_admin_required: {
    severity: "error",
    title: "Business admin required",
    description: "Only business admins can connect a Jira site for webhook automation.",
  },
  jira_site_fetch_failed: {
    severity: "error",
    title: "Jira site lookup failed",
    description:
      "We couldn't list the Jira sites for your Atlassian account. Make sure the account has access to at least one Jira Cloud site, then try again.",
  },
  jira_site_already_bound: {
    severity: "error",
    title: "Jira site already connected",
    description:
      "This Jira site is already bound to another Cycloid business. Disconnect it there first, then try again.",
  },
  notion_connect_failed: {
    severity: "error",
    title: "Notion connection failed",
    description:
      "We couldn't complete the Notion OAuth flow. Try connecting again; if the problem persists, contact your admin.",
  },
  slack_connect_failed: {
    severity: "error",
    title: "Slack connection failed",
    description:
      "We couldn't complete the Slack OAuth flow. Try connecting again; if the problem persists, contact your admin.",
  },
  slack_business_admin_required: {
    severity: "error",
    title: "Business admin required",
    description:
      "Only workspace admins can install Cycloid in Slack. Ask an admin to install it from Workspace integrations.",
  },
  slack_workspace_approval_required: {
    severity: "error",
    title: "Slack install not completed",
    description:
      "The install was cancelled or blocked by Slack. If you cancelled, just retry. If your Slack workspace requires app approval, ask a Slack admin to approve Cycloid (Slack -> Manage Apps) first.",
  },
  slack_workspace_already_installed: {
    severity: "error",
    title: "Slack workspace already installed",
    description:
      "This business already has Cycloid installed in a Slack workspace. Remove that install first to switch workspaces.",
  },
  slack_install_success: {
    severity: "success",
    title: "Cycloid installed in Slack",
    description: "The Cycloid bot is now in your Slack workspace. Invite @Cycloid to a channel and mention it.",
  },
  slack_link_success: {
    severity: "success",
    title: "Slack account linked",
    description: "Your Cycloid account is linked to your Slack user. Mention @Cycloid again to start a session.",
  },
  slack_link_already_bound: {
    severity: "error",
    title: "Slack account already linked",
    description:
      "This Slack user is already linked, or your Cycloid account already has a Slack link. Disconnect the existing link first.",
  },
  slack_link_invalid: {
    severity: "error",
    title: "Slack link expired",
    description: "This Slack link is invalid or has already been used. Mention @Cycloid again to get a fresh link.",
  },
  slack_link_workspace_mismatch: {
    severity: "error",
    title: "Slack workspace mismatch",
    description:
      "This Slack link is for a workspace that isn't connected to your Cycloid business. Ask an admin to install Cycloid there.",
  },
};

/**
 * Type guard: is `value` a known callback code? Use on the frontend before
 * looking up copy in `CALLBACK_MESSAGES` so unknown codes degrade to "no
 * banner" rather than crashing.
 */
export function isOAuthCallbackCode(value: string | null): value is OAuthCallbackCode {
  if (value === null) return false;
  return (Object.values(OAUTH_CALLBACK_CODES) as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Step metadata
// ---------------------------------------------------------------------------

export const ONBOARDING_STEP_META: Record<OnboardingStepId, OnboardingStepMeta> = {
  github_login: {
    title: INTEGRATION_REGISTRY.github.displayName,
    owner: "user",
    required: true,
  },
  github_business_authorized: {
    title: "GitHub Business Access",
    owner: "admin",
    required: true,
  },
  github_app_installed: {
    title: "GitHub App",
    owner: "user",
    required: true,
  },
  github_repo_access: {
    title: "Repository Access",
    owner: "user",
    required: true,
  },
  openai_key: {
    title: INTEGRATION_REGISTRY.openai.displayName,
    owner: "user",
    required: false,
  },
  linear_oauth: {
    title: INTEGRATION_REGISTRY.linear.displayName,
    owner: "user",
    required: false,
  },
};
