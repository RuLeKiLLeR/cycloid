# Competitive Roadmap Proposals

Date: 2026-05-15

Larger Cycloid product bets based on `2026-05-15-agentic-engineering-landscape.md`, each checked against the source material and the actual codebase. Intentionally excludes already-supported items: basic GitHub intake, Linear intake, observability access, PR creation, session streaming, screenshot artifacts, control-plane authorization.

## Source Accuracy Review

Signals are directionally strong but need careful interpretation:

- Obvious Autobuild: clearest source for project hierarchy; docs explicitly describe initiative -> feature -> executable, where executables are atomic agent tasks usually producing PRs. Validates a project/work-graph roadmap item.
- Charlie Labs: clearest source for durable daemons; public pages and docs describe repo-defined daemons, event/schedule triggers, routines, and GitHub/Linear/Slack/Sentry event-driven runtime. Validates a watcher/recurring-agent roadmap item.
- WorkOS Horizon: internal system, not a purchasable competitor, but highly relevant; frames the bottleneck as orchestration, context, verification, and safe production delivery. Validates lifecycle-state and post-deploy roadmap items.
- Arga and AutoSana: validation layers, not full Cycloid replacements. Validate a direction around browser/mobile/preview evidence, API twins, generated tests, replay, logs, and PR checks — not that Cycloid must become a full QA company.
- Stilla: broader than engineering — workplace AI teammate, shared memory, broad integrations, Slack/Linear/GitHub/email mentions, meeting notes, skills, enterprise packaging. Lesson: packaging, memory, and cross-tool workflow breadth, not becoming a generic business automation suite.
- Augment Cosmos/Intent: signal coordinated multi-agent workspaces, living specs, review checkpoints, shared memory, domain experts. Claims are product/marketing heavy; treat as strategic pressure, not exact feature specs.
- HumanLayer/CodeLayer: mostly local desktop supervision. Lesson: inspection/checkpoint/fork UX, not per-tool approval as a core priority.
- Junior: Slack bot runtime with plugins for Sentry, Datadog, GitHub, Linear, Notion, Browser, and more. Lesson: plugin/runtime authority and Slack-native packaging, not that Cycloid lacks those integrations.

## Roadmap Bet 1: Project Work Graph

Build a first-class project layer above sessions: `Project -> Workstream -> Task -> Session -> PR -> Deploy`.

Why now:

- Obvious makes initiative/feature/executable a product object.
- WorkOS Horizon frames orchestration as the limiting factor.
- Augment Intent/Cosmos frames coordinated agents around living specs and shared workspaces.
- Cycloid already has sessions, parent/child lineage, Linear context, GitHub/Linear intake, and PR output, but lacks the product object that ties them into one delivery graph.

Core functionality:

- Create a project from a spec, Linear project, Linear issue set, GitHub issue set, document, or prompt.
- Generate a proposed work graph with task boundaries, dependencies, target repo, suggested owner, expected files/areas, verification requirements, and output type.
- Let a user edit and confirm the graph before any sandbox starts.
- Launch tasks individually or as a dependency-aware batch.
- Track each node through planned, queued, running, blocked, PR opened, review requested, changes requested, green, merged, deployed, verified.
- Support same-repo child sessions first; add cross-repo project nodes with explicit per-repo authorization later.
- Show a project dashboard: active tasks, blocked tasks, PR state, CI state, review state, deploy/verification state, and next eligible work.

Codebase fit:

- Builds on `session_index` parent/child metadata, Linear issue refs, GitHub webhook refs, session projection, and PR workflow.
- Needs new D1 tables for project/work nodes and dependency edges.
- Should keep route/service/DAO layering and fail-closed repo authorization per node.

MVP:

- Linear project or manually pasted spec -> generated task graph -> review/edit -> launch same-repo tasks.
- Show graph dashboard and session/PR linkage.
- No automatic cross-repo work until the same-repo graph is reliable.

Risk:

- Bad decomposition creates noise. The review/edit step is essential.
- Cross-repo task graphs can break auth and ownership assumptions if introduced too early.

## Roadmap Bet 2: Policy-Bound Watchers And Daemons

