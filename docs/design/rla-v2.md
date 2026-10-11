# RLA v2 — CI-First Review Loop with Verification Handshake

Source of truth for the review-loop (RLA) redesign that integrates the verification agent (VA) into the PR lifecycle. Owner: Jagrit. VA-side behavior (verdict semantics, draft demotion/promotion, `VerificationResult` plumbing from PR #4507) is owned by the VA feature owner and is **out of scope** here; this doc covers RLA only.

> **Superseded (ARC-1177): `ReviewLoopDoneState` collapsed to `"working" | "done"`.** The two settled outcomes `done_green` and `done_exhausted` referenced below merged into a single `done` (they always handed off to the VA identically; CI status is visible on the PR). The single applied PR label is `review-loop:done`; the legacy `review-loop:done-ci-red` label and its constant have since been fully removed. Read `done_green | done_exhausted` below as `done`, and the green-vs-red split / "done_green-only in practice" notes as historical context for the pre-collapse design.

> **Superseded (ARC-1330 CI-ladder cut): QA is no longer a merge gate.** The verifier child is spawned at publish (`SPAWN_VERIFICATION_CHILD`) and runs off-gate in parallel; the `caught_up` cascade is a pure CI ladder (`ci_green ∧ no_inflight_epoch → MERGE_READY`). `VERIFYING` is drain-only (no new entering edge). QA verdicts are advisory bookkeeping; a cap/infra failure emits a non-blocking DM, never a `NEEDS_YOU`. References below to `review_timeout_minutes` are historical context from the pre-cut model. Read [fsm.md](../fsm.md) and [lifecycle.md](../lifecycle.md) for the current live model.

Glossary: CGA = code-generation agent (implementation session). RLA = review-loop agent (sweep + epochs). VA = verification agent (separate session, `agentRole: "verification"`).

## 1. Target Flow

```
1. CGA publishes a PR, ready for review (drafting happens only later,
   if VA decides things are bad — VA-owned)
2. RLA CI phase (always on, every PR):
     if CI failing → fix until green or capped
     → ReviewLoopDoneState: done_green | done_exhausted
3. Verification planner phase decides: verification needed?
     if no → verification-skipped, RLA continues
     if yes → VA auto-runs (verificationRuntimeMode: "none"; app/runtime deferred to launcher phase)
     VerificationState: verification-in-progress → verification-done
     VerificationResult: merge-ready | needs-work        (PR #4507)
     RLA is PAUSED for the PR while verification-in-progress
4. on merge-ready:
     VA comment is conclusive; RLA never reads it; loop resumes normal listening
   on needs-work:
     RLA runs a fresh sweep: VA comment + accumulated review comments + CI failures
     → LLM triage → one synthesized work prompt → session addresses it → back to 2
Cycle is capped by MAX_VERIFICATION_RUNS_PER_PR = 3 → verification-exhausted ends it
```

JTBD of VA (context only): (1) is the PR reasonable, (2) has it been tested (conclusivity). `bad_intent` hand-back to CGA is VA-owned.

## 2. Current State (evidence, latest main)

What already exists and what v2 builds on:

- **CI/review epoch split exists.** Epochs carry `source_kind = 'bot'|'human'|'mixed'|'ci'|'mention'`; CI epochs use the `expected_bots_hash='ci-fixes'` sentinel (`services/review-loop-epochs.ts:44`). Eligibility is already split: `resolveReviewLoopChecklist` (bot reviews, needs configured bots), `resolveReviewLoopCiEligibility` (CI, needs no bots, per-repo `ci_response_enabled` default ON), `resolveReviewLoopHumanEligibility` (`services/review-loop-settings.ts:144,186,220`). All three additionally require the user master toggle `user_settings.pr_review_auto_response_enabled`, which **defaults to 0 (opt-in)** (migration 0084).
- **Loop mechanics.** 5-min cron sweep (`router.ts:362` → `services/review-loop-sweep.ts`). Webhooks (`check_run`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`, `synchronize`) ingest into epochs; the sweep claims due epochs, builds prompts (`webhooks/prompts.ts:1081–1179`), and enqueues them to the session. Caps: 5 attempts/epoch, CI same-failure cap 3, CI total backstop 6. Done state: `computeReviewLoopRollup` (`services/review-loop-rollup.ts:80`) → `working | done_green | done_exhausted`. Green CI webhooks also trigger inline done-state reconcile (`services/review-loop-done-reconcile.ts`), but verification starts only after review-loop/no-show state is settled; the sweep backstops the slower worklist poll.
- **RLA→VA handoff exists but is done_green-only in practice.** `scheduleAutoVerificationAfterReviewLoopDone` (`session/verification-auto-scheduler.ts:101`) is called from (a) the `review-loop:done` label webhook (`webhooks/github.ts`) and (b) the DO done-state route — but the DO route only fires on `done_green` (`session/durable-object.ts:5818`). The done label historically does not stick, so the label trigger is unreliable; net effect: VA does not run on CI-red.
- **Verification plumbing.** `VerificationState` (`shared/session/phase.ts:30`) is synced onto linked implementation sessions and PR labels by `syncVerificationStateForPr` (`session/verification-state.ts:194`); D1 `session_index` writes QA-named `qa_testing_*` state/count mirrors. PR #4507 (merged 2026-06-11) added `VerificationResult = "needs-work" | "merge-ready"` (CONCLUSIVE→merge-ready, INCONCLUSIVE→needs-work) with DO+snapshot plumbing and `syncVerificationResultForPr` (no D1 mirror; see §4).
- **QA Tester comment.** Marker `<!-- cycloid-qa:v1 owner=… repo=… pr=… head=… -->`, heading `## Cycloid QA`, `**Verdict:** CONCLUSIVE|INCONCLUSIVE`, structured Summary/Evidence/Blockers (`github/verification-comment.ts:24,403`). Since #4490 the QA Tester only reports; it never pushes fixes.
- **Cycloid-authored comments are filtered out everywhere.** `ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET` and `isCycloidAppLogin` drop them at webhook ingest and worklist build (`webhooks/github.ts`, `github/pr-review-bots.ts`). The VA comment is therefore invisible to RLA today.
- **Actionability is heuristic.** Status-only patterns, generated-summary detection, actionable-section extraction (`github/pr.ts:1384–1533`). Prompts carry the raw worklist (quoted bodies + URLs + sourceIds).
- **Draft machinery (#4331).** INCONCLUSIVE/malformed/outdated-head verification converts the PR to draft (`github/verification-comment.ts:501–582`), `handlePullRequestDraftStateEvent` reacts to `ready_for_review`/`converted_to_draft` (`webhooks/github.ts:2628`), `pr-draft-reconciliation.ts` syncs `pr_draft` onto sessions, UI shows "View Draft".
- **Platform-LLM pattern.** OpenAI `gpt-5.4-mini`, reasoning "low", strict-schema tool calls via `executePlatformLlmCall` (`apps/control-plane-worker/src/services/platform-llm.ts:142`); call types in `shared/llm/platform-llm-contract.ts` (`pr_template_fill`, `review_loop_triage`, `slack_progress_narration`); every feature fails open to a deterministic path when `ARCANIST_OPENAI_API_KEY` is missing or the call fails. Service-tier policy: background calls (`pr_template_fill`) use Flex with 30s timeout and 3 retries; interactive calls opt out of Flex — `review_loop_triage` uses Auto tier with 8s timeout and 2 attempts (fail open quickly to the deterministic worklist), `slack_progress_narration` uses Auto tier with 4s timeout and 1 attempt (live Slack card).

## 3. Work Items

### A. Draft machinery: no RLA changes (re-decided 2026-06-11)

Main already implements the intended model — nothing to comment out:

- Publish always opens PRs **ready for review** (`prDraftOptions` → `draft: false`, `session/publish-service.ts:550`).
- A PR is demoted to draft only when VA decides things are bad: INCONCLUSIVE/malformed/outdated-head verification → `applyVerificationDraftReconciliation` → `convertPrToDraftForVerification` (`github/verification-comment.ts:501–582`). VA-owned, stays.
- The only promote-to-ready path is the full publish flow: `publish-service.ts:2085` → `reconcilePrDraftState` → `markPullRequestReadyForReview` (`github/pr.ts:524`). The `ready_for_review`/`converted_to_draft` webhook (`webhooks/github.ts:2628`) is pure `pr_draft` display sync — no loop triggers. Both stay.
- RLA requirement that falls out: loop eligibility must keep ignoring draft-ness (already true) so the needs-work cycle keeps running on a demoted PR.
- Coordination note for the VA owner: a CONCLUSIVE re-verification returns `not_applicable` and does not auto-promote a previously demoted PR; only a full re-publish does. If merge-ready should un-draft, that hook is theirs.

### B. Pause RLA while verification runs

- Sweep gate: in `processEpoch` and `reconcileReviewListeningSessions`, read the linked implementation session's `verificationState`; if `verification-in-progress`, defer (do not claim/prompt/bootstrap) without consuming attempts. Webhook ingest keeps recording into epochs while paused.
- Resume on `verification-done` (then branch on `VerificationResult`) or `verification-exhausted` (terminal: no further VA-driven work) or `verification-skipped` (routing decided verification unnecessary; RLA continues normally).

### C. React to the VA verdict

- **merge-ready:** nothing to address; RLA does not read the comment; loop resumes normal listening for future human/bot feedback until merge.
- **needs-work:** trigger an immediate fresh sweep for the PR: admit the managed QA Tester comment (located via the `cycloid-qa:v1` marker — a narrow exception to the Cycloid-author filter, only when result is needs-work) into the worklist together with any accumulated review comments and current CI failures; reset done-state to `working`; bootstrap a `source_kind='verification'` epoch (§6.4).
- **Trigger fix:** schedule VA from the DO done-state route on `done_exhausted` as well as `done_green` (today green-only; the label path is unreliable). Coordinate with VA owner so it lands once.

### D. LLM triage replaces heuristic actionability and link-dump prompts

- New platform-LLM call type (e.g. `review_loop_triage`) following the existing pattern: `shared/llm/` contract + tool schema + prompt builder, config in `constants/platform-llm.ts` (gpt-5.4-mini, low effort, strict schema), executed control-plane-side via `executePlatformLlmCall` from the sweep.
- Input: all candidate comments (incl. VA needs-work comment) + CI failure items for the epoch. Output: structured action items — each with the synthesized instruction and the `sourceId`s it covers — plus dropped items with reasons. A deterministic renderer turns action items into the final session prompt, so `cycloid.review_loop_reply` threading keeps working (sourceIds are never LLM-invented; items referencing unknown sourceIds are discarded).
- Replaces the current behavior of forwarding the raw worklist; also subsumes the string heuristics (`isStatusOnlyReviewLoopComment` etc.), which remain only as the fallback path.
- **Fail open:** key missing / call fails / output malformed → current deterministic worklist prompt, nothing dropped. Structured logs + Sentry via `captureLlmProviderFailure`, matching existing platform-LLM features.

### E. Enablement: both loops always-on, no opt-out (decided 2026-06-11)

RLA is required infrastructure for VA and CI testing, so there is **no opt-out anywhere** — not the user master toggle, not the per-repo CI toggle, no new flags, no migration.

- Stop reading `user_settings.pr_review_auto_response_enabled` and `user_pr_review_bot_settings.ci_response_enabled` in all three eligibility gates (`review-loop-settings.ts`); the columns stay (append-only schema), the gates keep only the installation-capability check (fail closed — lacking GitHub perms is inability, not opt-out).
- The only remaining knob, scoped to the **code-review RLA only** (never the CI loop): the expected-bots checklist (add more bots if you want).
- VA needs-work handling must not require a configured bot checklist (zero-bot repos still get the full cycle).
- UI: remove the "Respond on PRs from your sessions" master toggle and the "Respond to CI failures" toggle from `GeneralSettings.tsx`; keep bots + collection-window controls. Settings API keeps accepting the dead fields for compat but they no longer affect behavior.

### F. Automatic VA runs after RLA and CI settle

Between PR publish and automatic VA, RLA dispatches bot/human/CI epochs normally. The done rollup only schedules VA after CI is settled, no active/pending review-loop epochs remain, queued bot/human comments have been handled, and the expected-reviewer no-show window has elapsed when no review signal arrives. `review-loop:done` still waits for a terminal approving verifier result, so VA remains the final judge. (Updated 2026-06-29.)

### G. Docs, tests, telemetry

- Update `docs/bridge.md` / `docs/lifecycle.md` / `docs/prompt-agents.md` review-loop sections.
- Tests per slice (see §5); extend `review-loop-sweep`, `review-loop-rollup`, `verification-state`, webhook-dispatch suites; new triage unit tests with mocked platform-LLM.
- Datadog counters for: pause/resume events, VA-intake epochs, triage outcomes (used/fallback/dropped counts). Monitors, if any, via `infra/*.tf` only.

## 4. Constraints and invariants

- All gates fail closed on auth/capability; the LLM triage fails **open** to the deterministic path (feature degradation, not a security boundary).
- D1 access stays in DAO functions; schema changes are append-only migrations; routes→services→DAOs layering.
- PR #4507 (`VerificationResult`) merged 2026-06-11 (`2b1a75d73`). Verified it carries what RLA needs: the type + `verificationResultFromAgentVerdict` (`shared/session/phase.ts:39`), result synced onto linked implementation sessions (`syncVerificationResultForPr` → `resolveImplementationSessionIds`, `session/verification-state.ts:267`), and readable by the sweep via `getSessionState` (`SessionState.verificationResult`, `types.ts:214`). Two intentional non-gaps: (a) no D1 `session_index` mirror for `verification_result` — irrelevant, the sweep reads DO session state per PR ref, not D1 queries; (b) **nothing resets the result when a new verification run starts** — an outdated `needs-work` from run N persists while run N+1 is in progress. Therefore RLA must treat `verificationResult` as meaningful only when `verificationState === "verification-done"`, and slice 3 (`rla-v2-va-intake`) clears the result (sync `null`) when the auto-scheduler sets `verification-in-progress`.
- VA attempt budget stays `MAX_VERIFICATION_RUNS_PER_PR = 3`; RLA epoch caps unchanged (5 attempts, CI 3-same/6-total). `verification-exhausted` is terminal for the VA↔RLA cycle; rollup then reports `done_exhausted` unless CI is green.
- Webhook ingest is never disabled by pausing — pausing only defers dispatch.

## 5. PR stack (Graphite, one concern per PR)

| #   | Branch (jagrit/…)      | Content                                                                                                                                                                                       | Depends on |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | rla-v2-spec            | This doc                                                                                                                                                                                      | —          |
| 2   | rla-v2-va-pause        | Work item B (+ tests)                                                                                                                                                                         | —          |
| 3   | rla-v2-va-intake       | Work item C: needs-work sweep, marker admission, done_exhausted trigger, result reset on new run, 0122-style epochs-table rebuild migration for `source_kind='verification'` (§6.4) (+ tests) | —          |
| 4   | rla-v2-triage-contract | Work item D part 1: shared/llm contract + config + builder, unused (+ tests)                                                                                                                  | —          |
| 5   | rla-v2-triage-wire     | Work item D part 2: sweep integration + fallback (+ tests)                                                                                                                                    | 4          |
| 6   | rla-v2-always-on       | Work item E: drop toggle reads from gates, UI toggle removal (+ tests)                                                                                                                        | —          |
| 7   | rla-v2-ci-first        | Work item F: pre-VA dispatch gating (+ tests)                                                                                                                                                 | 2, 3       |
| 8   | rla-v2-docs            | Work item G docs/telemetry remainder                                                                                                                                                          | all        |

(Former draft-removal slice dropped — work item A requires no code change.)

Verification: unit tests + `npm run typecheck` + `npm run lint:changed` per PR; full-flow E2E as a Cycloid session on QA after the stack reaches QA (CI-fail PR → fix → VA → needs-work → RLA addresses → merge-ready).

## 6. Decisions

Resolved 2026-06-11:

1. **No opt-out anywhere** (user decision). RLA is required for VA and CI testing; both loops are always-on. The master toggle and `ci_response_enabled` stop being read; the only knob is the expected-bots checklist, and it affects only the code-review RLA. See work item E.
2. **PR #4507 verified sufficient** for the verdict handshake; the only addition RLA makes is clearing the stale result when a new run starts (see §4).
3. **Pre-VA comment deferral: queue** (adopted by default). Comment epochs collect but do not dispatch until the first VA verdict.
4. **VA epoch representation: new `source_kind='verification'`** (adopted by default). Needs a 0122-style epochs-table rebuild for the CHECK constraint.
5. **Draft machinery stays as-is** (re-decided 2026-06-11, supersedes the earlier comment-out plan). Main already ships the intended model: publish opens ready-for-review; VA demotes to draft on a bad verdict; full publish is the only promote path. RLA v2 makes no draft changes — see work item A for the verified mechanism and the one VA-owner coordination note (no auto-promote on merge-ready).

## 7. Out of scope

- VA behavior, prompts, verdict semantics; all draft demotion/promotion machinery (VA-owned, already final on main); PR #4507 itself.
- Business-level (vs user-level) review-loop settings; settings UI revamp.
- review-loop sweep-starvation fix (separate work, see review-loop-sweep budget).
