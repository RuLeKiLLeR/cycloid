# Bridge / Prompt Runtime

Codex parts arrive incrementally: a part may first appear without `state.input`, then update with input populated. Part-processing code must:

- **Never mark a part "seen" before emitting its event.** Use separate "processed" vs "emitted" tracking sets when emission depends on later-arriving data.
- **Use part-specific IDs for text events, not the shared `messageId`.** Text parts before and after a tool call have different part IDs; `messageId` merges them into one block at the wrong position.
- **Skip user-message text parts from assistant narration.** Codex emits the submitted prompt as a `UserMessage` text part; track message roles from `message.updated` events and filter text/reasoning parts belonging to user messages to prevent prompt echo.
- **Defer summary generation until input is available.** Emitting a tool-call summary before `part.state.input` is populated produces bare tool names instead of useful details.

## Bridge collaborators

`apps/sandbox-bridge/src/bridge.ts` delegates to extracted state holders / collaborators; it proxies their fields and methods rather than owning logic inline:

- `control-plane-session.ts` — WS transport, event buffer, pending-ack tracking.
- `memory-manager.ts` — memory loading, ranking, and enforcement state; runtime memory tools/injection are gated by `ARCANIST_MEMORY_TOOLS_ENABLED`.
- `services/git-ops.ts` — staging, commit, push, PR-readiness git work.
- `services/timeline-emitter.ts` — `agent_timeline` emission. `sendAgentTimelineEvent` is the single redact/truncate chokepoint feeding the typed `emit*Timeline` helpers (prompt-observation, command, verification, publish-gate).
- `services/prompt-activity.ts` — `prompt_activity` / `agent_progress` emission, per-prompt agent-progress dedup, the prompt-activity pulse helpers, and the first-message latency tracker (`prompt.first_message`). The pulse seam (`withPromptActivityPulse`) also emits a `prompt.activity_phase` duration log (Datadog metric tagged by `phase` / `outcome` / `repo`). The startup-attempt id and pending-ack/buffer accounting stay bridge/`ControlPlaneSession`-owned and are injected as readers.
- `utils/git-setup.ts` — fail-soft customer git safeguards (`setupGitExclude`, `setupProtectedPathPreCommitHook`, `setupGitConfig`); pure functions taking `{ cwd, log, execAsync }`.
- `services/hook-bootstrap.ts` — detects repo-declared git hook managers (pre-commit, Husky, Lefthook) at session start and bootstraps them before the first commit so customer hooks run during publish. Supported managers fail closed on bootstrap errors; unsupported managers are logged and skipped.
- `services/workspace-setup-tracker.ts` — `WorkspaceSetupTracker` owns the pending/ready-marker bookkeeping for external dependency setup and the workspace prompt-activity / agent-progress signals. The background watcher and foreground dependency-command wait share one `awaitReady` poll loop, differing only in throw-vs-return and log wording. fs / clock / sleep are injectable.
- `services/question-reply.ts` — `handleRespond` delivers a user's answer to a pending Codex question (child-question, no-pending fallback, normal parent). Each branch replies via the in-process Codex client (`question.reply`); no local `codex://` fetch and no control-plane callback. The bridge keeps a thin delegator that builds the port from `this`.
- `services/codex-session.ts` — `CodexSessionManager` owns the Codex `client` / `server` (bridge proxies both), the `codexInitPromise` double-spawn latch, `codexStaticConfig`, fail-closed model resolution (`parseModel` / `getRequestedModelInfo` / `getEnvModelInfo`, request > env precedence), Codex runtime init, and `createCodexSessionForPrompt`. The session id, current agent, and first-prompt-in-session flag stay bridge-owned (read across the stream loop and setup/restore), so no field has split ownership.
- `services/event-translator.ts` — `translateCodexEvent(event, deps, loopState, promptState, toolTracker)` is the per-event translation step. The bridge keeps `streamPromptToClient` as the async I/O driver (prompt-start timeout/abort, `session.error` retry sleep + re-dispatch, stream teardown); the translator runs the synchronous classification and fires side effects inline through injected `deps`, preserving emit / BT-span / evidence ordering. It returns a control signal (`next` | `break` | `retry`) the driver acts on. Preserves every branch: prompt-start detection, stale-event suppression, the `emittedToolParts` dedup guard (the subtask path adds `subtaskPid` to `emittedToolParts` without `seenPartIds`, so the guard prevents a re-emit), transient-only retry (`auth`/`aborted` fall through to a terminal error), and `raw_agent_runtime` fallbacks (adapter-scoped via `{codex,claude,opencode}.raw_fallback` → per-backend drift metrics). Tool-part state (`seenPartIds`, `emittedToolParts`, `emittedToolStatuses`, `toolStartTimes`, `deferredSafetyRejectedToolPartIds`) lives on `PromptLoopState` and is read there, never mirrored.
- `trackers/tool-part-tracker.ts` — `ToolPartTracker` owns ONLY `activeToolSpans` (Braintrust child spans). `startSpan` degrades on a span-start failure (`btSpanDegraded` log, never crashes the stream); `forceEndAll` closes orphaned spans at prompt teardown and returns the leak count (logged as `bt.tool_span_leak` → metric `arcanist.bt.tool_span_leak`). First-seen-terminal tools end their spans immediately with the observed terminal status.
- `services/post-execution/artifact-collector.ts` — `collectVerificationArtifacts` walks `RUNTIME_EVIDENCE_DIR` (top-level + recursive `walkE2EDir`), dedupes by content hash, caps non-screenshot uploads, and uploads each artifact for QA verifier sessions. Behind a full-surface port (evidence dir, upload URL/token, content-type sniff, `fetch`). Keeps the `isWithinEvidenceRoot` realpath containment guard on both top-level and recursive candidates so no artifact resolves to an out-of-tree file. `logFailure` never receives the bearer token. The bridge keeps a thin delegator.
- `services/post-execution/failure-context.ts` — pure functions for abnormal prompt endings. `PostExecutionFailureContext` describes how a prompt ended (aborted or prompt_error); `buildFailureClaim` / `buildFailureCaveats` synthesize honest publish-prep claims and caveats; `resolveFailurePublishDecision` drafts failed or stopped prompts for manual review. Unit-tested in isolation; bridge call sites use thin adapters that bind per-invocation context.
- `services/post-execution/format.ts` — deterministic formatting helpers. `compactCommandOutputForReview` formats command output for the PR body. Pure and unit-tested.
- `services/post-execution/publish-gates.ts` — the pre-publish gate reducer. Configured tests produce `GateResult`s instead of mutating scattered `let`s. `applyGateResult` folds active gate results into one `PublishDecision` with `blocked > draft > normal` precedence. Warn reasons append+dedupe by default. `markGateFailedDraft` / `markGateResourceKilled` are the shared draft outcomes.
- `services/post-execution/verification-finalizer.ts` — `finalizeVerification` for QA verifier-session artifact upload and `ExecutionVerification` payload folding. Implementation-session post-exec builds only gate/failure publish metadata and does not upload runtime evidence or synthesize a verification verdict.

