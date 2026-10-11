# Adding a new integration

Use when adding an OAuth integration, business-managed credential integration, webhook ingress, or first-party tool surface.

For the current supported-integration reference, see [supported-integrations.md](supported-integrations.md).

## Choose the shape first

| Shape                                     | Typical examples                              | Required pieces                                                              |
| ----------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| OAuth + per-user tokens                   | Linear, Jira, Notion, Slack                   | OAuth routes, token storage, connection status, disconnect flow              |
| Business-managed service credentials      | Datadog, LaunchDarkly, Cloudflare, Terraform  | Admin credential storage, scope gating, spawn-time injection or bridge tool  |
| Business/user BYOK model-provider keys    | OpenAI, Anthropic                             | User key storage, business credential storage, effective credential resolver |
| Webhook-producing integration             | GitHub, Slack, Linear, Jira, PagerDuty        | Signature verification, idempotency, route registration                      |
| First-party dynamic-tool integration      | Datadog, LaunchDarkly, Cloudflare, Braintrust | Registry metadata, bridge tool implementation, input schema, tool guidance   |
| Bridge-owned privileged execution surface | Terraform                                     | Bridge-only credential, constrained command/tool, child-env denylist tests   |

Slack-specific install, scope, `team_id`, and magic-link decisions: [docs/slack.md](slack.md).

## Scope decision rules

- Use `CredentialScope.USER` when actions must happen on behalf of the session actor, depend on a user's workspace/page access, or need per-user audit identity. Prefer provider OAuth over pasted tokens when available.
- Use `CredentialScope.BUSINESS` when the credential represents a shared organization/service resource, infra account, observability account, model billing account, webhook installation, or automation identity.
- Use both `USER` and `BUSINESS` only for BYOK model providers where a business default can replace individual user keys.
- A business-only integration must reject `scope="user"` in `setBusinessIntegrationScope`; a user-only integration must reject `scope="business"`.
- Do not expose business credentials to the agent child env when a bridge-owned dynamic tool can hold the credential and perform the operation.
- Provider OAuth is the default for delegated user access; service account, account-owned, team, or workload identity credentials are the default for shared automation.

## Current integration inventory

| Integration        | Scope in registry                    | Current auth shape                                                           | OAuth / credential recommendation                                                                                                               |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub             | Always available                     | GitHub OAuth user tokens plus installation/repo authorization                | Keep OAuth/App install. Repo access is identity-bound and not a business API-key integration.                                                   |
| Slack              | User plus business workspace install | Slack OAuth bot/workspace install and per-user Slack OAuth tokens            | Keep hybrid. Workspace install is business context; user tokens stay user-scoped for user-context actions.                                      |
| Linear             | User                                 | OAuth user tokens; business webhook binding for inbound events               | Keep user OAuth. Linear supports OAuth and personal API keys; use OAuth for delegated user issue actions.                                       |
| Jira               | User                                 | Atlassian OAuth 2.0 user tokens plus selected site; business webhook binding | Keep user OAuth. Jira Cloud 3LO is user-delegated and site access is selected per user.                                                         |
| Notion             | User                                 | Notion public OAuth connection token                                         | Keep user OAuth. Notion public connections are OAuth and page access is user/workspace-grant scoped.                                            |
| Sentry             | Business                             | Business-managed auth token plus organization slug                           | Keep business-managed. For org-wide diagnostics prefer an internal integration/org auth token; do not use personal tokens for shared tools.     |
| Datadog            | Business                             | Business-managed API key, application key, and site                          | Keep business-managed. Prefer service account application keys today; consider Datadog OAuth/SAT only as a dedicated future migration.          |
| LaunchDarkly       | Business                             | Business-managed access token                                                | Keep business-managed. Use a LaunchDarkly API access token for shared flag inspection and low-frequency environment patching.                   |
| Cloudflare D1      | Business                             | Business-managed account ID, D1 database ID, and API token                   | Keep business-managed. Prefer account-owned API tokens with read-only D1 permissions where available.                                           |
| Braintrust         | Business                             | Business-managed API key and optional API URL                                | Keep business-managed API key; Braintrust API docs center API-key auth, not OAuth app auth.                                                     |
| Neon               | Business                             | Business-managed API key plus project/parent-branch config                   | Keep business-managed. Use a Neon API key tied to the target project; mint per-session branch URLs instead of exposing a long-lived shared DSN. |
| Stripe             | Business                             | Business-managed secret key for Stripe Connect and payment-flow checks       | Keep business-managed. Use restricted or test-mode secret keys for shared automation; avoid exposing Stripe secrets to the agent child env.     |
| Terraform Cloud    | Business                             | Business-managed team/API token, bridge-only `terraform.plan` dynamic tool   | Keep business-managed. Use HCP Terraform team tokens for automation; org tokens cannot run plans/applies, and OAuth tokens are for VCS.         |
| OpenAI             | User + business                      | User BYOK API key or business BYOK key, exchanged for session gateway token  | Keep both. For business automation, prefer project/service account keys or workload identity federation when we support it.                     |
| Codex subscription | User                                 | Per-business BYOS Codex subscription auth                                    | Available to businesses with `codex_byos_enabled=1`; seeded on Cycloid by default.                                                              |
| Anthropic          | User + business                      | User BYOK API key or business BYOK key                                       | Keep both. API keys are the current product path; workload identity federation is a possible future business-managed upgrade.                   |
| Baseten            | User                                 | Per-user BYOK API key for opencode OSS models                                | Keep user-scoped. Each user supplies their own Baseten key; no platform/shared billing key path.                                                |
| Vercel             | Business                             | Business-managed access token plus optional team ID                          | Keep business-managed. Use a Vercel access token with deployment read scope; team ID is required for team-owned projects.                       |

