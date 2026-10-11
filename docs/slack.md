---
last_verified: 2026-04-26
---

# Slack

Canonical Slack integration notes; link here instead of re-explaining install strategy in plans.

Routine verification workflow, default channel selection, and operator assumptions: [docs/slack-testing.md](slack-testing.md).

Channel name -> channel ID map (resolve before calling any Slack tool that takes a `channel` ID): [docs/slack-channels.md](slack-channels.md).

## Metadata

| Item                     | Value                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Prod app                 | `Cycloid`                                                                                         |
| Local dev app            | `Cycloid (DEV)`                                                                                   |
| Prod app URL             | `https://app.trycycloid.com`                                                                      |
| QA app URL               | `https://qa.app.trycycloid.com`                                                                   |
| Current support boundary | Multi-workspace bot tokens are implemented. Customer Slack workspaces require OAuth install flow. |
| Current token model      | Per-workspace encrypted bot tokens stored in `slack_workspaces`, resolved by `team_id`.           |
| Identity binding         | `user_integrations.external_user_id` stores the Slack user ID used by `getUserBySlackId`.         |

Prod uses `@Cycloid`; local dev uses `@Cycloid (DEV)`; no separate QA Slack app. Mentions, bot IDs, signing secrets, and install state are not interchangeable between the two apps.

## Source Links

- OAuth v2: https://docs.slack.dev/authentication/installing-with-oauth/
- Scopes: https://docs.slack.dev/reference/scopes/
- App distribution: https://docs.slack.dev/app-management/distribution/
- Request verification: https://docs.slack.dev/authentication/verifying-requests-from-slack/
- `app_uninstalled`: https://docs.slack.dev/reference/events/app_uninstalled/
- App approval: https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace
- App requests/scope changes: https://slack.com/help/articles/360024269514-Manage-app-requests-for-your-workspace

## Decisions

- Public Distribution can be enabled for customer workspaces now that multi-workspace bot tokens and the workspace OAuth install flow exist.
- Customer Slack support requires a workspace install OAuth flow, a `slack_workspaces` D1 table keyed by `team_id`, encrypted bot tokens, and `app_uninstalled` handling.
- Ambient company-memory capture for normal channel messages is opt-in per channel (Workspace settings -> Integrations -> Slack channel memory). Direct app mentions are explicit interactions; channel messages outside configured intake rows are ignored unless they match a Slack channel automation rule (bot messages from alert providers like Datadog or Sentry trigger automated sessions).
- DMs are supported and behave like a channel @mention for session handling. Slack never sends `app_mention` in a DM (it delivers `message.im`), so a `message.im` whose text @mentions the bot is promoted onto the `app_mention` path and runs the same downstream flow (identity, repo resolution, session, follow-ups, `stop`). A `message.im` that does not @mention the bot is ignored. Users must still type `@Cycloid` in the DM, by design, so there is one code path. The one deliberate divergence: DMs are **never** ingested into company memory (a 1:1 DM is private; only public channel mentions / opt-in intake channels are captured).
- Slack-originated sessions must persist `slack_team_id` in session metadata; later async/session code must use it to resolve the correct workspace bot token.
- Plan-ready owner DMs use Block Kit with a plain-text fallback, a revision-bound Approve button, and a link to the web session for edit/discuss. Approval is ack-first through durable background work; requests never expire, are one-shot with replacement on pre-commit failure, and are superseded when the plan or session moves on. Delivery state is durable and retries are bounded; deduplication keys on plan prompt ID plus revision so duplicate parks do not resend while a revised plan can notify again.
- Missing, unknown, or uninstalled `team_id` must fail closed before posting, reacting, DMing, reading thread history, or spawning Slack-dependent work.
- Legacy callback contexts without `slack_team_id` are not backfillable from channel/thread alone; async notifications must log and fail closed, not fall back to `SLACK_BOT_TOKEN`.
- Bot operations stay in the worker for auditability. Do not inject customer workspace bot tokens into the sandbox by default; pass only user-scoped Slack tokens where current sandbox behavior requires them.
- Target scope strategy: move `*:history` to the bot so normal `@cycloid` use does not require every employee to complete Slack OAuth (bot reads only conversations it can access, e.g. invited channels). Keep `search:read` as optional user OAuth; Slack has no bot equivalent.
- App Directory submission can proceed now that multi-workspace bot tokens have landed; deploy and test the workspace install OAuth flow before submission.

