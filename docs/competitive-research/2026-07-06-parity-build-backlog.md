# Parity build backlog from competitor UX

Detailed functionality backlog from the July 6 competitor review. Evidence sources: saved `~/Downloads/competitor research.pdf`, live logged-in tabs for Devin/Capy/Replicas/Niteshift/Factory, and the companion teardowns in this directory. This file is about what to build for parity. The frontend design-language companion is [2026-07-06-ux-improvements-to-match-competitors.md](2026-07-06-ux-improvements-to-match-competitors.md).

## Goal

Make Cycloid feel like the strongest async coding-agent control plane, not just a session transcript. The product should show what the agent knows, what it is doing, how to steer it, how it verifies work, and how teams govern it.

## Highest-leverage gaps

### 1. Build an agent cockpit for every session

Competitors: Niteshift, Devin, Replicas, Capy.

Current gap: our session surface does not make enough of the running work inspectable. Users need to leave Cycloid or infer from transcript text.

Needed UX:

- Keep the transcript, but add right-side tabs for **Changes**, **PR**, **Verification**, **Preview/Browser**, **Terminal/Logs**, and **Context**.
- Make **Changes** a first-class diff viewer with grouped changed files, additions/deletions, commit/branch metadata, and "what changed since last check" summaries.
- Make **PR** show title, number, base/head branch, draft/ready state, checks, reviewers, unresolved comments, and merge-readiness.
- Make **Verification** show commands run, pass/fail status, artifacts, screenshots, and a final evidence report.
- Make **Preview/Browser** available for apps with exposed ports: reload, port selector, path field, open external, copy URL, fullscreen, and screenshot capture.
- Make **Terminal/Logs** available as read-only by default, with a clear escalation path for interactive access later.
- Keep these panels stable during streaming so users can watch without layout shifts.

Why it matters: Niteshift's task view is the clearest proof that users expect to inspect the workbench while the agent runs. Devin shows the same pattern through Worklog/Changes/PR/test-report/Desktop.

Smallest useful version:

- Add `Changes`, `PR`, and `Verification` tabs first.
- Add `Preview/Browser` only when a session has a detected port or browser artifact.
- Add `Terminal/Logs` as read-only streaming logs before interactive terminal.

### 2. Separate Ask, Plan, and Build

Competitors: Devin, Factory, Capy.

Current gap: task creation pushes users into one generic prompt path. That makes low-stakes questions, planning, and actual repo edits feel the same.

Needed UX:

- Add composer modes: **Ask**, **Plan**, **Build**.
- Ask: answers questions with no code changes and no PR.
- Plan: produces a task plan, expected files, risks, and verification steps; user can start Build from it.
- Build: starts the full Cycloid async session.
- Add visible defaults for model/reasoning only where users need them, not as an always-visible wall of controls.
- Let sessions transition from Ask -> Plan -> Build while preserving context.

Why it matters: Devin's Agent/Ask split reduces prompt anxiety. Factory's Mission planning state makes orchestration visible before execution. Capy makes clarification and todo creation part of the product.

Smallest useful version:

- Implement mode labels and backend-safe routing for Ask vs Build.
- Add Plan as a structured preflight output before adding any new workflow engine.

### 3. Add a Mission view for multi-step or high-risk work

Competitors: Factory, Capy, Devin.

Current gap: Cycloid already performs planning, execution, and verification, but the UI does not present those as clear roles or phases.

Needed UX:

- Add a **Mission** layout for complex sessions with phases: Clarify, Plan, Build, Verify, Publish, Review.
- Show role cards: **Planner**, **Builder**, **Verifier**. Do not imply separate agents unless they actually are separate runtimes.
- Show model/backend used per role when applicable.
- Show a checklist/todo list that updates as work proceeds.
- Surface required clarifying questions as a blocking step with answer choices when possible.
- Show mission-level counters: elapsed time, tokens/compute if available, changed files, verification commands, PR status.

Why it matters: Factory's Mission Control explains orchestration at a glance. It makes validation feel designed into the workflow.

Smallest useful version:

- Add phase/checklist UI to existing sessions.
- Label verification as a distinct role even if it uses the same session machinery.

### 4. Make Context and Environments visible objects

Competitors: Capy, Replicas, Niteshift, Devin, Runtime.

