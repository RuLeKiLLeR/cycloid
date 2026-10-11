---
last_verified: 2026-06-11
---

# Jira

Canonical Jira Cloud integration notes. Link here instead of re-explaining.

## Metadata

| Item             | Value                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Platform         | Jira Cloud only (Atlassian OAuth 2.0 3LO). No Data Center/PAT.                                      |
| App console      | https://developer.atlassian.com/console/myapps/                                                     |
| API base         | `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...` (cloudId via accessible-resources)     |
| Identity binding | `user_integrations.external_user_id` = Atlassian `account_id` (dedup + webhook actor resolution).   |
| User site        | `jira_user_sites` (one per user; reconnect switches).                                               |
| Business binding | `jira_webhook_installations` (one business per site, partial unique index).                         |
| Sandbox tools    | `jira.create_issue`, `get_issue`, `list_transitions`, `transition_issue`                            |
| Migrations       | `0151_jira_integration.sql`, `0152_jira_oauth_pending.sql`, `0158_jira_personal_data_reporting.sql` |

## OAuth

- `GET /auth/jira` (user): scopes `read:jira-work write:jira-work read:jira-user read:me offline_access`. `GET /auth/jira/business` (admin): adds `manage:jira-webhook`, registers webhooks. Shared callback `/auth/jira/callback`.
- Multi-site accounts: encrypted `jira_oauth_pending` row (10-min TTL, single-use nonce) finalized via `/auth/jira/pending` + `/auth/jira/finalize`; picker renders on personal and business settings pages. Single site auto-selects.
- Business binding tokens live on the connecting admin's `user_integrations` row (`connected_by_user_id`); unresolvable credential → installation `degraded`, any admin can re-bind.

## Tokens

~1h access tokens, rotating refresh. `getValidJiraToken` persists via CAS (`WHERE oauth_refresh_token = <used>`); lost races (including 4xx from rotated-token reuse) re-read the winner's tokens. Missing `refresh_token` in a response keeps the prior one. Env (`JIRA_ACCESS_TOKEN`/`JIRA_CLOUD_ID`/`JIRA_SITE_URL`/`JIRA_TRIGGER_LABEL`) injects at spawn only; long sessions can hit `token_expired` (retry/relaunch; mid-session mint deferred).

Sandbox tool calls hit `api.atlassian.com` directly from the bridge; the host must stay on `DEFAULT_SANDBOX_EGRESS_ALLOWLIST` (`apps/control-plane-worker/src/sandbox/egress-policy.ts`) or every `jira.*` call fails with ECONNREFUSED at the egress firewall.

## Webhooks

- Dynamic, registered with JQL `labels = "<JIRA_TRIGGER_LABEL>"` (default `cycloid`); label on an issue → session. Trigger label is stripped from agent-created issues (`jira.create_issue`) to prevent session cascades; humans apply it manually. 30-day expiry; the `*/5 * * * *` cron sweep refreshes webhooks expiring within 7 days and re-registers installations with no stored webhook IDs. Label changes require workspace reconnect (JQL is baked in remotely; handler validates the installation's persisted `trigger_label`).
- Atlassian allows one webhook callback URL per user per app across all environments. Registration lists and deletes every webhook the app holds for the binding user before registering, so a stale registration from another environment (e.g. a local-dev tunnel) cannot wedge the bind. Environments needing concurrent webhooks need separate Atlassian apps.
- Ingress `POST /api/webhooks/jira/:token` verification order: Authorization JWT signed with the OAuth client secret (HS256, `exp` mandatory, `timingSafeEqualString` signature compare; deliveries are NOT HMAC-signed — no webhook secret exists), installation lookup by unguessable URL token, authoritative API re-fetch of the issue. Payload is never trusted.
- Transient re-fetch failures release the idempotency claim and return 503 (Atlassian retries <=5); deterministic drops return 200 + reason + Datadog drop event. Actionable repo-step drops (`repo=` missing/invalid, GitHub App missing, repo access denied, or repo access check failed) also post one deduped issue comment per reason with fix guidance.
- Webhook actor `accountId` → Cycloid user; actor's selected site must match the installation's or the delivery drops with a lifecycle event.

## Configuration

| Name                       | Where                       | Notes                                                  |
| -------------------------- | --------------------------- | ------------------------------------------------------ |
| `JIRA_OAUTH_CLIENT_ID`     | SSM `/cycloid/...` (String) | From console app Settings.                             |
| `JIRA_OAUTH_CLIENT_SECRET` | SSM (SecureString)          | Also signs webhook JWTs.                               |
| `JIRA_OAUTH_CALLBACK_URL`  | wrangler `[vars]`           | Prod: `https://app.trycycloid.com/auth/jira/callback`. |
| `JIRA_TRIGGER_LABEL`       | wrangler `[vars]`           | Change requires workspace reconnect.                   |
| `JIRA_HEALTH_INTERVAL_MS`  | wrangler `[vars]`           | Binding health sweep (default 6h).                     |

Console app: register every environment's callback URL (one per line, max 30); Jira API classic scopes `read:jira-work write:jira-work read:jira-user manage:jira-webhook` + User Identity API `read:me`. `offline_access` is authorize-time only. Local dev: `JIRA_OAUTH_*` in `apps/control-plane-worker/.dev.vars` (per worktree), callback `http://localhost:<api-port>/auth/jira/callback`.

## Behavior notes

- ADF: writes wrap plain text into paragraphs; reads flatten to text. No rich markdown conversion.
- Tool errors mirror Linear: 401 → `token_expired`, 403 → `scope_missing`, 404 → `not_found`.
- Revoked bindings surface as `revoked` (Reconnect), distinct from never-connected.
- Health: `/me` + accessible-resources via the binding credential, recorded with `recordBusinessIntegrationHealthCheck`.

## Source links

- 3LO: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- Webhooks: https://developer.atlassian.com/cloud/jira/platform/webhooks/
- Webhooks API: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/
- ADF: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