### Post-execution telemetry

- `post_execution.completed` carries the sandbox's advisory `publishMode` (the control plane re-derives authoritatively from `gateResults`) and a per-gate `gateDecisions` map (`tests` comes from the configured `.cycloid.json` `verify.test` pre-publish gate) on the success path.
  Configured `.cycloid.json` `verify.fix` runs before the publish commit, emits `post_execution.pre_publish_fix`, and folds successful tracked mutations into the normal commit without adding a gate decision.
  us5 log-metrics: `arcanist.post_execution.publish_mode` (count by `publish_mode`/`outcome`).
- When verifier artifact collection runs, `e2e_post_exec_artifacts` records outcome counts (`uploaded`/`failed`/`skipped`/`duplicate`/`oversized`) alongside the per-type counts. us5 log-metrics: `arcanist.post_execution.artifacts_uploaded` / `arcanist.post_execution.artifacts_failed` (distributions, grouped by `e2e_runtime`).

### Control-plane event buffering

`ControlPlaneSession` buffers non-ACK bridge events while the control-plane WebSocket is unavailable.
The buffer is in-memory and bounded by `EVENT_BUFFER_MAX`.
When it is full, the bridge drops the oldest buffered non-ACK event and logs `Event buffer full, dropping oldest event`.
ACK-required events bypass this lossy buffer through `pendingAckEvents` and durable outbox recovery.
Do not treat buffered stream output as durable replay data; completed sessions rely on persisted control-plane events, not this transient bridge queue.

