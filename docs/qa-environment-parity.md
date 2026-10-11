# QA environment parity

This doc records the current QA parity stance for production integrations. It is intentionally separate from the operational runbook in [qa-environment.md](qa-environment.md).

## Current answer

QA has live-verified parity for Slack and Linear.

The current OAuth integration state is:

- GitHub
- Linear is configured and live-verified in QA.
- Slack is configured and live-verified in QA.

Jira and Notion are intentionally pending until QA-owned OAuth apps are created and their `/cycloid/qa/*` SSM values are populated.

Do not describe QA as missing Slack or Linear integration parity unless current preflight or smoke evidence regresses. Braintrust, Datadog, Cloudflare D1, Sentry, OpenAI, and Anthropic have documented parity paths, but should be called "documented but unverified" until QA preflight or tool smoke evidence exists.

## Parity definition

An integration is at QA parity only when all of these are true:

1. QA-owned external app or fixture exists. Do not reuse prod credentials.
2. Required `/cycloid/qa/*` SSM values are populated and not `CHANGE_ME`.
3. `deploy-control-plane-qa.yml` succeeds and syncs those values to the QA worker.
4. QA health, preflight, or targeted smoke passes for that integration.
5. A real QA browser/API/session action has produced current evidence for the integration path.

Documentation or Terraform placeholder existence alone is not enough.

## OAuth integrations

These require QA-owned OAuth apps and user connection evidence:

| Integration | Required QA SSM keys                                                           | Current status                                                                                     |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| GitHub      | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, app ID/private key/webhook secret  | Existing QA app appears installed; keep validating through QA login and smoke.                     |
| Linear      | `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET`                         | Live-verified in QA; keep validating through QA preflight and Linear runtime tool smoke.           |
| Slack       | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, signing/linking/bot/workspace values | Live-verified in QA; keep validating through QA preflight and Slack-originated session/tool smoke. |
| Jira        | `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`                             | Pending. Leave as `CHANGE_ME` until a QA Jira app/site exists.                                     |
| Notion      | `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`                         | Pending. Leave as `CHANGE_ME` until a QA Notion public OAuth integration exists.                   |

The QA deploy must not read prod OAuth client IDs or secrets as a substitute for these values. QA should read only `/cycloid/qa/*` and fail closed when required targeted QA config is missing.

## Business-tool and provider integrations

These have documented QA parity paths, but they still need live evidence:

| Integration   | Required QA fixture values                                                                                                         | Verification                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Braintrust    | `QA_BRAINTRUST_API_KEY`, optional `QA_BRAINTRUST_API_URL`; may fall back to `BRAINTRUST_API_KEY` for platform-equivalent QA config | QA preflight or Braintrust tool smoke.           |
| Datadog       | `QA_DATADOG_API_KEY`, `QA_DATADOG_APP_KEY`, `QA_DATADOG_SITE`                                                                      | QA preflight or Datadog tool smoke.              |
| Cloudflare D1 | `QA_CLOUDFLARE_ACCOUNT_ID`, `QA_CLOUDFLARE_D1_DATABASE_ID`, `QA_CLOUDFLARE_API_TOKEN`                                              | QA preflight or D1 query tool smoke.             |
| Sentry        | `QA_SENTRY_ACCESS_TOKEN`, `QA_SENTRY_ORGANIZATION_SLUG`                                                                            | QA preflight or Sentry tool smoke.               |
| OpenAI        | `QA_OPENAI_API_KEY` or fallback to `ARCANIST_OPENAI_API_KEY`                                                                       | QA preflight and session spawn evidence.         |
| Anthropic     | `QA_ANTHROPIC_API_KEY`                                                                                                             | QA preflight and Claude-backed session evidence. |

If preflight or targeted smoke has not passed recently, call the status "documented but unverified", not "working".
