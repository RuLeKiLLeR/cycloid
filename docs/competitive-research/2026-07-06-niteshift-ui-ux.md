# Niteshift UI/UX teardown

Observed July 6, 2026 from the authenticated Niteshift app on repo `gunn3rforlife/excalidraw`, including a completed task, Automations, and Settings.

## Cycloid baseline

Cycloid's current UI centers on a session transcript and PR state. The user can follow streamed events, answer questions, attach files/images, view artifacts/screenshots, trigger QA verification, and send follow-up prompts. Product configuration lives under Settings. The session detail does not yet behave like a full browser IDE or cloud workstation.

Niteshift is organized as a task workbench. It keeps the transcript, but it also places a live preview, git panel, IDE, terminal, and logs beside the conversation.

## Information architecture

Niteshift left nav:

- Command Palette
- Search tasks
- Automations
- Settings
- Tasks
- Recent tasks grouped by repo
- New task
- Account menu

The current task page has:

- Center transcript.
- Bottom composer/control row.
- Right sidebar workbench with tabs:
  - Preview
  - Git
  - IDE
  - Terminal
  - Logs

Cycloid's session page is transcript-first. Niteshift's task page is transcript-plus-workbench. This is the most important UX difference.

## Command palette and search

Niteshift keeps a command palette/search affordance visible:

- "Command Palette"
- "Search for a command to run..."
- Task search input.

Cycloid has keyboard shortcuts and sidebar filtering, but no global command palette. Niteshift's shell feels more like an IDE because command invocation is a top-level concept.

## Task list

Observed task sidebar:

- Recent tasks grouped under `excalidraw`.
- Draft PR indicator/icon on task row.
- Onboarding setup task.
- Task action buttons.
- Search tasks.
- New task.

Cycloid has a session list, but Niteshift rows expose richer task affordances in-place, including draft PR indicators and per-task action controls.

## Task transcript

Observed completed task:

- Tool calls are rendered as expandable cards with labels:
  - Run command
  - Github.create pull request
- Tool-call durations appear inline: `208 ms`, `1.3 s`, `256 ms`.
- Transcript explains fallback decisions:
  - connector could not create PR due to permissions
  - falling back to `gh pr create`
- Final summary includes file links with line numbers, validation commands, branch, commit, and draft PR URL.
- Task header shows PR number, base branch, head branch, and `Autofix`.

Cycloid also renders tool events/transcript, but Niteshift's inline command cards and durations are very compact and operational. Cycloid's transcript is more narrative and event-log oriented.

## Composer and model controls

Observed composer/control row:

- File upload.
- Contenteditable message box.
- More actions.
- Browser tools.
- Send button.
- Model selector: `GPT-5.5`.
- Reasoning selector: `Extra High`.
- Fast mode toggle.
- Tool-call collapse toggle.

Cycloid has model/reasoning selection at session creation and prompt form reasoning controls, but Niteshift keeps model/reasoning/fast/tool-collapse controls attached to the task workbench at all times.

## Preview panel

Niteshift Preview panel includes:

- Reload preview.
- App label/port: `app :3001`.
- Editable preview path (`/`).
- Element selection mode.
- Local/Agent toggle.
- Open in new tab.
- Copy preview URL.
- Full screen.
- Live iframe rendering the app.
- Device viewport selector.

Cycloid currently lacks this dedicated live app preview workbench in the product UI. The current local branch has a `SessionLiveComputerPanel` file, but the stable product baseline is still not at Niteshift's right-panel depth: path editing, local/agent toggle, element selection, device viewport, logs, IDE, terminal, and preview all in one place.

This is Niteshift's biggest UX advantage.

## Git panel

Niteshift Git panel shows:

- Pull request title.
- PR number.
- Draft state.
- Base branch.
- Head branch.
- Commit count.
- Changed files count.
- Expand all.
- Per-file status and line deltas.

Cycloid has a PR section, but not an embedded Git/file-change panel beside the transcript. Our PR state is lifecycle-oriented; Niteshift's is code-review/workbench-oriented.

## IDE panel

Observed IDE panel:

- Tab exists as first-class workbench panel.
- Shows workspace root `/root/excalidraw`.

The text extraction did not expose a full editor tree, so the only hard claim is that an IDE panel exists and is tied to the workspace root. Existing competition docs also flag Niteshift's in-browser IDE as a known strength.

Cycloid does not have an in-browser IDE surface in the current product baseline.

## Terminal panel

Observed Terminal panel:

- Tab exists as first-class workbench panel.
- Shows `Connected`.

