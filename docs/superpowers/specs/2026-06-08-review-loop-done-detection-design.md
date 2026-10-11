# Review-Loop Deterministic "Done" Detection + Label + FE Indicator

**Date:** 2026-06-08
**Status:** Design approved, pending spec review (revised after adversarial review)

## Problem

A review loop runs until its 24h window closes or the PR merges. There is no deterministic, surfaced signal for "the loop is caught up" — a user must open the PR and read reviews + check-runs to guess. We want:

1. A deterministic, point-in-time claim that a PR's review loop has **no actionable work left**, split into:
   - **done — green:** caught up and CI is green.
   - **done — exhausted:** caught up, CI not green, no in-flight work left (it did all it could right now).
2. A **GitHub label** reflecting that claim, automation- and filter-friendly.
3. A **frontend indicator** (session list + detail) that _breathes_ while working/listening and settles to steady **bright/green** (done-green) or **amber** (done-exhausted).

"Done" is **live and reversible**: the loop keeps listening; a new review or CI failure re-opens work and the label/indicator revert to working, then re-settle.

## Non-Goals

- No change to how the loop decides actionable items or builds prompts (epoch worklist logic unchanged).
- No change to the 24h window or merge/close termination.
- No new terminal session phase. `review_listening` stays non-terminal; done-state is orthogonal metadata, computed separately from `computePhase`.
- No sticky "end of session" stamp — done is recomputed every tick.

## Core Concept

The loop is event-driven and always listening until window close or merge — no natural finish line — so "done" is a **computed, point-in-time rollup** recomputed every sweep tick (and inline on green CI webhooks when the review/no-show state is already settled; see `services/review-loop-done-reconcile.ts`) and reconciled (converge-to-desired-state) onto three consumers: GitHub labels, the session Durable Object field, and the mirrored `session_index` list row.

### Done-state values

```ts
// shared/session/phase.ts (beside Phase)
export type ReviewLoopDoneState = "working" | "done_green" | "done_exhausted";
```

Persisted field is `ReviewLoopDoneState | null`. **`null` means "no claim"** — not review-listening, or the loop is intentionally disabled / indeterminate (see classification). FE renders nothing for `null`.

### The deterministic predicate

A pure function with no GitHub/D1 dependency — all polling happens in the caller:

```ts
function computeReviewLoopRollup(input: {
  epochs: { status: ReviewLoopEpochStatus; blockedReason: string | null }[]; // at current head
  ci: ReviewLoopCiState; // pre-reduced; "pending" | "failing" | "green" | "absent"
  botNoShowSettled?: boolean; // sweep-determined: zero bot/human epochs and window elapsed
}): ReviewLoopDoneState | null;
```

Each at-head epoch is classified:

- **in-flight** — `status` in `collecting`/`ready`/`reserving`/`enqueued`/`processing`/`waiting_for_owner`/`publishing`.
- **settled** — `status === "completed"`, OR `status === "blocked"` with `blockedReason ∈ EXHAUSTED_BLOCKED_REASONS`.
- **disabled** — `status === "blocked"` with `blockedReason ∈ DISABLED_BLOCKED_REASONS`.
- **failed** — `status === "blocked"` with any other `blockedReason` (fail-safe default — an unclassified/new reason is failed, never done).

Reason sets (named constants in `review-loop-rollup.ts`, exhaustively unit-tested):