Add durable, customer-configurable watchers that turn recurring responsibilities into bounded Cycloid sessions.

Why now:

- Charlie explicitly positions daemons as the next layer after agents.
- Stilla and Viktor package recurring automations.
- WorkOS Horizon and Fiberplane emphasize lifecycle hooks and state-driven automation.
- Cycloid already has webhook intake, prompt enqueueing, repo authorization, integration credentials, and session projection.

Core functionality:

- Repo or UI-defined watcher manifest with `trigger`, `routine`, `scope`, `deny`, `budget`, `schedule`, and `evidence`.
- Trigger types: cron, GitHub PR opened/ready, CI failed, review changes requested, branch behind, Linear label/status/assignment/comment, Sentry issue regressed, Datadog monitor alert, docs changed.
- Built-in routines: stale PR helper, CI failure triage, requested-changes resolver, docs drift fixer, dependency update resolver, issue enrichment, production error clustering, post-deploy smoke.
- Dry-run mode: explain what would launch and why.
- Activation history: event payload summary, skipped/ran reason, policy decision, session link, cost, PR link, evidence.
- Business-level enablement and repo-level allowlists.

Codebase fit:

- Extends existing GitHub/Linear webhook handlers and session enqueueing.
- Can reuse first-party Datadog/Sentry/Linear/Slack tools.
- Needs a watcher policy service and D1 tables for definitions, activations, and dedupe keys.

MVP:

- `stale-pr-helper` and `ci-failure-triage` for Cycloid-created PRs only.
- GitHub webhook/check polling plus session creation when policy allows.
- Dashboard with activations and skipped reasons.

Risk:

- Recurring agents can spam teams if trigger/dedupe policy is weak.
- Start with read-mostly triage and Cycloid-created PRs before broad repo automation.

## Roadmap Bet 3: Evidence Contract And Verified States

Turn PR readiness and runtime evidence into an explicit product contract per task type.

Why now:

- AutoSana and Arga sell evidence as the product: screenshots, video, logs, generated tests, digital twins, PR checks.
- WorkOS Horizon explicitly plans deterministic browser artifacts and PR-attached evidence.
- Fiberplane emphasizes check-before-done hooks and verification gates.
- Cycloid already has PR readiness evidence, draft/manual-review publish mode, review-loop hold status, runtime evidence, screenshots/videos, and artifact access controls.

Core functionality:

- Task classes with default evidence contracts: docs-only, backend, UI, migration, auth, integration, sandbox, observability incident, post-deploy.
- Session states: `completed_unverified`, `verified_commands`, `verified_runtime`, `verified_ci`, `verified_deploy`, `blocked_missing_evidence`, `blocked_failed_evidence`.
- Evidence panel in session UI: required checks, actual commands, exit status, artifacts, trace links, CI links, PR URL, deploy URL.
- PR body section generated from deterministic evidence records, not final prose.
- Business/repo policy for which evidence gates block PR creation vs create draft PR.
- Verification explainability: "this is verified because these checks satisfied this contract."

Codebase fit:

- Builds directly on `PrReadinessEvidence`, `ExecutionVerification`, artifact proxy, PR body rendering, session projection, and UI session detail state.
- Most of the backend primitives exist; this is a persistence/UI/policy productization project.

MVP:

- Add evidence contract rendering for UI/runtime, backend/test, and migration/auth risky areas.
- Surface contract status in session header and PR section.
- Do not change publish blocking behavior until the UI makes the contract legible.

Risk:

- Over-strict gates block useful work. Start as visible status, then graduate selected risky classes to blocking policy.

## Roadmap Bet 4: Browser And Mobile Verification Workbench

Make UI verification a dedicated Cycloid surface instead of only an artifact side effect.

Why now:

- AutoSana is focused on web/iOS/Android agentic E2E with screenshots, replay, and CI/mobile integrations.
- Arga focuses on browser validation, logs, artifacts, live frame, and PR checks.
- WorkOS Horizon highlights browser verification with screenshots and DOM snapshots.
- Cycloid already supports app runtime profiles, preview contracts, screenshots/videos, and PR artifact links.

Core functionality:

