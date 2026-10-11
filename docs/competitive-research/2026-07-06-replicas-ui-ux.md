# Replicas UI/UX teardown

Observed July 6, 2026 from the authenticated Replicas app in `My Organization`, including Automations, Getting Started, Environments, Coding Agents, and one workspace detail.

## Cycloid baseline

Cycloid organizes work around sessions. A repo and model are selected in the home composer; sessions stream into a flat sidebar and open into a transcript/PR detail page. Environment, integrations, MCP, automations, usage, and repository settings live under Settings.

Replicas organizes work around environments and workspaces. Sessions are not the only object. A workspace belongs under an environment, environments hold reusable setup/config, and automations/workspaces are visible in the left nav as operational objects.

## Information architecture

Replicas top-level left nav:

- Getting Started
- Environments
- Automations
- Search
- Dashboard
- Environment groups:
  - Default `gunn3rforlife/excalidraw`
  - Default `gunn3rforlife/hiring-agent`
  - Default `gunn3rforlife/strix`
  - Global
- Workspaces nested under environment groups.
- Per-environment quick actions:
  - New workspace in environment
  - Edit environment
- Account menu with plan (`Hobby`).

Cycloid's left sidebar is a session list. Replicas' left sidebar is a workspace tree grouped by environment. This is a substantial product-shape difference:

- Cycloid asks "which session?"
- Replicas asks "which environment/workspace?"

The Replicas structure makes environment reuse central. Cycloid's repo sandbox/settings exist, but they are not the primary navigation primitive.

## Getting Started

Replicas onboarding is a wizard:

- Repository
- Agent
- Workspace
- Integrations (optional)
- Team (optional)

Observed Integrations step:

- Linear: assign Linear issues to Replicas and have agents work automatically.
- Slack: mention `@replicas` in Slack to trigger agents and get updates.
- Source Control Triggers: use `@tryreplicas` mentions on GitHub issues/PRs or GitLab issues/MRs, with automatic CI failure handling.
- Back / Skip & complete / Next step.

Cycloid has a getting-started checklist in Settings, but Replicas' onboarding reads like a guided product activation flow. It explicitly teaches trigger surfaces and ends by completing setup. Cycloid setup is accurate but less narrative.

## Environments

Replicas Environments page describes environments as:

"Reusable presets of variables, files, skills, and MCPs that get applied to your workspaces."

Observed hierarchy:

- Global:
  - default environment for all workspaces
  - Pool off
  - Start hook off
  - Warm hook off
  - Vars count
  - Files count
  - Skills count
  - MCPs count
- Team:
  - inherits from Global with repository-specific additions or overrides
  - `New environment`
  - default repo environments
- Personal:
  - only visible to the user
  - private tokens or agent-specific config
  - `New environment`

Observed environment capabilities:

- variables
- files
- skills
- MCPs
- pools
- start hooks
- warm hooks
- inheritance/overrides
- personal/team/global scopes

Cycloid has repository secrets/env vars, sandbox environment settings, MCP servers, memory, and skills. Replicas packages those as a single "environment" primitive that is always visible and reusable.

This is one of the clearest gaps: Cycloid has environment pieces, but not a unified environment object with visible inheritance, hooks, warm pools, files, skills, MCPs, and personal/team/global scopes.

## Coding Agents / harness management

Replicas has a Coding Agents settings page, split between account and organization.

Observed organization-wide coding agents:

- Claude:
  - Claude Code account auth
  - Anthropic API key
  - Claude Bedrock
- Codex:
  - Codex account auth, connected as `shivam@trycycloid.com · pro`
  - OpenAI API key
- Cursor:
  - Cursor API key
  - model allowlist, 4 enabled
- Opencode:
  - OpenRouter API key

This is more explicit than Cycloid's model picker. Cycloid supports model/provider selection and Codex/Claude runtime paths, but Replicas makes "coding agent harness" a first-class admin/user configuration object.

Replicas' user can understand the difference between:

- using Claude Code account auth
- using Anthropic API for Claude Code
- using AWS Bedrock for Claude
- using Codex account auth
- using OpenAI API for Codex
- using Cursor
- using Opencode via OpenRouter

Cycloid exposes model/provider keys, but the UI does not make harness identities this legible.

## Automations

Replicas Automations page:

- Shared workflows for organization.
- Create Automation CTA.
- Organization / Your Automations toggle.
- Billing note: automation runs billed per minute of active workspace time based on compute size; plans include free monthly minutes.
- Empty state.
- Template gallery.

Observed templates:

- Code Review: leave a single PR comment with a thoughtful X/5 review score.
- DRY Code Check: catch duplicated logic, parallel schemas, reinvented utilities.
- No Unused Code: flag code that became unused because of the PR.
- No useEffects Check: flag unnecessary React `useEffect` escape hatches.
- Unnecessary Comments Check: flag comments that restate code.
- Unnecessary TypeScript Casting: challenge avoidable `as any`, non-null assertions, and `@ts-ignore`.
- Documentation Sync: verify docs/changelog stay in sync.
- Daily Security Review (Slack): daily pentest with severity-graded Slack findings and Severity 1 paging.

Cycloid automations are less template-rich and less opinionated. We have recurring runs and Slack alert automation; Replicas ships code-quality templates that encode strong engineering opinions.

Replicas also makes automation cost explicit in the automation page itself. Cycloid has usage settings, but not per-automation active workspace minute messaging at automation creation.

## Workspace detail

Observed workspace: `Update Excalidraw logo color`.

Workspace UI includes:

- Title.
- Environment label.
- Tabs:
  - Chat
  - History
  - Create PR
- Agent selector: `Codex`.
- Conversation transcript.
- Tool cards:
  - Git status
  - Command
  - Read file
  - Edit
  - Git diff
- Copy buttons.
- Agent status: `Codex is sleeping`.
- Wake CTA.
- Mode/control row:
  - Wake
  - Build
  - Fast
  - Goal
  - progress percentage (`50%`)
  - model (`GPT-5.5`)
  - reasoning (`Medium`)
- Changes panel:
  - All files
  - unavailable until workspace wakes in this observed state
- Canvas:
  - Plan
  - empty until agent writes files into `~/.replicas/canvas/`

Cycloid session detail has transcript, PR, artifacts/screenshots, follow-up composer, and verification. Replicas adds more workspace-local controls:

- explicit goal/progress control
- Build/Fast toggles
- canvas filesystem convention
- Chat/History/Create PR tabs
- changes browser tied to workspace wake state

## Search

Replicas search copy says it searches:

- pages
- workspaces
- automations
- environments

Cycloid has sidebar/session search/filtering, but no global command/search surface that spans settings pages, workspaces/sessions, automations, and environments.

## Features Replicas has that Cycloid does not

- Environment-first sidebar with workspaces nested under environments.
- Global/team/personal environment hierarchy.
- Environment inheritance and overrides.
- Environment object combining variables, files, skills, MCPs, hooks, and pools.
- Start hooks.
- Warm hooks.
- Workspace pools.
- Personal environments for private tokens/agent-specific config.
- Wizard onboarding: Repository -> Agent -> Workspace -> Integrations -> Team.
- Source-control trigger education for GitHub/GitLab mentions and automatic CI failure handling.
- Organization/user Coding Agents page.
- Harness-specific auth choices: Claude Code account, Anthropic key, Bedrock, Codex account, OpenAI key, Cursor key/model allowlist, Opencode/OpenRouter.
- Workspace tabs: Chat, History, Create PR.
- Workspace-level Build/Fast/Goal/progress controls.
- Canvas area populated from `~/.replicas/canvas/`.
- Automation template gallery focused on code quality and security.
- X/5 PR review score automation.
- DRY/code duplication check automation.
- React `useEffect` check automation.
- TypeScript casting check automation.
- Daily security review with Slack severity routing.
- Automation billing explained per active workspace minute.
- Global search across pages, workspaces, automations, environments.
- Workspace wake state gating changes/file browsing.

## Features Cycloid has that Replicas did not clearly show

- Jira support is documented in Cycloid; Replicas onboarding showed Linear, Slack, GitHub/GitLab source control, but not Jira.
- Cycloid's PR-as-user/control-plane credential model is a core repo invariant; Replicas is known from `competition.md` to have PR-as-user, but the inspected UI did not expose its full credential boundary.
- Cycloid has explicit QA verification child sessions and PR evidence state.
- Cycloid's FSM-backed review/merge-ready lifecycle is more explicit in code/docs than Replicas' observed UI.

## Product takeaways

Replicas' central insight is that environment is the product object. Their UI makes the setup substrate visible and reusable:

- environments group workspaces
- environments have hooks, vars, files, skills, MCPs
- environments can be global, team, or personal
- automations and workspaces run inside those environments

Cycloid should consider whether repo sandbox settings, secrets, MCP servers, skills, and memory are too fragmented. A unified "environment" page/object could make our existing capabilities easier to understand and reuse.