This is a direct feature gap. Cycloid streams command output as transcript events, but users cannot attach to a live terminal inside the session.

## Logs panel

Observed Logs panel:

- Timestamped app logs.
- Setup logs:
  - Excalidraw setup starting.
  - Node/Yarn versions.
  - dependencies already present.
  - Vite dev server starting on port 3001.
- Vite readiness:
  - local URL
  - network URL
- Warnings:
  - Browserslist stale data.
  - TypeScript ESLint supported version warning.
- TypeScript/watch output.
- Vite reload events.

Cycloid has transcript events and sometimes artifacts/log output, but no dedicated live app logs panel attached to the preview server.

## Automations

Niteshift Automations page:

- "Wire Slack, schedules, and webhooks to a single agent action."
- New automation CTA.
- Metrics:
  - automations count
  - fires last 24h
  - fires last 7d
  - failed last 7d
- Filters:
  - All
  - Mine
- Empty state:
  - Slack channel
  - HTTP webhook
  - recurring schedule
  - combine sources on a single automation to chain workflows

Cycloid automations are under Settings and do not currently show operational metrics on the automation page. Niteshift's automation UX is closer to an ops dashboard.

## Settings

Niteshift settings are split into account and repository sections.

Observed account sections:

- GitHub
- Models
- Integrations
- Preferences

Observed repository sections:

- Sandbox
- Setup Script
- Environment
- Preview Ports
- Configuration
- Custom Instructions
- Preview Auth
- Plugins
- Networking
- MCP Servers
- AWS
- Database
- Static IP Proxy

Observed settings content:

- Source control:
  - GitHub connected to `gunn3rforlife`
  - user connection
  - repository count
  - connected date
  - manage action
- Commit signing setup.
- AI Models:
  - Claude connect
  - Codex connected via ChatGPT
  - Cursor connect
- Default model:
  - `GPT-5.5 · extra high`
- Integrations:
  - Slack
  - Linear
  - Graphite token
- Preferences:
  - Pull Requests: Draft
  - Autofix
  - failing CI
  - review comments by bots
  - review comments by you
  - review comments by other reviewers
  - auto-archive merged/closed tasks
  - desktop notifications
  - task orchestration via built-in Niteshift MCP server
  - custom instructions

Cycloid has many matching backend concepts - integrations, MCP, sandbox settings, repo secrets, scheduled/alert automations - but Niteshift exposes more repo-level infrastructure in one place: preview auth, preview ports, networking, AWS, database, static IP proxy.

## Features Niteshift has that Cycloid does not

- Command palette as a primary shell feature.
- Split transcript/workbench layout.
- Live preview panel.
- Preview path editing.
- Local vs agent preview toggle.
- Element selection mode in preview.
- Device viewport selector.
- Open/copy/fullscreen preview URL controls.
- Embedded Git panel with PR state and changed files.
- In-browser IDE panel.
- Connected terminal panel.
- Dedicated runtime logs panel.
- Model, reasoning, fast-mode, and tool-collapse controls always visible on the task page.
- Browser tools button in composer.
- Draft PR indicator and PR metadata tightly integrated into task header.
- Repo-level preview ports settings.
- Repo-level preview auth settings.
- Repo-level networking settings.
- AWS integration settings.
- Database settings.
- Static IP proxy settings.
- Graphite integration in settings.
- Autofix controls split by event source:
  - failing CI
  - bot review comments
  - user review comments
  - other reviewer comments
- Auto-archive on PR merge/close.
- Task orchestration through a built-in Niteshift MCP server.
- Automations metrics for fires/failures by time window.
- Combining Slack, schedule, and webhook sources into one automation.

## Features Cycloid has that Niteshift did not clearly show

- PR-as-user is a first-class Cycloid invariant. Niteshift's observed task created a draft PR, but prior repo notes say PR-as-user posture was not verified and may be bot-authored in some cases.
- Jira support is documented in Cycloid; Niteshift settings showed Slack, Linear, Graphite, but not Jira.
- Cycloid's control-plane security boundary is explicit in repo docs.
- Cycloid has FSM-backed review/verification/merge-ready lifecycle state.
- Cycloid has QA verification child-session affordances tied to PR evidence.

## Product takeaways

Niteshift's strongest edge is interactive depth. It makes a background task feel inspectable and steerable:

- transcript for what happened
- preview for what changed
- git panel for changed files
- IDE for code inspection
- terminal for manual commands
- logs for runtime behavior

Cycloid should be careful before copying this wholesale because our core promise is async delegation with strong governance. But Niteshift sets a clear user expectation: serious coding-agent products increasingly include a live workbench, not only a transcript.
