# Getting started with Cycloid

Cycloid is a background coding agent: give it a task, it works in a sandbox on your repo and opens a pull request as you. First-time setup is ~10 minutes, done once.

Your URL: **https://app.trycycloid.com** (or your team's custom URL).

## Required setup

**1. Sign in with GitHub** — Go to your URL, click **Sign in with GitHub**, authorize. PRs are attributed to you, not a bot.

**2. Install the GitHub App** — When prompted (or **Settings → Integrations**), install on your org/account and pick the repos Cycloid can use. Not an org admin? An owner must approve the install.

**3. Confirm repo access** — Your repos should appear on the home page. Missing one? Click **Manage access** to add it on GitHub, then refresh.

**4. Add a model API key** — **Settings → API Keys**. Add the key for your agent: OpenAI (`sk-...`) for Codex, or Anthropic for Claude Code. Stored server-side, never exposed. If your admin set a shared key, it shows as managed by your workspace — skip this.

## Run your first task

Home page → pick a repo → describe the task in plain language → submit. Cycloid runs against the repo's default branch, works the task live, and opens a PR.

**Tip:** add an `AGENTS.md` to each repo root with your conventions and build/test commands. Cycloid reads it every task; it noticeably improves results.

## Automatic review handling (optional)

Cycloid can watch the PRs it opens and address reviewer feedback, looping until caught up. This is **off by default** — Cycloid always fixes CI, but ignores reviews unless you enable this.

1. **Settings → General** → turn on **"Automatic review handling"**.
2. A **Review bot checklist** appears. Per repo, list the reviewers Cycloid should respond to (the allow-list) — known bots (Greptile, CodeRabbit, Cursor Bugbot, ChatGPT Codex, Strix) or any GitHub login (a teammate or your own bot).
3. Optional per repo: keep **respond to failing CI** on.

Cycloid stops once it's caught up and CI is green; the PR is then ready for your review and merge.

To act on one specific review comment while automatic handling is off, mention `@cycloid` on that comment.

## Optional integrations

Connect from **Settings → Integrations** anytime.

| Integration   | What it does                              | Who connects |
| ------------- | ----------------------------------------- | ------------ |
| GitHub        | Repo access, PRs, login (required)        | You          |
| OpenAI        | Model key — Codex agent                   | You or admin |
| Anthropic     | Model key — Claude Code agent             | You or admin |
| Linear        | Start tasks from issues; act as you       | Admin + You  |
| Slack         | Start tasks by message; updates in-thread | Admin (once) |
| Notion        | Read pages for context                    | You          |
| Sentry        | Look up issues and events                 | Admin        |
| Datadog       | Search logs, fetch traces                 | Admin        |
| Cloudflare D1 | Read-only SQL queries                     | Admin        |

A model key is required — add OpenAI (Codex) or Anthropic (Claude Code) to match your workspace's agent. "Admin" items are set up once for the team and show as already managed.

## Troubleshooting

| Problem                    | Fix                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Pending access" screen    | Account awaiting approval — contact your Cycloid contact, then sign in again.                                                                                           |
| No repos on home page      | **Settings → Integrations → Manage access**; confirm the repo is selected.                                                                                              |
| "GitHub App not installed" | Finish step 2; an org owner may need to approve.                                                                                                                        |
| Task fails on missing key  | Add your key (step 4) or confirm the workspace key with your admin.                                                                                                     |
| PRs not attributed to me   | Sign in with the GitHub account that has repo access.                                                                                                                   |
| Not responding to reviews  | Turn on **Automatic review handling**, add the reviewer to that repo's checklist, and confirm your Cycloid contact enabled the review webhook events on the GitHub App. |

**Settings → Integrations** shows live status for every step — share a screenshot with your Cycloid contact if stuck.
