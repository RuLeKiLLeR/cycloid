# Frontend UX direction from competitor review

Design-language and page-composition brief from the July 6 competitor review. Evidence sources: saved `~/Downloads/competitor research.pdf`, live logged-in tabs for Devin/Capy/Replicas/Niteshift/Factory, and the companion teardowns in this directory. This file is about how the app should feel and be organized. Functional parity items live in [2026-07-06-parity-build-backlog.md](2026-07-06-parity-build-backlog.md).

## North star

Cycloid should feel like a calm professional control room for async engineering work. The best reference is a blend of **Devin's clean product hierarchy** and **Capy's project cockpit**, with selective use of **Niteshift's workbench** only where the artifact density is truly useful.

The app should not feel like a chat app with settings bolted on. It should feel like a durable workspace where every background agent run has a place, every artifact has a home, and every status answers "what is happening, what changed, what should I do next?"

## Design language

### Overall feel

Target a quiet, dense, engineering-native product:

- Neutral surfaces, small type, crisp borders, restrained status color.
- More like Linear/Devin/Capy than a marketing dashboard.
- Less full-page card stacking; more persistent shell, tables/lists, split panes, tabbed detail panels, and compact status rows.
- No decorative gradients, oversized hero sections, or illustrative empty states inside authenticated product surfaces.
- Let the product's real artifacts carry the page: prompts, repos, PRs, diffs, checks, logs, context files, verification reports.

This fits the existing Cycloid design contract in [DESIGN.md](../../DESIGN.md): use the `surface-0` to `surface-3` ladder, tokenized typography, sentence-case copy, restrained radii, and named focus/control utilities.

### Visual hierarchy

Use three persistent layers:

1. **Global workspace shell:** sidebar, workspace switcher, primary nav, create action.
2. **Object list or object nav:** sessions, PRs, automations, repos, context files, activity events.
3. **Object detail:** the active session/PR/automation/context page.

The current app should move toward competitor hierarchy:

- Devin: broad top-level product areas are easy to scan.
- Capy: project nav makes Threads, PRs, Automations, Context, and Explore feel like real objects.
- Runtime: Build/Observe/Govern/Manage grouping is useful for admin-heavy areas.
- Niteshift: task detail uses a strong left/middle/right workbench when live work needs inspection.

Avoid putting major workflows under Settings. If a user checks it weekly, it gets a nav item or a project-level tab.

### Density

Competitors are dense without feeling messy because they reserve large whitespace for the transcript and use compact rows everywhere else.

Cycloid should use:

- 12-14px metadata and labels.
- 15-16px primary row titles.
- Compact row heights for lists: sessions, PRs, automations, activity.
- Tab bars and segmented controls instead of separate pages for closely related views.
- Sticky local headers for detail pages.
- Stable widths for sidebars and right panels so streaming content does not reflow the page.

Do not use hero-scale type inside the product. The strongest competitor screens mostly use small, utilitarian headings and let state/artifacts create importance.

### Surface model

Use a flatter surface model than the current "card everywhere" instinct:

- Page background: `surface-0`.
- Primary panes: `surface-1` or transparent with borders.
- Selected/hover rows: `surface-2`.
- Active tabs/selected nav: `surface-2` or `surface-3`.
- Cards only for repeated templates, modal content, stat tiles, and discrete artifact blocks.

Capy and Devin feel sleek because their pages are not a stack of equal-weight cards. They use persistent structure, thin dividers, rows, tabs, and small status chips.

### Status language

Make status precise and calm:

- Use small colored dots and chips, not loud banners, for routine status.
- Reserve warning/error color for action-required states.
- Status labels should be verbs or concrete nouns: `Planning`, `Running`, `Waiting for input`, `Verifying`, `PR open`, `Checks failing`.
- Pair agent states with the next user action when relevant: `Waiting for input` plus the question; `Checks failing` plus `Review failure`; `Ready for review` plus `Open PR`.

Capy's granular state tracking and Devin's phase visibility are the references here.

## App shell

### Global sidebar

Use a persistent left sidebar with:

- Workspace/business switcher.
- Primary create button: `New session`.
- Global search / Cmd-K entry.
- Product nav grouped by job:
  - **Work:** Home, Sessions, PRs, Automations.
  - **Knowledge:** Context, Repos, Templates.
  - **Observe:** Activity, Reports.
  - **Manage:** Integrations, Members, Settings.

Why: Devin makes major product areas visible. Capy makes project-level work objects visible. Runtime's Build/Observe/Govern/Manage split is useful, but Cycloid should use plainer labels that match engineering workflows.

### Secondary project/repo nav

Inside a project or repo, use a second nav row or sidebar section:

- Overview
- Sessions
- PRs
- Automations
- Context
- Environment
- Activity
- Settings

This copies Capy's strongest organization: a project is not just settings plus session history. It is a place where work, PRs, automation, and context live together.

### Header pattern

Every major page should have a compact sticky header:

- Object title and repo/project metadata.
- Current status chip.
- Primary action.
- Secondary actions in an overflow menu.
- Optional tabs directly below.

Avoid tall page headers. Devin and Capy mostly keep the chrome compact so the work content starts high on the page.

## Home / dashboard

### Desired layout

Home should be an operational start page, not a marketing surface:

- Top row: compact composer with Ask / Plan / Build mode switch.
- Left/main: active sessions grouped by status and recency.
- Right rail: setup checklist, recently touched repos, failed/needs-input items.
- Bottom or secondary section: automation health and recent PRs.

### What to borrow

From Devin:

- "Get started" should be prominent when setup is incomplete.
- New-session entry is obvious and centered without hiding other product areas.
- Ask vs Agent mode should be visible at creation time.

From Capy:

- Suggested prompt chips should be practical and repo-aware.
- Thread/session filters should be reachable without leaving the dashboard.
- Idle/running/waiting groupings should make the user's queue obvious.

### Design notes

- The composer should be a real work surface, not a chat bubble floating in empty space.
- Use compact suggested actions under the composer.
- Keep setup guidance in a right rail or inline checklist, not in a modal.
- Empty states should show concrete actions: connect repo, start first session, connect Slack/Jira/Linear.

## Session view

### Core layout

Use a three-zone layout:

1. **Left context rail:** session title, repo/branch, status, phase timeline, related PR, owner/source, child/verification runs.
2. **Center transcript:** user prompts, agent reasoning summaries, tool-call groups, questions, final report.
3. **Right artifact panel:** tabs for Changes, PR, Verification, Preview/Browser, Logs, Context.

This is the most important frontend shift. Devin's session view proves that artifacts need to be adjacent to the transcript. Niteshift proves a right-side workbench is the clearest way to inspect live work. Capy proves granular state/todo tracking makes the agent feel legible.

### Left rail

The left rail should answer "where am I and what phase is this in?"

Include:

- Session title with editable title action.
- Repo, base branch, head branch.
- Source: UI, Slack, Jira, Linear, GitHub, API, automation.
- Status chip and elapsed time.
- Phase timeline: Created, Planning, Building, Verifying, Publishing, Review loop, Done.
- PR card if one exists.
- Related sessions: verifier, review-loop runs, follow-ups.

Keep it narrow and stable. Do not put large prose here.

### Center transcript

The transcript should be calmer and more structured:

- User prompts are compact, with source metadata.
- Agent reasoning is summarized in collapsible groups, not a wall of text.
- Tool calls are grouped by phase and displayed as rows with icon, command/file, duration, status.
- Questions are visually distinct and sticky enough not to be missed.
- The composer stays pinned at the bottom while active.
- Final output becomes a report block, not just the last assistant message.

Capy's "agent asks questions" and todo list behavior should be reflected in the UI. When Cycloid needs input, the question should look like a first-class blocking state.

### Right artifact panel

The right panel should be tabbed, with each tab optimized for scanning:

- **Changes:** file tree, diff summary, changed since last viewed, additions/deletions, generated/renamed/deleted markers.
- **PR:** title, branch, draft/ready, checks, reviewers, comments, merge state, PR-as-user identity.
- **Verification:** command list, pass/fail, runtime, artifacts, screenshots, final evidence.
- **Preview/Browser:** live preview when available, screenshot history otherwise.
- **Logs:** runtime/setup/app logs, filter by source.
- **Context:** instructions, env, MCPs, skills, secrets used in this session.