- Live browser frame for sandbox preview sessions.
- One-click screenshot/video capture from UI.
- Agent-triggered browser scenario runs with screenshots, console logs, network logs, DOM snapshot, and visual assertion.
- Repo-defined verification scenarios in `.cycloid` config or skills: natural language goal, required route, auth setup, fixture data, assertions, artifact requirements.
- Visual regression: before/after screenshots for affected routes.
- Mobile partner interface: attach AutoSana-style iOS/Android run results as Cycloid evidence before building native mobile infra.

Codebase fit:

- Extends existing runtime preview, artifact upload/listing, and `ExecutionVerification`.
- Needs UI work for live preview and artifact grouping; backend work for scenario definitions and evidence records.

MVP:

- Browser workbench for web apps only: live frame, capture screenshot, capture console/network logs, attach to session/PR.
- Later: scenario runner and mobile partner ingestion.

Risk:

- Full browser automation can become a QA platform. Keep the first version focused on evidence capture for Cycloid-created changes.

## Roadmap Bet 5: PR Babysitter And Review Loop

Own the PR after creation until it is green, reviewed, and ready to merge.

Why now:

- Obvious explicitly mentions babysitting stalled PRs.
- Charlie positions PR helper daemons and default PR review.
- Augment has a code review SKU with guidelines and analytics.
- Cycloid already opens/updates PRs, has readiness evidence, handles PR review webhooks, and can enqueue follow-up prompts.

Core functionality:

- PR state monitor for Cycloid-created PRs: CI failing, checks pending too long, branch behind, merge conflict, changes requested, unresolved comments, reviewer idle.
- "Send back to Cycloid" action from GitHub comment, Linear, Slack, or UI.
- Policy-driven auto-follow-up for safe cases: failed lint/test with clear output, branch behind, requested changes on Cycloid-authored PR.
- Pre-handoff review pass: correctness, verification adequacy, risky-area checklist, security/migration/auth review.
- Analytics: time-to-first-PR, time-to-green, time-to-merge, review rework rate, common failure classes.

Codebase fit:

- Extends existing GitHub webhook handling, `pr_review_auto_response_enabled`, PR workflow, and session projection.
- Needs durable PR state rows, check-run polling/webhook handling, and dedupe.

MVP:

- Cycloid-created PR monitor with manual "send back" and automatic branch-behind/failing-test triage.
- Summary dashboard for stuck PRs.

Risk:

- Auto-follow-up can churn. Default to manual "send back" for requested changes, and auto-run only deterministic CI recovery first.

## Roadmap Bet 6: Incident Investigation Workflow

Package observability tools into a production debugging workflow that starts read-only and ends with post-fix verification.

Why now:

- Junior and WorkOS Horizon emphasize Sentry/Datadog context.
- Browserbase and Stilla position agents around production/support workflows.
- Peter Pang's thread argues observability must be designed for agent diagnosis.
- Cycloid already has Datadog log search, Datadog trace lookup, Sentry issue lookup, Slack, Linear, GitHub, and memory tools.

Core functionality:

- "Investigate incident" session type from Slack, Linear, Sentry, Datadog, or UI.
- Initial read-only context bundle: alert/issue, trace/log samples, linked deploy/commit/PR, recent related sessions, Linear/GitHub context.
- Hypothesis report before code edits: suspected component, likely commits, repro path, proposed fix, verification plan.
- Optional code-fix session linked to the investigation.
- Post-fix check: query the original metric/error after deploy and attach recovery evidence.
- Incident artifact: timeline, evidence, PR, deploy, recovery status.

Codebase fit:

- Builds on first-party dynamic tools, memory recall, session artifacts, and PR workflow.
- Needs a product template and maybe a typed incident context object.

MVP:

- UI/Slack command that starts a read-only investigation with Datadog/Sentry/Linear/GitHub context and produces a linked investigation artifact.
- Follow-up prompt can convert it into an implementation session.

Risk:

- Observability credentials and production data are sensitive. Keep access scoped, read-only by default, and make credential/tool use visible.

## Roadmap Bet 7: Skill And Runtime Authority Manifests

Separate reusable workflow instructions from runtime authority.

