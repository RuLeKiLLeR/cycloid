import { GITHUB_ACTION_AUTH_FILE_ENV } from "./github-action-auth.js";
import {
  BRAINTRUST_INTEGRATION_API_KEY_ENV,
  BRAINTRUST_INTEGRATION_API_URL_ENV,
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  CLOUDFLARE_D1_DATABASE_ID_ENV,
  JIRA_ACCESS_TOKEN_ENV,
  JIRA_CLOUD_ID_ENV,
  JIRA_SITE_URL_ENV,
  LAUNCHDARKLY_ACCESS_TOKEN_ENV,
  LINEAR_ACCESS_TOKEN_ENV,
  NOTION_ACCESS_TOKEN_ENV,
  SENTRY_ACCESS_TOKEN_ENV,
  SENTRY_ORGANIZATION_SLUG_ENV,
  STRIPE_SECRET_KEY_ENV,
} from "./sandbox-env.js";

/**
 * Security policy for the env an untrusted agent child process (Codex
 * app-server, Claude Code CLI, repo-runtime commands) may inherit from the
 * bridge. The bridge env carries platform telemetry secrets, transport
 * secrets, and resolved customer credentials; the agent shell is steered by
 * untrusted repo content, so it gets a fail-closed allowlist instead.
 *
 * The control plane shares these lists so its credential env-name validation
 * cannot accept a customer-chosen name that collides with an allowlisted
 * operational name (e.g. `NODE_OPTIONS`).
 */

/** Names whose suffix marks them credential-shaped regardless of list state. */
export const SECRET_ENV_KEY_SUFFIX_PATTERN = /(_TOKEN|_SECRET|_API_KEY|_PASSWORD|_CREDENTIALS?)$/i;

/**
 * Platform/bridge secrets that must never be readable by untrusted child code
 * (git hooks, agent shells, repo-runtime commands). `SENTRY_DSN`,
 * `DD_SITE`, and `ARCANIST_PREVIEW_CONTRACT_JSON` are listed explicitly
 * because they do not match the credential suffix pattern.
 */
export const PLATFORM_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  "SANDBOX_AUTH_TOKEN",
  "GITHUB_CLONE_TOKEN",
  "GITHUB_USER_TOKEN",
  "GH_TOKEN",
  "SANDBOX_CALLBACK_SECRET",
  "SANDBOX_RUNTIME_CLEANUP_SECRET",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "DD_API_KEY",
  "DD_APP_KEY",
  "DD_SITE",
  LAUNCHDARKLY_ACCESS_TOKEN_ENV,
  "VERCEL_ACCESS_TOKEN",
  "VERCEL_TEAM_ID",
  STRIPE_SECRET_KEY_ENV,
  "BRAINTRUST_API_KEY",
  "SENTRY_DSN",
  "ARCANIST_ADMIN_TOKEN",
  "ARCANIST_TOKEN",
  "ARCANIST_PREVIEW_CONTRACT_JSON",
  "ARCANIST_RUNTIME_AUTH_PROOF",
  "ARCANIST_LOGIN_USERNAME",
  "ARCANIST_LOGIN_PASSWORD",
  "ARCANIST_CODEX_AUTH_JSON",
  "ARCANIST_REAL_GIT_PATH",
  "ARCANIST_REAL_GH_PATH",
  "ARCANIST_GH_SHIM_DIR",
]);

/**
 * Exact env names the agent child legitimately needs. Every entry is
 * evidence-backed by a named consumer (gh shim, Codex CLI resolution,
 * language toolchains); names with no consumer stay off the list even when
 * harmless. `NODE_OPTIONS` and `CLAUDE_CLI_PATH` are deliberately absent:
 * neither has an agent-child consumer, and both are execution-control names a
 * hostile value could abuse.
 */
export const AGENT_CHILD_ENV_EXACT_ALLOWLIST: readonly string[] = [
  // Toolchain / OS
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "PWD",
  "PYTHONUNBUFFERED",
  "NVM_DIR",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "JAVA_HOME",
  // Agent runtime (CODEX_CLI_PATH / CODEX_PATH consumed by resolveCodexPathOverride)
  "CODEX_HOME",
  "CODEX_NO_LOGIN",
  "CODEX_CLI_PATH",
  "CODEX_PATH",
  // GitHub action capability input + non-secret session/repo context
  GITHUB_ACTION_AUTH_FILE_ENV,
  "SESSION_ID",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "FRONTEND_URL",
  "REPO_OWNER",
  "REPO_NAME",
  "REPO_PATH",
  "BRANCH",
  "CHECKOUT_BRANCH",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "OWNER_LOGIN",
  "MODEL",
  "PROVIDER",
  "OPENCODE_CLIENT",
];

/**
 * Session-scoped operational secrets that are safe for repo-influenced child
 * execution contexts. None are currently allowed; trusted first-party bridge
 * helpers receive required secrets through non-child paths.
 */
export const AGENT_CHILD_ALLOWED_OPERATIONAL_SECRETS: ReadonlySet<string> = new Set<string>();

/**
 * Model provider key names callers may inject via the `providerKeys` overlay.
 * Restricting the overlay to these names keeps a mistaken call (e.g.
 * `{ DD_API_KEY }`) from re-surfacing a platform secret past the final
 * denylist.
 */
