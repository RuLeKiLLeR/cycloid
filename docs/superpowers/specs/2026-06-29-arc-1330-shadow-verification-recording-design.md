# ARC-1330 — Record verification in shadow (pre-Wave-9 fix)

**Date:** 2026-06-29 · **Branch:** `arc-1330-divergence-sampler` (→ folds into #6046 before Wave 9 merge)
**Status:** approved approach (A1 + parent-keying + self-sourced run-id + B1 gate + B2 triage), keystone review pending on the new edge.

## Problem (soak-proven)
In shadow, the FSM spine **never records verification**: 0/32 QA `pr_coordination` rows ever entered VERIFYING, bumped `verification_run_count`, reached MERGE_READY, or stored a verdict — while legacy verified normally. Root cause (two parts):
1. **Enter blocked:** the only REVIEW→VERIFYING is cascade row 1, reached only via an internal `caught_up{head}` event that every shadow resolver **hard-floors off** (`caughtUpInputs → {count:1, settled:false}`) to prevent a shadow recompute spuriously minting MERGE_READY (row 7). The floor collaterally blocks the safe enter.
2. **Verdict misrouted + unmatchable:** the verifier's terminal verdict is emitted with the **verifier child's** session id (`prompt-queue.ts:3995`), not the parent's spine row → `no_record`. And `verifierResult.verificationRunId` is **never populated anywhere in the repo** → even keyed to the parent, the run-scoped freshness check fails → ghost-discard.

Without this, the prod shadow soak (the Wave-10 go/no-go gate) produces ~96% artifact divergence and can't inform the flip.

## Approach (chosen)
**A1 — additive enter edge (NOT A2 cascade-relax).** A2 was rejected: the cascade is a pick-one table whose only sound separator is `code_changed`, which buys only rows 1-2 — identical to A1 — while spreading the no-MERGE_READY invariant across 10+ resolvers (a row-7 footgun at the live flip). A1 leaves every floor and the cascade untouched.

### 1+2. A1 producer emits the EXISTING `caught_up` event (NO FSM type/edge change)
**Refinement over a `verification.requested` variant:** drive the existing cascade row 1 instead of adding an edge — zero changes to `types.ts`, `transition.ts`, the exhaustiveness machinery, or any resolver floor.

- New `request-verification-producer.ts` (mirrors the other producers: `parseFsmMode` gate `off→skip`, D1-unbound no-op, whole body try-caught off the legacy critical path). Hooked at the auto-VA schedule chokepoint (`verification-auto-scheduler.ts:415`, where legacy already stamps `verificationState=verification-in-progress`).
- It reads the parent's `pr_coordination` row and **only proceeds when `state===REVIEW ∧ codeChangedSinceVerification===true`** (the D1 data confirms `code_changed=1` on every soak row). Then it calls `applyEvent(parentSessionId, { type: "caught_up", headSha })` with a `guards` resolver supplying — for the `caught_up` event — the real `codeChangedSinceVerification:true`, `underVerificationCap`, `verificationRunCount`, `verificationRunId` from the parent row (the same fields `noshow-producer.ts:91-95` supplies). `caughtUpCascade` then returns **row 1** (VERIFYING + `requestVerification` + spawn child) or **row 2** (NEEDS_YOU verification_noconverge if over cap) — never beyond.
- **No-MERGE_READY proof:** row 7 (the sole MERGE_READY emitter) requires `¬code_changed`; the producer only ever emits `caught_up` when `code_changed=true`, so the cascade is structurally confined to rows 1-2. The internal recompute floor is **untouched** (this producer emits `caught_up` directly with explicit guards; it never relaxes `caughtUpInputs`), so no other path can reach the cascade in shadow. Invariant preserved verbatim, in the producer (not the pure FSM).
- VERIFYING is a `caught_up`-no-op (unhandled→null), so a stray second `caught_up` after entry can't double-enter.

### 3. Parent-keying (verdict-back)
- `prompt-queue.ts:~3995`: hoist `childRow.parent_session_id` out of the telemetry closure; call `shadowEmitVerifierTerminalVerdict(env, parentSessionId, …)` (guard on a resolved parent; skip otherwise).

### 4. Self-sourced run-id (shadow-side; NO legacy weaving)
- The verdict-back producer reads the parent spine row's current `verification_run_id` (stamped by the A1 enter) and uses it as the emitted `verification.pass/app_breaks{runId}`, so `event.runId === record.verification_run_id` holds **by construction**. The strict stale-run/ghost-discard edge (head moved mid-verification) is **deliberately not modeled in shadow** — documented incompleteness, validated by a **canary at the Wave-10 flip** where it has teeth.

### 5. B1 gate + B2 triage (divergence)
- Keep the steady-state sampler (`steady-state-divergence.ts`) as the **go/no-go population** (compares at quiescence — sound). Add **B2** as a per-transition emit at the `applyEvent` §18.4 choke point (after `emitTransitionEvent`), behind an optional `divergence?`/`waitUntil?` seam on `ApplyEventDeps` (default-absent = no-op). Producer supplies the **independently-captured** legacy snapshot (F41) via a shared `honestLegacyDivergenceState()` helper extracted from the sampler. Per-transition is **triage drill-down** ("which transition introduced divergence"), not the gate.

## Flip-time coordination (Wave-10 note, NOT this PR)
At `FSM_MODE=live`, choose ONE verification-enter driver — the cascade row 1 OR the `verification.requested` producer — never both, or VERIFYING double-enters. Recorded here for the emitter-rewire slice (PR 47).

## Keystone checklist
- [ ] The `verification.requested` edge's sole target is VERIFYING; grep proves no new `decide("MERGE_READY",…)` path.
- [ ] Cascade row 7 + all `caughtUpInputs` hard-floors are unchanged → MERGE_READY still unreachable in shadow.
- [ ] A1 producer is mode-gated, D1-unbound no-op, try-caught off the legacy path (shadow-inert).
- [ ] Parent-keyed verdict lands on the parent row; verifier child has no row.
- [ ] Self-sourced run-id makes freshness pass; the un-modeled stale-run edge is documented for the flip canary.
- [ ] `npm run typecheck` exhaustiveness (37-variant union) green; full `tests/test_cloudflare/fsm` green.

## TDD sequence
1. Pure edge `verification.requested` → VERIFYING (+ requestVerification writes + SPAWN child); + a guard test that it never targets MERGE_READY.
2. Completeness/exhaustiveness updates (types + every switch).
3. A1 producer (mode-gate/no-op/isolation; emits + stamps run id on parent).
4. Parent-keying + self-sourced run-id (verdict records on the parent; freshness passes).
5. Shared `honestLegacyDivergenceState` extraction + B2 seam (default-absent no-op; emits when wired).
6. typecheck + full fsm suite; then redeploy QA + re-soak to confirm state+verdict track.
