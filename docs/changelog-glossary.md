# Changelog Glossary

One-line plain-language definitions of internal names kept as shared wording for changelog-style summaries.
One line per entry; add one when a post needs a missing term.

- **Cycloid**: our product — a coding agent that runs in the background and opens PRs for you.
- **Control plane**: the central server (a Cloudflare Worker) handling auth, sessions, webhooks, and state — the brain of the product.
- **Session**: one run of the agent on one task, from prompt to (usually) a PR.
- **SessionDO / session Durable Object**: the per-session stateful object in the control plane that tracks live state and streams events to the UI.
- **Sandbox**: the isolated cloud VM (provider: E2B) where the agent actually runs.
- **Bridge / sandbox-bridge**: the program inside the sandbox that drives the coding agent (Codex or Claude Code) and reports progress back.
- **Publish flow**: how a session's code changes become a real GitHub PR, opened as the requesting user.
- **Review loop**: the feature where Cycloid automatically responds to review comments on PRs it opened.
- **Automation schedules**: the product feature that runs sessions on a recurring cron schedule.
- **Memory / memory PRs**: Cycloid's learning system — it proposes repo-convention updates as small PRs after sessions.
- **Company memory**: business-level remembered facts, refined by a background LLM job.
- **Platform LLM**: the control plane's own LLM calls (filling PR templates, triaging review-loop dispatches, synthesizing Slack progress narration) — separate from the coding agent itself.
- **CLI**: the `cycloid` command-line tool for creating and driving sessions from a terminal.
- **QA environment**: the staging copy of everything at qa.trycycloid.com, used for testing before prod.
- **Doc-drift bot (Detail)**: a third-party bot that opens PRs fixing docs that drifted from the code.
- **Graphite stack ([i/N] PRs)**: a series of small dependent PRs that land in order; together they are one change.
- **D1**: Cloudflare's SQLite database where the control plane stores its data.
- **Warm pool**: pre-started sandboxes kept ready so sessions start faster.
