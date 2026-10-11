# ARC-1401 Plan Mode P0 — always plan, then auto-execute

**Ticket:** [ARC-1401](https://linear.app/cycloid2/issue/ARC-1401/plan-mode-autonomous-plan-then-execute-p0) · **Owner:** Jag · **Status:** design approved 2026-07-02; implementation gated on Jag's explicit go.
**Team mandate:** the archived orchestration sequencing plan's Phase 1 keystone — "Always make a plan, then auto-run. The setting to wait for user approval comes later — v1 is plan-then-execute."

All code anchors verified against origin/main @ `fb4f9a564` (2026-07-02). Line numbers drift; function/file names are the stable references. Hardened by a 3-round adversarial spec review (Claude + Codex, 2026-07-02): gating hole (opt-in bypass), DO-persistence mechanism, queue-race semantics, Codex worktree bleed, question-flow stall, and payload cloning were all found there and are folded in below.

## Problem

Cycloid implements end-to-end and opens a PR from ambiguous prompts, skipping the plan/spec step engineers actually do. P0: every eligible session produces a readable plan first, then auto-executes it into one PR — same session, no human gate.

## Decisions locked (Jag, 2026-07-02)

1. **Handoff shape: two prompts via the control plane.** Plan turn → DO self-enqueues the implement turn. Not the bridge-internal single-prompt pipeline.
2. **`autonomy_mode` setting: deferred to ARC-1381.** P0 hardcodes auto-execute. No migration, no dead setting.
3. **FSM `PLANNING` state: separate follow-up ticket.** The genesis arc is structurally shadow under every `FSM_MODE` (`transport-producer.ts` `transportResolverForMode` scope guard; `dispatch_prompt` inert in `live-side-effects.ts`), so a `PLANNING` state today is observability-only. Change-list preserved in Appendix A.
4. **Plan surface: transcript-native + durable artifact.** The plan turn's response *is* the plan; no dedicated UI card in P0 (rides with ARC-1381's approval surface). *Amended in spec review:* the plan is the whole final response (`# Plan` markdown), not a fenced block — fences render as monospace code blocks in the transcript and Slack, defeating this very decision.
5. **ARC-169: superseded.** v1 plan mode (PR #618, extended by #638 auto-detection) was removed end-to-end 2026-04-30 (PR #2640, −1210 lines). Zero live remnants; nothing to reuse. v1's manual approve/reject gate and prompt-text auto-detection are exactly what this design forbids.

## Architecture

```
create session (planMode resolved at chokepoint, disable-only public field)
  └─ prompt 1 dispatched with agent+agentProfile "plan"  ──►  plan turn
       agent researches repo (read-only); its ENTIRE final response IS the plan
       ("# Plan" markdown) — renders natively in transcript/Slack
       DO captures the durably-persisted final response → session plan record + S3
       post-execution: no publish; terminal user-facing side effects suppressed
  └─ DO enqueues prompt 2 locally with agentProfile "build"  ──►  implement turn
       (ahead of any queued user follow-ups; once-only; not on stopped sessions)
       profile switch mints a FRESH agent conversation (same sandbox/worktree,
       worktree asserted pristine); original prompt payload + bounded planContext
       injected; normal lifecycle → one PR
```

Why two prompts: the post-plan seam is where ARC-1381 approval and Phase-3 fan-out later hook in; each turn is an ordinary, battle-tested prompt lifecycle; the plan is a first-class visible turn.

## Components

### `plan` agent profile (no new agentRole)

- Add `plan` to `BUILTIN_AGENTS` (`shared/agent/constants.ts`; currently build/verify/onboard) with **`mode: "internal"`** — `getValidAgentNames()` already excludes internal agents from API callers, so `plan` is never user-selectable; user-supplied `agent: "plan"` on a prompt is rejected like any invalid agent name. The DO's first-prompt dispatch sets it via an internal override (both `agent` and `agentProfile` on the command — the bridge derives `requestedAgent` from `agent` and keys guidance off `agentProfile`, so both must be set). `agentRole` stays `implementation`.
- Rationale: unknown `agentRole` strings are silently coerced to `implementation` at ~4 hand-maintained whitelists (`durable-object.ts` normalizer, `do-db.ts` read coercions ×2, bridge `normalizeAgentRole`) — the `superseded`-phase failure class. Profile-keyed behavior (the onboarding precedent) avoids the union widening entirely.
- `reviewVerificationExemptReason` needs no change: the plan turn produces no PR; the implement turn runs as plain `build`.

### `planMode` session field + resolution

- `planMode?: boolean` on `CreateSessionOptions` (`session/state.ts`, interface ~:524) and `SessionState` (`types.ts` ~:210). **No D1 `session_index` column/migration in P0** (nothing lists/queries by it) — but persistence is not free: extended-session fields are column-mapped in DO SQLite, so `planMode` joins the `do-db.ts` extended-session columns (insert list ~:214, both read-backs ~:299/:477, update mapping ~:576) with a schema-session DDL addition; old sessions default `false` on read. The handoff driver must read it back correctly after DO eviction.
- Resolved inside `createSessionState` (the `resolveAutoVerifyEnabled` pattern) so every entrypoint inherits one rule. **The public field is disable-only:** `planMode === false ? false : (isCycloidMember(ownerUser) && eligible)`. `planMode: true` from a non-gated caller must NOT force the internal feature on (ignored/rejected); gate lookup failure fails closed to OFF. Membership is evaluated on the resolved owner-user row (`isCycloidMember`), which covers webhook entrypoints that have no request-time browser auth; impersonated operators inherit the actor-aware `verify*` semantics on the API path.
- Eligible: new parent implementation sessions. Ineligible: QA (`agentRole === "verification"`), onboarding profile, child sessions, `targetPrUrl` fix flows.
- Per-entrypoint behavior (all via the chokepoint; explicit `planMode` only exists on the API): UI/API/CLI **on** (gated), Slack mention/DM **on** (gated), Slack channel automation **on** (gated), Linear/Jira/GitHub-issue webhooks **on** (gated), scheduled rules **on** (gated), child-sessions route **off** (ineligible), auto-QA verifier **off** (ineligible). Uniform-on keeps the "always plan" mandate; automation latency cost is accepted for dogfood and revisited on signal.
- Escape hatch (deterministic, per the sequencing doc's posture): `planMode: false` accepted on `POST /api/sessions` (validated boolean; `routes/sessions.ts` body parse). Update `docs/session-creation-entrypoints.md` **and `docs/api.md`** in the same PR (both docs mandate it; api.md documents that only `false` is a supported public value).

### First-prompt plan dispatch

- Prompt-queue dispatch decision: when `session.planMode` and this is the session's first prompt and no explicit per-prompt agent override → dispatch with the internal plan override (`agent` + `agentProfile` = `plan`).
- Polarity is the *opposite* of onboarding's per-prompt profile pinning (`prompt-queue.ts` pins onboard against overrides): `plan` applies to exactly one turn and must never leak to follow-ups.
- The plan turn inherits the session's model and backend — plan quality is the point; no fast-model override in P0.
- Follow-up user prompts never re-plan in P0.

### Plan guidance (bridge)

- Per-prompt injected guidance section, mirroring the onboarding-playbook injection (`bridge.ts`, `ctx.agentProfile === ONBOARD_AGENT_NAME` branch ~:3839): fires when the prompt's profile is `plan`. Per-prompt injection also sidesteps the init-time staleness of Codex `AGENTS.md` / Claude system-prompt append (both are keyed to the agent session, which the profile switch resets anyway).
- Contract: research the repo and in-repo docs (read-only), then make the **entire final response the plan** — readable markdown opening with a `# Plan` heading. Required sections: intent restatement, scope in/out, approach, ordered steps, files to touch, verification plan, risks, breadth (XS–XL — feeds Phase-3 fan-out sizing), open assumptions. **No fence:** fenced content renders as a monospace code block in the transcript and Slack, defeating the transcript-native surface; whole-response capture also deletes the fence-parsing edge-case class. Never code blocks meant for execution, never edits, never commits.
- **Never ask the user questions.** The plan turn must not invoke the ask-user/question flow (that would park the session in `waiting_for_input`, breaking the autonomous mandate); unresolved items are recorded in the plan's open-assumptions section. Enforced both by guidance and mechanically (question flow denied/auto-proceeded for the plan profile), with a regression test that a question attempt still proceeds to implementation.
- The agent does **not** write `plan.md` itself — capture is platform-owned. This structurally kills the deleted-May-2026 focused-command-planner failure mode (LLM output that the platform executes); plan output is data, never commands.

### Read-only enforcement (tiered, stated honestly)

- Thread the plan profile into `ToolSafetyOptions` (`utils/protection.ts` `checkToolSafety`, currently mode-based only) and hard-deny file edits/writes and mutating bash for plan turns.
- Beyond files/bash, the plan profile is also denied side-effecting tools: `cycloid.spawn_child_session` and any mutating first-party dynamic tools (precedent: the verification-role gate in `services/first-party-dynamic-tools.ts` ~:602-604), plus the ask-user question flow (above). Read/search/status tools stay available; sandbox env exposure is unchanged from any other turn (same posture as implementation).
- Enforcement tier per backend (per audit): **claude_code** — pre-execution in-process `canUseTool` deny (`services/claude-tool-safety.ts`), fail-closed; **OpenCode** — same gate via `opencode-event-translator.ts`; **Codex** — post-hoc detection at tool-part translation (`bridge.ts` ~:1814) with the existing repeated-attempt hard stop; prevention would need Codex read-only sandbox config (out of P0 scope, documented gap).
- **Worktree hygiene bounds the Codex gap:** at the plan→implement boundary the bridge asserts the worktree is pristine and resets it if not (`git reset --hard` + `git clean -fd` — safe here because nothing legitimate has been produced yet), emitting a violation metric when anything was dirty. Plan-turn mutations therefore cannot bleed into the implement turn and get published, on any backend.
- Reads (grep/ls/file reads) stay allowed — planning requires repo research.

### Capture + persistence

- **Capture is DO-side, from state the DO already durably persists:** the plan turn's final response (canonical prompt history / final-answer persistence). No new load-bearing bridge event exists, so a bridge reconnect/crash cannot lose a captured plan — if the prompt completed, the plan text is already durable.
- At plan-prompt completion the DO derives the plan record: secret redaction first (reuse the phase-artifacts redaction helper), size-capped, upserted keyed by the plan prompt id (idempotent across retries/redelivery). Validity check: response non-empty + required headings present (else the fallback path below).
- Full markdown is uploaded as an S3 session artifact via the DO-internal upload path (`uploadSandboxArtifact` internals), content type `text/markdown` under artifact type `log` (already whitelisted — zero schema work), **private visibility** (never the public screenshot/WebM tier); the artifact id is stored on the session plan record. Durable + addressable → forward-compatible with Phase-3 cross-session plan sharing without building it now.
- Shared contract code (plan headings, validity check, context-injection formatting) lives in `shared/` (precedent: `shared/verification/phase-artifacts.ts`).

### Handoff driver (control plane)

- Trigger: plan-prompt completion, keyed off the DO's **own persisted dispatch record** for that prompt (the DO authored the plan override) — NOT the `post_execution` event payload, which carries no `agentProfile` field (verified `shared/events/bridge.ts` ~:198).
- The enqueue is **DO-local** (the driver lives in the session DO and writes its own prompt queue — no cross-DO HTTP hop, unlike the auto-QA scheduler's cross-session `enqueueSessionPrompt`), persisted adjacent to the prompt-completion critical persistence. On failure: retry via DO alarm; a permanently failed handoff surfaces as a session error — never a silent stall.
- **Idempotent and guarded:** once per session (persisted handoff-dispatched flag keyed by the plan prompt id, so post-execution redelivery cannot double-enqueue), and never on a stopped/failed/terminal session (guard checked at enqueue time, after the terminal check).
- **Ordering:** the implement prompt is inserted ahead of any queued user follow-up prompts and enqueued before the plan prompt's completion settle, so (a) a queued follow-up cannot run between plan and implement, and (b) the session never transiently settles to a done/no-PR state between turns. Plan-turn terminal user-facing side effects (Slack "completed" notification, done/no-PR projection settle) are suppressed until the implement prompt is durably enqueued (`plan_handoff_pending` rule). Covered by an explicit race test.
- Implement prompt payload: the original prompt's full payload is cloned — text plus `skills`, `files`, `uploadedFiles`, `uploadedImages`, actor/reply metadata, and memory bootstrap context (upload dedupe is bridge-instance-scoped, so uploads must reinject into the fresh conversation) — plus a new typed `planContext` field on the command (`HandlePromptOptions`/`SandboxCommand`): bounded plan excerpt + artifact ref + missing-reason, wrapped as untrusted content with an explicit char budget. **Not** `verificationParentPrompts` (QA-role-gated, 4k truncation would clip a plan).
- Profile `build` → agent-change reset (`bridge.ts` ~:3582-3588) nulls `agentSessionId` → `createSessionForPrompt` gives a genuinely fresh conversation in the same sandbox/worktree (asserted pristine, above). That is the "write plan → clear context → implement" contract, mechanically.
- Implement turn completes → existing publish path → one PR.

## Error handling

- **Fail-open is the invariant: planning must never stall or kill a session.**
- Invalid plan (empty response / required headings missing) → enqueue the implement turn anyway with a "no structured plan captured" note; emit the `fallback` metric. The response text (whatever it was) still rides along as `planContext`.
- Plan-turn agent error/timeout → existing prompt error handling; if the turn terminally fails, the handoff driver still enqueues the implement turn (plan-less) rather than orphaning the session.
- Handoff enqueue failure → DO alarm retry; permanent failure surfaces as a session error (never a silent stall).
- Sandbox death between turns → the DO/S3 plan copies survive (never depend on a sandbox `/tmp` file); the enqueued prompt dispatches on resume like any queued prompt. Prompt retry/redelivery is safe: the plan record upserts by prompt id and the handoff flag prevents double-enqueue.
- Session stopped during plan turn → normal stop semantics; the terminal guard also stops a post-completion handoff (stop lands between turns → no implement enqueue).
- Queue-race ordering is specified in the handoff section (implement prompt ahead of queued follow-ups, enqueued before completion settle) and carries an explicit race test.

## Observability

- Counters: plan turn ran / plan captured / handoff enqueued / fallback taken / worktree-hygiene violation; plan-turn duration metric (planning adds a serial turn before implementation — Jeman's latency track needs the baseline from day one). Concretely: `cycloid.plan_mode.*` metrics with low-cardinality tags only (outcome, backend, env — never prompt or plan text), duration emitted as `duration_ms` with a `datadog_metric_metadata` unit of `millisecond`, dashboard extension in the agent-behavior Terraform file (`infra/datadog-agent-behavior.tf`) via the existing log-metric/monitor modules — Terraform only, never the Datadog UI.

## Rollout

- Behind the internal feature gate (`services/internal-feature-gate.ts`, `isCycloidMember` on the resolved owner-user row — prod + QA Cycloid businesses): plan mode defaults ON for eligible sessions of gated users, OFF otherwise, fail-closed OFF. Dogfood → judge plan quality + PR-alignment signal → remove the gate.
- Kill switch = the gate itself plus per-session `planMode: false`.
- Deploy surfaces: control-plane worker (`deploy-control-plane.yml`) + E2B sandbox template (`deploy-e2b-sandbox.yml`) — bridge changes require a template build, and `shared/**` changes trigger both workflows. The only `infra/` touch is the dashboard/metric PR (Terraform Cloud auto-apply; no infra↔deploy sequencing hazard since nothing in the deploy depends on the dashboard).
- Docs updated in the same stack: `docs/session-creation-entrypoints.md`, `docs/api.md` (planMode field, disable-only), `docs/prompt-agents.md` (plan profile behavior contract).

## Out of scope (tracked, not built)

- FSM `PLANNING` state → follow-up ticket (Appendix A). `autonomy_mode` + approval gate → ARC-1381. Plan card UI (Edit/Start buttons) → with ARC-1381. Re-planning on follow-up prompts. Cross-session plan sharing (Phase 3). Web search/egress. Smart PR opening.

## Acceptance criteria

1. Vague prompt on a throwaway repo → session produces a plan turn (readable `# Plan` markdown response: scope, approach, steps, files, verification, risks, breadth) rendered natively in transcript/Slack, then implements and opens **one** PR whose diff matches the plan. Evidence = a real Cycloid session (repo E2E policy), not unit tests alone.
2. Plan turn cannot edit/write/commit, spawn child sessions, invoke mutating dynamic tools, or ask user questions on claude_code + OpenCode (mechanically); Codex tier documented, detect-and-stop verified, and the plan→implement worktree reset proven (a deliberately dirtied plan-turn worktree never reaches the PR).
3. Plan persists durably (DO plan record + private S3 artifact) and survives sandbox death and prompt redelivery (no duplicate handoff).
4. Invalid-plan fallback proceeds to implementation with a note + metric; no session stalls attributable to planning; a queued user follow-up never runs between plan and implement.
5. QA/onboarding/child/`targetPrUrl` sessions and `planMode: false` sessions behave exactly as today; `planMode: true` from a non-gated caller does NOT enable plan mode.
6. Metrics above emit; dashboard extended via Terraform.

## Testing / verification

- Unit (same PR as each slice, repo convention): profile resolution + eligibility + gating (incl. non-gated `planMode: true` rejected), first-prompt dispatch routing, plan validity check + redaction, tool-safety denial per backend path (incl. question flow + dynamic tools), handoff enqueue + idempotency + terminal guard + fallback, payload cloning (attachments/skills).
- Integration/smoke (repo convention for cross-module side-effect flows): the DO→bridge→DO handoff flow in `tests/smoke/`, plus the follow-up race test and redelivery/no-double-enqueue test.
- Prompt assembly: the new guidance section changes assembled system context → update/regenerate the prompt golden suite (`tests/test_sandbox-bridge/prompt-golden/`, `UPDATE_PROMPT_GOLDENS=1`).
- Full backend suite after the profile addition (role/profile additions have bitten adjacent tests before).
- E2E: bridge changes do **not** apply via `npm run dev:full` — rebuild the local E2B template (`scripts/e2b-template-build.sh`) first; then a local dogfood session, then QA env. Deliberately vague prompt; assert plan turn → implement turn → one PR; include one Slack-origin session to verify plan rendering + suppressed completed-notification between turns.

## Risks & gotchas (from the M0 audit)

- First-prompt-only anchoring (`bridge.ts` ~:3049-3060, PR-body/branch hints) — verify behavior when prompt 1 is a plan turn.
- Profile switch forfeits transcript continuity by design; confirm resume-from-volume (`restorableSessionId` cleared on agent change) has no surprise for turn 2.
- `buildPromptCommandForDispatch` lives in the **control-plane worker** (`session/prompt-queue.ts`), not the bridge — the ticket's path was wrong.
- Plan injection must use its own bounded `planContext` field; DO phase-note compaction is 8k and parent-prompt truncation is 4k — both too small for a real plan. Full text lives in S3.
- Wave-11 churn: this design touches `prompt-queue.ts` and `durable-object.ts`, both contested by open FSM PRs (#6413 et al.) — rebase-cost, not correctness; sequence merges accordingly.
- Terminal-side-effect suppression (`plan_handoff_pending`) touches the same completion-settle machinery the FSM shadow observes — keep the suppression legacy-side and confirm no FSM divergence-sampler noise from plan-mode sessions during dogfood.

## Appendix A — FSM `PLANNING` follow-up ticket content (deferred)

When the transport arc gains live authority (post-Phase-B), add `PLANNING` between `PROVISIONING` and `GENERATING` (17 states today, `SUPERSEDED` included). tsc-total maps to update: `types.ts` `FSM_STATES` + `_STATE_PRESENCE`; `deadline-producer.ts` `DEADLINE_CLASS_MS` (the real deadline resolver); `project.ts` `STATE_TO_PHASE` (→ `running`), `STATE_TO_FE_CHIP` (→ `working`), `STATE_TO_LABELS`, `STATE_TO_STAGE`, `STATE_TO_PR_STAGE`. Non-tsc-forced: `transition.ts` `coreTransition` (retarget PROVISIONING case + add PLANNING case), `deadlineTransition`, `HARD_FAILURE_STATES`/`NON_TERMINAL_STATES`; `transport-producer.ts` event mapping; `backfill.ts` skip-set + legacy-phase mapping. New `plan.*` events touch six lockstep sites in `types.ts`. `planning_child_id` mirrors the pre-allocated `intent-${sessionId}` guard pattern. **Do not** project a new legacy `Phase` value — reuse `running` (the `superseded` mapping incident). Producer mirrors `verification-producer.ts` (dual-emit, off critical path). Coordinate with Wave-11 owners; `apply-event.ts`/`live-side-effects.ts` are contested.