When this table changes, update `shared/constants/integrations.ts`, integration visibility tests, spawn/runtime credential tests, [docs/qa-prod-parity.md](qa-prod-parity.md), and this doc in the same PR.

## Prerequisites

- Add the integration to `shared/constants/integrations.ts`.
- Put env vars in the correct source of truth:
  - Terraform-managed SSM for secrets/runtime values
  - Wrangler `[vars]` for public static worker config
- Read [docs/security.md](security.md) for auth/signature rules and [docs/deployments.md](deployments.md) for deploy surfaces.

## Canonical files

| Concern                                   | Files                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product-level integration registry        | `shared/constants/integrations.ts`, `shared/constants/integration-helpers.ts`                                                                                                                                                                             |
| Worker credential storage and scope logic | `apps/control-plane-worker/src/integrations/db.ts`, `apps/control-plane-worker/src/integrations/service.ts`, `apps/control-plane-worker/src/integrations/runtime.ts`                                                                                      |
| OAuth handlers                            | `apps/control-plane-worker/src/auth/routes.ts`, `apps/control-plane-worker/src/routes/auth.ts`                                                                                                                                                            |
| Webhook ingress                           | `apps/control-plane-worker/src/webhooks/verify.ts`, `apps/control-plane-worker/src/webhooks/handlers.ts`, `apps/control-plane-worker/src/routes/webhooks.ts`                                                                                              |
| Session spawn wiring                      | `apps/control-plane-worker/src/session/durable-object.ts`                                                                                                                                                                                                 |
| UI settings/admin surfaces                | `apps/ui/src/components/settings/IntegrationsSettings.tsx`, `apps/ui/src/components/settings/WorkspaceIntegrationsSettings.tsx`, `apps/ui/src/components/settings/McpServersSettings.tsx`                                                                 |
| First-party dynamic tools                 | `apps/sandbox-bridge/src/services/*-dynamic-tool.ts`, `apps/sandbox-bridge/src/services/first-party-dynamic-tools.ts`, `apps/sandbox-bridge/src/services/dynamic-tool-input-schemas.ts`, `apps/sandbox-bridge/src/services/dynamic-tool-image-results.ts` |
| MCP wiring                                | `apps/sandbox-bridge/src/bridge.ts`, `apps/sandbox-bridge/src/constants/bridge.ts`, sandbox bundle mount points                                                                                                                                           |

