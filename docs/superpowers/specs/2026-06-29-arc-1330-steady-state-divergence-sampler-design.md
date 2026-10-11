# ARC-1330 — Steady-state divergence sampler (QA shadow-soak instrumentation)

**Date:** 2026-06-29
**Branch:** `arc-1330-divergence-sampler` (off `arc-1330-lifecycle-fsm` / PR #6046)
**Status:** approved design → TDD implementation
**Purpose:** generate a *real, honest* `cohort:included` FSM-divergence signal from a QA shadow soak of PR #6046, so we can judge whether the FSM spine tracks legacy before the Wave-10 flip.

## Why this exists (the finding)

PR #6046 ships the FSM in shadow but does **not** wire any live divergence emit. The only
`emitDivergenceMetric` caller is `emitBackfillDivergence` (unwired, and hard-tagged
`excluded_backfilled`). So a soak of #6046 as-is produces **zero** `fsm.divergence` events.

Investigation of the pinned 7-field go/no-go set (`state, verdict, verdict_head_sha,
code_changed_since_verification, verification_run_count, ci_fix_rounds, deadline_at`) found that
only **3 fields are honestly + independently comparable** for a live session:

| Field | Honest? | Why |
|---|---|---|
| `state` | ✅ | `legacyAdapterRecord` maps legacy phase/verification/done → FSM state (the F47 parity guarantee). |
| `verdict` | ✅ | `verdictFromLegacy(verificationState, verificationResult)`; `verificationResult` is on `SessionState`. |
| `verdict_head_sha` (freshness) | ✅ | `verificationVerdictHeadSha === reviewListeningHeadSha` — both on `SessionState` (DO ext). |
| `code_changed_since_verification` | ❌ | FSM-only flag; legacy clears the verdict instead. No legacy source. |
| `verification_run_count` | ❌ | Legacy = cumulative-never-reset; FSM = consecutive-reset-on-pass. Different semantics. |
| `ci_fix_rounds` | ❌ | **No legacy counter exists at all.** |
| `deadline_at` (armed) | ❌ | FSM-only; agrees in shadow only incidentally (spine mostly null too). |

The 4 ❌ fields are **genuine model differences, not FSM bugs** — comparing them would manufacture
false divergence. This is itself a flip-readiness finding: **the specced 7-field go/no-go is not
well-defined for live sessions as written.** Flagged for Wave-10.

## Design

A periodic **sampler** that emits one honest `fsm.divergence` check per active review-listening
session, **off the webhook hot path** (the one real shadow risk — producers are awaited inline).

### Hook
Inside the existing `*/5` review-loop sweep, in `reconcileReviewListeningSessions`'
per-session loop (`apps/control-plane-worker/src/services/review-loop-sweep.ts`), **after** the
guards pass (`session` exists, `status!=archived`, `reviewListeningActive`, `prUrl` matches —
~line 2340). At that point the full `SessionState` is already in hand (one read the loop already
pays for). The call is wrapped in its own `try/catch` (best-effort) so a divergence fault never
perturbs the sweep. Skipped unless `parseFsmMode(env.FSM_MODE) !== "off"`.

### New module: `apps/control-plane-worker/src/session/fsm/steady-state-divergence.ts`
`emitSteadyStateDivergence(deps, input)` (mirrors `emitBackfillDivergence`, but for live sessions):

1. **Spine side:** `getPrCoordination(db, sessionId)`; if `null` → skip (no spine row yet). Project
   via `divergenceStateFromRecord(divergenceViewOf(row))`.
2. **Legacy side (independent — F41):** build a `LegacyAdapterInput` from `SessionState`:
   `phase: "review_listening"` (the sampled cohort), `prUrl`, `headSha: reviewListeningHeadSha`,
   `verificationState`, `verificationResult`, `reviewLoopDoneState`,
   `cycloidDone: {state, outcome, reasons}`. Then derive the legacy `DivergenceState`:
   - `state`, `verdict` ← `legacyAdapterRecord(input)` (canonical mapping).
   - `verdictFresh` ← **honest**: `verdict==null ? null : verificationVerdictHeadSha === reviewListeningHeadSha`
     (NOT the bare adapter's always-null → always-stale).
   - 4 secondary fields ← **copied from the spine snapshot** (neutralized: they agree by
     construction, so they never enter `divergent_fields`). Their raw spine values stay on the
     `pr_coordination` D1 row (read directly during analysis), so the soak still *sees* them without
     polluting the rate.
3. **Cohort:** `classifyDivergenceCohort({ autoCreatePrOff: getUserSettingsIfExists(db, ownerUserId)?.auto_create_pr_enabled === 0, backfilledNotClean: false })`
   → `included` for a normal session.
4. **Emit:** reuse `emitDivergenceMetric` (the canonical `fsm.divergence` payload — cohort / diverged /
   primary_divergent_field bounded tags + spine_state / legacy_state drill-down). Best-effort try/caught
   (inherited — `emitDivergenceMetric` swallows DD failures internally).

`divergence.ts`, `legacy-adapter.ts`, `backfill.ts` are **unchanged** (reused as pure imports).

### Data flow
`*/5 cron → runReviewLoopSweep → reconcileReviewListeningSessions → [guards] → emitSteadyStateDivergence → getPrCoordination + legacy snapshot → computeDivergence → fsm.divergence (env:qa) → us5 Datadog logs → manual rate analysis`.

### Error handling / isolation
- Mode gate (`off` → skip), `env.DB` presence gate.
- Whole call try/caught in the sweep loop; `postStructuredEventToDd` already internally try/caught.
- A divergence fault increments nothing and never affects the sweep's healRef / reconcile work.

## Testing (TDD, written first)
`tests/test_cloudflare/fsm/steady-state-divergence.test.ts`:
- normal session → emits `fsm.divergence`, `cohort:included`.
- no spine row → no emit (skip).
- `state` mismatch → `diverged=true`, `primary_divergent_field=state`; agreement → `diverged=false`.
- `verdict_head_sha` freshness is **honest** (fresh verdict on matching head ⇒ not stale).
- secondary fields **neutralized**: spine `verificationRunCount=3/ciFixRounds=2/codeChanged=true/deadlineArmed=true`
  with agreeing state/verdict ⇒ `diverged=false` (no secondary field leaks into `divergent_fields`).
- `autoCreatePrOff=true` ⇒ `cohort:excluded_off_user`.
- emit failure swallowed (best-effort).

Wiring (the one-line sweep hook) is covered by the QA soak itself (E2E) + typecheck.

## Out of scope (deliberate)
- The 4 secondary fields' honest comparison (needs a Wave-10 legacy-counter derivation that doesn't exist).
- Pre-PR transient states (GENERATING/AWAITING_INPUT/FINALIZING) — sampler covers the post-PR cohort only.
- Terraform metric/dashboard for QA (env:production-scoped; QA reads raw logs).
- True legacy `phase` derivation for settled/blocked-while-listening edge cases (documented approximation; drill-down surfaces it).

## Reversibility
New file + one best-effort call site on a throwaway branch. `git revert` or redeploy `main`. Off the hot path. Promotable toward the real Wave-10 PR-45 producer if the soak validates the approach.
