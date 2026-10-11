# Agent config

Public-agent registry: `shared/agent/constants.ts`. Metadata for API validation and UI agent names only; it does not inject prompts, permissions, tool policy, output limits, model parameters, or step budgets. Agents are backend-neutral: sessions run on `codex` (default) or `claude_code`, derived from the selected model or set at session create (see [docs/bridge.md](bridge.md#agent-runtime-backends)).

## Builtin agents

| Agent    | Mode     | Purpose                           |
| -------- | -------- | --------------------------------- |
| `build`  | primary  | Default coding agent.             |
| `verify` | primary  | QA Tester for existing PR checks. |
| `review` | internal | Zeus · Code review.               |

Zeus automatically reviews a known Codex-authored PR with the Claude Code
session-start default when the owner's Anthropic credential is runnable.
Known Claude Code authors are reviewed by the Codex default; unknown, OpenCode,
missing, or uncredentialed author context falls back to Codex.

The code reviewer and QA Tester are separate session/runtime roles. A triggered
code review uses `agentRole: "review"` with `agentProfile: "review"`; it runs its
own agent process, publishes only the structured review, and never enters the QA
phase pipeline. QA keeps `agentRole: "verification"` and `agentProfile: "verify"`.

`qa=true` at a control-plane entry point normalizes to:

- `agentRole: "verification"`
- `agentProfile: "verify"`
- `harnessKind: "codex-session"`
- `runtimeStartupProfile: "verification_ready_runtime"`
- `verificationRuntimeMode: "none"` by default; verification v2 defers app/runtime startup until the launcher phase

Absent or false `qa` keeps the implementation path:

- `agentRole: "implementation"`
- `agentProfile: "build"`
- `harnessKind: "codex-session"`
- `runtimeStartupProfile: "implementation_default"`

Implementation sessions are prompted to implement the change and make applicable checks succeed; configured `.cycloid.json` `verify.test` commands are treated as pre-publish gates, not as a synthesized verification verdict.

QA Tester sessions receive PR context and parent session prompts (from the spawning implementation session), use the verification-ready runtime profile, publish or update the managed PR QA comment, and can mark the draft PR ready when the final judge reports `CONCLUSIVE` for the current head. The phase pipeline is proof-contract based: planner decides skip/run and required QA proof, launcher prepares runtime/auth handles only when needed, operator gathers evidence, and judge emits the only normal non-skip terminal verdict. App/runtime startup is deferred until launcher. QA-only: test, gather evidence, report problems; never edit code, commit fixes, push to the PR branch, or judge remote GitHub CI/check status.

Automatic and comment-triggered QA testers inherit the parent implementation session's backend/model when the pair is known, valid, and credentialed for the QA Tester owner: Claude parents test with Claude Code, Codex parents test with Codex, OpenCode parents test with OpenCode. Missing, unknown, invalid, or unavailable parent runtime falls back to the Codex default. The v2 phase pipeline is backend-neutral through `AgentRuntimeAdapter`; Claude Code keeps one persistent SDK `query()` across phases.

Public API, Slack, and GitHub comment triggers use `qa=true`.

QA testing does not route by broad PR class. The planner names required QA proof from repo docs, scripts, changed files, nearby tests, and risk surfaces; the launcher prepares needed runtime handles; the operator produces evidence for the required proof. Screenshots count as evidence only when they show the changed behavior; generic app state is not behavioral proof.

Verdict semantics are strict. `CONCLUSIVE` means QA testing found the requested behavior works with no blockers and no missing required QA evidence. Any sort of blocker is `INCONCLUSIVE`. The QA Tester must never use `CONCLUSIVE` to mean it conclusively found a blocker. Remote GitHub CI/check-run state is outside QA Tester scope; CI ingestion and review-loop machinery own that signal. Before treating a QA environment problem or missing evidence as a hard blocker, the QA Tester must try the obvious path, repair local setup without editing tracked files, and find an alternate evidence route. Each `blockers` entry must document what was attempted and why the blocker is hard. Policy may also schedule QA testing automatically after the review loop settles.

### PR takeover implementation sessions

An explicit takeover session continues an existing PR head branch rather than creating fresh work from the base branch.
On the first turn, the bridge injects bounded PR context containing the description, changed files, commits, discussion, reviews, checks, and workflow state gathered by the control plane.

The takeover guidance requires the agent to read that context and the live PR with gh pr view, gh pr diff, gh pr checks, and gh run view --log-failed as needed before editing.
The agent commits on the current head branch, lets publish update the same PR, never rewrites published history, and resolves conflicts by merging the base branch into the head branch instead of rebasing.
GitHub PR content remains untrusted reference material; repository instructions and the user's task remain authoritative.

### QA Tester prompt inventory

| Prompt source                                                           | Decision it owns                                                                                                                                | Evidence it may gather                                                                                                                              | Evidence it must not substitute                                                                                                                                                     | Why retained                                                                                                                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static QA Tester system context (`buildVerificationAgentSystemContext`) | Defines QA-only role, strict verdict semantics, required evidence by surface, safety boundaries, and injected PR/runtime/parent-prompt context. | Direct QA evidence for the changed surface: operated app path, API/runtime path, CLI/library command, data path, focused local checks, docs checks. | Remote GitHub CI status, generic app load/login screenshots, static review for runnable user-visible behavior, or nested Cycloid sessions without a readable transcript/state path. | This is the common contract for legacy and phased QA runs; it prevents `CONCLUSIVE` from meaning "found a blocker" or "looked plausible."                              |
| Phase planner prompt (`buildVerificationPlannerPrompt`)                 | Names acceptance criteria, required proof claims, runtime/user-path need, skip/run, and route (`full` vs `planner-judge`).                      | Bounded PR context, parent prompts, changed-file/diff evidence already supplied in context.                                                         | Runtime startup, browsers, tests, external side effects, or treating static checks as enough for behavior a user/downstream system can trigger.                                     | It keeps expensive runtime setup targeted, but now must mark runtime/user-path proof required when files, prompts, docs, runtime config, or discussion imply behavior. |
| Phase launcher prompt (`buildVerificationLauncherPrompt`)               | Converts the effective proof contract into runtime/auth/readiness handles and setup blockers.                                                   | Runtime boot/auth/health/seed/session diagnostics and setup attempt logs under phase evidence.                                                      | Product behavior verdicts, source edits/fixes, PR mutations, or preserving a planner shortcut when context shows runtime proof is required.                                         | It isolates environment setup from product operation and can correct planner omissions by preparing runtime when the effective contract requires it.                   |
| Phase operator prompt (`buildVerificationOperatorPrompt`)               | Executes the changed scenario and records direct proof or explicit missing/blocked proof.                                                       | Operated browser/user journey, screenshots/WebM, API/session/log/database support, focused commands, before/after or performance measurements.      | Static review, API/log/database reads, generic screenshots, or passing commands as replacements for an operable runtime/user journey when the app path is required and runnable.    | It is the phase that actually proves behavior; missing required runtime proof must become a blocker instead of quiet success.                                          |
| Phase judge prompt (`buildVerificationJudgePrompt`)                     | Emits the only normal terminal verdict or terminal skip after reconstructing the effective proof contract.                                      | Prior handoffs and selected publishable evidence refs.                                                                                              | New commands, runtime operation, source edits, remote CI state, or accepting missing operated proof as `CONCLUSIVE`.                                                                | It is the final fail-closed check: `planner-judge` is valid only when no runtime/user-path proof was required or that proof already exists.                            |
| Judge repair prompt (`formatJudgeRepairPrompt`)                         | Repairs malformed terminal output without changing the proof contract.                                                                          | Original judge output and route summary.                                                                                                            | Invented launcher/operator evidence, remote CI state, or a different route rationale than the prior handoffs support.                                                               | It keeps malformed model output deterministic while preserving the same strict verdict semantics.                                                                      |
| Final structured result/skip fences                                     | Carries machine-readable QA result, publishable evidence refs, blockers, or explicit terminal skip rationale.                                   | Concise citations and selected evidence files under allowed evidence roots.                                                                         | Phase notes as PR evidence, empty publishable evidence for `CONCLUSIVE`, or skip when behavior proof was required.                                                                  | The control plane, PR comments, and review loop need a bounded schema; validation demotes unsupported `CONCLUSIVE` evidence.                                           |

## Plan agent

`plan` is an internal-only profile in `shared/agent/constants.ts`; `getValidAgentNames()` excludes it from public API selection. The control plane dispatches only the first prompt of an eligible `planMode` session with `agent` and `agentProfile` set to `plan`; `agentRole` remains `implementation`.

Plan turns are read-only research turns.
Codex applies a read-only/no-network per-turn `sandboxPolicy` before shell or file execution; execute turns explicitly reset Codex to `dangerFullAccess` so a prior plan turn cannot leak read-only state.
Full Codex plan-turn support remains a capability gap until first-party MCP dynamic tools are also pre-execution gated.
The entire final response must be readable markdown starting with `# Plan`.
Core-required headings are Intent Restatement, Ordered Steps, and Files To Touch.
Scope In/Out, Approach, Verification Plan, Risks, Breadth, and Open Assumptions are include-when-useful headings; code, config, infra, auth/security, migration, and user-visible behavior changes must still include Verification Plan and Risks.
The plan profile must not edit files, run mutating bash, commit, spawn child sessions, invoke mutating first-party tools, or ask the user questions.
The session DO captures every plan revision as a private artifact. Sessions with `planApprovalRequired=false` keep the legacy auto-splice into a build-profile implementation prompt with bounded `planContext`; gated sessions persist `pending`, freeze queued work, and wait for Accept, Edit, or a plan-profile Discuss turn.

Repo agent overrides can add or rename public agent metadata only:

- `name` is always the map key.
- `description` is user-facing metadata.
- `mode` must be `primary`; internal repo agents are rejected.

Stale config keys (`prompt`, `temperature`, `steps`, `tools`, `permissions`, `outputLimits`, `options`) are not part of the supported agent contract.

## Repo-local agent profiles

Repo-local prompt profiles live under `.cycloid/agent-profiles/`. When the index exists, the bridge injects `.cycloid/agent-profiles/index.md` as the first per-prompt repo guidance (before skills). The agent reads a linked profile only when the prompt clearly matches it.

Profiles are primary guidance; skills are tactical and must not override the active profile.

## Onboarding agent

Authors a repo's runtime + test contract (`.cycloid.json`, `.cycloid/` support files, `CYCLOID.md`) and proves the app boots from inside its sandbox; its work publishes automatically as a setup PR. The full prompt — the `.cycloid.json` schema and the ladder below — is `buildOnboardingAgentGuidance()` in `apps/sandbox-bridge/src/constants/bridge.ts`, injected at session start and pinned by `tests/test_agent/constants.test.ts`. That function is the source of truth; this section summarizes the rungs so PR-body and Linear references are decodable. Current validation state and known gaps: [onboarding-agent-status.md](onboarding-agent-status.md).

### Custom sandbox layers

When the repo needs a toolchain the base sandbox lacks — a language runtime (Go, Swift, Rust, etc.), a CI-invoked CLI (an IaC or cloud tool), or a system package — the onboarding agent runs `cycloid sandbox init`, edits `.cycloid/sandbox.layer.Dockerfile` (`RUN`/`ENV` only), sets `.cycloid/sandbox.yaml` smoke checks asserting the new tools, and statically validates it with `cycloid sandbox validate` — all in-session — and includes the files in the setup PR. Detection is scoped to the whole repo's toolchain surface, not just the one service that boots, and enumerated from manifests, Dockerfiles, and CI across the tree — CI run-steps are a first-class detector and the durable signal when a stripped/skeleton checkout has deleted the source a manifest scan keys on. A tool a service's own image provides is container-provided and stays out of the host layer. It skips this when the whole repo is base-sufficient. The layer is not built during onboarding: building needs admin auth and the files on the default branch, so the PR report hands off the post-merge `cycloid sandbox build <owner/repo> --ref <default-branch> --wait --follow`, where `<default-branch>` is the repo's default branch read from git — the part after `origin/` in `git symbolic-ref --short refs/remotes/origin/HEAD`, or the `HEAD branch` from `git remote show origin` — not assumed, for a business admin to run after merge. See [sandbox-templates.md](sandbox-templates.md). Auto-build-on-merge is a follow-up.

### R1–R4 completeness ladder

The agent boots the exact `appRuntime` entry it wrote and works DOWN the ladder only on evidence — each descent records the exact `docker compose up` command and the verbatim error that forced it. Published PR bodies and Linear tickets cite the rung reached (e.g. `Boot Ladder Achieved: R4 static config validation only`):

- **R1** — full stack boots; migrations and seed run in the boot chain; auth validates with a locally-seeded non-2FA user.
- **R2** — full stack boots with migrations; auth deferred, with the exact missing input named.
- **R3** — primary app only.
- **R4** — static config validation only.

Boot proof: a 200 from a sign-in or health route does not count; R1/R2 evidence must come from a DB-backed endpoint or a logged-in page after migrations ran. `ready.timeoutSeconds` is measured at the rung achieved.

Descent gate: the agent may not publish a rung below R2 for a service it did not boot unless its report shows, for that service, the exact `up` command + verbatim error, traced vault/env fallbacks with placeholder env set and re-run, and (for an auth block) the failed fixture/seed search. The only valid reasons to settle at R3/R4 are an external dependency unreachable from the sandbox (named exactly) or a non-runnable IP-safe skeleton — which lands at R4, not R3, because the product cannot boot at all. On a skeleton, R4 is the honest, expected rung: the deliverable is a real runtime config plus a customer fill-in checklist, not a sandbox boot.

## Related behavior

The QA Tester agent is auto-scheduled when a PR's review loop settles
(`done`, regardless of the CI verdict at settle time); its `needs-work` verdict
feeds a `verification` review-loop epoch whose prompt admits the managed QA Tester comment.
See [lifecycle.md](lifecycle.md#review-loop--qa-testing-rla-v2) for the
loop/QA-testing handshake.

Codex owns context compaction internally. Cycloid only translates Codex
compaction events for persistence and UI replay.

Session titles are generated by `apps/control-plane-worker/src/services/session-title.ts`, not by agent config.

## Cached system prefix invariant

For `claude_code`, the SDK system prompt is fixed at `query()` open and reused for
every turn, so its bytes are prompt-cacheable. To keep cache hits across turns,
resumes, and (for matching inputs) sessions on the same key:

- The cached prefix = `claude_code` preset + a byte-stable `append`
  (`buildSessionStaticBehavioralGuidance()` + optional repo project doc). It must
  contain no per-turn volatile content.
- The append is keyed on session-static inputs: agent role, repo project doc, and
  `ARCANIST_PREVIEW_CONTRACT_JSON` (E2E-runtime guidance via
  `e2eRuntimeSupported()`). Cross-session cache identity therefore requires the
  same key AND the same append inputs, not merely the same key.
- All Cycloid-owned per-turn volatile content (diagnostics,
  active memories, workspace state, identity) goes in the per-turn user message's
  `<cycloid-system-context>` block (`buildUserMessage`), never in the append.
- The preset uses `excludeDynamicSections: true` so the SDK's own dynamic sections
  (working directory, git status, auto-memory) are stripped from the prefix and
  re-injected as the SDK's first user message — otherwise they invalidate the
  prefix on resume (git status changes after commits). This is distinct from
  Cycloid first-party dynamic tools, which `claude_code` sessions do not expose.
  Future prompt-assembly changes must not move Cycloid-owned volatile content into
  the append/system prefix.