## Agent runtime backends

The bridge drives every backend through the neutral `AgentRuntimeAdapter` contract (`apps/sandbox-bridge/src/agent/agent-runtime-adapter.ts`); selection arrives via `ARCANIST_AGENT_RUNTIME_BACKEND` (`codex` default, `claude_code`, `opencode`).

Readiness boundary:

- `warmup()` is non-mutating pre-prompt readiness work; it must not create transcripts, runtime sessions, event subscriptions, or dispatch a model turn. Backends that support safe warmup return `ready`; unsupported backends return `skipped`.
- `ensureClientInitializedForPrompt()` is required before a real prompt dispatch.
- `createSessionForPrompt()` may create durable backend session state.
- `subscribeEvents()` opens the event stream for the active turn.
- `sendPrompt()` is the first real model turn.

For the end-to-end control-plane, credential, prompt, event, and shared-surface comparison, see [agent runtime backends](agent-runtime-backends.md).

| Concern             | codex                                                    | claude_code                                                                                    |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Process model       | Codex app-server + stdio client                          | ONE persistent `@anthropic-ai/claude-agent-sdk` `query()` per session (streaming input)        |
| Per-turn flow       | `session.promptAsync` + event subscription               | Push user message onto the input stream; demux the generator into a per-turn stream            |
| Tool safety         | External `PreToolUse` hook subprocess                    | In-process SDK `canUseTool` gate (`services/claude-tool-safety.ts`)                            |
| MCP servers         | Codex runtime TOML `mcp_servers`                         | Repo `.mcp.json` projected into `query()` `mcpServers` (`services/claude-mcp-config.ts`)       |
| State sync          | `$CODEX_HOME/sessions/` via `services/state-rollout.ts`  | `~/.claude/projects/` via the same shared transport                                            |
| Questions           | In-process `question.reply` on the local Codex client    | In-process: `canUseTool` holds AskUserQuestion open; answer flows via `updatedInput`           |
| Prompt-start budget | `promptLoop.promptStartTimeoutMs`                        | `promptLoop.claudeCodePromptStartTimeoutMs` (warmup mitigates cold boot; this is the fallback) |
| Drift signal        | `codex.raw_fallback` log → `arcanist.codex.raw_fallback` | `claude.raw_fallback` log → `arcanist.claude.raw_fallback`                                     |

Claude protocol fixtures live under `tests/test_sandbox-bridge/fixtures/claude-protocol/<version>/` and back `claude-event-translator-golden.test.ts`; the SDK version is pinned in `shared/constants/claude-code-runtime.ts`.

### Claude refusal behavior

The pinned Claude Agent SDK emits `system.model_refusal_fallback` when the
primary model ends a turn with Anthropic `stop_reason: "refusal"`.
The SDK retries the turn on its fallback model and persists that model for the
session.

The bridge classifies this notification as non-terminal SDK telemetry and waits
for the following `result` message.
That result follows the normal success path when fallback succeeds, so the
session reaches the ordinary terminal state and the user sees the fallback
response.
If the fallback also fails, the SDK emits its normal error result and the
bridge emits the existing durable `error` event; there is no refusal-specific
hang or silent completion path.

The refusal category and explanation are observational fields only.
They are not parsed into product logic because Anthropic documents the
explanation as unstable human prose and categories may expand ahead of the SDK
schema.

## Protocol coverage