- `EXHAUSTED_BLOCKED_REASONS = { attempt_cap_reached, ci_attempt_cap_reached, ci_checks_pending_cap_reached }` — the loop genuinely did all it could.
- `DISABLED_BLOCKED_REASONS = { auto_response_disabled, ci_response_disabled, empty_expected_bots, expected_bots_changed, session_not_review_listening, session_mismatch }` — loop intentionally off; no done claim.
- Everything else blocked (`github_auth_lost`, `repo_gone`, `github_validation_failed`, `missing_installation`, `installation_capabilities_missing`, `prompt_enqueue_failed`, `prompt_send_not_ready`, `github_poll_failed`, `sweep_failed`, `verification_session`, and the delivery failures `publish_failed` / `reply_failed` — the agent processed the review but couldn't publish the reply/fix, so the feedback is **not** addressed, distinct from the genuine give-up `attempt_cap_reached`; …) → **failed** → `working`. A broken loop must never claim "done." (`head_changed` only ever tags old-head epochs, so it never appears in a current-head query; it falls to the safe default anyway.)

Rules, in order:

1. `epochs.length === 0`:
   - If `botNoShowSettled` (the sweep determined that expected bots never produced any signal and the collection window elapsed) AND CI is `green` or `absent` → **`done_green`**. The wait is genuinely over — reviewers had their window and stayed silent.
   - Otherwise → **`working`**. (No epoch yet means the loop hasn't processed feedback; a freshly-listening PR reads as breathing. The no-show path only fires when the window has elapsed, so a brand-new watch stays working until either a signal arrives or the deadline passes.)
2. any **in-flight** → **`working`**.
3. any **failed** → **`working`** (degraded/broken loop; breathing is the honest state).
4. any **disabled** → **`null`** (hide the indicator, hold no label).
5. all **settled** (no in-flight/failed/disabled) and CI:
   - `ci === "pending"` → **`working`**
   - `ci === "failing"` → **`done_exhausted`**
   - `ci === "green"` or `ci === "absent"` → **`done_green`** — absent = no checks configured = nothing red = clean done. The CI-registration race (CI about to start but not yet reported) is closed by the **head-change reset** (forces `working` on a push) plus the **≥1-settled-epoch gate** (delays any done claim by a full agent response cycle, by which time real CI registers as `pending`), so `absent` only survives to settled when there genuinely is no CI.

Two orthogonal axes: **review/epoch work decides `working` vs `settled`; CI only chooses the flavor (`done_green`/`done_exhausted`) among settled states.** CI green never overrides in-flight review work, and review work never reads CI:

|                                     | CI green   | CI failing     | CI pending | CI absent  |
| ----------------------------------- | ---------- | -------------- | ---------- | ---------- |
| **reviews in-flight / unaddressed** | working    | working        | working    | working    |
| **reviews all settled**             | done_green | done_exhausted | working    | done_green |

"Done" reflects **caught-up-on-submitted feedback** — a reviewer who was _requested_ but hasn't submitted creates no epoch and does not block done; if they submit later, a new wave epoch spawns → `working` (the reversible contract). Waiting on unsubmitted requested reviewers would make "done" unreachable within the 24h window, **except** the bot no-show path bounds this: if zero bot/human signals ever arrive and the collection window elapses, the sweep settles the wait and may claim `done_green`.

This is the deterministic core and gets the heaviest test coverage, including a reason-classification test that fails when a new `blocked_reason` is added without being classified.

### CI state reduction

`type ReviewLoopCiState = "pending" | "failing" | "green" | "absent"` — four-valued, matching the repo's own `getCommitCiStatus` (`pr.ts:824`), which maps no-checks to `unknown`, **not** success. Reduced in a new pure helper rather than reusing `getCombinedCommitStatus` (module-private and self-fetches the `/status` combined endpoint — cannot reduce a pre-fetched `CommitStatusContext[]`).

`reduceCiState(checkRuns: CommitCheckRun[], statusContexts: CommitStatusContext[]): ReviewLoopCiState`, pure:

- **Check-runs** — reuse existing exported pure helpers: `hasPendingCheckRuns` (`pr.ts:784`, any `status !== "completed"`) and `isFailingCheckRun` / `FAILING_CHECK_RUN_CONCLUSIONS` (`pr.ts:768`, `{ failure, timed_out, action_required, startup_failure }` — `cancelled`/`neutral`/`skipped`/`success` are not failing).
- **Status contexts** — `getCommitStatusContexts` returns **all** contexts with no latest-dedup, so first **collapse per context name to the most recent** (highest `id`) to avoid a stale `pending` masking a later `success`. Then map state: `pending` → pending, `failure`/`error` → failing, `success` → ok.
- **Combine:** any pending → `pending`; else any failing → `failing`; else any ok signal (≥1 completed check-run or ≥1 success context) → `green`; else (zero signals) → `absent`.

> **Why poll both sources:** modern CI uses check-runs but some integrations report via the legacy commit-status API. Declaring green off check-runs alone would mislabel a PR whose commit-status is red.

## Where it runs

**Inside `reconcileReviewListeningSessions()`** (`apps/control-plane-worker/src/services/review-loop-sweep.ts:1031`), the per-session-PR reconcile run every cron tick — it already resolves `createInstallationToken` (~line 1085), parses owner/repo via `parseGithubPrUrl` (~1069), and polls PR state+head (~1086, 1125) with merge/close handling (~1087–1115).

**Critical placement (corrected):** the rollup must run **after head reconciliation but BEFORE the early `continue`s** at lines 1186 (`if (botEpochExists && ciEpochExists) continue;`), 1219, and 1252. Those early-exits fire **exactly in the steady "done" state** (both epoch kinds present, no new feedback), so a rollup appended at the end of the iteration would never execute for caught-up PRs — the case it exists to detect. Factor the rollup into a helper invoked unconditionally for each review-listening PR ref right after head reconciliation:

1. `getReviewLoopEpochSummariesForHead(db, { sessionId, prUrl, headSha })` → `{ status, blockedReason }[]` (new DAO).
2. **Own CI poll** (unconditional, every tick): `getCommitCheckRuns` + `getCommitStatusContexts` for the current head → `reduceCiState`. Cannot piggyback on the existing conditional CI-recovery fetch (skipped in the done state). **Cost:** one check-runs + one status poll per review-listening PR per tick, on top of the existing `getPrMergeStatus` (single Get-a-PR read returning state + head + mergeability). Bounded by the number of review-listening PRs; acceptable.
3. `computeReviewLoopRollup(...)`.
4. If the result **differs** from the stored `reviewLoopDoneState`: persist via the new DO internal route, then reconcile GitHub labels. If unchanged, do nothing (no redundant GitHub or DO writes).

**Head-change reset.** When the reconciled head differs from the prior session head **this tick**, force `working` and remove both done labels _before_ evaluating, then skip done-evaluation until the next tick. The new head is unprocessed; this prevents a stale prior-head `done_green` persisting when the new head's CI poll fails, and avoids any window where a prior-head done claim bleeds across a push. (A force-push _back_ to a byte-identical prior SHA legitimately reuses that SHA's completed epochs — same SHA = same tree — and reversibility via new-wave epochs covers any fresh feedback.)

**Accepted property — one-tick convergence.** `reconcileReviewListeningSessions` runs _before_ the per-epoch `processEpoch` loop in the same tick, so the rollup reflects epoch statuses as of the start of the tick; an epoch turning terminal _this_ tick is observed _next_ tick. The rollup is a reversible converge-to-state reconcile and ticks are frequent, so the at-most-one-tick-late breathing→done transition is invisible and does not affect correctness.

## Components

### 1. Pure rollup + CI reducer (new)

`apps/control-plane-worker/src/services/review-loop-rollup.ts` (+ `review-loop-rollup.test.ts`):

- `computeReviewLoopRollup(input)` — the predicate above.
- `reduceCiState(checkRuns, statusContexts)` — the pure four-valued reducer (reuses `FAILING_CHECK_RUN_CONCLUSIONS`, `hasPendingCheckRuns`, `isFailingCheckRun`; writes a fresh pure status-context reducer with per-name latest-dedup — does **not** route through `getCombinedCommitStatus`).
- `EXHAUSTED_BLOCKED_REASONS`, `DISABLED_BLOCKED_REASONS`, `ReviewLoopCiState`.

No GitHub/D1 dependency — trivially unit-testable.

### 2. Epoch summary DAO query (new)

`apps/control-plane-worker/src/services/review-loop-epochs.ts`:

- `getReviewLoopEpochSummariesForHead(db, { sessionId, prUrl, headSha })` → `{ status, blockedReason }[]`.
- `SELECT status, blocked_reason FROM pr_review_response_epochs WHERE session_id = ? AND pr_url = ? AND head_sha = ?`.
- **Includes both review and CI epochs** (no `source_kind` filter — unlike `hasReviewLoopEpochForHead`, which excludes CI; CI epochs are real in-flight work). A PR has few epochs, so returning rows (not counts) and classifying in the pure fn keeps the SQL dumb and the logic tested.
- Index `idx_pr_review_response_epochs_session` on `(session_id, pr_url, head_sha)` already exists (migration 0125) → covered lookup. **No new D1 migration for the epoch table.**

### 3. Session done-state persistence (control plane)

- **`SessionState`** (`apps/control-plane-worker/src/types.ts:~188`): add `reviewLoopDoneState?: ReviewLoopDoneState | null` beside the `reviewListening*` fields. `SessionDOResponse` (`types.ts:241`) inherits it via `Omit<SessionState, …>` — **do not re-declare it there.**
- **Session DO schema** (`session/schema.ts`): append to `MIGRATIONS[]` — `ALTER TABLE session ADD COLUMN review_loop_done_state TEXT;` with `ignoreDuplicateColumn: true`.
- **DO row mappers** (`session/do-db.ts`): add `reviewLoopDoneState` to the **`getSessionExtended`** read (return + `SessionExtendedFields`, ~306–362) and the **`updateSessionFields`** write mapping array (~425–428). (There is no `getSession`/`saveSession` pair; `getSession` returns the base state without review fields.)
- **DO response/snapshot builders** (`session/durable-object.ts`): the field lives on the session table (read via `ext`), so every builder that spreads `...session` then re-adds `reviewListening*` from `ext` must also copy `reviewLoopDoneState`: `buildSessionDoResponse` (~3214) and the `ClientSessionSnapshot` builder (~3370). Audit the other `ext` builder sites (~3184/3335/4430/5585/5983) and add it wherever the snapshot must carry it. **Without these hops the field is null end-to-end even though the types compile.**
- **New internal route** (`session/internal-routes.ts`, mirroring `/session/review-listening/head`): `POST /session/review-loop/done-state`, request `{ requestId, doneState }`, response `{ ok, updated }`. Handler in `durable-object.ts` (~5369 pattern) writes the column **and** mirrors it to `session_index` (next to the existing `updateSessionRichStatus` mirror, so the list path sees it — see §6) **and broadcasts the updated snapshot** so subscribers update live (the live emit is **required** — the FE breathing→done promise depends on it).
- **Client fn** (`session/state.ts`, beside `updateSessionReviewListeningHead`): `setSessionReviewLoopDoneState(env, sessionId, { doneState })` via `fetchSessionRouteResult`. Called from the sweep.
- **`assembleSessionView`** (`services/session-view.ts:~125`): add an explicit `reviewLoopDoneState: session.reviewLoopDoneState ?? null` line to the view-model literal (no existing review-listening pass-through to mirror — it's a new field). **`computePhase` is not touched.**

### 4. Shared DTOs (the PR1↔PR2 seam)

- **`SessionViewModel`** (`shared/types/session-view.ts`) and **`ClientSessionSnapshot`** (`shared/types/session-websocket.ts`): add `reviewLoopDoneState?: ReviewLoopDoneState | null`.
- **`SessionRow` + `toSessionApiShape`** (`apps/control-plane-worker/src/session/db.ts:444, 812`) and the **`session_index`** table: add a `review_loop_done_state` column (append-only migration) and surface it in the list API shape (conditional spread like the other review fields). **The list endpoint (`GET /api/sessions`) is a separate, lighter path over `session_index` — it does not read `SessionViewModel`/the DO**, so the field must exist here or the list dot is permanently `null`.
- `ReviewLoopDoneState` is exported from `shared/session/phase.ts` (next to `Phase`), imported by worker, shared DTOs, and UI — one definition, no new file.

### 5. GitHub labels (control plane)

- **Constants** (`constants/pr-labels.ts`):
  - `REVIEW_LOOP_DONE_LABEL = "review-loop:done"`
  - `REVIEW_LOOP_DONE_CI_RED_LABEL = "review-loop:done-ci-red"` (clearer than "…-failing", which reads as if the _loop_ failed; the failure is localized to CI).
- **`removeLabel` helper** (new, `github/pr.ts`): `DELETE /repos/{owner}/{repo}/issues/{issueNumber}/labels/{encodeURIComponent(label)}` via `tracedFetch` + `githubHeaders`, matching `deleteIssueComment` (~pr.ts:348). `404` → no-op. Status code embedded in the thrown error message so `classifyGithubPollFailure` (`review-loop-sweep.ts:147`) can discriminate auth-lost vs transient.
- **Reconcile** (driven by the computed transition, best-effort — failures logged, never thrown, matching `memory/service.ts:627`):
  - → `done_green`: `ensureRepoLabel` + `addLabels([REVIEW_DONE])`, `removeLabel(REVIEW_DONE_CI_RED)`.
  - → `done_exhausted`: `ensureRepoLabel` + `addLabels([REVIEW_DONE_CI_RED])`, `removeLabel(REVIEW_DONE)`.
  - → `working` or `null`: `removeLabel` both.
  - merged/closed: `removeLabel` both **best-effort immediately before** the existing `closeSessionForWebhook` call (~sweep:1104); a label-removal failure must never block session close.
  - **Dedup**: reconcile fires only on a state change (computed ≠ stored), so steady state makes zero GitHub label calls. `permission_denied`/`unavailable` from `ensureRepoLabel` is tolerated (DO field + FE still update — consistent with the install-permission fail-open reality, ARC-1117).

### 6. FE indicator (PR2)

- **`apps/ui/src/types.ts`** (`SessionMetadata`, a `type` alias at :19) + **`apps/ui/src/api/sessions.ts`**: add `reviewLoopDoneState`. The **list** normalizer `normalizeSessionMetadata` (~47) spreads `...session` → carries it for free **once `session_index`/`toSessionApiShape` provide it (§4)**. The **detail** mapper `fetchSessionView` (~193–228) is an explicit allowlist → add `reviewLoopDoneState: vm.reviewLoopDoneState ?? null`. `SessionDetail` inherits via `SessionMetadata`.
- **`ReviewLoopIndicator`** (`apps/ui/src/components/ReviewLoopIndicator.tsx`, new) — two `variant`s, rendering driven purely by the state (`null`/absent → render nothing):
  - `dot` (list): small circle. `working` → breathing; `done_green` → steady green; `done_exhausted` → steady amber. **Color-only is insufficient (WCAG 1.4.1, per the App.css:487 convention)** — add a `title`/`aria-label` per state ("Review loop: working" / "…caught up, CI green" / "…caught up, CI not green"), matching the existing title-attribute pattern in `SessionList`.
  - `badge` (detail): pill with icon + text — breathing "Listening…" / `done_green` → "Review loop: caught up" (check; CI-neutral copy since `done_green` also covers the no-CI case) / `done_exhausted` → "Review loop: caught up · CI not green — did all it could". Copy says **"CI not green"**, not "tests failed" (the exhausted bucket includes `action_required`/`startup_failure`, which aren't test failures). The persisted enum stays three-valued; green-vs-no-CI is not distinguished in copy (informational only — revisit by persisting a CI sub-state if needed).
- **Animation** (`apps/ui/src/App.css`): add a new `@keyframes review-loop-breathe` (opacity + soft glow, ~2s, `--ease-editorial`) + a utility class, with a `prefers-reduced-motion` fallback. Use a **distinct** keyframe from `status-pulse` (which **is** in active use by the working status dot in `apps/ui/src/constants.ts:14` and must not be perturbed). Steady states use a soft glow, not the pulse; colors via existing `--color-success` / `--color-warning`.
- **List wiring** (`SessionList.tsx`): render `<ReviewLoopIndicator variant="dot" … />` inside the status row (~:132, beside the label that renders when `flattenStatus(session.phase)` is the listening display; gate JSX on `phase === "review_listening"`). Confirm exact anchor at implementation time.
- **Detail wiring** (`SessionHeader.tsx`): render `<ReviewLoopIndicator variant="badge" … />` as a sibling of the Scheduled/Stop pills in the controls flex container (~:173), gated on `phase === "review_listening"`.
- **Liveness (honest):** the **detail badge updates live** via the DO snapshot rebroadcast (§3) consumed by `useSessionWebSocket`. The **session list neither polls nor subscribes per-session**, so list dots update on the next list refetch (scope switch / refresh / remount). To make the **currently-open** session's list row update live, have the detail WS snapshot handler also call `patchSession(sessionId, { reviewLoopDoneState })` (`Layout.tsx:167`). Other rows settle on refetch. The spec's "live" claim is scoped accordingly.

## Data Flow

```
cron tick → runReviewLoopSweep → reconcileReviewListeningSessions (per review-listening PR ref)
  ├─ poll PR state/head (existing) → merge/close: removeLabel both (best-effort) → closeSessionForWebhook
  ├─ if head changed this tick → force working (remove labels), skip done-eval
  └─ else, BEFORE the botEpoch/ciEpoch early-continues:
       ├─ getReviewLoopEpochSummariesForHead(db, …)                 [new DAO]
       ├─ getCommitCheckRuns + getCommitStatusContexts → reduceCiState   [own per-tick poll]
       ├─ computeReviewLoopRollup(…) → ReviewLoopDoneState | null   [pure]
       └─ if changed vs stored:
            ├─ setSessionReviewLoopDoneState → DO route
            │     ├─ write session.review_loop_done_state
            │     ├─ mirror → session_index.review_loop_done_state
            │     └─ broadcast snapshot (REQUIRED)
            └─ label reconcile (ensure/add/remove)                  [best-effort]

Detail:  GET /api/sessions/:id/view → assembleSessionView → SessionViewModel → fetchSessionView → SessionHeader badge
         WS snapshot (ClientSessionSnapshot.reviewLoopDoneState) → live badge + patchSession(open row)
List:    GET /api/sessions → toSessionApiShape(session_index) → normalizeSessionMetadata → SessionList dot
         (updates on refetch; open row also via patchSession)
```

## Error Handling

- **GitHub CI poll failure** (check-runs / statuses) during reconcile → cannot determine CI → **do not change** `reviewLoopDoneState` this tick; keep prior value, retry next tick. Never flip to a wrong done-state on a failed poll. (Exception: on a detected head change, force `working` regardless — the new head is unprocessed; holding a prior-head `done_green` through a poll failure would be stale-green.)
- **Persist-then-labels ordering**: write the DO field first; only reconcile labels if the persist succeeded, keeping field and labels in lockstep. On persist failure, log and retry next tick (no label change).
- **Label API failure**: logged, swallowed; DO field still updates; next state change retries.
- **`permission_denied` on `ensureRepoLabel`**: tolerated; FE still reflects done-state via the DO field.

## Testing

- **Pure predicate** (`review-loop-rollup.test.ts`): table-driven over every combination — `epochs.length===0` gate (including `botNoShowSettled` paths); in-flight; each blocked-reason class (exhausted/disabled/failed) including an **exhaustiveness test that fails if a known `blocked_reason` is unclassified**; CI `pending`/`absent`/`green`/`failing`; precedence (failed before disabled before settled).
- **CI reducer** (`reduceCiState`): each check-run status/conclusion (incl. every `FAILING_CHECK_RUN_CONCLUSIONS` member and the excluded `cancelled`/`neutral`/`skipped`); each commit-status state; per-context-name latest-dedup; zero-signal → `absent`; OR-combination across both sources.
- **DAO** (`getReviewLoopEpochSummariesForHead`): includes CI epochs; head filter excludes other heads; returns status + blocked_reason; zero-epoch case.
- **`removeLabel`**: 404 no-op; non-404 embeds status so `classifyGithubPollFailure` discriminates; `encodeURIComponent("review-loop:done")`.
- **Label reconcile**: each transition's exact add/remove set; merged/closed cleanup ordering (before close, never blocks close); dedup (no GitHub call when unchanged); best-effort swallow.
- **`setSessionReviewLoopDoneState`** (client fn): success; DO non-ok; `updated=false`.
- **Done-state internal route handler**: column write; `session_index` mirror; snapshot broadcast on change; `updated` true/false branches.
- **`do-db` mapper round-trip**: `getSessionExtended` read + `updateSessionFields` write incl. `null`.
- **`assembleSessionView`**: copies the field into the view model.
- **Sweep integration**: a fully-settled PR (both epoch kinds at head) still computes the rollup and fires `setSessionReviewLoopDoneState` once on a state change (regression guard for the early-`continue` placement); unchanged → no fire; failed CI poll → field unchanged; head-change → forced `working`.
- **FE** (`ReviewLoopIndicator`): renders all states in both variants; `null`/absent → renders nothing; reversibility (working→done_green→working); `aria-label`/`title` per state; `prefers-reduced-motion`.

## Decomposition (two PRs)

Two loosely-coupled deliverables meeting only at the `reviewLoopDoneState` DTO field:

- **PR1 — control plane (done-detection + labels).** `review-loop-rollup.ts` + reducer, `getReviewLoopEpochSummariesForHead`, sweep wiring (hoisted rollup + own CI poll + head-change reset), DO field/route/handler/mappers/schema migration + snapshot broadcast, `session_index` column + mirror + `toSessionApiShape`, labels, and the shared DTO fields (`SessionViewModel`/`ClientSessionSnapshot`/`SessionMetadata`). FE simply ignores the new field. Independently shippable; verifiable via a Cycloid session + GitHub label / DO inspection.
- **PR2 — frontend (indicator).** `apps/ui` api threading, `ReviewLoopIndicator`, `App.css` animation, list/detail wiring, `patchSession` liveness.

The seam (the shared DTO field) is added in PR1.

## Open Decisions Resolved

| Decision                                 | Choice                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Reversible vs sticky                     | **Live/reversible** — recomputed every tick.                                                          |
| Green vs exhausted                       | **Two distinct labels** + two FE steady states.                                                       |
| `waiting_for_owner`                      | **In-flight → working/breathing**; no own label.                                                      |
| Declare done with zero reviews yet?      | **No** — require ≥1 epoch at head.                                                                    |
| Blocked-epoch meaning                    | **Partitioned**: exhausted→done-eligible, disabled→`null` (hidden), failed→`working`.                 |
| Absent CI (zero checks), reviews settled | **`done_green`** (clean done) — race closed by head-change reset + ≥1-epoch gate.                     |
| Green CI, reviews in-flight              | **`working`** — review work gates; CI only flavors settled states.                                    |
| FE surfaces                              | **Both** list (dot) and detail (badge).                                                               |
| Detection mechanism                      | **Sweep reconcile**, hoisted above the steady-state early-`continue`s, with its own per-tick CI poll. |
| Live update                              | **Detail badge live** (mandatory WS rebroadcast); **list on refetch** + open-row via `patchSession`.  |
| Label name                               | `review-loop:done` / `review-loop:done-ci-red`.                                                       |
| Scope                                    | **Two PRs** at the DTO seam.                                                                          |

## Files Touched (summary)

**PR1 — New:** `services/review-loop-rollup.ts` (+ test); `ReviewLoopDoneState` in `shared/session/phase.ts`.
**PR1 — Modified:** `services/review-loop-epochs.ts` (DAO + test), `services/review-loop-sweep.ts` (hoisted rollup, CI poll, head-change reset, label reconcile), `github/pr.ts` (`removeLabel`), `constants/pr-labels.ts`, `types.ts` (`SessionState`), `session/schema.ts` (DO migration), `session/do-db.ts` (mappers), `session/internal-routes.ts` (route), `session/durable-object.ts` (handler + builder hops + broadcast), `session/state.ts` (client fn), `session/db.ts` (`session_index` column + `SessionRow` + `toSessionApiShape`) + `session_index` migration, `services/session-view.ts` (view copy), `shared/types/session-view.ts`, `shared/types/session-websocket.ts`.

**PR2 — New:** `apps/ui/src/components/ReviewLoopIndicator.tsx`.
**PR2 — Modified:** `apps/ui/src/types.ts`, `apps/ui/src/api/sessions.ts`, `apps/ui/src/components/SessionList.tsx`, `apps/ui/src/components/SessionHeader.tsx`, `apps/ui/src/components/Layout.tsx` (`patchSession` liveness), `apps/ui/src/App.css`.