## Shape-specific checklist

### OAuth integrations

- add initiate + callback routes
- validate state/CSRF
- exchange tokens and store them through integration DB helpers
- expose connection status through `/auth/me`
- add disconnect handling
- add tests for success, state mismatch, and token-exchange failure

GitHub has a scheduled confidence check for the configured owner user and repo. The control-plane cron resolves the user's GitHub OAuth token, calls GitHub's repo API for `GITHUB_HEALTH_REPO_OWNER` / `GITHUB_HEALTH_REPO_NAME`, and stores retained evidence in `business_integration_health_checks`. Do not store raw GitHub responses or tokens in health rows.

Linear is user OAuth-managed for delegated issue actions and business webhook-bound for inbound issue events. The bridge exposes first-party dynamic tools for issue create/read/update/statuses plus ticket discussion/search (`linear.list_comments`, `linear.create_comment`, `linear.search_issues`) using the session user's `LINEAR_ACCESS_TOKEN`; comment bodies and search terms are redacted before persistence.

Jira is user OAuth-managed for delegated issue actions and business webhook-bound for inbound issue events. The bridge exposes first-party dynamic tools for issue create/read/transition plus ticket discussion/search (`jira.list_comments`, `jira.add_comment`, `jira.search_issues`) using the session user's `JIRA_ACCESS_TOKEN` and `JIRA_CLOUD_ID`; comment bodies and JQL are redacted before persistence.

### Business-managed credentials

- use the existing business credential storage path; new table only if the provider truly needs one
- resolve the credential at spawn time in `integrations/runtime.ts` or the session-owned runtime helper when the value stays app-runtime-only
- gate availability based on integration scope
- wire admin UI if special fields are required
- prefer service-account, account-owned, team, or workload identity credentials over personal tokens for shared automation
- if a credential powers a first-party dynamic tool, keep it in the bridge env and denylist it from `AGENT_CHILD_ENV_EXACT_ALLOWLIST`

Datadog is business-managed for observability, internal debugging, and agent log/trace/metric/monitor lookups. Stores a Datadog API key and application key through the business credential route; exposed to the sandbox as `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`. The bridge provides first-party dynamic tools (`search_datadog_logs` with bounded cursor pagination, `get_datadog_trace` with a bounded lookback override, `query_metrics`, `get_monitors`) using these credentials directly; no separate Datadog MCP server is registered.

LaunchDarkly is business-managed for flag inspection and low-frequency gated-rollout changes from implementation sessions. Store the access token in `api_key`; expose only the bridge/tool env needed by `launchdarkly.list_feature_flags`, `launchdarkly.get_feature_flag`, and the narrow `launchdarkly.patch_feature_flag` semantic-patch tool. Keep LaunchDarkly credentials bridge-only and denylist them from the agent child env. Verification-role sessions stay read-only: they may list/get flags but must not register or execute `launchdarkly.patch_feature_flag`. The patch tool is intentionally narrow: it can turn a flag on or off and update only the environment fallthrough/off variations, not arbitrary LaunchDarkly flag structure.

Cloudflare D1 is business-managed for read-only queries against a customer's own D1 database. Credentials reuse the business columns: API token to `api_key` (encrypted, the only secret), account ID to `oauth_access_token` (encrypted), database ID to `service_url` (plaintext); injected as `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN` for the bridge `query_d1` tool. Read-only is enforced two ways: a customer-supplied D1 Read-scoped token (scope unverifiable via the Cloudflare API) and the tool's SQL guard allowing only a single `SELECT` statement or provably read-only `WITH ... SELECT` CTE query (no multiple statements, writes, or ambiguous CTE shapes), which is the load-bearing control we own.