## Current Slack App Config

Required event subscriptions:

- `app_mention`
- `message.im` (DM sessions; requires App Home -> Messages Tab enabled so users can send the bot a DM). The handler ships first; enable the Messages Tab + `message.im` subscription as a prod canary after deploy. Rollback is config-only: disable the Messages Tab and remove the `message.im` subscription.

Current user scope requested by `/auth/slack`:

- `search:read`

History scopes (`channels:history`, `groups:history`, `im:history`, `mpim:history`) are granted
to the bot via the workspace install, not per user, so normal `@cycloid` use does not require
every employee to complete this user OAuth. `search:read` stays a user scope because Slack has no
bot equivalent.

## Target Slack App Config

Target bot scopes for normal `@cycloid` use:

- `app_mentions:read`
- `chat:write`
- `reactions:write`
- `users:read`
- `users:read.email`
- `files:read`
- `files:write`
- `channels:read`
- `groups:read`
- `channels:history`
- `groups:history`
- `im:history`
- `im:write`
- `im:read`
- `mpim:history`
- `team:read`

`SLACK_WORKSPACE_INSTALL_SCOPES` (`apps/control-plane-worker/src/slack/workspace-install.ts`) is
the source of truth for configured bot scopes; keep this list in sync with it.
Existing workspaces must reinstall the Slack app to grant newly added scopes.
<!-- ci-sync -->

Target user scope after magic-link identity binding:

- `search:read` - Slack has no bot equivalent; use only for agent-side Slack search.

## Magic Link Identity Binding

Implemented. When an unlinked Slack user mentions `@Cycloid`, the bot DMs a one-click link that
binds their Slack identity to their Cycloid account, instead of forcing per-user OAuth.

- Tokens are signed with the shared HMAC `signed-token` primitive (not a JWT) using a dedicated
  `SLACK_LINK_SIGNING_KEY` (not `TOKEN_ENCRYPTION_KEY`); payload
  `{ slackUserId, slackTeamId, jti, expiresAt }`, 10-minute TTL (`SLACK_LINK_TOKEN_TTL_MS`).
- Routes live under the proxied `/auth/*` prefix (top-level `/slack/*` is not proxied to the
  Worker): `GET /auth/slack/link?token=...` renders a server-side consent screen (verify token,
  `users.info` for display name, show the logged-in Cycloid account); unauthenticated visitors
  get a sign-in prompt. `POST /auth/slack/link/confirm` is the only bind path.
- Confirm enforces: a re-resolved session, an `Origin`/`Referer` allowlist check against
  `FRONTEND_URL`, and a double-submit CSRF token (`slack_link_csrf` cookie vs form field).
- Fail closed unless the token's `slack_team_id` resolves to an installed, active
  `slack_workspaces` row whose `business_id` matches the logged-in user's business (blocks
  forwarded/leaked links).
- One-time `jti`: consumed atomically with the bind via `db.batch` against
  `slack_link_token_consumptions` (PK rejects replays). `bindSlackIdentity` refuses silent
  rebinds — the user keeps any existing link, and the partial unique index on
  `(integration_id, external_user_id)` rejects a Slack id already owned by another user. The bind
  is identity-only and never touches stored OAuth tokens.
- The DM uses `unfurl_links: false` / `unfurl_media: false` and is rate-limited per
  `(team, user)` on the `RATE_LIMITS` KV (~1 per 10 min), recorded only on a successful send.
- A magic-link binding has `external_user_id` but no OAuth token, so `/auth/me` reports it as
  linked (not `slackNeedsReconnect`). `slackConnected` still reflects the `search:read` user
  token only.

## Code Map

