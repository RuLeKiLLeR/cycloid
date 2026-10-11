# Devin UI/UX teardown

Observed July 6, 2026 from the authenticated Devin app in the `gunn3rforlife` org. Primary evidence was the open Devin session `Add Duplicate to the right`, plus the earlier same-browser pass through Devin's home, Ask, Automations, Security, Review, Wiki, and Settings surfaces.

## Cycloid baseline

Cycloid's authenticated app is organized around a narrow async task-to-PR loop:

- Home is a centered composer: repo chip, model chip, reasoning effort, attachments, `@file` autocomplete, slash-skill parsing, and submit.
- The left sidebar is a session list with filtering/status counts, not a project/product nav.
- Session detail is the primary work artifact: header, status, repo/branch/PR metadata, transcript turns, screenshots/artifacts, PR section, QA verification child-session affordances, and follow-up composer.
- Settings are grouped as Account, Repositories, Workspace, and System. Product surfaces like automations, MCP, memory, workspace integrations, API keys, usage, and repo sandbox settings live under Settings rather than as top-level apps.
- Cycloid's durable differentiators are server-owned auth/credential resolution, PR-as-user, Slack/UI/API intake, E2B sessions, review-loop/verification state, and security-boundary rigor.

That means Cycloid currently feels like "sessions plus settings." Devin feels like a suite of coding-agent products with sessions as one of several work modes.

## Information architecture

Devin's top-level app nav is product-first:

- New session
- Automations
- Security
- Review
- Wiki
- Recent sessions
- Settings

This differs sharply from Cycloid. Cycloid exposes only session creation/session history at the top level; everything else is tucked into Settings. Devin promotes adjacent jobs - review, security scanning, codebase wiki, and automations - as peer products.

The practical UX result: Devin's left nav tells the user "Devin can do several durable engineering jobs." Cycloid's nav tells the user "Cycloid can run sessions." We may have features in settings, but they are not presented as first-class workflows.

## Session experience

The observed Devin session shows a full work lifecycle:

- Prompt appears as a structured task block, including requirements.
- Repo context appears under the prompt.
- Agent replies with short acknowledgement.
- Work is grouped into timed blocks such as `Thought for 4s`, `Worked for 8m 24s`, `Worked for 16s`, `Worked for 3m 15s`.
- A PR card appears inline with title, repo/PR number, line delta, and bot author.
- CTAs appear directly on the PR card: `Review with Devin`, `Analyze`.
- Devin suggests environment changes based on the session's learnings.
- The environment suggestion is shown as editable docs/YAML with a `Save to environment` CTA.
- Test/verification result appears as an attachment with summary and pass count.
- The session enters a sleep state with `Wake Devin up?`.
- Bottom/side tabs include Worklog, Changes, PR, `test-report.md`, and Desktop.

Cycloid has a transcript and PR section, but Devin's session turns the work into a richer object:

- PR is not just an output; it is a bridge into Devin Review.
- Verification report is a named artifact with pass/fail summary.
- Environment learning is surfaced as a product loop: "save this for faster results in future sessions."
- Desktop is a visible live-computer tab even when sleeping.

Cycloid has pieces of this - artifacts, screenshots, PR section, QA verification child session, live computer work in the current branch - but the UX is less explicitly organized as "worklog / changes / PR / desktop / artifacts."

## Composer and work modes

Devin's home composer has two high-level modes:

- Agent: "Ask Devin to build features, fix bugs, or work on your code."
- Ask: "Ask Devin questions about your code."

Agent mode exposes:

- Context attachment menu: upload attachment, repositories, codebase files, skills, Devin sessions, playbooks, secrets, send secrets.
- Capability selector: Normal, Ultra, Lite.
- Fusion preview toggle.
- Mode selector: Agent and Data observed.
- Speed selector: Standard and Fast observed.
- More options: virtual environment, notable repositories, manage MCP connectors.
- Send options.

Ask mode exposes:

- Auto
- Q&A
- Plan
- Deep mode toggle
- Repository selection / add repositories gate

Cycloid's composer is simpler:

- Repository
- Model
- Reasoning effort
- Attachments
- `@file` autocomplete
- leading slash skills

Cycloid does not currently separate "ask about code" from "build code" as first-class modes. We can ask Cycloid a question in a session, but the product does not frame Q&A/planning as its own lower-risk workflow. Devin's `Ask` mode is a meaningful funnel advantage because it lets a user start with exploration before spending on an implementation session.

## Review product

Devin Review is a separate top-level app at `/review`.

Observed list/detail features:

- Repository filter.
- Pull-request URL paste box.
- `Go to pull request`.
- Status bucket: Waiting for reviewers.
- PR rows with title, PR number, age, source, repo, additions, deletions.
- Review onboarding carousel explaining value:
  - catches bugs automatically, ranked by severity
  - auto-fix and iterate
  - intelligently organized code diffs
- Review trigger onboarding:
  - Manual
  - When the PR is ready
  - Auto review on every push once ready
  - Edit in settings
- PR detail page:
  - status (`Ready to merge`)
  - merge action
  - open action
  - base/head branch metadata
  - file count and line delta
  - generated description
  - discussion and commits tabs
  - Devin's AI analysis slot
  - file outline with per-file deltas
  - side-by-side diff
  - mark-as-viewed
  - "lines left"
  - bottom CTA to run Devin's AI analysis
  - checks
  - auto-fix
  - reviewers
  - assignees
  - labels

Settings for Review include:

- Add Devin Review link in PR descriptions.
- Optional security scan phase.
- Post PR comments by category:
  - Bugs
  - Security
  - Flags (investigate)
  - Flags (note)
- Post GitHub CI checks.
- Automatic review enrolled by repositories and self-enrolled users.
- Auto-review spend limits.
- Rules/context files such as `**/REVIEW.md`.

Cycloid has PR lifecycle state and a review loop, but the UI is not a PR-review product. We do not have a top-level PR inbox, organized diff viewer, PR URL intake, category-based review comments, review trigger policy, review spend limits, or review-context rule management.

## Automations

Devin Automations is top-level, not buried in settings.

Observed features:

- Natural-language automation composer with placeholder like "Fix lint errors whenever CI fails on a PR."
- Analytics link.
- Featured automations:
  - Triage Bug Reports on Slack
  - CI Failure Fixer
  - `/devin` Issue Fix
- Empty state with setup choices:
  - Classical Automation: trigger Devin sessions based on integrations, schedules, and webhooks.
  - Watch a Channel: a Devin with long-term memory triages incoming Slack messages.

Cycloid has Automations under Settings and currently frames them as recurring runs plus Slack alert automation for Datadog/Sentry alerts posted to Slack. Devin's automation product is more discoverable and more template/natural-language led.

## Security

Devin has a top-level Security product. In the observed org it was empty, but the structure was clear:

- Security page title.
- Scans tab.
- Profiles tab.
- Search/filter scans.
- Start scan CTA.
- Profiles customize how scans analyze code.

Cycloid does not have an equivalent first-class code/security scanning product. Cycloid can run verification/review sessions and ingest alerts, but it does not expose "Security scans" or configurable scan profiles as a product.

## Wiki / DeepWiki

Devin's Wiki is branded as DeepWiki.

Observed features:

- Repository list.
- Per-repo `Generate` action.
- Add repository.
- Search/filter/refetch repositories.
- Repo-scoped wiki generation.

Cycloid has workspace/Slack memory and repo context, but no user-facing repo wiki generation product. We do not expose generated architecture docs, repo maps, or "ask the repo wiki" as a separate artifact.

## Settings and admin model

Devin Settings are extensive and productized:

- Personal:
  - Preferences
  - Connections
- Organization:
  - General
  - Connections
  - Plans
  - Invoices
  - Usage & limits
- Products:
  - Devin
  - Review
  - DeepWiki
  - Schedules
  - Devin Desktop
- Resources:
  - Skills & Rules
  - Environment
  - Knowledge
  - Playbooks
  - Secrets
- Administration:
  - Repositories
  - Membership
  - Devin API
  - Analytics

