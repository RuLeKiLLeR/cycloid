# Customer Onboarding Checklist

Everything a technical lead needs to get their environment ready for Cycloid. Required items first, optional integrations after.

---

## What we need from you

### 1. OpenAI API key (required)

- [ ] Provide your `OPENAI_API_KEY` — stored server-side; Cycloid routes OpenAI calls through its control-plane gateway, so the raw key is never sent to the sandbox

### 2. GitHub — agent credentials (required, pick one)

The agent needs write access to your repositories to push branches and open PRs.

**Option A: GitHub App (recommended)**

Create a GitHub App with permissions:

- `contents: write`
- `pull_requests: write`
- `issues: write` (required for GitHub reactions and QA trigger comments)
- `metadata: read`

For Cycloid to auto-respond to PR reviews (the review loop), subscribe the App to webhook events:

- `check_run`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `push`, `status`

Install it on the repositories (or org) Cycloid should access, then provide:

- [ ] `GITHUB_APP_ID`
- [ ] `GITHUB_PRIVATE_KEY` (PEM format)
- [ ] `GITHUB_WEBHOOK_SECRET`

**Option B: Personal Access Token**

Create a PAT with the `repo` scope, then provide:

- [ ] `GITHUB_TOKEN`

### 3. GitHub — web UI login (required for dashboard)

The GitHub App from Step 2 also handles OAuth login for the Cycloid dashboard. Engineers log in with GitHub; PRs are attributed to the logged-in user. No additional app registration — we use the GitHub App's built-in OAuth credentials:

- [ ] `GITHUB_CLIENT_ID` (the GitHub App's client ID, starts with `Iv`)
- [ ] `GITHUB_CLIENT_SECRET` (a client secret generated on the GitHub App's settings page)

> We will set the OAuth callback URL (`GITHUB_CALLBACK_URL`) on our side and share it with you.

### 4. Repository setup (required)

- [ ] Add an `AGENTS.md` file to the root of each repository the agent will work on
- [ ] Include database schema files if relevant (the agent uses them for context)
- [ ] Keep root instruction files environment-agnostic and focused on implementation and verification rules

Reference:

- Repo instruction-file boundaries: [docs/conventions.md](conventions.md)
- Cycloid publish and handoff workflow: [docs/workflow.md](workflow.md)
- Security expectations for repo guidance and secrets: [docs/security.md](security.md)

### 5. App runtime profile (optional runtime preview)

Add `.cycloid.json` only for repos where Cycloid should start the app runtime on request. Browser evidence is optional and user-directed; without a profile, Cycloid still does code review, tests, and static checks.

Example Docker Compose profile:

```json
{
  "appRuntime": {
    "kind": "web",
    "runner": "docker",
    "entry": {
      "type": "compose",
      "files": ["docker-compose.yml"],
      "service": "web"
    },
    "url": {
      "hostPort": 3000,
      "path": "/"
    },
    "ready": {
      "path": "/"
    },
    "open": {
      "path": "/"
    }
  }
}
```

- [ ] Set `entry.service` when Compose has multiple services; match a `services:` key
- [ ] Confirm `url.hostPort` is exposed by the container
- [ ] Run a runtime smoke test and confirm the preview contract starts

#### Optional: declare end-to-end runtime

Add an `appRuntime.e2e` block to let the agent run the dockerized app and exercise it end-to-end (`cycloid-app run npm run test:e2e`, etc.). The agent prompt section is injected only when this block is declared.

> Full reference: [End-to-end runtime](customer-e2e-runtime.md) — schema, supported login flows, what is **not** supported (no 2FA / SSO / OAuth / captcha / magic-link), credential-management API, and agent behavior when the runtime can't start.

```json
{
  "appRuntime": {
    "...": "...",
    "e2e": {
      "testCommand": "npm run test:e2e",
      "seedCommand": "npm run db:seed:test",
      "resetCommand": "npm run db:reset",
      "credentials": [
        { "name": "test_user_email", "envVar": "E2E_USER_EMAIL" },
        { "name": "test_user_password", "envVar": "E2E_USER_PASSWORD" }
      ]
    }
  }
}
```

- [ ] Add the repo `.env` values in Settings → Repository secrets.
- [ ] If `credentials[]` is declared, ensure each `envVar` exists in the stored repo `.env` or set an overriding value via `cycloid test-creds set <owner>/<repo> <name> --business <id>`.
- [ ] For Playwright suites, keep `testCommand` focused on running tests; Cycloid pre-bakes Chromium for the pinned sandbox Playwright install. Install other browsers or project-specific Playwright browser versions in the repo setup/test command if needed.

### 6. Linear integration (optional)

Cycloid can create sessions from Linear issues automatically after a business admin connects the Linear workspace through OAuth.

**Workspace webhook automation**

When an issue is labeled with a trigger label, Cycloid picks it up and starts a session.

- [ ] Configure the Cycloid Linear OAuth application webhook URL: `https://app.trycycloid.com/api/webhooks/linear`
- [ ] Enable the OAuth application webhook for **Issues** and **OAuth authorization events**
- [ ] Update the Terraform-managed SSM value for `/cycloid/LINEAR_WEBHOOK_SECRET` to match the OAuth application webhook signing secret
- [ ] Re-authorize the Cycloid Linear OAuth application from the target Linear workspace after changing webhook settings
- [ ] Provide `LINEAR_DEFAULT_REPO_URL` — the GitHub clone URL for the default repo (e.g. `https://github.com/org/repo.git`)
- [ ] Create an `cycloid` label in Linear to use as the trigger

**Per-user OAuth — individual access**

Customer admins connect the Linear workspace from Business settings. Engineers connect their own Linear account through the Cycloid dashboard so webhook actors map to Cycloid users and Cycloid can post comments and update issues as that user.

Create a Linear OAuth application ([docs](https://developers.linear.app/docs/oauth/authentication)) and provide:

- [ ] `LINEAR_OAUTH_CLIENT_ID`
- [ ] `LINEAR_OAUTH_CLIENT_SECRET`

> We will set the OAuth callback URL (`LINEAR_OAUTH_CALLBACK_URL`) on our side and share it with you.

Reference:

- Integration checklist and security expectations: [docs/adding-integrations.md](adding-integrations.md), [docs/security.md](security.md)

### 7. Slack integration (optional)

Cycloid can receive tasks from Slack, post live status updates in threads, and optionally search Slack messages.

Current boundary: [Multi-workspace bot-token support](slack.md) is implemented. Customer Slack workspaces require workspace OAuth install flow.

If a workspace requires app approval, a Workspace Owner or app manager must pre-approve the app first:

1. Slack sidebar: **Admin** -> **Apps and workflows**.
2. Click **Browse**, search for `Cycloid (PROD)`, and open the app page.
3. Click **Approve**.

Install precondition: `/auth/slack/install` requires a logged-in Cycloid user who is a **business
admin**, and binds the workspace to that user's business. Before sending the install link, the
Cycloid team must approve the customer business, add the installer as a business admin, and
confirm their GitHub/repo access; otherwise the installer is rejected before the Slack OAuth step.

First mention: when an installed-workspace user mentions `@Cycloid` for the first time, the bot
DMs them a one-click magic link to connect their Cycloid account (no per-user Slack OAuth). They
open it, confirm, then mention `@Cycloid` again to start a session.

Scopes, tokens, Public Distribution caveats, and magic-link identity binding: [docs/slack.md](slack.md). Required secrets for the current shared app path:

- [ ] `SLACK_BOT_TOKEN` (`xoxb-...`)
- [ ] `SLACK_CLIENT_ID` — OAuth app client ID
- [ ] `SLACK_CLIENT_SECRET` — OAuth app client secret

> Note: Slack scope changes require reinstall/re-authorization and can rotate the bot token.

Reference:

- Slack-specific setup details: [docs/slack.md](slack.md)
- Integration checklist and security expectations: [docs/adding-integrations.md](adding-integrations.md), [docs/security.md](security.md)

### 8. Failure alerting (optional)

If a session fails, Cycloid can notify a Slack channel via an incoming webhook.

- [ ] Create a Slack incoming webhook and provide `ALERT_SLACK_WEBHOOK_URL`

---

## What we'll configure

On our side — no action needed from you.

- Deploy and host the API server (`PORT`, `FRONTEND_URL`)
- Provision the SQLite database (`DB_PATH`)
- Generate the admin API bearer token (`ARCANIST_ADMIN_TOKEN`)
- Configure the execution environment (worktree or cloud sandbox)
- Wire all provided env vars into the deployment
- Set OAuth callback URLs (`GITHUB_CALLBACK_URL`, `LINEAR_OAUTH_CALLBACK_URL`)
- Build and serve the web UI
- Validate the `.cycloid.json` runtime profile with a smoke-test session when runtime preview is expected
- Validate end-to-end with a test session
