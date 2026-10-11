/**
 * Static client-side search index over the settings surface: one entry per
 * settings route, listing the section titles and setting labels rendered on
 * that page plus match-only synonyms. Search is a pure substring match over
 * this data — no network. `SettingsSearch.test.ts` asserts the routes here
 * stay in sync with `SETTINGS_GROUPS`, so update both together when adding,
 * renaming, or removing a settings page.
 */

export type SettingsSearchEntry = {
  /** Route the result navigates to; must match a SETTINGS_GROUPS tab `to`. */
  to: string;
  /** Nav/tab label, shown as the result title. */
  label: string;
  /** Nav group the tab belongs to ("Account", "Workspace", …). */
  group: string;
  /** Section titles and setting row labels rendered on the page. */
  items: string[];
  /** Match-only synonyms not rendered on the page. */
  keywords: string[];
};

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    to: "/settings/get-started",
    label: "Getting started",
    group: "Account",
    items: ["Required setup", "Optional setup", "Try these ways to use Cycloid"],
    keywords: ["onboarding", "setup checklist", "first session", "install github app"],
  },
  {
    to: "/settings/preferences",
    label: "Preferences",
    group: "Account",
    items: [
      "Session behavior",
      "Open pull requests as drafts",
      "Run verification for sessions",
      "Session defaults",
      "Default model",
      "Default repository",
      "Display",
      "Diff view",
    ],
    keywords: ["draft PR", "auto verify", "unified diff", "split diff", "default repo"],
  },
  {
    to: "/settings/integrations",
    label: "Connected accounts",
    group: "Account",
    items: ["Connected accounts"],
    keywords: ["Slack", "Linear", "Jira", "GitHub", "Notion", "connect", "disconnect", "OAuth", "identity"],
  },
  {
    to: "/settings/api-keys",
    label: "Model API keys",
    group: "Account",
    items: ["Provider keys", "Codex auth.json"],
    keywords: ["OpenAI", "Anthropic", "API key", "bring your own key", "BYOK", "credentials"],
  },
  {
    to: "/settings/personal-secrets",
    label: "Personal secrets",
    group: "Account",
    items: ["Secrets", "Add secret", "Import"],
    keywords: ["secret", "env var", "environment variable", "encrypted", "credentials", "token"],
  },
  {
    to: "/settings/cli-tokens",
    label: "CLI tokens",
    group: "Account",
    items: ["Create a token", "Existing tokens", "Install"],
    keywords: ["terminal", "command line", "revoke", "access token"],
  },
  {
    to: "/settings/usage",
    label: "Usage",
    group: "Account",
    items: ["OpenAI spend", "Sources", "Managed limit"],
    keywords: ["billing", "cost", "tokens", "spend", "monthly limit"],
  },
  {
    to: "/settings/repositories",
    label: "Repositories",
    group: "Repositories",
    items: ["Environment variables", "Sandbox environment", "Review checklist"],
    keywords: ["repo", "env vars", "secrets", "setup script", "reviewer checklist", "sandbox layers"],
  },
  {
    to: "/settings/workspace-policies",
    label: "Workspace policies",
    group: "Workspace",
    items: ["Member defaults", "Shared sessions", "Custom egress domains"],
    keywords: ["policy", "egress allowlist", "network", "admins"],
  },
  {
    to: "/settings/workspace-integrations",
    label: "Workspace integrations",
    group: "Workspace",
    items: ["Integration policies"],
    keywords: ["Slack workspace", "GitHub app", "install", "workspace connect"],
  },
  {
    to: "/settings/slack-memory",
    label: "Slack memory",
    group: "Workspace",
    items: ["Slack workspace", "Tracked channels"],
    keywords: ["memory", "channels", "context"],
  },
  {
    to: "/settings/mcp-servers",
    label: "MCP servers",
    group: "Workspace",
    items: ["Configured servers"],
    keywords: ["MCP", "tools", "transport", "model context protocol"],
  },
  {
    to: "/settings/diagnostics",
    label: "Diagnostics",
    group: "System",
    items: ["Integration events"],
    keywords: ["debug", "lifecycle events", "latency", "troubleshoot"],
  },
];
