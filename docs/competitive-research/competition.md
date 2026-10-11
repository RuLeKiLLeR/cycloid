# Competition

Canonical list of who Cycloid competes with. "Competition" / "competitors" = this file. Refreshed 2026-07-06 from the saved `~/Downloads/competitor research.pdf`, live logged-in tabs for Devin/Capy/Replicas/Niteshift/Factory, and prior changelog/site reads. Added 2026-07-07: Paperclip and Kortix/Suna (see "AI-company OS / self-hosted agent-management"). Deeper analysis: [2026-05-15-agentic-engineering-landscape.md](2026-05-15-agentic-engineering-landscape.md), [2026-06-20-goose-learnings.md](2026-06-20-goose-learnings.md). UI teardowns: [Devin](2026-07-06-devin-ui-ux.md), [Capy](2026-07-06-capy-ui-ux.md), [Replicas](2026-07-06-replicas-ui-ux.md), [Niteshift](2026-07-06-niteshift-ui-ux.md). Follow-ups: [parity build backlog](2026-07-06-parity-build-backlog.md), [frontend UX direction](2026-07-06-ux-improvements-to-match-competitors.md). Method for refreshing a single competitor from its changelog: `competitor-teardown` skill.

## Our category

Delegate a task async (Slack / UI / API / issue) -> agent runs in an isolated cloud sandbox -> PR opened **as the user**. Our moat: control plane owns auth/state/credential resolution + ephemeral E2B sandboxes + PR-as-user. IDE autocomplete (Copilot tab, Cursor editor) is not our category.

## Current pattern read

The market is converging on a broader product than "chat transcript that opens a PR." The best competitors make the work observable, steerable, and administrable while it runs.

1. **Work cockpit, not transcript:** Devin and Niteshift put live work artifacts next to the transcript: browser/preview, git changes, IDE, terminal, logs, verification report. Capy shows a live computer-use agent. Replicas shows tool cards plus a Canvas/Changes panel. Our UI is still mostly session list + transcript + PR outcome.
2. **First-class object model:** Capy has Projects, Threads, PRs, Automations, Explore, Context, Folders, Recents. Replicas has Environments and Workspaces. Niteshift has Repos, Tasks, Automations, repo Settings. Devin has Sessions, Automations, Review, Security, Wiki, Settings. Runtime separates Build, Observe, Govern, and Manage. Our IA is flatter and hides much of this in settings or session detail.
3. **Setup is a guided product surface:** Devin puts "get started" on the homepage. Replicas uses mandatory onboarding: repository -> agent -> workspace -> integrations -> team. Runtime forces users to instantiate different agent types. Niteshift runs an onboarding agent that studies the repo and writes setup. We rely more on users knowing what to configure.
4. **Automations are not a side feature:** Devin separates ambient and classical automations. Capy and Replicas ship automation template galleries. Niteshift shows automation health metrics and multiple trigger sources. Runtime presents agents as reusable operational roles. Our automations need clearer creation, templates, health, and activity surfaces.
5. **Context is visible and editable:** Capy has a Context page for AGENTS/CLAUDE/CAPTAIN/BUILD/REVIEW files and installed skills. Replicas elevates variables, files, skills, MCPs, hooks, and warm pools into Environment objects. Niteshift has repo configuration tabs for setup script, preview ports, custom instructions, preview auth, plugins, networking, MCP, AWS, database, and proxy. Our equivalents are powerful but less discoverable.
6. **Verification is productized:** Devin exposes live testing and a verification report. Niteshift exposes preview, logs, git, terminal, and IDE. Capy and Replicas show PR/change views. Our strongest strategic edge is verification-as-PR-evidence, but the product surface should make that edge obvious.
7. **Admin and governance are visible:** Runtime has Activity, cost, token usage, session sources, personal/team views, guardrails, templates, and strong access controls. Capy exposes audit log, service users, usage, members, org connections. Devin exposes service users, quotas, secrets, model/API provider settings, and security scans. Governance is no longer enterprise-only polish.

