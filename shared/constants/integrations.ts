import type { IntegrationToolMeta } from "../types/tools.js";

export const CredentialScope = {
  ALWAYS: "always",
  USER: "user",
  BUSINESS: "business",
} as const;

export type CredentialScope = (typeof CredentialScope)[keyof typeof CredentialScope];

export const PERSONAL_SETTINGS_SECTION = {
  OAUTH: "oauth",
  BUSINESS_MANAGED: "business-managed",
  API_KEY: "api-key",
  INTERNAL: "internal",
} as const;

export type PersonalSettingsSection = (typeof PERSONAL_SETTINGS_SECTION)[keyof typeof PERSONAL_SETTINGS_SECTION] | null;

export interface IntegrationRegistryEntry {
  displayName: string;
  description: string;
  toggleable: boolean;
  credentialScopes: readonly CredentialScope[];
  personalSettingsSection: PersonalSettingsSection;
  lifecycleSupport: "instrumented" | "unsupported";
  tools?: readonly IntegrationToolMeta[];
  // When false, the integration stays fully reachable via API/CLI/business credentials but
  // is hidden from every customer-facing settings surface (personal API keys, personal
  // OAuth, business integrations) through isCustomerFacingIntegration. Absent === true.
  // Honored regardless of personalSettingsSection wherever those lists are rendered.
  customerFacing?: boolean;
}

export const DATADOG_SUPPORTED_SITES = [
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
] as const;

const DATADOG_SUPPORTED_SITE_SET = new Set<string>(DATADOG_SUPPORTED_SITES);

export function normalizeDatadogSite(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized ? normalized : null;
}

export function isSupportedDatadogSite(
  value: string | null | undefined,
): value is (typeof DATADOG_SUPPORTED_SITES)[number] {
  const normalized = normalizeDatadogSite(value);
  return normalized !== null && DATADOG_SUPPORTED_SITE_SET.has(normalized);
}

// Cloudflare account IDs are 32-character hex strings; D1 database IDs are UUIDs.
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const CLOUDFLARE_D1_DATABASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCloudflareAccountId(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && CLOUDFLARE_ACCOUNT_ID_PATTERN.test(normalized);
}

export function isValidCloudflareD1DatabaseId(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && CLOUDFLARE_D1_DATABASE_ID_PATTERN.test(normalized);
}

const STRIPE_LIVE_SECRET_KEY_PATTERN = /^sk_live_/;

export function isAllowedStripeBusinessSecretKey(value: string | null | undefined): boolean {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 && !STRIPE_LIVE_SECRET_KEY_PATTERN.test(normalized);
}

export const BRAINTRUST_DEFAULT_API_URL = "https://api.braintrust.dev";
export const BRAINTRUST_ALLOWED_API_HOSTS = ["api.braintrust.dev", "api-eu.braintrust.dev"] as const;

const BRAINTRUST_ALLOWED_API_HOST_SET = new Set<string>(BRAINTRUST_ALLOWED_API_HOSTS);

