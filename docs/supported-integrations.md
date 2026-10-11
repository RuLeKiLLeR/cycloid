# Supported integrations

This is the product reference for integrations currently supported by Cycloid.

“User-managed” means each member connects their own account or API key.
“Business-managed” means a business admin configures one shared credential or installation.
Some integrations support both scopes.

The tool names below are the first-party agent tools exposed by Cycloid.
Workspace-managed MCP servers are additional, user-configured tool sources and are not part of this fixed registry.

| Integration        | How it can be connected                                             | Management                                                        | Available tools                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub             | GitHub OAuth, GitHub App installation, and repository authorization | User identity plus business/repository authorization              | Repository checkout and GitHub CLI access; pull request and review workflow tools                                                                                       |
| Slack              | Slack OAuth workspace installation and per-user Slack OAuth         | Business workspace installation plus user-managed access          | `slack.get_thread`, `slack.search_messages`, `slack.send_message`                                                                                                       |
| Linear             | Linear OAuth                                                        | User-managed; business webhook binding is used for inbound events | `linear.create_issue`, `linear.get_issue`, `linear.list_issue_statuses`, `linear.update_issue`, `linear.list_comments`, `linear.create_comment`, `linear.search_issues` |
| Jira               | Atlassian OAuth 2.0 (3LO) with a selected Jira Cloud site           | User-managed; business webhook binding is used for inbound events | `jira.create_issue`, `jira.get_issue`, `jira.list_comments`, `jira.add_comment`, `jira.search_issues`, `jira.list_transitions`, `jira.transition_issue`                 |
| Notion             | Notion public OAuth connection                                      | User-managed                                                      | `notion.search`, `notion.get_block_children`                                                                                                                            |
| Sentry             | Business-managed authentication token and organization slug         | Business-managed                                                  | `sentry.lookup_issue`, `sentry.search_issues`                                                                                                                           |
| Datadog            | Business-managed API key, application key, and Datadog site         | Business-managed                                                  | `datadog.search_datadog_logs`, `datadog.get_datadog_trace`, `datadog.query_metrics`, `datadog.get_monitors`                                                             |
| LaunchDarkly       | Business-managed LaunchDarkly access token                          | Business-managed                                                  | `launchdarkly.list_feature_flags`, `launchdarkly.get_feature_flag`, `launchdarkly.patch_feature_flag`                                                                   |
| Cloudflare D1      | Business-managed account ID, D1 database ID, and API token          | Business-managed                                                  | `cloudflare.query_d1`                                                                                                                                                   |
| Braintrust         | Business-managed API key and optional API URL                       | Business-managed                                                  | `braintrust.list_projects`, `braintrust.query_sql`, `braintrust.summarize_experiment`, `braintrust.generate_permalink`, `braintrust.infer_schema`                       |
| Neon               | Business-managed API key and project/branch configuration           | Business-managed                                                  | Per-session Postgres branch credentials; no integration-specific agent tool                                                                                             |
| Stripe             | Business-managed secret key                                         | Business-managed                                                  | Stripe Connect and payment-flow access through configured privileged runtime surfaces; no integration-specific first-party agent tool                                   |
| Terraform Cloud    | Business-managed team or API token                                  | Business-managed                                                  | `terraform.plan`                                                                                                                                                        |
| Vercel             | Business-managed access token and optional team ID                  | Business-managed                                                  | `vercel.get_deployment_for_ref`, `vercel.get_preview_url`                                                                                                               |
| OpenAI             | User or business BYOK API key                                       | User-managed or business-managed                                  | Model access; no integration-specific agent tool                                                                                                                        |
| Codex subscription | Per-business Codex subscription authentication                      | User-managed within eligible businesses                           | Codex model access; no integration-specific agent tool                                                                                                                  |
| Anthropic          | User or business BYOK API key                                       | User-managed or business-managed                                  | Claude Code model access; no integration-specific agent tool                                                                                                            |
| Baseten            | Per-user BYOK API key                                               | User-managed                                                      | Opencode OSS-model access; no integration-specific agent tool                                                                                                           |

## Scope and visibility notes

GitHub is always available because it provides repository identity and access for sessions.

Terraform Cloud and the Codex subscription are internal or privileged integrations and are not shown in every customer-facing settings surface.

Anthropic remains available to backend, CLI, and internal Claude Code flows even though its customer-facing API-key field is hidden today.

Integration availability is still subject to business scope, credentials, repository access, and the tool’s own runtime checks.

The canonical implementation sources are [`shared/constants/integrations.ts`](../shared/constants/integrations.ts), [`shared/constants/integration-helpers.ts`](../shared/constants/integration-helpers.ts), and the first-party bridge tools under [`apps/sandbox-bridge/src/services`](../apps/sandbox-bridge/src/services).