## Watchlist

These are the five competitors worth tracking on product and UX. Everything else in the space is either slop or too early to matter. Runtime, Boxes, Tembo, and Anyframe are covered under Broader direct competitors and Adjacent below. Builderbot (Block, internal only) is not a product. It is an in-house Slack and ticket to PR fleet on Goose, and it validates our lane.

### Tier 1, study closely

| Company               | URL      | Shape                                        | Threat                       |
| --------------------- | -------- | -------------------------------------------- | ---------------------------- |
| **Devin** (Cognition) | devin.ai | Autonomous SW engineer, own models + IDE     | Direct, mega-funded          |
| **Capy** (Scrapybara) | capy.ai  | IDE-first parallel multi-agent orchestration | Adjacent, owns sandbox infra |

### Tier 2, borrow selectively

| Company        | URL             | Shape                                          | Threat               |
| -------------- | --------------- | ---------------------------------------------- | -------------------- |
| **Niteshift**  | niteshift.dev   | Background coding agent, our exact loop        | Direct, closest peer |
| **Replicas**   | tryreplicas.com | Background coding agent, harness-agnostic+BYOK | Direct, closest peer |
| **Factory.ai** | factory.ai      | Droid/mission orchestration, enterprise        | Direct, well-funded  |
| **Ara**        | ara.so          | Cloud coding agents, software factory          | Direct, well-funded  |

## Build priority

This is the ranked list of what to build from this research, highest impact first. Priority is judged by how far behind we are and how many of the top competitors already ship it. The per-competitor detail is in the individual analysis below and in the [parity build backlog](2026-07-06-parity-build-backlog.md).

| Priority | Build                                                                                                       | Why it ranks here                                                                                   | Seen in                          |
| -------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------- |
| P0       | Live artifact panel next to the transcript with a changes and diff viewer, PR view, and verification report | This is our biggest gap. Our work is invisible while it runs, and everyone strong shows it.         | Devin, Capy                      |
| P0       | Watchable computer-use agent over VNC                                                                       | The user can see what the agent is actually doing in the sandbox. This is the strongest single wow. | Devin, Capy                      |
| P0       | PR as a first-class surface with a clear PR view and a PR inbox with review buckets                         | PR state is buried inside the session today. Both tier 1 products make it a real page.              | Devin, Capy                      |
| P1       | Granular live state, a todo list before work starts, and visible clarifying questions                       | This makes the agent legible and lowers prompt anxiety.                                             | Capy, Factory                    |
| P1       | Session summary on completion                                                                               | A clean end-of-run report reads better than the last agent message.                                 | Capy                             |
| P1       | Right-side workbench with preview, terminal, logs, and git                                                  | This is best for frontend and runtime-heavy tasks. Copy the observability, not the clutter.         | Niteshift                        |
| P1       | Onboarding agent that studies the repo on first run and writes setup                                        | This turns setup into an agent job instead of a config chore.                                       | Niteshift                        |
| P2       | Automations as a top-level product with templates, health metrics, and ambient vs classical splits          | Ours are hidden in settings today.                                                                  | Devin, Capy, Niteshift, Replicas |
| P2       | Context page with visible instruction precedence                                                            | Users should see the active instructions without reading AGENTS.md.                                 | Capy                             |
| P2       | Setup on the homepage plus an ask vs code split at creation                                                 | This makes getting started obvious and lowers the cost of exploring before a build.                 | Devin                            |
| P2       | Workspace and environment primitive for setup                                                               | This is cleaner than our current project and session split.                                         | Replicas                         |
| P2       | Mission-style orchestration UI with orchestrator, worker, and validator roles and a clarifying gate         | This communicates multi-agent work better than a flat session.                                      | Factory                          |

## Screenshot-reviewed competitors

### Replicas

Replicas is our closest peer on shape: background coding agents that run in cloud workspaces, support multiple harnesses, and open PRs. Their live app is organized around **Getting Started**, **Environments**, **Automations**, **Search**, a dashboard, default repo/global environment groups, and nested workspaces.