Current gap: Cycloid has important repo, credential, MCP, instruction, and setup state, but much of it is either implicit, buried, or spread across settings.

Needed UX:

- Add a top-level **Context** page per project/repo.
- Show instruction files and precedence: AGENTS.md, CLAUDE.md, custom project instructions, review/build instructions.
- Show connected MCP servers, skills, integrations, secrets, environment variables, and setup hooks.
- Show which context was injected into a given session.
- Add an **Environment** object for reusable repo execution config: env vars, files, skills, MCPs, setup script, warm/pool status, preview ports, auth requirements.
- Support scopes where useful: personal, team, project/repo.
- Add diff/history for context changes so teams can understand why agent behavior changed.

Why it matters: Capy's Context page and Replicas' Environments make invisible agent inputs visible. Niteshift's repo settings prove users need setup, preview, networking, MCP, database, and auth controls close to the repo.

Smallest useful version:

- Start with read-only context inspection per project/session.
- Then add editable project instructions and MCP/secret visibility with server-side enforcement.

### 5. Improve automations from "configured trigger" to product area

Competitors: Devin, Capy, Replicas, Niteshift, Runtime.

Current gap: automations need stronger creation, templates, observability, and failure handling.

Needed UX:

- Add a top-level **Automations** page.
- Offer templates: CI failure fixer, review-comment fixer, daily security review, stale PR cleanup, dependency health, crash/incident triage, documentation sync, no-unused-code check.
- Separate automation types: **Ambient** (watches a source), **Scheduled**, **Webhook**, **Slack**, **Manual replay**.
- Add natural-language automation creation with a structured preview before enabling.
- Show health metrics: enabled count, fires last 24h/7d, failures, last run, next run, average duration.
- Show run history with session links, PR links, failure reason, retry action, and owner.
- Add filters: All, Mine, Failing, Disabled, Needs setup.

Why it matters: Devin and Capy make automations discoverable through templates. Niteshift makes operations visible through health metrics. Runtime's Activity view shows session sources and usage.

Smallest useful version:

- Add template gallery and run history first.
- Add metrics once run events are reliable enough to aggregate.

### 6. Add PR and Review as first-class workflows

Competitors: Devin, Capy, Niteshift.

Current gap: PR state appears through sessions, but users also need a cross-session PR inbox and a review-specific workflow.

Needed UX:

- Add **PRs** or **Review** top-level page.
- Buckets: New/Open, Draft, Needs review, Approved, Changes requested, Checks failing, Closed.
- Rows should show repo, PR title/number, base/head, author, session, age, checks, reviewers, deltas.
- Add PR URL intake for asking Cycloid to review or fix a PR.
- Add review trigger policies: manual, ready-for-review, auto on owned PRs, auto on requested review.
- Add reviewer comment inbox with "ask Cycloid to address" action.
- Show PR-as-user identity and credential posture clearly.

Why it matters: Devin has a real review product. Capy has a PR inbox with status buckets. Niteshift's Git panel keeps PR context beside work.

Smallest useful version:

- Build read-only PR inbox from existing session/PR records.
- Add PR URL review intake after the inbox exists.

### 7. Add Activity, usage, and governance pages

Competitors: Runtime, Capy, Devin, Replicas.

Current gap: team owners need to see usage, cost, sources, members, audit events, and access posture without asking engineering.

Needed UX:

- Add **Activity** with personal/team filters.
- Summary cards: sessions, prompts/tasks, cost/credits, tokens/compute, PRs opened, verification pass rate.
- Heatmap and line/bar chart modes over 30d/90d/1y.
- Session sources: UI, Slack, API, GitHub, Linear, Jira, automation.
- Cost analytics: total, average per session, average per successful PR, plan/credit usage.
- Token/compute usage by model/backend when available.
- Add governance pages for members, roles, service users, audit log, API tokens, integration access, model allowlists.
- Show fail-closed states clearly: missing repo access, disconnected integration, insufficient role, expired credential.

Why it matters: Runtime's Activity page and Capy's org settings make governance feel built-in. This matters for teams deciding whether to trust background agents.

Smallest useful version:

- Add Activity with session/source counts and recent events.
- Add cost/token once accounting is reliable.

### 8. Make onboarding mandatory enough to produce a working first repo