Braintrust is business-managed for experiment, log, and trace queries. Stores a Braintrust API key plus optional API URL through the business credential route; exposed to the sandbox as `BRAINTRUST_INTEGRATION_API_KEY` and `BRAINTRUST_INTEGRATION_API_URL`. The bridge provides first-party `braintrust.list_projects`, `braintrust.query_sql`, `braintrust.summarize_experiment`, `braintrust.generate_permalink`, and `braintrust.infer_schema` dynamic tools against the Braintrust REST and `/btql` APIs; no Braintrust MCP server is registered.

Neon is business-managed for branchable Postgres app runtimes. Store the Neon API key in `api_key` and the workspace-selected project metadata in `service_url` as JSON. Repos opt into the generated session database URL through app-runtime `credentials[]` declarations with `source: "business_neon_branch"`; session start creates one writable Neon branch, injects its connection URI into the declared env vars (for example `DATABASE_URL`), reuses that branch on respawn, and best-effort deletes it when the session closes.

Stripe is business-managed for payment-flow checks and Stripe Connect automation. Store the secret key in `api_key`; expose it as `STRIPE_SECRET_KEY` at spawn so business-managed MCP servers or other privileged runtime surfaces can use it. Prefer Stripe test-mode or restricted keys for verification work, and do not expose Stripe secrets to the agent child env.

Terraform Cloud is business-managed for infrastructure planning. Stores a plan-only Terraform Cloud token in `api_key`; exposed only to the sandbox bridge as `ARCANIST_TERRAFORM_PLAN_TOKEN` plus `TF_IN_AUTOMATION=1`. The agent child env must not receive Terraform credentials. Live planning goes through the first-party `terraform.plan` dynamic tool, which runs only `terraform plan -no-color -input=false` with a bridge-owned credential overlay.

Sentry is business-managed for organization diagnostics. Store the token in `api_key` and the organization slug in `service_url`; expose only the bridge/tool env needed by `sentry.lookup_issue` and `sentry.search_issues`. Prefer organization/internal-integration tokens for shared use. Avoid personal Sentry tokens for business-scoped diagnostics; they are tied to a user lifecycle.

Vercel is business-managed for deployment status and preview URL lookup. Store the access token in `api_key` and an optional team ID in `service_url`; expose only the bridge/tool env needed by `vercel.get_deployment_for_ref` and `vercel.get_preview_url`. Keep Vercel credentials bridge-only and denylist them from the agent child env. GitHub `check_run` evidence for the Vercel app is also surfaced on verification PR context as `vercelDeployPreview` when a preview URL can be parsed from the check output.

### BYOK model providers

OpenAI and Anthropic support both user and business scope. Business scope is the shared billing/default path; user scope is individual BYOK. Baseten is user-scope only; do not add a business/shared credential path for opencode OSS models. Keep provider selection in `shared/constants/models.ts` aligned with `PROVIDER_ENV_VAR` and the runtime resolver. For OpenAI, spawn uses a session gateway token instead of passing the raw BYOK key to the agent. For future static-secret reduction, prefer OpenAI or Anthropic workload identity federation only after the control plane can mint short-lived tokens without exposing long-lived keys to the sandbox.

### Webhook integrations

- verify the signature from the raw request body
- claim idempotency before side effects
- register the webhook route with `auth: "webhook"`
- resolve the user/business context before dispatching follow-up work
- add tests for invalid signatures and duplicate deliveries

### MCP-backed integrations

- remote MCP server: add upstream references and any server-specific rules to [docs/mcp.md](mcp.md)
- local MCP server: mount it in every required E2B template and any retained legacy deploy surface that still needs it
- register the tool server conditionally in the bridge
- add tool guidance in bridge constants so the agent knows when to use it
- `DYNAMIC_TOOLS_GUIDANCE_PREAMBLE` frames first-party tools as the intended interface, not a fallback for raw-API access. Prompt guidance, not enforcement: creds stay in the sandbox env.

## Verification checklist

- integration appears in the shared registry and correct UI surfaces
- credentials resolve only when scope and auth allow it
- secrets are not exposed to the client
- required deploy surface updates are made for worker, sandbox, or UI changes
- webhook ingress works end-to-end when applicable
- tests cover the new credential path and auth or webhook failure modes