Default tab logic:

- While running: show the tab with the newest meaningful artifact.
- On failure: show Verification or Logs.
- On PR creation: show PR.
- On completion: show final report with Changes and Verification available.

### Mobile session view

On mobile, collapse to:

- Sticky session header.
- Transcript as the default tab.
- Bottom tab bar for Transcript, Changes, PR, Verification, More.
- Artifact panels full-screen when selected.

Do not try to preserve the desktop three-pane layout on mobile.

## Sessions list

### Desired layout

Sessions should look closer to Capy's thread dashboard and Devin's recent sessions:

- Filters at top: All, Mine, Running, Waiting, Failed, PR open, Done.
- Search and repo filter.
- Grouping by status: Needs attention, Running, Recently completed.
- Rows with title, repo, source, status, phase, owner, age, PR/check summary.

### Row design

Each row should be one scan unit:

- Left: status dot, title, short prompt snippet.
- Middle: repo/source/model/phase metadata.
- Right: PR/check chips, age, owner/avatar.

Avoid large cards for every session. Dense rows are faster to compare and match competitor patterns.

## PRs / Review page

### Desired layout

Borrow from Devin Review and Capy PRs:

- Left list or full table of PRs.
- Buckets: Needs attention, Draft, Open, Approved, Checks failing, Closed.
- PR detail panel with diff/review/checks when selected.
- Top action: paste PR URL / review a PR.

### Design language

This page should look like an inbox:

- Compact rows.
- Strong status chips.
- Quick filters.
- Split-view detail for review.
- Clear owner and credential identity.

Do not make review feel like a settings workflow. Devin wins here because Review is a product area.

## Context and Environment pages

### Context page

Use Capy as the strongest reference.

Layout:

- Left: context sources list.
- Center: selected source content or summary.
- Right: precedence, scope, last updated, sessions using it.

Sources:

- AGENTS.md / CLAUDE.md / repo instructions.
- Cycloid project instructions.
- Review/build instructions.
- Skills.
- MCP servers.
- Secrets and env vars as redacted entries.
- Setup scripts/hooks.

Visual treatment:

- Use file-like rows, precedence badges, and scope chips.
- Show read-only previews first.
- Mark missing, stale, conflicting, or overridden context with subtle warnings.

### Environment page

Use Replicas and Niteshift as references.

Layout:

- Summary strip: setup health, preview ports, last successful verification, connected integrations.
- Tabs: Variables, Files, Skills, MCP, Setup script, Preview, Auth, Networking.
- Change history side panel or footer.

The page should make execution setup feel inspectable and repairable.

## Automations page

### Desired layout

Borrow from Devin templates, Capy marketplace, Replicas automation list, and Niteshift health metrics.

Page structure:

- Header with `New automation`.
- Metrics strip: enabled, fires last 24h, failures, next scheduled.
- Template gallery as compact cards.
- Existing automations table.
- Run history drawer/detail panel.

Template card structure:

- Icon.
- Name.
- One-line job.
- Trigger type chips.
- Required integrations.
- Last-run/usage signal when installed.

Installed automation row:

- Status, name, trigger, repo/project, owner, last run, failure count, next run, actions.

Design rule: templates can be cards; installed automations should be rows/tables.

## Activity page

### Desired layout

Runtime is the reference.

Page structure:

- Personal/team toggle.
- Metric strip: sessions, PRs, verification pass rate, cost/tokens if available.
- Heatmap or line chart.
- Source breakdown: UI, Slack, Jira, Linear, GitHub, API, automation.
- Event stream table.

Use restrained charts. This should feel like engineering operations, not an analytics product.

## Onboarding and setup

### Desired flow

Use a persistent checklist, not a wizard that traps experienced users.

Checklist:

- Connect GitHub.
- Pick repo.
- Confirm PR identity.
- Detect setup.
- Run first verification.
- Connect Slack/Jira/Linear.
- Create first automation.

