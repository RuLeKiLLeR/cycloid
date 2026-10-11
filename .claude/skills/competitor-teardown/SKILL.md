---
name: competitor-teardown
description: Tear down one competitor from its public changelog or site, cross-reference every capability against the Cycloid codebase, and produce an evidence-backed "where they beat us / where we lead" read. Optionally post the summary to Slack and update the competitive-research doc. Use when Josiah drops a competitor URL and wants the diff against our code.
user_invocable: true
argument: a competitor changelog/site URL (required) plus optional name; e.g. "https://competitor.dev/changelog Foo"
---

# Competitor teardown

Turn one competitor's public changelog (or site, if no changelog) into an evidence-backed diff against the current Cycloid codebase. Output: where they beat us, where we lead, and any stale intel to correct. This is a research + writing workflow - do not edit product code.

Ground every claim in evidence: a competitor changelog line or a `file:line` in our repo. Label anything site-derived (no changelog) as lower confidence.

## Input

`$ARGUMENTS` contains a competitor URL (changelog preferred) and optionally a name. If only a homepage is given, look for a `/changelog`, `/releases`, or `docs` link and prefer that - a dated changelog is far higher-signal than marketing copy.

## Steps

1. **Fetch the changelog verbatim.** `WebFetch` the changelog with a prompt that demands every entry (date, title, full feature description) with no summarizing - triggers, sandboxes, harnesses, BYOK/models, PR authorship, governance/teams, computer-use, warm pools, multi-repo, preview URLs, self-hosting. Changelogs are large; the result is saved to a file - `Read` it fully. If there is no changelog, `WebFetch` the site + one `WebSearch` for funding/team/category, and flag the whole entry as site-derived.

2. **Fan out the codebase audit.** Launch parallel `Explore` agents (one per dimension) to inventory OUR capabilities with `file:line` evidence, so the diff is grounded in code, not memory. The four standing dimensions:
   - **Triggers & integrations** - Slack/Linear/GitHub/Jira/GitLab/Sentry/webhooks/cron-automations/REST+SSE/CLI/MCP-server/web. Start from `docs/session-creation-entrypoints.md` and `apps/control-plane-worker/src/routes/webhooks.ts`.
   - **Harnesses, backends, BYOK, models** - which harnesses ship (`shared/agent/agent-runtime-backend.ts`), model registry (`shared/constants/models.ts`), credential resolution (`apps/control-plane-worker/src/integrations/runtime.ts`), plan/thinking/fast mode, skills discovery. See `docs/agent-runtime-backends.md`.
   - **Sandbox & environment** - E2B backend, warm pools, environment primitive, multi-repo, preview URLs, computer-use/desktop, Docker, sizing, lifecycle. See `docs/sandbox-architecture.md`, `docs/sandbox-templates.md`.
   - **Governance & lifecycle** - PR-as-user + control-plane security boundary, feature gating, audit log, roles/seats, security policies, review-loop FSM, self-hosting. See `docs/fsm.md`, `docs/review-loop.md`, `docs/user-access.md`, `docs/security-boundaries.md`.
     If a fresh audit already exists in this session, reuse it instead of re-running - the four dimensions rarely change day to day.

3. **Diff.** Map each competitor capability to supported/partial/absent on our side. Produce two lists: **where they beat us** (usually breadth: harnesses, computer-use, warm pool, self-serve teams, preview URLs, IDE/terminal-in-task, integration count) and **where we lead**. Be honest - most peers now out-ship us on interactive surface. Do not inflate a parity item into a win.

4. **Correct stale intel.** Diff findings against `docs/competitive-research/competition.md`. Flag any prior that the changelog now contradicts (e.g. a moat a competitor has since shipped, a sandbox backend now confirmed). Corrections are the highest-value output.

## Our capability baseline (verify, don't trust - these drift)

- **Durable edges:** PR-as-user (user's GitHub OAuth token resolved server-side, never shipped to sandbox; user = git author, Cycloid = committer) + control-plane-as-security-boundary + fail-closed auth; **Jira** (few peers have it); verification-as-PR-evidence (App Runtime Profiles + Playwright + WebM artifacts); ephemeral E2B-per-task (smaller blast radius than persistent-env rivals).
- **Known gaps rivals exploit:** only 2 production harnesses (Codex + Claude Code; no Cursor/Amp/Gemini); no computer-use/GUI desktop; no warm pool (cold start every session); no self-serve team management (roles edited in D1 by hand); no public preview URLs; no in-task IDE/terminal; single-repo per sandbox; no GitLab/native-Sentry/generic-webhook; no Bedrock/OpenRouter.
- **Note:** PR-as-user is no longer universal - Replicas ships it. Confirm per competitor before claiming it as an edge.

## Deliverables (confirm scope with Josiah first)

- **Slack summary** to `#improvements` (`C0BBSE6BHPF`), then xpost to `#competition` (`C0BAN7J8HAS`) with a link back to the `#improvements` message. Lead with intel corrections, then "where they beat us", then a short "where we lead". Plain hyphens, sentence case, scannable bullets.
- **Doc update** to `docs/competitive-research/competition.md`: add/refresh the watchlist entry and per-competitor section, align with "Current pattern read" and "Takeaways", bump the "Refreshed" date. Ship as its own Graphite PR per repo git rules (`docs/graphite.md`); keep it separate from any skill/tooling change (one PR = one idea).

Default to producing the analysis and asking before posting to Slack or opening a PR, unless Josiah said to just do it.
