# Customer onboarding

Cycloid is a background coding agent for GitHub repositories. Give it a task from the web app, CLI, Slack, Linear, Jira, or API; it works in an isolated sandbox, streams progress back, and opens pull requests as the GitHub user who started the session.

Use this guide for customer workspace setup and rollout. Deep references: [Review Loop](review-loop.md), [CLI package README](../apps/cli/README.md), [Onboarding agent](prompt-agents.md#onboarding-agent), [Slack](slack.md), and [Jira](jira.md).

## Roles

- **Cycloid team** approves pending signups, creates or attaches users to the customer workspace, promotes the customer setup owner to Cycloid business admin, and normally runs the repo runtime onboarding agent.
- **Customer setup owner** installs or coordinates GitHub/Slack/Linear/Jira workspace access, manages workspace integrations, reviews setup PRs, and runs post-merge sandbox builds when needed.
- **Engineers** sign in with GitHub, finish their Get Started checklist, connect personal integrations where needed, and start sessions.

## Access approval

1. Go to [https://app.trycycloid.com](https://app.trycycloid.com) and sign in with the GitHub account you use for work.
2. Unknown GitHub users land on a pending access page. The page says to email `shivam@trycycloid.com` for access.
3. A Cycloid team admin approves the first user into a new customer workspace or approves later users into the existing workspace.
4. The Cycloid team marks the customer setup owner as a Cycloid business admin so they can manage workspace integrations.

Customer admins do not approve pending users today.

## Get Started checklist

After approval, go to **Settings -> Get Started**. This is the primary setup path; incomplete users are redirected there from **Settings**.

Complete the required checklist:

1. **Sign in with GitHub** - already done after approval.
2. **Install the GitHub App** - install Cycloid on the GitHub org/account that owns the repos. If you are not a GitHub org admin, ask an owner to approve the install.
3. **Pick the repositories** - select the repos Cycloid may use. If a repo is missing, use the GitHub App manage-access link from Get Started or Settings.
4. **Pick a default repository** - required for setup completion. Slack, Linear, Jira, and quick-start flows use it when no repo is named. Slack and Linear can also infer repos from message or issue context; Jira v1 needs either `repo=owner/repo` in the issue description or a default repo.
5. **Add a model API key** - normal customer setup uses an OpenAI key for Codex sessions unless a workspace admin configured a shared key. Business-managed credentials are configured under **Workspace integrations**; if the selected model has no valid effective key, session start fails closed.

The home page composer is useful after this checklist is complete: pick a visible repo, describe the task, and submit. Cycloid opens a PR for human review.

## Repository guidance

Add an `AGENTS.md` file to each repo root before serious use. Keep it practical:

- setup commands
- required checks
- coding conventions
- test commands
- security rules
- repo-specific review expectations

For customer `AGENTS.md` files, include implementation and verification rules only. Do not include Cycloid publish workflow instructions such as commit, push, or PR creation.

## Workspace rollout

Use **Settings -> Integrations** for each engineer's personal OAuth accounts. Use **Settings -> Workspace integrations** for admin-managed rollout.

### Personal integrations

Engineers connect these under **Settings -> Integrations** when they need Cycloid to act as them:

- Linear
- Jira
- Notion
- optional Slack search

Personal Slack OAuth is only needed for Slack search. Normal `@Cycloid` mentions use the workspace Slack app plus magic-link identity binding.

### Workspace integrations

Cycloid business admins manage these under **Settings -> Workspace integrations**:

- shared OpenAI credentials
- Slack workspace install
- Linear workspace webhook binding
- Jira Cloud site webhook binding
- Sentry
- Datadog
- Cloudflare D1
- Braintrust

Workspace integrations may be disabled, user-managed, or business-wide depending on the integration.

## Slack

For Slack task intake, a Cycloid business admin installs the `@Cycloid` Slack app from **Workspace integrations**. If the Slack workspace requires app approval, a Slack admin must approve or complete the install.

After the workspace app is installed, members can mention `@Cycloid` in Slack. On first mention, Cycloid DMs a one-click link that binds the user's Slack identity to their Cycloid account. After binding, mention `@Cycloid` again to start a session.

## Linear

For Linear issue-triggered sessions:

1. A Cycloid business admin enables Linear and connects the Linear workspace webhook from **Workspace integrations**.
2. Each engineer who labels or updates issues connects their own Linear account in **Settings -> Integrations**.
3. Add the configured trigger label, default `cycloid`, to start a session.
4. Name the repo in the issue when needed, or rely on repo inference/default repo.

If the Linear actor is not connected to a Cycloid user in the workspace, Cycloid skips the webhook.

## Jira

For Jira issue-triggered sessions:

1. A Cycloid business admin connects one Jira Cloud site from **Workspace integrations**.
2. Each engineer who triggers Jira sessions connects their own Jira account and chooses the same site in **Settings -> Integrations**.
3. Add the configured trigger label, default `cycloid`, to start a session.
4. Include `repo=owner/repo` in the issue description unless the actor has a default repo.

Jira does not infer repositories from issue text today.

## Repo runtime onboarding

If Cycloid should boot, inspect, or test the customer's app during sessions, ask the Cycloid team to run the onboarding agent. The supported customer path is:

1. Cycloid runs a CLI onboarding session against the customer repo.
2. The onboarding agent opens a setup PR.
3. The customer reviews and merges the setup PR.
4. If the setup PR generated a custom sandbox layer, a Cycloid business admin runs the post-merge sandbox build.

The onboarding command shape is:

```bash
cycloid sessions create owner/repo "set up Cycloid runtime onboarding" --onboarding --wait
```

Technically, any authenticated user with a write-scoped CLI token, repo access, GitHub App installation, model credentials, and available session capacity can run it. In practice, `--onboarding` is team use, not normal customer task creation.

The setup PR can include `.cycloid.json`, `.cycloid/` support files, `CYCLOID.md`, helper scripts or compose files, and, when the base sandbox lacks a needed toolchain, `.cycloid/sandbox.yaml` plus `.cycloid/sandbox.layer.Dockerfile`.

The onboarding agent reports what it proved:

- full app boot with auth
- full app boot with auth deferred
- primary app boot only
- static config validation only

IP-safe skeleton repos usually land at static validation only; that is expected and is not product-boot proof.

If `.cycloid/sandbox.yaml` was generated, the layer is not built during onboarding. After the setup PR merges, a business admin runs:

```bash
cycloid sandbox build owner/repo --ref <default-branch> --wait --follow
```

Until that build succeeds, sessions continue using the base sandbox template or fallback path.

## Review Loop

Review Loop keeps working after Cycloid opens a PR. It can respond to selected reviewer feedback, fix red CI, and coordinate QA testing.

For first setup:

1. Open **Settings -> General**.
2. In the reviewer checklist, choose a repository.
3. Add the review bots or GitHub logins Cycloid should respond to (the allow-list). Known bot options include Greptile, CodeRabbit, Cursor Bugbot, ChatGPT Codex, and Strix; custom GitHub logins are supported.
4. Save changes.

The reviewer checklist controls the configured-bot/comment-review arm only. If no reviewers are selected, Cycloid can still run CI and QA automation on capable repos.

To request QA testing on a PR, comment from a GitHub account connected to a Cycloid user with repo access:

```text
@cycloid qa=true https://github.com/owner/repo/pull/123
```

The PR URL is required for manual QA testing. Full behavior and labels are in [Review Loop](review-loop.md).

## CLI

The CLI is published as [`@trycycloid/cli`](https://www.npmjs.com/package/@trycycloid/cli). The customer-facing command reference is [apps/cli/README.md](../apps/cli/README.md). The internal reference is [docs/cli.md](cli.md).

Install:

```bash
npm install -g @trycycloid/cli
```

Requires Node.js 22 or newer.

Create a CLI token in **Settings -> CLI Tokens**, then log in:

```bash
cycloid auth login
```

Use a read-scoped token for inspection and debugging. Use a write-scoped token to create sessions, send prompts, stop runs, run `--onboarding`, or build sandbox layers.

Common commands:

```bash
cycloid auth whoami
cycloid sessions create owner/repo "fix the login bug"
cycloid sessions create owner/repo "add tests" --wait
cycloid sessions events <session-id> --follow --json
cycloid sessions send <session-id> "also update the docs"
cycloid sessions get <session-id>
cycloid sessions transcript <session-id>
cycloid sessions stop <session-id>
```

Use `--json` for machine-readable output. Prefer `ARCANIST_TOKEN` over `--token` for automation:

```bash
export ARCANIST_TOKEN=arc_...
export ARCANIST_API_URL=https://app.trycycloid.com
```

## Troubleshooting

| Problem                       | Fix                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Pending access page           | Email `shivam@trycycloid.com` or contact your Cycloid contact.                                       |
| No repos after GitHub install | Reopen GitHub App manage access, select the repo, and refresh Cycloid. Check GitHub SAML SSO too.    |
| Missing model key             | Add an OpenAI key, or ask a business admin to configure a shared key in Workspace integrations.      |
| Slack mention does nothing    | Confirm the workspace app is installed, then complete the first-mention magic-link identity binding. |
| Linear/Jira issue ignored     | Connect the actor's personal Linear/Jira account, check the trigger label, and set or name the repo. |
| CLI repo access error         | Use a GitHub account with repo access and confirm the GitHub App includes the repo.                  |