- Treat the pinned Codex CLI version as a versioned wire contract, not an implementation detail.
- Checked-in source of truth: `tests/test_sandbox-bridge/fixtures/codex-protocol/<CODEX_CLI_VERSION>/`.
- Refresh fixtures with `node scripts/record-codex-protocol-capture.mjs` whenever `shared/constants/codex-runtime.ts` changes.
- Every captured item type, notification, and server-initiated request method must be classified in `apps/sandbox-bridge/src/services/codex-protocol-coverage.ts` as `translated`, `raw_fallback`, or `ignored`, with a rationale.
- `apply_patch` canonical lifecycle rule: direct custom-tool events win when present; synthesized `fileChange` tool events are fallback-only and must not double-count the same logical patch.

The bridge is the **sole translator** of Codex events. The DO persists and broadcasts whatever the bridge sends; it does not re-interpret or translate raw Codex events.

- **Optional event fields must not change terminal behavior on their own.** When adding bridge metadata that affects prompt finalization or queue draining, treat missing fields as an old-sandbox payload and preserve the previous completion path. Concretely, `execution_complete` may only preempt `session_idle` when the bridge provided the metadata needed to make the same decision, or when it explicitly reported `idleObserved=false`.

### Bridge protocol version

The bridge/control-plane WebSocket protocol is versioned by `BRIDGE_PROTOCOL_VERSION` in `shared/constants/bridge-protocol.ts`.
The sandbox bridge sends its compiled version in the `x-bridge-protocol-version` WebSocket handshake header.
The session DO sends the worker's version back in the `sandbox_session.bridgeProtocolVersion` frame field.
The session DO also sends an optional bounded opaque `workerVersionId` from the `version_metadata` binding.
The control plane stores the bridge-reported version on `sandbox_state.bridge_protocol_version` and emits `bridge.protocol_skew` when it is missing or differs.
The bridge also logs `bridge.protocol_skew` when the worker advertises a different numeric version.

Skew is expected during deploys because E2B still bakes the bridge bundle into its template, while Freestyle keeps baked fallbacks but injects fresh `bundle.js` and `start-bridge.sh` at session start from R2. Other Freestyle baked scripts still require a base rebuild + rotation — see [docs/freestyle-snapshots.md](freestyle-snapshots.md).
A live sandbox can therefore run an older bridge bundle against a newer worker.
The `runtime_info` runtime report carries `bridgeBundleSha256` / `bridgeBundleSource` (injected vs baked) so a stale baked bundle is observable per session (ARC-1512).
Missing bridge version means `pre-versioning`, not an auth or protocol error.
Current behavior is tolerate-and-measure only; do not add a refusal floor until production skew duration shows it is safe.

Protocol version 2 adds the distinct `review` agent role. During bridge skew,
the worker sends review-profile prompts to pre-v2 bridges with the legacy
`verification` role so old sandboxes retain their existing read-only behavior;
v2 bridges start the reviewer under its independent runtime role.

Bump `BRIDGE_PROTOCOL_VERSION` for breaking changes to `shared/types/sandbox.ts` command/event shapes or the `sandbox_session` frame.
Do not bump it for additive optional fields that old workers or old bridges can safely ignore.
Keep rollout compatibility both ways: new worker plus old bridge, and old worker plus new bridge.

`workerVersionId` is observational metadata, not a new acknowledgement handshake.
The authenticated socket adoption remains the acceptance signal, and the Worker does not wait for a bridge acknowledgement before clearing transport deadlines.
The bridge compares version ids only for equality, so rollbacks and skipped generations are handled without assuming provider ordering.

## Live context inventory

A Codex session can receive model-facing context from these paths:

| Source                        | Where it enters                                                                                                                                           | Default behavior                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native project docs           | Codex project-doc config                                                                                                                                  | Root `AGENTS.md`, falling back to `CLAUDE.md` / `agents.md`                                                                                                             |
| Bridge per-prompt system text | `apps/sandbox-bridge/src/utils/system-context.ts`                                                                                                         | Rebuilt every prompt; carries only observed-fact one-shot sections (diagnostics, attachments, identity)                                                                 |
| Uploaded files and images     | `apps/sandbox-bridge/src/utils/uploaded-files.ts` and prompt parts                                                                                        | Budgeted, resized/truncated, and wrapped as untrusted user content                                                                                                      |
| Repo memories                 | `.cycloid/memory/**/*.md` plus D1 `repo_memories` (when `MEMORY_REPO_SINK=d1`)                                                                            | Loaded for storage/enforcement compatibility; runtime recall/injection is available only when the control plane passes `ARCANIST_MEMORY_TOOLS_ENABLED=1` to the sandbox |
| Repo agent profiles           | Bridge injects `.cycloid/agent-profiles/index.md` as the first per-prompt repo guidance when present; agent reads a matching linked profile before skills | Profile-first prompt guidance; skills remain available as tactical guidance after profile selection                                                                     |
| Diagnostics                   | `formatDiagnosticsReminder()`                                                                                                                             | One-shot, newest-first, bounded by `DIAGNOSTICS_SYSTEM_CONTEXT_TOKEN_BUDGET`                                                                                            |
| Codex session history/output  | Codex runtime conversation and tool output history                                                                                                        | Not directly assembled by Cycloid; tracked through estimates and noisy-output events                                                                                    |
| Tool schemas and guidance     | Codex runtime config plus bridge behavioral guidance                                                                                                      | Runtime guidance emits only when relevant                                                                                                                               |

Model-facing memory tools are gated by `ARCANIST_MEMORY_TOOLS_ENABLED`, which the control plane sets for production sessions with a business id. `MEMORY_FEATURE_DISABLED` hides UI-only memory surfaces.

Context-size controls are not a substitute for pruning stale guidance:

- Fixed instruction prose should be deleted or relevance-gated.
- Cycloid-injected variable-size artifacts should stay explicitly bounded because Cycloid knows their semantic priority before Codex does.
- Codex-owned history and tool output should normally stay with Codex's native context manager unless Cycloid has concrete evidence that layer is failing.

## Prompt assembly

The bridge assembles model-facing context from layers with different lifecycles:

| Layer                  | Lifecycle                                                                  | Where defined                                                                          |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Repo instruction files | Session-static, selected before Codex init                                 | Codex-native root docs (`AGENTS.md`, fallback `CLAUDE.md` / `agents.md`)               |
| Behavioral guidance    | Session-static; written once to `${CODEX_HOME}/AGENTS.md` at session start | `apps/sandbox-bridge/src/constants/bridge.ts` (`buildSessionStaticBehavioralGuidance`) |
| One-shot state         | Drained after assembly (diagnostics, attached repos)                       | `apps/sandbox-bridge/src/bridge.ts`                                                    |
| Task artifacts         | Per-prompt user content (task text, uploads, images)                       | Control plane / bridge                                                                 |

Per-turn `body.system` carries prompt-scoped sections in this order:

1. Requesting user identity (when `GIT_AUTHOR_NAME` or a prompt-actor ID is available)
2. Repo agent profile index guidance (when `.cycloid/agent-profiles/index.md` exists)
3. Explicitly selected repo skill directives
4. Per-prompt attached file directives
5. Diagnostics reminder (when the previous turn produced errors)

Per-turn `body.system` no longer carries repo-memory sections.

All durable behavioral rules (see the section table under "Session-static behavioral guidance") are written once to `${CODEX_HOME}/AGENTS.md` at session start by `buildSessionStaticBehavioralGuidance()` and re-injected by Codex after every auto-compaction via `config.user_instructions`. Per-turn assembly does not classify the session, gate on task text, or branch on prior edits.

Instruction placement rules:

- Do not put prompt text in `AgentConfig`; it is public agent metadata only and provides no prompt layer. Cycloid product guidance belongs in Codex instruction files or the session-static `${CODEX_HOME}/AGENTS.md`.
- Put repo-specific guidance in repo instruction files (these own repo-specific conventions such as performance evidence requirements and final-answer file-reference style).
- Put prompt-specific state in per-prompt system context.
- Put task artifacts in user parts.
- Keep hard safety rules in code: protection rules, blocked commands, retries, tool limits, and event semantics.

## Instruction files

Root repo instruction files are session-static defaults. Codex loads root `AGENTS.md` natively, falling back to `CLAUDE.md` then `agents.md` through project-doc config.