Important observed settings:

- Devin:
  - native deployments
  - full computer use vs legacy browser tools
  - default agent
  - API default agent
  - default platform
  - custom slash commands: `/implement`, `/plan`, `/review`, `/test`, `/think-hard`
  - batch/session limits
  - per-message spend limit
  - PR prompt sharing
  - require `@Devin` to respond
  - auto-add reviewer
  - open PRs as Devin or other identity
  - bot response allowlist
- Environment:
  - organization blueprint
  - repo setup order
  - snapshots
  - active snapshot vs clean image
  - auto-build snapshots
  - differential builds
  - clone repos on all platforms
  - build schedule
  - migration status/session/revert
- Knowledge:
  - org knowledge
  - suggestions
  - admin-only approvals
  - enabled-in-session state
- Playbooks:
  - reusable system prompts
  - macros
  - org/system categories
- Secrets:
  - org and personal scopes
  - bulk add
  - `$NAME` references
- Connections:
  - GitHub/GitLab/Bitbucket
  - Slack/Teams
  - Linear/Jira
  - MCP catalog with 136 servers
- API:
  - org ID
  - service users
  - legacy API keys
  - role/scope/expiry metadata
- Usage:
  - plan and renewal
  - daily/weekly quota
  - on-demand balance
  - auto-reload
  - per-message usage limit
  - session history and CSV export

Cycloid has some equivalents under Settings: API keys, usage, integrations, workspace integrations, automations, Slack memory, MCP servers, repositories, repo sandbox settings, workspace policies. But Devin has more product-specific settings and makes environment/knowledge/playbook/secrets concepts first-class.

## Features Devin has that Cycloid does not

- Top-level Ask mode for repo Q&A and planning, separate from implementation.
- Deep mode toggle for more thorough codebase answers.
- Capability tiers separate from model choice: Normal, Ultra, Lite.
- Speed selector separate from model/reasoning.
- Data mode in the same composer.
- Fusion preview mode.
- Context attachment types beyond ours: prior Devin sessions, playbooks, explicit secrets/send secrets, notable repositories.
- Top-level PR review product.
- PR URL paste/intake for review.
- Integrated diff viewer with grouped/reordered AI analysis.
- Moved/copied code detection positioned as a review feature.
- Review auto-trigger policy by repo/user and push cadence.
- Review comment category controls.
- Review spend limits.
- Security scan product with scan profiles.
- DeepWiki repo wiki generation.
- Natural-language automation composer.
- Slack channel watcher with long-term memory.
- CI failure fixer automation template.
- `/devin` GitHub issue automation template.
- Full environment blueprint/snapshot UI.
- Differential snapshot builds.
- Environment migration tooling.
- Reusable playbooks/macros as a product.
- Knowledge suggestions and approval workflow.
- Desktop/live computer tab as an expected session surface.
- Service users with scopes/roles/expiry.
- 136-server MCP marketplace/catalog.
- Native deployment toggle.
- Computer-use vs legacy browser tools toggle.
- Slash command customization at org level.
- Bot response allowlist.
- Usage controls tied to daily/weekly/on-demand balances.

## Features Cycloid has that Devin did not clearly show in this inspection

- Strongly documented PR-as-user positioning in our repo docs and product contract.
- Explicit control-plane ownership of auth, validation, state transitions, and credential resolution.
- FSM-backed post-publish lifecycle state for review/verification/merge readiness.
- QA verification child-session concept tied to PR evidence.
- Jira support in our documented integrations.

Devin may have internal equivalents for some of these; this doc only distinguishes what was visible in the inspected UI.

## Product takeaways

Devin's biggest advantage is packaging. It turns background coding into a suite:

- Agent work
- Code Q&A/planning
- PR review
- Security scanning
- Repo wiki
- Automations
- Environment/knowledge/playbook management

Cycloid should not blindly copy the whole suite. But the clear lesson is that top-level IA changes user perception. If Automations, PR review/verification, repo context, and live computer all remain hidden inside Settings or a single session page, users will undercount what Cycloid can do.