What they do:

- **Mandatory onboarding flow:** repository -> agent -> workspace -> integrations -> team. The product forces activation steps instead of dropping users into an empty dashboard.
- **Bring-your-own-agent model:** the app asks users to connect or configure Claude Code, Codex, Cursor, and Opencode through account/API modes and provider settings.
- **Environment primitive:** reusable presets of variables, files, skills, MCPs, start/warm hooks, warm pools, and scopes (global/team/personal) that can be applied to workspaces.
- **Workspace primitive:** work happens in a named workspace under an environment, with Chat, History, Create PR, agent status, tool cards, Changes, and Canvas.
- **Automation templates:** Code Review X/5, DRY Code Check, No Unused Code, No useEffects Check, Unnecessary Comments Check, Unnecessary TypeScript Casting, Documentation Sync, Daily Security Review Slack.
- **Tool-call UI:** explicit cards for shell/file/tool actions, model/reasoning controls, wake/build/fast controls, and progress.

Where they beat us:

- Environment/workspace objects are more legible than our project/session/config split.
- Harness support and BYOK are broader.
- Onboarding is more forceful and exposes integrations early.
- Automation templates are easier to understand at a glance.
- Tool calls and file changes are more visually distinct than a plain transcript.

Where we still lead or should lead:

- Jira and verification-as-PR-evidence are stronger Cycloid positions.
- Replicas feels less focused; the PDF notes the product as immature despite good primitives.
- Our control-plane security boundary and fail-closed credential model remain a core differentiator if the UI makes them visible.

### Niteshift

Niteshift is the most direct interactive UX benchmark. Its task page is a three-pane workbench: left repo/task nav, center transcript/composer, right workbench with **Preview**, **Git**, **IDE**, **Terminal**, and **Logs**. The PDF also shows a first-run **onboarding agent** that analyzes the repo, answers setup questions, writes setup script, reviews setup, and then starts the first agent.

What they do:

- **Repo-first nav:** Search tasks, Automations, Settings, Tasks, Recent tasks.
- **Command palette/search:** a visible shortcut/search affordance in the sidebar.
- **Live workbench:** preview iframe with reload, port selector, path editing, element selection, local/agent toggle, open/copy/fullscreen controls; git panel with PR metadata and diffs; IDE; connected terminal; logs.
- **Onboarding agent:** first repo run researches architecture and local dev requirements before normal work starts.
- **Automation health:** automation count, fires in last 24h/7d, failed count, All/Mine filters, schedule/webhook/Slack triggers.
- **Repo settings depth:** GitHub, models, integrations, preferences, sandbox, setup script, env vars, preview ports, configuration, custom instructions, preview auth, plugins, networking, MCP, AWS, database, static IP proxy.
- **Autofix source controls:** toggles for CI failures and review-comment sources.

Where they beat us:

- The right-side workbench is a materially better control room for frontend or runtime-heavy tasks.
- Preview/logs/terminal/IDE reduce uncertainty without leaving the app.
- Setup/onboarding is an agent-owned workflow, not a docs/config chore.
- Automations communicate usage and failures directly.
- Repo settings are broad and concrete.

Where we still lead or should lead:

- PR-as-user is not clearly visible from inspection; Cycloid should keep this as a trust edge.
- Jira support and verification evidence are stronger Cycloid wedges.
- Niteshift's UX is dense; we can copy the observability without copying the clutter.

### Devin

Devin is the highest-funded direct product benchmark. It organizes the app around **New session**, **Automations**, **Security**, **Review**, **Wiki**, **Recent**, and **Settings**. The session view exposes Worklog, Changes, PR, test report, Desktop/browser, environment setup suggestions, live testing, and sleep/wake controls.

What they do:

- **Homepage get-started:** setup guidance is front-and-center instead of buried.
- **Ask vs Agent split:** creation has explicit modes for Q&A/planning vs coding execution, plus Auto/Q&A/Plan/Deep controls.
- **Context attachment:** upload, repos, codebase files, skills, Devin sessions, playbooks, secrets, and send-secrets are available from composer context.
- **Review product:** PR URL intake, inbox, trigger policy (manual/ready/auto), diff viewer, AI analysis, autofix, checks, reviewers, comments.
- **Ambient/classical automations:** natural-language composer, templates like Slack bug triage, CI failure fixer, `/devin` issue fix.
- **Security and wiki:** scans/profiles plus repo knowledge generation.
- **Settings depth:** environment blueprints/snapshots, knowledge, playbooks, secrets, MCP catalog, API service users, usage quotas.
- **Live verification:** user can see setup, tests, changes, and verification report live.

Where they beat us:

- They separate ask/plan/code in a way that lowers prompt anxiety.
- PR review is a full workflow, not a session afterthought.
- Test reports and Changes are easy to find.
- Wiki/Security are strong adjacent surfaces that keep the product sticky.
- Settings and provider/catalog surfaces feel enterprise-ready.

Where we still lead or should lead:

- Devin is broad and expensive; Cycloid can be sharper on async workflow, PR-as-user, Jira, and customer-specific verification.
- Their power is in a large product suite; our chance is to make the core loop feel faster, clearer, and more trustworthy.

### Capy

Capy is more IDE/multiplayer oriented than our exact lane, but its organization is useful. Project nav includes **Dashboard**, **Threads**, **PRs**, **Automations**, **Explore**, **Context**, **Folders**, **Recents**, and **Settings**. The PDF calls out its homepage, thread tracking, Cmd-K dashboard, willingness to ask questions, todo list creation, granular state tracking, PR view, automation view, context view, live computer-use agent, and completion summary.

What they do:

- **Thread cockpit:** central composer, suggested prompt chips, participant/thread filters, idle grouping, folders, recents.
- **Agent asks questions:** the agent visibly pauses to clarify and turns work into a todo list before starting.
- **Granular state tracking:** progress states are visible at a finer level than "running/done."
- **PR inbox:** New/Open/Pinned/Approved/Needs review/Draft/Closed buckets with title/base/head/model/thread/age/deltas.
- **Automation templates:** Find critical bugs, Summarize changes daily, Crash triage, Security review, Dependency health, Stale PR cleanup.
- **Context page:** explicit instruction precedence and files such as CLAUDE.md, AGENTS.md, BUILD.md, REVIEW.md, CAPTAIN.md; installed skills are visible.
- **Explore marketplace:** project starters, automations, skills, org templates, personal templates.
- **Org/admin settings:** usage, activity, audit log, members, service users, projects, connections.

Where they beat us:

- Context/instructions are discoverable and inspectable.
- PRs and threads are first-class pages with useful filters.
- The product makes agent deliberation and clarification feel normal.
- Templates and marketplace make capabilities discoverable.

Where we still lead or should lead:

- Capy is IDE/multiplayer-first and does not clearly show Slack/Linear/Jira async intake or PR-as-user.
- Cycloid can borrow the UI organization without diluting the headless async lane.

### Factory

Factory's inspected app surface was simple: New Session, Mission Control, Search, Projects, sessions, and controls for model, auto mode, normal mode, MCP, and skills. The important differentiator from the PDF is **Mission** UI, not the basic session list.

What they do:

- **Mission Control:** a mission with states such as `PLANNING`, top stats for time/progress/usage, role/model assignments, and a progress log.
- **Role-based orchestration:** Orchestrator, Worker, and Validator are visible as separate roles with separate models.
- **Clarifying gate:** the mission asks a required question with explicit choices before proceeding.
- **Progress instrumentation:** mission-level progress and usage are part of the default view.
- **Simple core app:** sidebar for New Session/Mission Control/Search/Projects and composer controls for model/mode/MCP/skills.

Where they beat us:

- The Mission abstraction communicates multi-agent orchestration better than a flat session.
- Role assignment and validator visibility make verification feel planned, not bolted on.
- Forced clarification before a high-risk mission is good UX for ambiguous work.

Where we still lead or should lead:

- The basic web app felt sparse in inspection.
- Cycloid can adopt the mission/roles/validator UI while keeping our existing async session model and PR workflow.

### Ara

Ara positions itself as a "software factory" and "autonomous software engineer for GitHub" with cloud coding agents across web, CLI, desktop, and mobile. The product emphasizes comprehensive automation, review, QA with screen recordings, security scanning, code review, AutoWiki, repo memory, analytics, agent readiness, and model routing.

What they do:

- **Multi-platform access:** web, CLI, desktop, and mobile interfaces for cloud coding agents.
- **GitHub integration:** deep GitHub integration with PR workflow as the primary output.
- **Multiple triggers:** Slack, Jira, Linear, and API triggers for async task intake.
- **Comprehensive automation:** automations for review, QA with screen recordings, security scanning, and code review.
- **Knowledge management:** AutoWiki for repo documentation and repo memory for context.
- **Analytics and observability:** analytics dashboards and agent readiness metrics.
- **Model routing:** intelligent model routing for optimal performance and cost.
- **Team pricing:** per-seat pricing (e.g., Developer plan at $120/seat/month) with trial credits.

Where they beat us:

- Multi-platform coverage (web/CLI/desktop/mobile) is broader than our current web/CLI focus.
- QA with screen recordings is a strong verification differentiator we don't have.
- AutoWiki and repo memory are more productized than our context surfaces.
- Team pricing without per-seat costs may appeal to larger organizations.
- Agent readiness and model routing show mature operational thinking.

Where we still lead or should lead:

- PR-as-user security boundary and control-plane architecture remain our core trust differentiator.
- Our async workflow is more focused; Ara's "software factory" positioning may be too broad.
- Jira integration depth and verification-as-PR-evidence are stronger Cycloid positions.
- Our control-plane owns auth/state/credential resolution in a way that should remain visible as a security edge.

### Runtime

Runtime is not a direct ticket-to-PR clone, but it is a strong benchmark for onboarding, agent templates, Slack agent creation, Activity, cost/token visibility, and governance. Its IA is split into **Home**, **Quickstart**, **Build** (Sessions, Agents), **Observe** (Discover, Activity), **Govern** (Context, Guardrails, Templates), and **Manage** (Integrations, Settings).

What they do:

- **Quickstart progression:** Create Organization, Invite Team Members, Choose Your First Agent.
- **Agent templates:** Customer Support Agent, Data Analyst Agent, On-Call / Incident Responder, Code Reviewer / PR Agent, GTM / Lead Enrichment Agent.
- **Slack agent setup:** a clear modal for connecting Slack, configuring @mentions, connecting a workspace once, pasting Slack app config token, and connecting the workspace.
- **Activity page:** personal/team filters, session/prompt/cost/token summary, activity heatmap, session sources, cost analytics, token usage.
- **Governance sections:** Context, Guardrails, Templates, and strong access controls noted in the PDF.

Where they beat us:

- Activity and usage are product surfaces, not buried admin data.
- Agent templates make the platform legible to non-experts.
- Slack agent creation is a first-class flow.
- Access controls appear more mature.

Where we still lead or should lead:

- Runtime is more platform/runtime than coding-agent product. Cycloid should copy the observability and governance primitives, not become a generic runtime.

## Broader direct competitors

**Hyperscaler / mega-funded (win on distribution):**

- **OpenAI Codex cloud agent** - per-task sandbox -> PR; bundled in every ChatGPT plan (~4M weekly devs). Biggest distribution threat.
- **GitHub Copilot coding agent** - Issue -> Actions env -> tested draft PR. Native, default-on for paid Copilot. GitHub/Actions-locked, supervised. (Copilot Workspace dead, folded May 2025.)
- **Google Jules** - repo -> GCP VM -> PR + CI self-heal. Gemini-locked, generous free tier.
- **Cursor Cloud Agents** - isolated VM from web/Slack/GitHub/Linear/API -> PR. IDE-anchored funnel.
- **Augment Code Remote Agents** - isolated envs, PR author, parallel agents. IDE-centric entry.