Cycloid does not task-route app-level docs or inline linked repo docs. Root `AGENTS.md` remains the table of contents for repo docs; Codex uses normal file-reading tools and nested `AGENTS.md` discovery for more specific guidance.

Root instruction files are shared with normal local Codex sessions: keep them repo-specific and environment-agnostic, with Cycloid-only workflow left out. The canonical placement rule lives in [docs/conventions.md](conventions.md#instruction-placement); this doc covers only how the bridge consumes those layers.

Instruction file selection is session-static. Follow-up prompts do not mutate the initialized Codex instruction set.

## One-shot system context

`buildSystemContext()` drains prompt-scoped state after assembly:

- `systemContextSections` for attached repo paths
- `pendingDiagnostics`

This is intentional: one-shot sections (diagnostics, attached files, requesting-user identity) should appear on the next prompt exactly once. Prompt retries reuse the already-built prompt payload instead of rebuilding drained state; durable rules live in `${CODEX_HOME}/AGENTS.md` and do not need reassembly on retry.

## Session-static behavioral guidance

**File:** `apps/sandbox-bridge/src/constants/bridge.ts` (`buildSessionStaticBehavioralGuidance`)

Written once at session start to `${CODEX_HOME}/AGENTS.md` (see `apps/sandbox-bridge/src/services/codex-server.ts`). Codex loads it as `config.user_instructions` and re-injects after every auto-compaction.

OpenCode prepends the same guidance to the system prompt in `sendPrompt()` (`apps/sandbox-bridge/src/agent/opencode-runtime-adapter.ts`); it does not write to `${CODEX_HOME}/AGENTS.md`.

| Section                                                 | Notes                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox environment                                     | Headless container, no `open`/`xdg-open`, output URLs as text, secrets stay server-side                                                                                                       |
| Investigation and checks                                | Issue-tracker ticket references are not GitHub issues; scoped repo search; keep large command output in temp files                                                                            |
| Task completion                                         | Complete under safe assumptions, ask only for destructive steps, unexpected external mutation, material scope changes, or missing context; never ask users to paste secret values             |
| Validation before commit                                | Requires local verification, response-accuracy checks, and scoping no-diff/no-side-effect claims to the current prompt rather than the overall task                                           |
| Git restrictions                                        | PR-completion guidance from `PR_WORKFLOW_AUTOMATION_CLAUSE`, `PR_WORKFLOW_COMMIT_RULE`, and `buildPrWorkflowGuidanceBullets()` plus sandbox-isolation reminders                               |
| Artifact contract / optional E2E                        | Universal artifact directory rules; runtime evidence guidance when E2E is configured                                                                                                          |
| Linked repo guidance / Agent profiles / Code minimalism | Points to repo instruction files, explains that `.cycloid/agent-profiles/index.md` is injected before skills when present, and provides the minimalism ladder with `cycloid-shortcut:` marker |
| First-party dynamic tools (conditional)                 | Lists available first-party dynamic tools so the model prefers them over raw `curl`. Emitted only when at least one dynamic tool is registered for the session                                |
| Company memory (conditional)                            | One-line nudge to use company-memory tools proactively. Emitted only when company-memory dynamic tools are available                                                                          |

The bridge no longer classifies session shape per turn (no read-only vs edit-likely vs Q&A vs mixed gating, no task-text regexes, no `editCount` gate). If a deleted heuristic produces a regression, add the failing-case text into `AGENTS.md` as durable content rather than reintroducing a per-turn gate.

## Tool guidance

Bridge-owned behavioral guidance no longer carries first-party Cycloid runtime tool sections. Tool-specific routing now comes from available first-party dynamic tools and the repo/runtime instruction layers.

Normal `git fetch` uses the session's repo-scoped, read-only GitHub installation credential helper. The helper delegates to the absolute-path real `gh` binary and keeps credentials out of `origin`; push remains blocked by policy before credential lookup.

Safe `gh pr close`, `gh pr reopen`, and title-only `gh pr edit` commands are brokered by the control plane through a session-bound capability. Unsupported PR, issue, workflow, API, browser, and merge operations remain blocked.

`cycloid.git_sync` is reserved for bridge-controlled `force_push_current_branch` recovery after local conflict resolution. It uses `--force-with-lease`; ordinary base synchronization should use `git fetch`.

Use native read-only `gh` commands for pull-request contents. For inline review comments, use the bounded recipe `gh api --paginate repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {author:.user.login,path,line,body,review_id,in_reply_to_id}'`; this preserves author, path, line, review, and reply relationships while allowing the CLI to paginate. The sandbox blocks browser, auth-management, mutation, and unsupported API forms. The legacy `/pr-read` endpoint remains available only for already-published bridge bundles during rollout.

## Diagnostics reminder

**File:** `apps/sandbox-bridge/src/utils/system-context.ts` (`formatDiagnosticsReminder`)

Injected as one-shot system context when post-edit diagnostics produced errors. Errors are grouped by file as `file(line,col): severity -- message`, taking the newest diagnostics that fit within `DIAGNOSTICS_SYSTEM_CONTEXT_TOKEN_BUDGET`.

## Behavioral signal tracking

**File:** `apps/sandbox-bridge/src/prompt-loop-state.ts`

Per-prompt metrics feed Braintrust metadata, prompt logs, and completion-progress events:

| Signal                          | What it tracks                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `toolCallCount`                 | Total tool calls this prompt                                                            |
| `handledAutomaticallyViolation` | Whether the prompt attempted a blocked git/gh action that Cycloid handles automatically |
| `editCount`                     | Number of `apply_patch` calls                                                           |
| `questionCount`                 | Questions asked to the user                                                             |
| `contextFillPercent`            | Last known context window fill percentage                                               |
| `referencedExternalState`       | Whether text referenced PR/issue numbers or GitHub URLs                                 |
| `usedVerificationTools`         | Whether `gh pr view`, `gh issue view`, etc. were called                                 |
| `malformedSearchCommandCount`   | Malformed grep/rg search commands blocked before sandbox execution                      |
| `grepSearchCommandCount`        | Executed bash-shelled grep/egrep/fgrep search commands                                  |
| `ripgrepSearchCommandCount`     | Executed bash-shelled rg/ripgrep search commands                                        |

## Review-loop prompts

Review-loop work arrives as ordinary enqueued prompts tagged
`[cycloid:review-loop epoch=…]`, built control-plane-side by the sweep
(`webhooks/prompts.ts`): LLM-triaged action items when `review_loop_triage`
succeeds, otherwise the deterministic per-kind builders (bot, human/mixed,
CI-fix, verification-intake). The prompt-metadata `reviewLoopSourceKind`
(`bot|human|mixed`; CI and verification epochs dispatch as `mixed`) gates
bridge tools: `cycloid.review_summary_comment` is human/mixed-only, while
`cycloid.review_loop_reply` threads replies by worklist source id for
bot/human/mixed/ci/verification epochs; mention epochs resolve targets directly
from their authorized source IDs, bypassing the worklist.
`check-run-failure:` ids are never reply targets. Full loop flow:
[lifecycle.md](lifecycle.md#review-loop--qa-testing-rla-v2).

## Verification v2 phase pipeline

Verification v2 keeps one user-visible verification run and one managed PR verification comment. Inside that run, the bridge orchestrates `verification-planner`, `verification-launcher`, `verification-operator`, and `verification-judge` as artifact-producing phases through the active `AgentRuntimeAdapter`.

Intermediate phase artifacts emit `verification_phase_artifact` bridge events for persistence and debugging only. They must not run terminal verifier-session post-execution parsing, update the managed PR comment, release the verification lock, or look like separate verifier attempts. Only planner skip, final judge verdict, or a controlled pipeline failure enters the terminal verification result path.

The bridge validates artifact shape, builds effective proof contracts for phase inputs, redacts persisted artifacts, and converts malformed or missing artifacts into controlled `INCONCLUSIVE` blockers. It must not recompute proof coverage after a valid `VerificationJudgeArtifact` and downgrade the verdict as a hidden second judge. The judge artifact is the final non-skip verdict authority.

Phase prompts dispatch sequentially into one persistent backend session. Codex uses the same agent session; Claude Code uses the same SDK `query()` stream. Later phases receive prior validated artifacts and bounded context bundles, while backend conversation continuity is preserved across phases.

## Post-execution PR event contract

The bridge emits `post_execution` as the single PR-ready event for a completed prompt, only after diff prep, configured fix commands, commit/push or git-state fallback, configured tests, optional artifact upload, readiness evidence, and a deterministic PR body have completed.
The bridge post-idle path does not run the old verification loop; configured `.cycloid.json` fix/test commands are the only active pre-publish checks in this path.

Changed-file implementation publishes do not synthesize a verification verdict.
Configured `.cycloid.json` `verify.fix` commands run before the publish commit; successful tracked mutations are re-staged and folded into the commit, while failed fix commands restore partial tracked mutations and continue without blocking publish.
Configured `.cycloid.json` `verify.test` commands are the read-only pre-publish gate in this path; failures record readiness evidence and internal draft/manual-review metadata while GitHub PRs still open ready for review.
The generated implementation PR body includes the original user request, the agent's summary, and failed configured gate output when present.

Post-execution structured logs carry `observabilityUtility` so Datadog queries can separate noise from action: `trace` uses debug breadcrumbs, `progress` and `decision` use info, `degraded` uses warn for recoverable/manual-review publish paths, and `failure` uses error for broken post-exec machinery.

The control plane creates or updates PRs from `post_execution` when the effective push outcome is `true`: `pushed` from the event when present, else the queue layer falls back to a persisted push outcome written by an earlier `push_complete` or `push_error` event. If the effective outcome is false or cannot be resolved, the queue layer fails the publish closed with a terminal `publish.failed` event rather than stalling in `finalizing`.

Commit messages, PR titles, and PR bodies are deterministic: commit messages default to `"Apply changes"`, titles are resolved by `resolvePrTitle`, and PR bodies are rendered by `renderPrEvidenceCommentFromReadiness` (with `fallbackPrBody` as a backup). There is no follow-up LLM polish path.

## Session replay and exports

Unbounded list endpoints need pagination. Default page size is `50`, max is `100`, and cursor-based pagination is preferred.

`/api/sessions/:sessionId/events/history` is the replay/backfill contract and intentionally uses sequence cursors instead of the generic `{ data, nextCursor }` shape. The canonical page shape is `SessionReplayPage` (`shared/types/session-replay.ts`); the HTTP envelope is `SessionReplayResponse` and the WebSocket frame is `{ type: "replay_page", ...SessionReplayPage }`. They expose the same semantic fields: `afterSequence`, `beforeSequence`, `events`, `hasMore`, `droppedCount`, `firstSequence`, and `lastSequence`. `droppedCount` is a lower-bound truncation signal: `1` means at least one replay event was omitted.

Replay limit caps differ by transport on purpose: HTTP `events/history` uses `SESSION_REPLAY_MAX_LIMIT = 1000`, WebSocket `request_replay_page` uses `REPLAY_PAGE_SIZE = 200`, and the WebSocket `subscribed.replay` bootstrap uses `REPLAY_WINDOW_SIZE = 500`. See `shared/constants/session.ts` for the rationale; do not unify them.

Replay validation fails visibly on every transport. HTTP returns `400` with `{ ok: false, error }` for malformed query params. The WebSocket handshake (`?afterSequence=...`) returns `400` before accepting the upgrade. Inside an open WebSocket, malformed `request_replay_page` payloads receive `{ type: "replay_error", message }` and the connection stays open.

Cross-user or unauthorized replay/export access fails closed with `404`, deliberately not `403`, to avoid leaking session existence to non-owners. Prompt-scoped replay (`prompt_id`) is HTTP/MCP-only; WebSocket replay is for live reconnect/backfill and bootstrap.

`/api/sessions/:sessionId/export` is the full-session export contract. Use it for export, eval, feedback, and repair flows that need the entire session in one read; do not use replay for those. Do not blur replay and export responsibilities without updating routes, tests, and docs together.