Why now:

- Junior's plugin model is a strong pattern: capabilities, credential behavior, domains, env, dependencies, MCP, and skills are declared in a manifest.
- Charlie and Browserbase both use repo-local skill/daemon files, but authority needs clearer review boundaries.
- Cycloid already supports skills and first-party dynamic tools, but skill markdown should not become the authority source for credentials, domains, or package installation.

Core functionality:

- `cycloid.plugin.yaml` or `skill.manifest.yaml` alongside skill markdown.
- Manifest fields: required tools, allowed dynamic tools, credential sources, allowed domains, runtime packages, MCP servers, command env, artifact outputs, verification contract.
- Static validator that rejects mismatches: skill asks for Datadog but manifest lacks Datadog; skill asks to install runtime deps but manifest does not declare them; skill asks for a domain not in policy.
- Business/repo UI showing skill authority and review status.
- Internal skill catalog with approved workflows.

Codebase fit:

- Extends `shared/skills/index.ts`, dynamic tool registration, egress policy, and repo preview/diagnostics.
- Should avoid letting natural-language skill text mutate runtime configuration.

MVP:

- Read-only manifest validation and UI diagnostics for declared tools/domains/evidence.
- Enforcement later, after diagnostics are useful.

Risk:

- Too much manifest ceremony can kill skill adoption. Start with optional manifests for privileged skills only.

## Roadmap Bet 8: Artifact, Trace, And Workspace Inspector

Give users a stronger way to inspect what happened during long-running background work.

Why now:

- HumanLayer/CodeLayer has rich local tool/diff views and checkpoint operations.
- Browserbase/OpenWork emphasize files, logs, artifacts, and traces.
- Arga/AutoSana make logs/screenshots/videos/replay a core review surface.
- Cycloid has session events and screenshot artifacts, but most review still collapses to transcript + PR diff.

Core functionality:

- Artifact browser grouped by prompt/task: screenshots, videos, logs, reports, generated files, command outputs.
- Timeline that links prompt -> tool call -> command -> file change -> commit -> artifact -> PR section.
- Diff snapshots at milestones: after initial edit, after verification fix, before PR.
- Checkpoint/fork UX for sessions where users want to continue from a known point.
- Download/export debug bundle for support and incident review.

Codebase fit:

- Builds on durable events, artifact proxy, transcript projector, PR body evidence, and session UI.
- Needs broader artifact typing and careful private artifact authorization.

MVP:

- Session evidence tab with screenshots/videos plus command evidence, PR readiness, runtime evidence, and linked PR state.
- Defer full filesystem browser until artifact typing and retention policies are clear.

Risk:

- Raw filesystem exposure can leak secrets. Prefer agent-uploaded typed artifacts and redacted command outputs first.

## Roadmap Bet 9: Engineering Memory And Failure-Class Learning

Turn repeated failures, review comments, and accepted fixes into auditable engineering memory.

Why now:

- Stilla and Obvious sell shared memory as a core product capability.
- Augment Cosmos Experts emphasizes specialized agents improving from feedback.
- Fiberplane recommends turning repeated failure patterns into deterministic checks.
- Cycloid already has memory recall, memory analysis, PR readiness, and session event data.

Core functionality:

- Memory review queue: proposed memory, source session/PR/comment, scope, expiration/freshness, reviewer, applied workflows.
- Failure-class mining: recurring test failures, review comments, missing verification, auth mistakes, migration mistakes, flaky commands.
- Suggested guardrail generator: repo instruction update, skill update, ast-grep rule, lint rule, test fixture, verification checklist.
- Retrieval explainability: show which memories influenced a session and why.
- Reliability dashboard by repo/workflow.

Codebase fit:

- Builds on memory services, PR review handling, and session events.
- Needs explicit reviewer attribution for memory promotion, but not a tool-call approval queue.

MVP:

- Propose memories from merged PRs and resolved review comments; user accepts/edits/rejects.
- Show accepted memory in future session context and transcript.

Risk:

- Bad memories create worse agents. Memory needs freshness, source links, scope, and revocation.

## Roadmap Bet 10: Enterprise Control Center