export function normalizeBraintrustApiUrl(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !BRAINTRUST_ALLOWED_API_HOST_SET.has(hostname)) return null;
    parsed.hostname = hostname;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export const INTEGRATION_REGISTRY = {
  github: {
    displayName: "GitHub",
    description: "Repository access, pull requests, and authentication",
    toggleable: false,
    credentialScopes: [CredentialScope.ALWAYS],
    personalSettingsSection: null,
    lifecycleSupport: "instrumented",
  },
  baseten: {
    displayName: "Baseten",
    description: "Opencode OSS-model BYOK provider",
    toggleable: false,
    credentialScopes: [CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.API_KEY,
    lifecycleSupport: "instrumented",
  },
  slack: {
    displayName: "Slack",
    description: "Workspace messaging, thread context, and Slack-originated agent workflows",
    toggleable: true,
    credentialScopes: [CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.OAUTH,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "get_thread", description: "Read a Slack thread by channel and root message timestamp" },
      { name: "search_messages", description: "Search Slack messages in the connected workspace" },
      { name: "send_message", description: "Post a Slack message to a channel or thread" },
    ],
  },
  linear: {
    displayName: "Linear",
    description: "Issue tracking and project management",
    toggleable: true,
    credentialScopes: [CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.OAUTH,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "get_issue", description: "Read a Linear issue by ID or identifier" },
      { name: "list_issue_statuses", description: "List workflow states for a team" },
    ],
  },
  jira: {
    displayName: "Jira",
    description: "Issue tracking and project management for Jira Cloud",
    toggleable: true,
    credentialScopes: [CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.OAUTH,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "create_issue", description: "Create a Jira issue in a project" },
      { name: "get_issue", description: "Read a Jira issue by key or ID" },
      { name: "list_transitions", description: "List available workflow transitions for an issue" },
      { name: "transition_issue", description: "Move a Jira issue to a new workflow status" },
    ],
  },
  notion: {
    displayName: "Notion",
    description: "Workspace search and page content reads",
    toggleable: true,
    credentialScopes: [CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.OAUTH,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "search", description: "Search shared Notion pages and data sources by title" },
      { name: "get_block_children", description: "Read the child blocks for a Notion page or block" },
    ],
  },
  sentry: {
    displayName: "Sentry",
    description: "Issue and event lookup for connected Sentry organizations",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    tools: [{ name: "lookup_issue", description: "Resolve a Sentry issue, event, URL, or short ID" }],
  },
  datadog: {
    displayName: "Datadog",
    description: "Logs and trace lookup for connected Datadog organizations",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "search_datadog_logs", description: "Search Datadog logs within a time range" },
      { name: "get_datadog_trace", description: "Fetch a Datadog trace by trace ID" },
    ],
  },
  launchdarkly: {
    displayName: "LaunchDarkly",
    description: "Feature flag lookup and narrow environment patching for gated rollout verification",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    tools: [
      {
        name: "list_feature_flags",
        description: "List LaunchDarkly feature flags for a project, optionally filtered by environment",
      },
      {
        name: "get_feature_flag",
        description: "Read a LaunchDarkly feature flag by key with variation and environment state",
      },
      {
        name: "patch_feature_flag",
        description: "Apply a narrow environment patch to a LaunchDarkly feature flag",
      },
    ],
  },
  cloudflare: {
    displayName: "Cloudflare D1",
    description: "Read-only SQL queries against a connected Cloudflare D1 database",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "query_d1", description: "Run a read-only SQL query against the connected Cloudflare D1 database" },
    ],
  },
  braintrust: {
    displayName: "Braintrust",
    description: "Experiment, log, and trace query access for connected Braintrust organizations",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    tools: [
      { name: "list_projects", description: "List Braintrust projects visible to the business API key" },
      { name: "query_sql", description: "Query Braintrust logs, experiments, and datasets with SQL" },
      { name: "summarize_experiment", description: "Summarize Braintrust experiment metrics and comparisons" },
      { name: "generate_permalink", description: "Generate shareable Braintrust links" },
      { name: "infer_schema", description: "Infer fields and metadata from sampled Braintrust data" },
    ],
  },
  neon: {
    displayName: "Neon",
    description: "Per-session Postgres branch credentials for runtime migrations and previews",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "unsupported",
  },
  stripe: {
    displayName: "Stripe",
    description: "Payment-flow checks and Stripe Connect access using a shared secret key",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
  },
  terraform: {
    displayName: "Terraform Cloud",
    description: "Terraform Cloud access for infrastructure planning",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    customerFacing: false,
  },
  vercel: {
    displayName: "Vercel",
    description: "Deployment status and preview URL lookup for connected Vercel projects",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.BUSINESS_MANAGED,
    lifecycleSupport: "instrumented",
    tools: [
      {
        name: "get_deployment_for_ref",
        description: "Resolve the latest Vercel deployment for a project and git ref or commit SHA",
      },
      {
        name: "get_preview_url",
        description: "Return the live preview URL for a Vercel deployment on a git ref or commit SHA",
      },
    ],
  },
  openai: {
    displayName: "OpenAI",
    description: "Model access via OpenAI API keys",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS, CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.API_KEY,
    lifecycleSupport: "instrumented",
  },
  codex_subscription: {
    displayName: "Codex subscription",
    description: "Internal Codex subscription auth for Cycloid coworkers",
    toggleable: true,
    credentialScopes: [CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.INTERNAL,
    lifecycleSupport: "instrumented",
    customerFacing: false,
  },
  anthropic: {
    displayName: "Anthropic",
    description: "Model access via Anthropic API keys (Claude Code agent runtime)",
    toggleable: true,
    credentialScopes: [CredentialScope.BUSINESS, CredentialScope.USER],
    personalSettingsSection: PERSONAL_SETTINGS_SECTION.API_KEY,
    lifecycleSupport: "instrumented",
    // Claude Code is not selectable in the web product yet, so hide the Anthropic
    // API-key field from customers. Backend resolution stays intact for CLI/API/internal
    // claude_code sessions and business-managed credentials.
    customerFacing: false,
  },
} as const satisfies Record<string, IntegrationRegistryEntry>;