**Independents (beatable on focus):**

- **Tembo** - background-agent orchestration over Claude Code/Codex/Cursor/Amp/Gemini. Triggers: Slack/Linear/GitHub/Sentry; VPC self-host + BYOK. Bets on agent-agnostic orchestration.
- **Anyframe** - control plane + runtime to run any harness in seconds-to-boot sandboxes; multi-trigger + human-approval gate. Sells the generic substrate, not the vertical.
- **Charlie Labs** - 24/7 daemons from Slack/Linear/GitHub -> PRs + Playwright E2E. TypeScript-only, small team.
- **Superconductor** - multiplayer cloud workspace with live previews, automated QA, guided review, multiple harnesses, automations, and multi-agent-per-ticket recommendations. Collaborative-first / multi-agent-per-ticket vs our async PR-as-user lane.
- **OpenHands / All Hands AI** - MIT-licensed, model-agnostic; tag on issue/PR/Slack -> Docker sandbox -> PR. Heavy self-host.
- **Atlassian Rovo Dev** - Jira item -> sandbox -> PR (Bitbucket+GitHub). Strong in Jira/regulated; weak for GitHub-first.

## Adjacent

- **Linear Agents** - marketplace where Devin/Cursor/Codex/Charlie/Copilot are assignable teammates. Disintermediation threat and distribution channel.
- **Sentry Seer** - error -> autofix PR, but delegates codegen. Incident-to-PR entrant.
- **CodeRabbit / Cubic** - AI PR reviewers, complementary but can move toward autofix.
- **Conductor / Sculptor / Omnara** - local-first or desktop parallel-agent surfaces.
- **Boxes** - per-thread cloud computers with snapshot-fork including running services and DB state. Useful environment-fidelity benchmark.

## AI-company OS / self-hosted agent-management (adjacent, emerging)

A distinct open-source category is scaling fast: self-hosted "operating systems" that run and govern a fleet of agents across all company tools, not a coding-specialized ticket-to-PR loop. Both entrants below are model-agnostic, BYOK-via-gateway, self-host/air-gap capable, and viral on GitHub. Threat is indirect: they own the "manage all your agents" layer that could sit above Cycloid and commoditize the coding specialist, or become a distribution channel for it. Confidence: medium - site + changelog + repo metadata, no hands-on. Refreshed 2026-07-07 via `competitor-teardown`.

### Paperclip (paperclip.ing / paperclipai/paperclip)

Open-source (MIT), self-host only, no cloud. ~73k GitHub stars in ~4 months (created 2026-03), pushed daily. "The app people use to manage AI agents for work" - an org chart of agents, not a coding tool. Explicitly not a coding agent, sandbox provider, or code-review tool.

- Bring-your-own-agent via heartbeat/HTTP adapter ("if it can receive a heartbeat, it's hired"): Claude Code, Codex, Gemini, Cursor, OpenClaw, Pi, OpenCode.
- Company modeling: org charts, roles/titles/reporting lines, board-approval workflows before an agent acts.
- Per-agent monthly budgets with hard caps + auto-pause; cost tracking per company/agent/project/goal/model.
- Ticketing with goal hierarchy, atomic task checkout, blocker deps; immutable audit log of every tool-call/decision. Cron/heartbeat scheduling; git worktrees/operator branches for isolation; Postgres + plugin workers.

Where they beat us: multi-agent org modeling (roles, delegation, board approval) vs our single-agent-per-session + child sessions only; harness breadth (7+ runtimes) vs our 3; immutable action audit log (we have none, `docs/user-access.md` + role split at `auth/business-role.ts:1` is admin/member only); per-agent hard budgets as a product surface; open-source self-host distribution.