export const AGENT_CHILD_ALLOWED_PROVIDER_ENV_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "BASETEN_API_KEY",
]);

export const ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV = "ARCANIST_REPO_RUNTIME_ENV_NAMES";

/**
 * Repo environment variables from Settings -> Repositories are primarily app
 * runtime inputs and belong in Docker composeEnv. Only these operational names
 * may also enter the agent-visible sandbox env.
 */
export const AGENT_VISIBLE_REPO_RUNTIME_ENV_EXACT_ALLOWLIST: ReadonlySet<string> = new Set([
  "NGROK_AUTHTOKEN",
  "NGROK_AUTH_TOKEN",
  "NGROK_DOMAIN",
]);

/**
 * Customer-integration credential env names that MAY be preserved into the
 * agent child env only through a higher-trust registration path, such as
 * control-plane managed MCP. Repo-local MCP config is repository-controlled
 * input and must not use this list to preserve credentials into the child env.
 * Platform names can never appear here. DD_API_KEY/DD_APP_KEY/DD_SITE are
 * deliberately absent: the customer Datadog integration reuses the platform
 * names, so they stay denied until the rename-to-distinct-names cleanup
 * (`mcp_env_ref_denied` is the diagnostic for a customer Datadog MCP
 * reference).
 *
 * Accepted residual, reviewed 2026-07-06: keep these agent-visible only when a
 * higher-trust MCP path references them. Codex uses this list to preserve
 * referenced managed MCP env vars, and Claude expands these names for local
 * stdio `.mcp.json` servers while still denying repo-controlled remote
 * URL/header references. First-party dynamic tools also consume most of these
 * credentials, but that bridge-owned use alone is not why they stay here.
 */
export const TRUSTED_INTEGRATION_CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set([
  LINEAR_ACCESS_TOKEN_ENV,
  JIRA_ACCESS_TOKEN_ENV,
  JIRA_CLOUD_ID_ENV,
  JIRA_SITE_URL_ENV,
  NOTION_ACCESS_TOKEN_ENV,
  SENTRY_ACCESS_TOKEN_ENV,
  SENTRY_ORGANIZATION_SLUG_ENV,
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_D1_DATABASE_ID_ENV,
  CLOUDFLARE_API_TOKEN_ENV,
  BRAINTRUST_INTEGRATION_API_KEY_ENV,
  BRAINTRUST_INTEGRATION_API_URL_ENV,
  "SLACK_TOKEN",
  "SLACK_USER_TOKEN",
]);

/**
 * `ARCANIST_*` names allowed through the prefix rule must not be one of these
 * (in addition to failing the secret suffix pattern). Listed separately from
 * PLATFORM_SECRET_ENV_KEYS for clarity at the prefix-rule call site.
 */
export const CYCLOID_PREFIX_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "ARCANIST_PREVIEW_CONTRACT_JSON",
  ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV,
  "ARCANIST_LOGIN_USERNAME",
  "ARCANIST_LOGIN_PASSWORD",
  "ARCANIST_TOKEN",
  "ARCANIST_ADMIN_TOKEN",
  "ARCANIST_RUNTIME_AUTH_PROOF",
  "ARCANIST_TERRAFORM_PLAN_TOKEN",
  "ARCANIST_CODEX_AUTH_JSON",
  "VERCEL_ACCESS_TOKEN",
  "VERCEL_TEAM_ID",
  STRIPE_SECRET_KEY_ENV,
  "ARCANIST_REAL_GIT_PATH",
  "ARCANIST_REAL_GH_PATH",
]);

const AGENT_CHILD_REPO_RUNTIME_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AGENT_CHILD_REPO_RUNTIME_ENV_EXACT_BLOCKLIST: ReadonlySet<string> = new Set([
  ARCANIST_REPO_RUNTIME_ENV_NAMES_ENV,
  "CODEX_CLI_PATH",
  "CODEX_PATH",
  "NODE_OPTIONS",
  "CLAUDE_CLI_PATH",
  "GIT_CONFIG_COUNT",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "JAVA_TOOL_OPTIONS",
  "RUBYOPT",
  "PYTHONSTARTUP",
]);

export function isAgentVisibleRepoRuntimeEnvName(name: string): boolean {
  if (!AGENT_CHILD_REPO_RUNTIME_ENV_KEY_PATTERN.test(name)) return false;
  if (!AGENT_VISIBLE_REPO_RUNTIME_ENV_EXACT_ALLOWLIST.has(name)) return false;
  // Keep the inherited safety filters after the allowlist so future operational additions stay fail-closed.
  if (PLATFORM_SECRET_ENV_KEYS.has(name)) return false;
  if (AGENT_CHILD_ALLOWED_PROVIDER_ENV_KEYS.has(name)) return false;
  if (CYCLOID_PREFIX_EXCLUDED_NAMES.has(name)) return false;
  if (AGENT_CHILD_REPO_RUNTIME_ENV_EXACT_BLOCKLIST.has(name)) return false;
  if (name.startsWith("GIT_CONFIG_")) return false;
  return true;
}
