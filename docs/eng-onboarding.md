# Engineer onboarding

New-hire setup. Customer onboarding: [onboarding-checklist.md](onboarding-checklist.md). App-login maps: [user-access.md](user-access.md).

## SaaS invites (ask admin)

GitHub (`trycycloid` org), Cloudflare (Workers/D1/Pages), AWS (SSM secrets, `infra/`), E2B (sandbox, replaced Modal), Datadog (`us5` only), Sentry, Braintrust, Slack, Linear, Otter. Modal: legacy evals only.

## GitHub

People joining should either rename their personal GitHub account to `<name>-cycloid` or create a new GitHub account. In either case, make the profile completely private while Cycloid is still in stealth.

## Personal accounts

Codex/OpenAI (agent runtime, team runs Max), Claude Max/Anthropic, Google Workspace. Company covers plan upgrades — ask when you hit limits.

## Local dev

1. Clone `trycycloid/cycloid`; install [Graphite](https://graphite.dev) (`gt`, required for branches/PRs; setup: [graphite.md](graphite.md)).
2. Work in a worktree; run `bash scripts/worktree-setup.sh` after entering it.
3. `npm run dev:full` only for live API/UI, browser, webhook, or E2E (API `:3000`, UI `:5173`). For E2B and dogfood startup details, use [e2b-local-setup.md](e2b-local-setup.md). Codex config syncs via `prepare`.
4. Read [CLAUDE.md](../CLAUDE.md) + [conventions.md](conventions.md).

## Good Reads

- [Ownership](ownership.md) - what we mean when we ask "can you own this?"
- [10 lessons from working at startups](https://x.com/nicholaschen__/status/2070979090094633439)
- [All code smells - oneliner guide](https://www.reddit.com/r/learnprogramming/comments/x2ewxi/all_code_smells_oneliner_guide/)
- [Achieving Abstraction in Code](https://medium.com/@ryannealewallace/achieving-abstraction-in-code-12e4b9836108)
- [Yagni](https://martinfowler.com/bliki/Yagni.html)
- [What is Durable Execution?](https://temporal.io/blog/what-is-durable-execution)
- [Ramp scales engineering automation with Graphite](https://graphite.com/customer/ramp)

## App login + verify

Sign in with GitHub at `https://app.trycycloid.com`; your login lands in `pending_signups` and a Cycloid-team admin approves you into the Cycloid business ([user-access.md](user-access.md)). Verify: start a session on `trycycloid/cycloid`, confirm it opens a PR. Debug with Datadog, D1, and the session APIs in [debugging-runbook.md](debugging-runbook.md).