Use Niteshift's onboarding-agent idea selectively:

- Show repo analysis as a running setup session.
- Surface detected framework, package manager, dev command, test command, preview port.
- Ask for confirmation before writing setup config.

Use Devin's home-page setup treatment:

- Incomplete setup should be visible from Home.
- Completed setup should disappear into a compact health indicator.

## Navigation and command palette

Capy and Niteshift both show that dense products need fast command/search.

Cmd-K should include:

- Navigate: Sessions, PRs, Automations, Context, Activity, Settings.
- Search: session title/prompt, repo, PR, automation.
- Actions: new session, review PR, create automation, connect integration, invite member.
- Recent objects.

Design:

- Centered modal.
- 40px input.
- Grouped results.
- Icons and keyboard hints.
- No marketing copy.

## Visual components to standardize

### Object rows

Standard row anatomy:

- Status dot/chip.
- Primary title.
- Secondary metadata line.
- Right-side artifact chips.
- Time/owner.

Use for sessions, PRs, automations, context sources, activity events.

### Artifact chips

Small chips for:

- `PR open`
- `Checks passing`
- `Checks failing`
- `Verified`
- `Needs input`
- `Slack`
- `Jira`
- `Linear`
- `Automation`
- model/backend

Keep chips compact and semantic. Avoid turning every metadata field into a pill.

### Phase timeline

Use a vertical compact timeline in session detail and a horizontal compact version in rows/details:

- Created
- Planned
- Built
- Verified
- Published
- Reviewed

Show skipped/failed/current states clearly.

### Tool-call groups

Group tool calls by phase:

- Planning
- Editing
- Testing
- Publishing
- Review loop

Rows should show command/file/action, status, duration, and expandable details.

### Empty states

Empty states should be operational:

- One sentence max.
- Primary action.
- Optional secondary action.
- No large illustrations.

Examples:

- Sessions: "No sessions yet." -> `Start a session`.
- PRs: "No PRs need attention." -> `Review a PR`.
- Context: "No project instructions found." -> `Add instructions`.

## What not to copy

- Do not copy Niteshift's full IDE-first density as the default. It is useful for workbench tabs, but Cycloid's main job is async delegation.
- Do not copy Replicas' broad BYO-agent complexity into the primary flow. It is powerful but can feel unfocused.
- Do not copy Runtime's generic platform language. Cycloid should stay coding-agent specific.
- Do not let settings become the main product surface. Competitors win by promoting core objects to nav.
- Do not overuse cards. Devin and Capy feel polished because they use lists, tabs, and panes for operational surfaces.

## Page-by-page target IA

### Global

- Home
- Sessions
- PRs / Review
- Automations
- Context
- Activity
- Repos / Projects
- Integrations
- Settings

### Project / repo

- Overview
- Sessions
- PRs
- Automations
- Context
- Environment
- Activity
- Settings

### Session

- Overview header
- Phase/timeline rail
- Transcript
- Artifact panel: Changes, PR, Verification, Preview/Browser, Logs, Context
- Final report

## Design implementation notes

- Use existing token classes from `apps/ui/src/App.css`; do not introduce a new palette.
- Keep authenticated UI in the existing Cycloid dark/light neutral system.
- Use sentence case for all labels.
- Prefer icons for repeated actions and tool tabs, with tooltips.
- Use tables/lists for operational objects and cards for templates/stat tiles only.
- Keep card radius within the existing scale except for existing session-stack surfaces.
- Make panes `contain-strict` where streaming updates could reflow neighbors.
- Make text fit at mobile widths; truncate metadata before wrapping primary titles into messy rows.
- Build mobile layouts as tabbed single-column surfaces, not squeezed desktop panes.

## Success bar

The redesign is working when:

- A new user can tell where to start from Home without opening Settings.
- A returning user can scan all live work in under ten seconds.
- A session page shows what changed, what verified, and what needs attention without reading the entire transcript.
- Project context and setup are inspectable from a named page.
- Automations and PR review feel like first-class workflows.
- The UI feels calm, dense, and serious in the same way Devin and Capy do, while staying unmistakably Cycloid.