Competitors: Replicas, Runtime, Devin, Niteshift.

Current gap: too much setup relies on users knowing which settings matter before their first useful session.

Needed UX:

- Add first-run checklist: connect GitHub, choose repo, confirm PR identity, configure runtime/setup, connect Slack/Linear/Jira, run first verification session.
- Add repo onboarding agent: inspect repo, detect package manager/framework, detect dev command/test command, detect preview port, propose setup script.
- Add integration-specific paths: Slack agent, Jira issue agent, GitHub PR review agent, automation agent.
- Show progress and allow skipping only when the skip is safe.
- Save successful setup as the default Environment for that repo.

Why it matters: Replicas and Runtime force activation steps. Niteshift's onboarding agent turns setup into visible work. Devin puts get-started guidance on home.

Smallest useful version:

- Add checklist and repo setup inspection.
- Defer full onboarding agent until we can safely apply detected config.

### 9. Add command palette and global search

Competitors: Capy, Niteshift.

Current gap: as Cycloid grows, navigation through sidebars/settings will get slower.

Needed UX:

- Global Cmd-K for sessions, repos, PRs, automations, settings, docs, integrations, and actions.
- Actions: new session, create automation, connect integration, open project context, invite member, open latest PR, retry failed session.
- Search filters: repo, status, source, owner, date, automation, PR state.

Why it matters: Capy's Cmd-K dashboard and Niteshift's search make dense products usable.

Smallest useful version:

- Add static command palette entries plus session/repo search.
- Add action execution after navigation search is stable.

### 10. Show final summaries as durable reports

Competitors: Capy, Devin, Niteshift.

Current gap: final session output is not enough if the user wants to share, audit, or compare work.

Needed UX:

- Generate a final report per session: request, plan, files changed, tests run, verification evidence, PR link, unresolved risks, follow-ups.
- Include screenshots/browser artifacts when generated.
- Make report copyable and linkable.
- Show "what to review" separately from raw logs.
- Preserve report after PR merge/close.

Why it matters: Capy gives completion summaries; Devin gives verification reports; Niteshift keeps logs and git context available.

Smallest useful version:

- Turn existing final messages and verification records into a structured report page.

## Priority order

### Now

1. Session cockpit tabs: Changes, PR, Verification.
2. Top-level Context page in read-only form.
3. First-run repo checklist.
4. Automation template gallery plus run history.
5. Final session report.

These are the best near-term moves because they expose strengths Cycloid already has instead of requiring a new product thesis.

### Next

1. Ask/Plan/Build composer modes.
2. PR/Review inbox.
3. Activity page with source and session metrics.
4. Environment object for setup/context.
5. Command palette.

These create stronger product structure and navigation once the core cockpit is clearer.

### Later

1. Live preview/browser workbench.
2. Read-only terminal/logs, then interactive terminal if justified.
3. Mission view with planner/builder/verifier role cards.
4. Natural-language automation builder.
5. Governance suite: audit log, service users, role/model allowlists, access-control reports.

These are valuable, but each adds more surface area or depends on cleaner underlying data.

## Competitive parity checklist

- Devin parity: Ask vs Agent, Review inbox, Changes, test report, environment setup suggestions, automation templates, security/wiki surfaces.
- Capy parity: Context page, PR inbox, folders/recents, command palette, clarification/todo UX, automation marketplace.
- Replicas parity: onboarding wizard, Environment object, harness/account settings, workspace changes/tool-call UI, automation templates.
- Niteshift parity: task workbench, preview, git, IDE/terminal/logs, onboarding agent, automation health, repo setup/settings.
- Factory parity: Mission orchestration, role cards, clarifying questions, progress/usage counters.
- Runtime parity: Quickstart, agent templates, Slack-agent creation, Activity page, cost/token/session-source analytics, access controls.

## Product principles

- Keep Cycloid async-first. Do not turn the app into an IDE by default.
- Expose evidence before adding control. Read-only Changes/PR/Verification beats a fragile interactive terminal.
- Make trust visible: PR-as-user, credential scope, repo access, verification, and fail-closed states should be obvious.
- Prefer repo/project-level primitives over global settings when the setting changes agent behavior.
- Use templates to teach capabilities, then let power users customize.
- Do not hide core workflows in Settings. If users run it every week, it deserves a top-level surface.