Package the architecture Cycloid already has into visible admin/security controls.

Why now:

- Stilla, Augment, Viktor, and other competitors make SSO, SCIM, audit logs, retention, security controls, and policy language visible.
- Junior/Browserbase/WorkOS provide strong credential/egress narratives.
- Cycloid's implementation is stronger than its current packaging.

Core functionality:

- Business admin dashboard for repo access, GitHub installation state, Linear/Slack/Datadog/Sentry credentials, sandbox egress, artifact visibility, retention, audit logs, and integration health.
- Per-session audit: actor, source, repo authorization, credentials made available, dynamic tools available/used, egress policy, artifact visibility, PR actor.
- Policy simulator: "Can this user launch work on this repo from this Linear issue?" "Can this session access Datadog?" "Can this sandbox reach this domain?"
- Exportable audit logs and SIEM hooks.
- Public-facing security matrix: control plane vs sandbox, raw secrets vs brokered tools, public vs private artifacts, repo authorization behavior.

Codebase fit:

- Builds on business settings, integration credentials, repo gating, artifact access metadata, egress docs, dynamic tool availability, and session projection.

MVP:

- Admin "Session Security" panel and "Integration Health/Policy" panel.
- Export one session's security/evidence bundle.

Risk:

- This is not glamorous but matters for enterprise trust. Keep it tied to actual implementation, not marketing-only controls.

## Prioritization

Recommended order:

1. Evidence Contract And Verified States
2. PR Babysitter And Review Loop
3. Project Work Graph
4. Policy-Bound Watchers And Daemons
5. Browser Verification Workbench
6. Incident Investigation Workflow
7. Skill And Runtime Authority Manifests
8. Artifact, Trace, And Workspace Inspector
9. Engineering Memory And Failure-Class Learning
10. Enterprise Control Center

Rationale:

- Evidence and PR babysitting compound immediately on Cycloid's current PR-centric workflow.
- Project graph and watchers are the largest strategic expansion and should build on reliable evidence/PR state first.
- Browser verification and incident workflows convert existing primitives into high-value use cases.
- Skill manifests, artifact inspection, memory, and enterprise controls make the platform safer and more legible as autonomy increases.

## Near-Term Build Sequence

Phase 1: make current work more trustworthy.

- Evidence contract panel.
- PR stuck-state monitor for Cycloid-created PRs.
- Session security/evidence bundle.

Phase 2: make work orchestration explicit.

- Project/work graph MVP.
- Same-repo task decomposition and dependency tracking.
- Manual launch of graph nodes.

Phase 3: make Cycloid proactive.

- Watcher definitions for stale PR and CI failure triage.
- Activation history and dry-run policy.
- Manual "send back to Cycloid" from GitHub/Linear/UI.

Phase 4: make verification and investigation deeper.

- Browser workbench.
- Incident investigation session template.
- Post-deploy verification state.

Phase 5: make autonomy governable.

- Skill/runtime authority manifests.
- Memory review queue.
- Enterprise control center.

## Sources Reviewed

- Obvious Autobuild docs: https://help.obvious.ai/developer-api/what-is-autobuild
- Stilla product/docs: https://stilla.ai/ and https://stilla.ai/docs/agents/overview
- Charlie daemons/product docs: https://charlielabs.ai/ and https://charlielabs.ai/how-it-works
- WorkOS Horizon: https://workos.com/blog/project-horizon
- Arga how it works: https://docs.argalabs.com/concepts/how-it-works
- AutoSana testing articles/product pages: https://autosana.ai/ and https://blog.autosana.ai/
- Augment Cosmos/Experts: https://www.augmentcode.com/product/cosmos and https://www.augmentcode.com/guides/cosmos-experts
- HumanLayer repository/docs: https://github.com/humanlayer/humanlayer
- Sentry Junior repository/docs: https://github.com/getsentry/junior
- Fiberplane Claude Code articles: https://fiberplane.com/blog/2026-04-10-how-we-use-claude-code-and-build-with-agents-at-fiberplane-part-1/ and https://fiberplane.com/blog/2026-04-30-how-we-use-claude-code-and-build-with-agents-at-fiberplane-part-2/