Where we lead: we do the actual coding-to-PR work end-to-end - Paperclip is a manager, not a worker (no sandbox, no PR-as-user, no verification). GitHub PR-as-user + control-plane security boundary + ephemeral E2B-per-task + Jira + verification-as-PR-evidence are all outside its scope. We also offer managed cloud; they are self-host only.

### Kortix / Suna (kortix.com / kortix-ai/suna)

Open-source (Apache-2.0), self-host or managed cloud ($20/seat + usage). ~20k stars (created 2024-10), pushed daily. "AI command center for your company" - whole company as a git repo of agents/skills/connectors/memory. Horizontal generalist worker (HubSpot/Gmail/Stripe/LinkedIn), not coding-specialized, but encroaches on our sandbox/PR lane.

- Sandbox-per-task with own VM + own git branch; warm prebake on push (warm pools), idle reaper TTLs, per-project sandbox provider override.
- Change Requests (~ internal PRs) with diffs / Review Center / approval gates before merge; rejects empty CRs; "fix with agent" on merge conflicts.
- BYOK "Kortix Gateway" across Claude, GPT-5, Gemini, Groq, Grok, GLM (OpenRouter routing); server-side default model resolution.
- 3,000+ connectors (MCP/OpenAI/GraphQL/HTTP); credentials brokered, never copied into sessions; scoped per project/agent/person.
- Computer-use/browser automation, people search, shared company memory. Governance: SSO group auto-provisioning, SCIM, per-role file/secret access, audit trail. Cron + webhook triggers; Slack/Teams/web/mobile/CLI/SDK (npm) intake.

Where they beat us: warm pools (we cold-start every session); model/provider breadth via gateway (no Bedrock/OpenRouter on our side); computer-use/browser automation (we have none); 3,000+ connectors vs our ~5 triggers; governance depth (SSO/SCIM/roles/Review Center) vs admin/member only; open-source self-host + air-gap; skills marketplace.

Where we lead: coding depth and trust - a real GitHub PR authored as the user (OAuth token resolved server-side, never shipped to the sandbox) + control-plane security boundary; their CR/review lives inside their own OS, not GitHub. Verification-as-PR-evidence, native Jira trigger, and coding-specialist quality are our wedge against a horizontal generalist.

## Takeaways

1. Independent ticket-to-PR is consolidating; reliability, security boundary, trigger breadth, and verification decide it now.
2. Cycloid's async PR-as-user loop is still strategically strong, but the UI must expose the trust story and the running-work evidence.
3. The next UX bar is an agent cockpit: transcript plus changes, PR, preview/browser, terminal/logs, verification, context, and setup state.
4. Automations need templates, natural-language creation, trigger taxonomy, health metrics, and activity history.
5. Context/environments should become a visible object, not hidden config: instructions, env vars, MCPs, skills, secrets, setup hooks, preview/auth.
6. Onboarding should be mandatory enough to produce a working first repo/session and lightweight enough not to block experienced users.
7. Mission-style orchestration is worth copying in a small form: planner/builder/verifier roles, clarifying questions, checklist, and verification report.
8. Runtime-style Activity and Capy-style Context are the most obvious admin/governance UX gaps.
9. Against Replicas and Niteshift, our durable edge is narrowing to Jira reach, PR-as-user security, and verification evidence. Those edges need product surfaces, not just backend correctness.
10. A self-hosted, open-source "AI-company OS" category (Paperclip, Kortix/Suna) is going viral (73k / 20k stars) as a governance/management layer above individual agents. It could commoditize the coding specialist or become a channel. Intel corrections: we now ship 3 harnesses (Codex, Claude Code, OpenCode/Baseten internal), not 2; and we already have backend spend budgets + hard caps + per-source usage tracking (`openai-gateway/budget-do.ts`, `openai-gateway/usage.ts`) - the gap is a user-facing Activity/usage surface and an action audit log, not the budget primitive.