| Concern                        | Files                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth routes                   | `apps/control-plane-worker/src/auth/routes.ts`                                                                                                                                                                                                                                                                                              |
| Webhook verification           | `apps/control-plane-worker/src/webhooks/verify.ts`                                                                                                                                                                                                                                                                                          |
| Webhook dispatch/session start | `apps/control-plane-worker/src/webhooks/handlers.ts`                                                                                                                                                                                                                                                                                        |
| Bot token resolution           | `apps/control-plane-worker/src/slack/tokens.ts`                                                                                                                                                                                                                                                                                             |
| Workspace storage              | `apps/control-plane-worker/src/slack/workspaces.ts`                                                                                                                                                                                                                                                                                         |
| Slack API helpers              | `apps/control-plane-worker/src/slack/notify.ts`, `apps/control-plane-worker/src/slack/blocks.ts`, `apps/control-plane-worker/src/slack/mentions.ts`, `apps/control-plane-worker/src/slack/phase-updates.ts`                                                                                                                                 |
| Session Slack callbacks        | `apps/control-plane-worker/src/session/slack-notifications.ts`, `apps/control-plane-worker/src/session/durable-object.ts`, `apps/control-plane-worker/src/session/pr-workflow.ts`                                                                                                                                                           |
| Sandbox env injection          | `apps/control-plane-worker/src/integrations/runtime.ts`                                                                                                                                                                                                                                                                                     |
| User integration storage       | `apps/control-plane-worker/src/integrations/db.ts`, `apps/control-plane-worker/src/auth/db.ts`                                                                                                                                                                                                                                              |
| Magic-link identity binding    | `apps/control-plane-worker/src/slack/link-token.ts`, `apps/control-plane-worker/src/slack/link-db.ts`, `apps/control-plane-worker/src/slack/link-service.ts`, `apps/control-plane-worker/src/slack/link-consent.ts`; migration `0159_slack_link_token_consumptions.sql`                                                                     |
| Status card controls           | `apps/control-plane-worker/src/webhooks/slack-interactions.ts`, `apps/control-plane-worker/src/slack/card-control-requests.ts`, `apps/control-plane-worker/src/slack/interaction-requests-db.ts`; migration `0244_slack_interaction_requests.sql`                                                                                           |
| Slack channel automation       | `apps/control-plane-worker/src/automation/db.ts`, `src/automation/slack-channel-service.ts`, `src/automation/slack-channel-trigger.ts`, `src/automation/slack-channel-admin-service.ts`, `src/routes/slack-channel-automation.ts`, `src/webhooks/slack-events.ts`; migrations `0191_automation_rules.sql`, `0192_automation_event_jobs.sql` |

## Wake-on-reply

Replies to threads whose session is stopped/archived wake the session back up:

- **Stopped (user-stopped)**: resumes through the same gates as the `/api/sessions/:id/resume` route (resume rate limit, repo access + installation gate, repo-context refresh). After resume, the reply is enqueued as a new prompt.
- **Archived**: does not wake. Cycloid replies that the session is archived and asks the user to start a new session.
- **Failed/blocked**: does NOT wake. The reply gets a single budget-path ask pointing at the Retry control on the status card.
- **Automation-origin sessions**: excluded from conversational wake. Thread replies do not wake automation sessions.

Surface gating (DM mention-free, channel @mention required) is enforced upstream by the follow-up gate in `slack-events.ts` before this module runs. The wake router (`webhooks/slack-wake.ts`) owns the stopped/archived wake path and does not handle failed/blocked phases.

Code reference: `apps/control-plane-worker/src/webhooks/slack-wake.ts`, `apps/control-plane-worker/src/constants/slack-wake.ts`.

## Verification

- Unit-test DAO/token lookup, install callback, uninstall handling, and missing-token fail-closed behavior.
- Magic-link binding is covered by `tests/test_cloudflare/slack-link-*.test.ts` (token, DAO with real
  sqlite constraints, service fail-closed branches, DM/rate-limit) and `tests/smoke/auth-slack-link.test.ts`
  (route auth/CSRF/origin branches). Extend these for new token, CSRF/origin, one-time `jti`, or
  refuse-rebind cases.
- E2E means a real Cycloid session from a Slack app mention, using the app matching the environment: prod `@Cycloid`, local dev `@Cycloid (DEV)`.
- CLI sessions do not exercise Slack callbacks.
- Multi-workspace verification must prove two Slack workspaces use different bot tokens and that the Cycloid workspace still works.
