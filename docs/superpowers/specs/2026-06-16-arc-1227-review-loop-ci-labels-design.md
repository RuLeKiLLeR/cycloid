# Review-Loop CI-Status Labels + Terminal-Only `review-loop:done`

**Date:** 2026-06-16
**Ticket:** ARC-1227 (parent ARC-1223, review-loop audit follow-ups)
**Status:** Design approved; revised after adversarial spec review (2 rounds — Claude + 2 independent reviewers)

## Problem

`review-loop:done` is applied the moment the loop's done-state rollup reaches `"done"` (`review-loop-sweep.ts:1447`). But that settle is also what _triggers_ auto-verification (DO `done` transition, gated on `doneState === "done" && reviewListeningActive`). So `done` appears ~10s after a reviewer's pass and is then removed when the loop re-engages or verification comes back needs-work — a visible race (audit finding N1; observed on PR #4852: `review-loop:done` applied 19:46:45, removed 19:57:21). Users read `review-loop:done` as "human-mergeable" when it is not.

We want:

1. `review-loop:done` to appear **only at the true terminal** — caught up _and_ (where verification applies) an approving verdict for the current head.
2. New `review-loop:ci-red` label to communicate a failing first-pass CI outcome while the loop is listening. Green CI surfaces no review-loop label (it is already visible on the PR's own check marks).

## Non-Goals

- **The verification _trigger_ is unchanged.** Auto-verification still fires off the internal DO `done` transition (`scheduleAutoVerificationAfterReviewLoopDone`, gated on `doneState === "done" && reviewListeningActive`), **not** the GitHub label. This change does not alter _when_ verification starts. (One in-scope addition is required for correctness: on a head change the now-outdated prior-head verdict is cleared — see "Head-freshness". That clears result state a head change already invalidated; it does not change the trigger.)
- No new persisted column / D1 migration.
- No FE change. Labels are a GitHub-side cosmetic mirror; the DB/DO is the source of truth.
- The dead `REVIEW_LOOP_DONE_CI_RED_LABEL` (`review-loop:done-ci-red`) constant is **kept**, not removed — it is still stripped by `clearDoneLabels` and still funnels legacy inbound labels to verification via the webhook allow-check.

## Core Concept

Two independent label axes, reconciled inside `reconcileReviewLoopDoneState` (`review-loop-sweep.ts:1476`):

- **CI label** surfaces `review-loop:ci-red` when CI is failing while listening; green/pending/absent CI surfaces no label (green is already visible on the PR's own check marks).
- **Done label** appears only at the true terminal.

The two axes are genuinely independent: the rollup can settle to `doneState === "done"` while `ci === "failing"` (CI exhausted via `ci_attempt_cap_reached`, or a failing **commit-status** that is not a fixable check-run — `review-loop-rollup.ts:184-200`), and verification can then return `merge-ready` ("did all it could, CI still red"). **In that terminal `review-loop:done` and `review-loop:ci-red` coexist** (decision below) — `done` = "verification approved / loop did all it could", `ci-red` = the orthogonal CI signal. No special-casing: each label reflects its own axis.

### The done-label predicate

Uses a shared `verificationApplies` helper (extracted so `isAwaitingFirstVerificationVerdict` and the predicate cannot drift):

```ts
// shared helper — also used by isAwaitingFirstVerificationVerdict
function verificationApplies(env: Env, session: SessionState): boolean {
  return resolveVerificationPolicy(env) === "auto_after_review_loop" && !session.autoVerifyDisabled;
}

function computeShowDone(env: Env, session: SessionState, doneState: ReviewLoopDoneState | null): boolean {
  const hasTerminalDoneSignal =
    !verificationApplies(env, session) || // disabled / non-auto policy → done-state is terminal
    session.verificationState === "verification-skipped" || // router decided no verification needed (clean PR)
    (session.verificationState === "verification-done" && session.verificationResult === "merge-ready"); // approving
  return (
    doneState === "done" &&
    !isAwaitingFirstVerificationVerdict(env, session) && // not waiting on a verdict ("nothing fresh")
    hasTerminalDoneSignal
  );
}
```

All six `VerificationState` values, when `verificationApplies` and `doneState === "done"`:

| verificationState (+result)                             | isAwaiting   | showDone  | label outcome                                                        |
| ------------------------------------------------------- | ------------ | --------- | -------------------------------------------------------------------- |
| `verification-pending` / `verification-in-progress`     | true         | **false** | CI label only (the intermediate settle that _triggers_ verification) |
| `verification-done` + `merge-ready`                     | false        | **true**  | `done` (+ CI label)                                                  |
| `verification-done` + `needs-work`                      | false/true\* | **false** | CI label only (not mergeable)                                        |
| `verification-skipped` (router: no verification needed) | false        | **true**  | `done` (+ CI label) — clean PR                                       |
| `verification-stopped` (interrupted, no verdict)        | false        | **false** | CI label only                                                        |
| `verification-exhausted` (gave up, not approved)        | false        | **false** | CI label only                                                        |

\* `verification-done` + `needs-work` + `verification-gap` keeps `isAwaiting` true (reprocessing). When `verificationApplies` is false (disabled / non-auto policy), `isAwaiting` is false and `hasTerminalDoneSignal` is true, so `showDone` reduces to `doneState === "done"` — **no regression** for non-verification sessions.

### Head-freshness (the correctness fix)

`verificationResult`/`verificationState` are **session-level**, not per-head, and `verificationResult` is reset **only at verification run-start** (`verification-auto-scheduler.ts:~425`, "Nothing else ever resets verificationResult"). The head-change branch (`review-loop-sweep.ts:1775-1795`) resets only `reviewLoopDoneState` — **not the verdict**. So a naive gate leaks: head A `merge-ready` (done shown) → push head B (done→`working`, done label cleared) → B re-settles to `"done"` carrying A's outdated `merge-ready` → `showDone` true for ~1 sweep tick before B's verification reschedules and nulls the result → `review-loop:done` on an unverified (maybe needs-work) head B. That reintroduces the N1 class one head later — so structural invariants alone are **insufficient**.

**Fix:** in the head-change branch, reset `verificationResult` **and** `verificationState` to `null` alongside `reviewLoopDoneState`, reusing the existing run-start reset helpers `syncVerificationResultForPr({ result: null })` and `syncVerificationStateForPr({ state: null })` (both accept `null`; `state: null` also reconciles the verification label off, which is correct for a new head). The session is then coherently "no verification for this head": `isAwaitingFirstVerificationVerdict` returns true (default branch) until B's verification concludes, so `showDone` withholds `done` on head B until a fresh `merge-ready` lands. No new column. (A persisted `verifiedHeadSha` column was considered and rejected as larger surface; the reset is the surgical fix.)

## Where it runs

`reconcileReviewLoopDoneState` (`review-loop-sweep.ts:1476`) is the decision point. Today it short-circuits on `if (next === priorDoneState) return;` (`:1506`) and only then syncs labels. That early-return is wrong for the new labels: both `ci` and `showDone` can change while `doneState` is unchanged (CI flips `failing → green` at `working`; a `merge-ready` verdict lands while `doneState` stays `"done"`). So:

- The **DB persist** stays deduped on `next !== priorDoneState`.
- The **label reconcile** runs on every `reconcileReviewLoopDoneState` invocation, after the (conditional) persist.

```ts
const next = computeReviewLoopRollup({ ... });
if (next !== priorDoneState) {
  const persisted = await setSessionReviewLoopDoneState(env, sessionId, { doneState: next });
  if (!persisted.ok) { logger.warn(...); /* still attempt label reconcile with `next` */ }
}
await syncReviewLoopLabels(token, owner, repo, prNumber, {
  ci,
  showDone: computeShowDone(env, session, next),
  currentLabels, // from mergeStatus.labels (sweep) | null (CI-webhook fast-path)
}, logger);
```

**Coverage caveat (eventual consistency).** `reconcileReviewLoopDoneState` is reached at `review-loop-sweep.ts:2232` only _after_ several unconditional `continue`s in `reconcileReviewListeningSessions`: dirty mergeable-conflict (~1855), behind-base update-branch (~1872/1918/1945), missing `ownerUserId` (~1949), and CI-poll failure (~2091). On those ticks labels are **not** reconciled, so a CI label can stay stale until the PR leaves that blocked state. This is accepted (CI labels are a cosmetic mirror; the sweep self-heals once the PR is reconcilable). The CI-webhook fast-path (`review-loop-done-reconcile.ts`) only reaches the reconcile with `ci === "green"` **and** while `isAwaitingFirstVerificationVerdict` (`:49`, `:66`), so `ci-red` and CI-label teardown are **sweep-driven (≤1 min)**, never webhook-driven.

## Components

### 1. Constants + CI-label registry (`constants/pr-labels.ts`)

- `REVIEW_LOOP_CI_RED_LABEL = "review-loop:ci-red"`, color `d73a4a` (ticket-specified; distinct from `verification-exhausted`'s `b60205`).
- Keep `REVIEW_LOOP_DONE_CI_RED_LABEL` (dead but still referenced).
- Pure `ReviewLoopCiState → label` mapping helper lives here (or `review-loop-rollup.ts`); `computeShowDone` stays in `review-loop-sweep.ts` (it depends on `isAwaitingFirstVerificationVerdict`, which lives there — moving it to `review-loop-rollup.ts` would be a circular import).

### 2. CI/done label reconcile helper — TARGETED, not full-set PUT (`review-loop-sweep.ts`)

Replace `syncReviewLoopDoneLabels` with:

```ts
async function syncReviewLoopLabels(
  token,
  owner,
  repo,
  prNumber,
  opts: { ci: ReviewLoopCiState; showDone: boolean; currentLabels: string[] | null },
  logger,
): Promise<void>;
```

- **Use targeted `addLabels` / `removeLabel`, NOT `setLabels` (the full-set PUT used by `syncVerificationStateLabels`).** A second full-set replacer racing the verification reconcile (which runs from webhooks/DO/prompt-queue/scheduler, concurrent with the per-minute sweep) would clobber `verification-*` labels via outdated-snapshot lost-update. Targeted ops only touch review-loop labels, so they never clobber the more-important verification labels. (Conversely, verification's PUT can transiently drop/resurrect a review-loop CI label from _its_ snapshot; this self-heals on the next sweep — see Error Handling. That residual is acceptable; exposing verification labels to the frequent sweep is not.)
- Desired set: the CI label for `ci` (`failing` only; `green`/`pending`/`absent` → none) plus `REVIEW_LOOP_DONE_LABEL` iff `showDone`.
- Diff against `currentLabels` when provided: `ensureRepoLabel` + `addLabels` only for labels to add; `removeLabel` only for the CI label present-but-undesired. **Ordering: remove undesired CI label before adding `done`** (brief neither-label window is fine). When `currentLabels` is `null` (fast-path), do the idempotent targeted add.
- Per-label best-effort: wrap each write so one failure does not abandon the rest (`Promise.allSettled` or per-label try/catch); the whole helper never throws — a label write failing must not abort the sweep ref or roll back persisted state.

### 3. `currentLabels` from the existing PR fetch (`github/pr.ts`)

Extend `PrMergeStatus` with `labels: string[]`, parsed from the `GET /pulls/{n}` response already fetched at `review-loop-sweep.ts:1634` (the PR object inlines up to 100 labels — sufficient for real PRs). Set `labels: []` in the `empty` fallback literal (`github/pr.ts:704-719`) and parse defensively: `Array.isArray(data.labels) ? data.labels.flatMap(l => typeof l?.name === "string" ? [l.name] : []) : []`. Thread `mergeStatus.labels` as `currentLabels`. (Alternative considered: reuse the paginated `listLabels` helper at +1 GET/tick — rejected as unnecessary given the PR fetch already carries labels.)

### 4. `clearDoneLabels` (`review-loop-sweep.ts:1425`) + teardown gating

Add `removeLabel` for `REVIEW_LOOP_CI_RED_LABEL` alongside the existing done removes, using `Promise.allSettled` so one non-404 failure does not abandon the others. **Decouple the teardown calls from the `priorDoneState === "done"` gate:** `ci-red` lives while `doneState === "working"`, so the head-change (`:1785`) and checklist-disabled (`:2058`) sites must call `clearDoneLabels` when `priorDoneState !== null` (loop was active), not only when `=== "done"` — otherwise a stale old-head `ci-red` label persists. The merged/closed teardown (`:1656`) is already unconditional.

### 5. Re-trigger guard (`webhooks/github.ts:2746`)

- **Do not** add `ci-red` to the label-webhook allow-check (`:2746` matches only `REVIEW_LOOP_DONE_LABEL` and legacy `REVIEW_LOOP_DONE_CI_RED_LABEL`). Applying the CI label never schedules verification (`untracked_label`).
- The self-applied `review-loop:done` re-fire is deduped per-SHA: `verificationRequestKey(headSha) = "review_loop_done:" + headSha` → `claimVerificationSessionRequest` `INSERT OR IGNORE` (the claim row persists after success — `releaseVerificationSessionRequest` is not called on the success path). **This dedup holds _because_ `done` is now head-fresh** (Head-freshness fix): `done` can only appear on a head whose verification already completed, so a claim row for that head exists → the webhook's re-schedule collides → `duplicate`. Asserted by a regression test.

### 6. Head-change verdict reset (`review-loop-sweep.ts`, head-change branch ~1775-1795)

Alongside the existing `setSessionReviewLoopDoneState(..., "working")`, call `syncVerificationResultForPr({ prUrl, result: null, ... })` and `syncVerificationStateForPr({ prUrl, state: null, ... })` (best-effort) to clear the outdated prior-head verdict. See Head-freshness.

### 7. Intake-reset call site (`review-loop-sweep.ts:~2007`)

This site runs _before_ the shared CI poll (`:2080`) and has no `ci`/`currentLabels`, so it cannot adopt the new `syncReviewLoopLabels({ ci, showDone, currentLabels })` shape. Migrate it to call `clearDoneLabels` (done-only strip; leave the CI labels for the next full reconcile to re-derive). Add to Files Touched.

## Error Handling

- **Label write failure**: per-label best-effort (`Promise.allSettled`); persisted state unaffected; next reconcile retries.
- **Persist failure** (`!persisted.ok`): logged; still attempt the label reconcile with the computed `next`.
- **Cross-reconciler convergence**: verification's full-set PUT may transiently drop or resurrect a review-loop CI label (and vice-versa is avoided by using targeted ops); any divergence self-heals on the next sweep tick. Labels are a cosmetic mirror; the DB/DO is the source of truth.
- **Eventual consistency**: CI labels are not reconciled on dirty/behind/poll-fail ticks (see Coverage caveat); they converge once the PR is reconcilable.

## Testing (TDD)

Suites per `docs/testing.md`: service/session/DAO units live in `tests/test_cloudflare/` (extend the existing `review-loop-sweep.test.ts`, `review-loop-done-reconcile.test.ts`, `github-pr.test.ts`, `verification-auto-scheduler.test.ts`). Webhook tests reuse `tests/test_cloudflare/github-webhook-fixtures.ts`; D1-backed tests use `FakeD1` / `createWorkerEnv()`. All GitHub I/O must be stubbed — `tests/setup/vitest-network-guard.ts` blocks live egress.

- **`syncReviewLoopLabels`**: `ci=failing` adds `ci-red`; `ci=green`/`pending`/`absent` removes it; `showDone` true adds `done`, false removes it; **diff skips no-op writes** when desired ⊆ `currentLabels`; `ensureRepoLabel` before `addLabels`; one label write throwing does not abandon the rest and never propagates.
- **`computeShowDone`**: all six `VerificationState` values (incl. `verification-skipped` → true, `verification-stopped`/`verification-exhausted`/`needs-work` → false); `autoVerifyDisabled` and non-auto policy reduce to `doneState === "done"`; `doneState !== "done"` → false.
- **`done` + `ci-red` coexistence**: `doneState=done` + `verification-done`/`merge-ready` + `ci=failing` → both labels present.
- **Head-freshness regression**: head A `merge-ready` → push head B → B settles to `done` → `review-loop:done` is **not** applied to B until B's own verification returns `merge-ready` (verifies the head-change verdict reset).
- **`reconcileReviewLoopDoneState`**: CI label added/removed when CI flips `failing↔green` while `doneState` stays `"working"` (label reconcile runs despite the persist short-circuit); `done` appears when a `merge-ready` verdict lands while `doneState` stays `"done"`.
- **`clearDoneLabels`**: strips `ci-red` in addition to `done` + legacy; head-change/disabled from a `"working"` prior state still clears CI labels.
- **`getPrMergeStatus`**: parses `labels`; empty/missing → `[]`; non-OK fallback → `[]`.
- **Webhook**: `ci-red` → `untracked_label` (no verification scheduled); `review-loop:done` still schedules.
- **Scheduler regression**: a self-applied `review-loop:done` for an already-scheduled head → `scheduled:false reason "duplicate"` (claim row persists after completion).

## Open Decisions Resolved

| Decision                                                                   | Choice                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done` when verification N/A or not approving                              | Gate where verification applies; else done-state is terminal.                                                                                                                                 |
| Terminal verification states that are `done`-eligible                      | `verification-skipped` (router: none needed) **and** `verification-done`+`merge-ready`. `stopped`/`exhausted`/`needs-work` withhold (CI label only).                                          |
| Head-freshness of the verdict                                              | **Reset `verificationResult`+`verificationState` to `null` on head-change** (reverses the earlier "structural invariants suffice"; structural invariants proved insufficient). No new column. |
| `ci-red` color                                                             | `d73a4a`.                                                                                                                                                                                     |
| CI label on `green` / `pending` / `absent`                                 | No CI label (remove `ci-red`).                                                                                                                                                                |
| Label-write mechanism                                                      | **Targeted `addLabels`/`removeLabel`** (NOT `setLabels` PUT) to avoid clobbering concurrent `verification-*` labels; remove-before-add for exclusivity.                                       |
| `done` + `ci-red` coexistence (verification merge-ready, CI red/exhausted) | **Show both** — `done` = verification-approved/did-all-it-could; `ci-red` = orthogonal CI signal.                                                                                             |
| Per-tick write spam                                                        | Diff against `mergeStatus.labels`; only the diff is written. CI labels eventually-consistent on blocked-state ticks.                                                                          |
| `review-loop:done` ↔ DO done-state 1:1                                     | Intentionally decoupled — label is a stricter terminal signal.                                                                                                                                |
| Scope                                                                      | One control-plane PR. No FE, no migration.                                                                                                                                                    |

## Files Touched (summary)

**Modified:**

- `constants/pr-labels.ts` — `ci-red` constant (+ pure CI→label mapping).
- `github/pr.ts` — `PrMergeStatus.labels` parsed in `getPrMergeStatus` (+ `labels: []` in `empty`).
- `services/review-loop-sweep.ts` — `syncReviewLoopLabels` (replaces `syncReviewLoopDoneLabels`; update **both** callers at `:1516` and `:~2007`), `computeShowDone` + shared `verificationApplies`, `clearDoneLabels` CI-label strip via `Promise.allSettled`, teardown gating change (`!== null`), head-change verdict reset (`syncVerificationResultForPr`/`syncVerificationStateForPr` null), reconcile threading (`ci`, `showDone`, `currentLabels`; label reconcile out of the persist dedup).
- `services/review-loop-done-reconcile.ts` — pass `currentLabels: null` to the reconcile (fast-path; only reaches with `ci=green`).
- `session/verification-auto-scheduler.ts` (or wherever `isAwaitingFirstVerificationVerdict` lives — it is in `review-loop-sweep.ts`) — `isAwaitingFirstVerificationVerdict` uses the shared `verificationApplies` helper.

**Tests:** `tests/test_cloudflare/` — `review-loop-sweep.test.ts`, `review-loop-done-reconcile.test.ts`, `github-pr.test.ts`, `verification-auto-scheduler.test.ts`, and the github webhook suite (via `github-webhook-fixtures.ts`).
