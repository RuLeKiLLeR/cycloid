# Review-listening "merge-ready" dormancy — design

**Date:** 2026-06-29
**Branch:** `review-listening-merge-ready-dormancy`
**Status:** approved design, pre-implementation (revised twice: after adversarial spec review, then after resolving the wake question — see "Review corrections")
**Origin:** dogfood session `240d1146-319a-4f6a-ae4e-7948c269b306` (diagnostic only) + this design pass.

## Post-rebase reconciliation (2026-06-29) — §5 dropped

After implementation, this branch was rebased onto current `main`, which had merged **#6110 "[1/2] Exclude review listening from active cap"** (`25bf7afc8`). That change adds `review_listening` to `ACTIVE_SESSION_CAP_EXCLUDED_PHASES`, excluding **all** review*listening sessions from the active cap/count — broader than, and subsuming, **§5 (counter/cap exclusion)**. §5 was therefore **dropped**: the cap/count goal is now owned by #6110. The DRY shared-predicate constant (was for 5 sites) was also dropped — only 2 sites remain (sweep-skip §3, metric §8), each inline. **Shipped: §3 (sweep-skip), §6 (label), §8 (metric).** Caveat: #6110 excludes \_all* review_listening including actively-working ones; §5 had kept working sessions counted — a finer distinction left to #6110's owners. §5 below is retained for history.

## Problem

A session enters `review_listening` when its PR is published and **never leaves except on `merged | closed | archived | user_stop | draft_republish`** (`lifecycle/types.ts:142`). There is a cap on how long Cycloid waits for review **bots** (`reviewTimeoutMinutes`, default 10 min), but **no cap that exits `review_listening`**.

Consequence: once a session is "caught up" (CI green, all reviews/bots settled, verification done) it sits in `review_listening`, and the 5-minute cron sweep (`crons = ["*/5 * * * *"]`, `wrangler.toml:126`) keeps running its per-session GitHub-polling reconcile for it **forever**, even though nothing changes until external PR activity arrives.

Measured cost (dogfood D1 read): the Cycloid business had ~218 non-terminal sessions vs **7 live sandboxes**; **89 were already `review_loop_done_state='done'` + `verification_state='verification-done'`** ("caught up") but still counted active and still reconciled. 191/218 were older than 7 days.

## Goal

When a session is caught up, treat it as **merge-ready** (human review is optional — never present it as blocked on one), and:

1. **Stop the per-session GitHub-polling reconcile for it.**
2. **Resume automatically** when real PR work arrives (no explicit wake handler — see §3).
3. **Label it "Merge ready"** in the UI.
4. **Stop counting it as "active"** — display and the per-business admission cap.

Non-goals: changing the bot no-show window, a session-lifetime timeout, the `check_suite` gap, or the FSM cutover itself. Near-term live fix that **mirrors** the ARC-1330 FSM `MERGE_READY` model (§9).

## How the sweep works (essential context)

`runReviewLoopSweep` has **two independent consumers**:

- **Session-reconcile** — `reconcileReviewListeningSessions` selects sessions via `listReviewListeningGithubPrRefs` (`webhooks/db.ts:1372`) and, per session per tick, makes GitHub API calls (head-change, PR-close backstop, mergeability, CI recovery, bot-checklist bootstrap, status-comment sync) **and is the only place `review_loop_done_state` is (re)computed** (`reconcileReviewLoopDoneState`, sweep.ts:2024, called at :3019; the done-state writers are all inside this loop — sweep.ts:2127/2452/2748/2799 — `processEpoch` never writes done-state). **This is the polling waste, and the only thing dormancy suppresses.**
- **Epoch dispatch** — `listDueReviewLoopEpochs` (`epochs.ts:1119`) selects epochs purely by epoch `status` (`ready` / collecting-past-fallback / reserving-expired), **no `session_index` join, no dormancy filter**, then `processEpoch` dispatches the prompt. **Dormancy does not affect this path.**

**Two consequences that shape the whole design:**

1. **Feedback is never dropped by dormancy.** A webhook for a dormant session still creates an epoch (the ingest gate `loadReviewListeningSession` passes — the session stays `status=active` + `reviewListeningActive=true`), and that epoch dispatches via `listDueReviewLoopEpochs` regardless of the reconcile skip. There is **no silent-drop hole.**
2. **But a dormant session's done-state would freeze.** Because `review_loop_done_state` is recomputed **only** inside the skipped reconcile, a caught-up session that received new work would do the work (epoch path) yet never re-settle its done-state — it would be stuck showing "merge ready" forever. **So a caught-up session must re-enter the reconcile the instant it has work.** That is what §3 does — automatically, with no wake handler.

## Key terms

- **Caught up** — `computeReviewLoopDoneClaim()` returns `"done"` (`review-loop-rollup.ts:225-296`): all epochs terminal/exhausted **and** the expected-bot no-show is settled **and** CI green/absent (or red-but-fix-exhausted).
- **Merge-ready / dormant** — caught up **and** verification settled (`arcanist_done_state='done'`; `outcome='success'` = strictly merge-ready) **and no in-flight epoch.**

## Decisions (locked)

| Decision              | Choice                                                                             | Rationale                                                                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target                | **Live fix + mirror in FSM design**                                                | FSM is shadow-only; pain is live now. Mirror its `MERGE_READY` model (§9).                                                                                                                                                                                                                          |
| State representation  | **Stay in `review_listening`; derive dormancy, no new column**                     | Derive from already-mirrored `session_index` columns + epoch presence — no migration.                                                                                                                                                                                                               |
| Re-admission ("wake") | **Automatic + epoch-aware — NO explicit wake handler**                             | done-state is recomputed only in the reconcile (verified), so a caught-up session must re-enter it when work arrives. Making the skip clause epoch-aware does this the instant any feedback webhook creates a (ready/collecting) epoch — no per-handler resets, no swallowed errors, no chokepoint. |
| Soundness margin      | **Pure webhook-only, no safety-net poll**                                          | User's explicit choice; consequences in §7 (narrow — feedback still dispatches).                                                                                                                                                                                                                    |
| "Active" count        | **Exclude merge-ready from display + admission cap; audit the automation sibling** | A done session shouldn't hold a slot. Deliberate capacity-semantics change (§5).                                                                                                                                                                                                                    |
| UI label              | **"Merge ready"**, derived sub-label, no new `Phase` enum                          | Human review is optional; never "waiting."                                                                                                                                                                                                                                                          |

## Design

### 1. Trigger — already computed

Caught-up = `computeReviewLoopDoneClaim()` → `"done"`. The merge-ready edge (done + verification settled) is observed at `recomputeCycloidDoneStatus()` (`durable-object.ts:4749`), which mirrors `arcanist_done_state`/`arcanist_done_outcome` → `session_index` (`mirrorCycloidDoneStatusToIndex` db.ts:309; review-loop done-state via `mirrorReviewLoopDoneStateToIndex` db.ts:298; both called at durable-object.ts:4740/4746). No new trigger logic.

### 2. Representation — derive, no new column

A session is **merge-ready/dormant** iff (`session_index` columns, all mirrored):

```
rich_status = 'review_listening'
AND review_loop_done_state = 'done'
AND arcanist_done_state = 'done'
AND <no in-flight epoch for this PR ref>      ← the epoch-aware refinement (§3)
```

`arcanist_done_state='done'` includes `outcome='needs_attention'`. For the **sweep-skip** the boundary is `state='done'` (no automated work left). For the **"Merge ready" label** gate on `outcome='success'`.

### 3. Stop the reconcile — one epoch-aware clause (this is the whole mechanism)

`listReviewListeningGithubPrRefs` already selects on `(rich_status='review_listening' OR EXISTS(<non-terminal epoch>))` (`webhooks/db.ts:1384-1393`). Add one clause to the `conditions` array:

```sql
AND NOT (
  COALESCE(s.review_loop_done_state, '') = 'done'   -- NULL-safe: a NULL done-state is never 'done', so the session is swept
  AND s.arcanist_done_state = 'done'
  AND NOT EXISTS (
    SELECT 1 FROM pr_review_response_epochs e
    WHERE e.session_id = s.session_id
      AND e.pr_url = refs.external_ref
      AND e.status NOT IN ('completed', 'blocked', 'stale')
  )
)
```

(The subquery is the same non-terminal-epoch predicate the existing OR-branch uses.) Selection becomes `(R ∨ E) ∧ ¬(D ∧ ¬E)` where R=`review_listening`, E=live epoch, D=`done∧done`:

- Caught-up, **no** live epoch (D, ¬E, R) → **skipped** (dormant). ✓ the saving.
- Caught-up **with** a live epoch (E) → **selected** → reconcile runs → `reconcileReviewLoopDoneState` sees the in-flight epoch → done-state → `working`. ✓ auto-resumed.
- Not caught-up → selected (unchanged). ✓

**Why this needs no wake handler:** every feedback webhook ingest creates a **ready or collecting** epoch — both non-terminal statuses (verified: `terminal: true` in the ingests means "no bot-collection wait → `ready`", not a terminal status; `statusForObserved` yields `ready`/`collecting`, `epochs.ts:984-987,1044`). CI-failure included (`ready`). So the instant any webhook records work, `EXISTS` flips true and the session is auto-readmitted on the next ≤5-min tick; the reconcile then flips done-state to `working`, processes, and re-settles to `done`; once the epoch goes terminal there is again no live epoch → dormant. `synchronize` (new commit) additionally resets done-state itself (`github.ts:3058`, harmless/redundant now). Human-review reengage (`github.ts:2388`) still bootstraps a human epoch → also auto-readmits.

This **replaces** the earlier explicit per-webhook reset design (dissolving the swallowed-error, chokepoint-ambiguity, and most of the drift-window findings — see "Review corrections").

### 4. Edges the auto-readmit does NOT cover (document + test; do not silently leave)

- **Multi-session-per-PR:** the ingest (`runReviewLoopWebhookIngest`) returns after the **first** handled session, so a non-human webhook (bot review, comment, CI) creates an epoch for only one of several sessions sharing a PR — only that one auto-readmits; the others stay dormant. Human reviews wake all (the human-loop iterates `sessionCandidates` scoped per session). Pre-change the sweep reconciled the others. **Decision:** rare; document the single-winner rule, OR change the ingest to create epochs for all matched sessions. Recommend documenting unless multi-session-per-PR is actually used.
- **Manual CI re-run while dormant:** `status:pending` / non-completed `check_run` deliveries are skipped (no epoch), so a re-run shows `pending` while the session stays labeled merge-ready until it completes. Failure → CI-failure ingest creates a `ready` epoch → auto-readmit; success → stays merge-ready (correct). Transient labeling staleness; GitHub's own PR view shows the running CI. **Decision:** accept + test.
- **CI recovery for a dormant `needs_attention` session:** a green `check_run` does not create an epoch (it drives the best-effort inline `reconcileReviewLoopDoneFromCiSignal` via `waitUntil`), so it does not auto-readmit. Confirm that inline path recomputes `arcanist_done_outcome` (needs_attention→success, clears `ci_red`) for a dormant session webhook-only; if it doesn't, the session stays mislabeled until other activity. **Resolve during impl; test.**

### 5. Stop inflating "active"

Add the residual clause to the active/non-terminal predicates (no schema change):

```sql
AND NOT (rich_status = 'review_listening'
         AND COALESCE(review_loop_done_state, '') = 'done'
         AND arcanist_done_state = 'done')
```

- `countActiveSessionsForBusiness` — `session/db.ts:517`. **Also gates the admission cap** (`session-admission.ts:59`): excluding merge-ready frees a concurrency slot per done session — intended. **Semantic shift:** the cap now bounds concurrent _active_ (non-merge-ready) sessions, not total open work.
- `countNonTerminalSessions` — admin tile, `admin-console.ts:461` (display).
- `countActiveAutomationSessionsForBusiness` — `automation/db.ts:1061` (automation cap).
- **`hasInFlightSessionForRule`** (`automation/db.ts:1043`) — scheduled-rule overlap guard, NOT a cap. **Decision: do NOT add the exclusion here** — a rule should not re-fire while its prior run's PR is open. The cap (capacity) and the overlap-guard (rule de-dup) intentionally diverge; document it.

**Counter is NOT epoch-aware (deliberate):** unlike the sweep-skip, the counters use only the 3-column predicate (no `EXISTS` subquery) to keep the hot, business-scoped cap query cheap. A re-activating session has an in-flight epoch but its `rich_status` is still `review_listening` only until `processEpoch` flips it to `running`, so for at most one tick it can be under-counted. Accepted (it is about to be counted as `running` anyway). The authoritative epoch-aware dormancy lives in the sweep-skip (§3); the counter is a cheaper display/cap approximation.

**DRY:** the 3-column predicate appears in the sweep-skip (wrapped in the epoch-aware NOT-EXISTS) + 3 counters, and is deliberately omitted from `hasInFlightSessionForRule`. Extract the 3-column predicate into a shared SQL-fragment constant (app-local `constants/`) so the "exclude" sites cannot drift, or state in code they are one unit.

### 6. UI label — "Merge ready"

`review_listening` phase derives from `reviewListeningActive` only (`shared/session/phase.ts:255`). Extend the existing caught-up sub-label in `ReviewLoopIndicator.tsx:29-44`, using flags already on the UI view model (`apps/ui/src/types.ts:66-67`):

- `reviewLoopDoneState==='done' && cycloidDoneState==='done' && cycloidDoneOutcome==='success'` → "Merge ready".
- else `done` → "Caught up"; `working` → unchanged.

New props are **optional** by design (they derive from the session wire shape — conventions.md exempts wire shapes; also degrades gracefully on deploy skew, matching the component's existing `normalizeReviewLoopDoneState`). No new enum, no backend change. PR3 (Pages deploy) ships independently — the fields are already on the wire.

### 7. Soundness — accepted webhook-only divergences

- **Feedback is not dropped on a missed wake** — there is no explicit wake; the epoch-aware clause re-admits the instant work exists, reading `pr_review_response_epochs` directly (not the mirrored done-state), so even a stale `review_loop_done_state` mirror cannot strand a session that has pending work (the prior draft's drift window is mitigated — a stale-`done` session with a live epoch still re-admits via `EXISTS`).
- **Dropped `pull_request:closed` webhook** — with the reconcile skipped, a dropped close webhook leaves the session cosmetically stuck at "Merge ready" and **skips post-merge processing** (`notifySessionPrMerged`, completion outcomes, memory-analysis). Excluded from the count, so it does not re-inflate it; the loss is post-merge processing + a wrong row. Nothing self-heals it. (Accepted; the cheap once-daily merge/close re-check is the obvious future mitigation.)
- **Base-branch drift / conflict** is not detected while dormant. Acceptable (staleness only matters at merge).

The ARC-1330 FSM keeps a coarse cron reconcile as the dropped-merge/close backstop (`…v4-consolidated-design.md` §3 L94, §10 L318, D17 L66); we are choosing not to — record as accepted divergence (§9).

### 8. Observability (required)

Perf + admission-semantics change → must be measurable (CLAUDE.md). Add:

- **Metrics** (via existing review-loop event/metric emitters): dormant-skip count per tick (or a gauge of review-listening sessions split dormant/active) — proves the reduction + detects "never dormant"; dormant-age distribution — detects sessions stuck after a dropped close webhook.
- **Baseline / delta:** baseline = 89 caught-up of 218 non-terminal (~7 live sandboxes); expected: those ~89 stop generating per-tick reconcile GitHub calls; the business "active" count drops by the merge-ready set.
- **Dashboard:** add/extend a Terraform-managed Datadog panel in `infra/` (declare units on duration metrics). **Separate `infra/` PR** from the worker PRs (infra-vs-deploy sequencing, docs/infrastructure.md).

### 9. FSM mirror (ARC-1330)

Annotate the v8 design doc (`docs/superpowers/specs/2026-06-26-arc-1330-lifecycle-fsm-v4-consolidated-design.md`, the design-worktree copy; 3 copies drifted — edit that one, reconcile):

| Live-fix piece                                 | FSM concept                                                                            | Doc anchor                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- |
| Caught-up trigger                              | `caught_up` guard + cascade row 7 (sole `MERGE_READY` emitter, D10)                    | §6 L149/L164, §9 L274                        |
| "Merge ready", human-optional                  | `MERGE_READY` terminal-success, signal-only, humans=0 no-show                          | §3 L86, §12 L350, §B5 L71                    |
| Dormant / stop reconcile + epoch-aware re-open | `MERGE_READY` no active deadline + cron-demotion; `MERGE_READY → REVIEW` re-open edges | §3 L94, §10 L318, §16 PR4c L437, §9 L296-300 |

Record the **accepted divergence**: the FSM keeps a coarse cron reconcile backstop; the live fix does not (§7).

## Testing

**Unit:**

- `listReviewListeningGithubPrRefs`: caught-up + no live epoch ⇒ **skipped**; caught-up + a live (`ready`/`collecting`) epoch ⇒ **selected** (the auto-readmit — this is the wake's replacement, assert via selection not a mock); not-caught-up ⇒ selected.
- Dormancy derivation across `done/needs_attention/working/null` × epoch-present/absent.
- Counters (`countActiveSessionsForBusiness`/`countNonTerminalSessions`/`countActiveAutomationSessionsForBusiness`) exclude merge-ready; `hasInFlightSessionForRule` still counts it (regression-guard the intentional divergence).
- `ReviewLoopIndicator`: success → "Merge ready"; needs-attention done → "Caught up"; absent cycloid props → "Caught up".

**E2E (dogfood — actual Cycloid session):**

- A session reaches merge-ready → **no further per-session reconcile GitHub calls** (watch the §8 metric).
- A late **bot** review on a dormant session: epoch dispatches and the session auto-readmits (reconcile resumes, label flips, feedback processed) — proves the epoch-aware re-admission end-to-end.
- A human review on a dormant session: reengage + auto-readmit + process.

## Sequencing (small stacked PRs, no flag)

1. **Core:** epoch-aware sweep-skip clause (§3) + tests. **This is the entire mechanism** (no separate wake task). Resolve the §4 CI-recovery edge here.
2. **Counter exclusion** (§5) — display + admission cap + automation sibling + `hasInFlightSessionForRule` regression guard + tests.
3. **UI label** (§6).
4. **Observability** (§8) — worker metrics; the Datadog **dashboard is a separate `infra/` PR**.
5. **FSM design-doc mirror** (§9).

## Review corrections (chronological)

- **Adversarial review:** the original "silent-drop hole" was wrong — epoch dispatch is independent of the sweep-skip (`listDueReviewLoopEpochs` has no dormancy filter), so feedback is never dropped. Added observability (§8), `hasInFlightSessionForRule` audit (§5), multi-session/pending-CI/needs-attention edges (§4), the projection-drift concern, cap-semantics + DRY notes.
- **Wake-necessity check (this revision):** traced that `review_loop_done_state` is computed **only** in the reconcile, so a caught-up session must re-enter it when work arrives — the wake is _necessary_. But the explicit per-webhook reset is _not_: every ingest creates a `ready`/`collecting` (non-terminal) epoch, so an **epoch-aware skip clause auto-readmits** with no handler. This **eliminated the separate wake task**, dissolved the swallowed-error and chokepoint findings, and mitigated the drift window (re-admission reads epochs, not the mirrored done-state). The multi-session/pending-CI/needs-attention edges remain (§4) — they are orthogonal to the mechanism.

## Open risks to resolve during implementation

- **CI recovery for dormant `needs_attention`** (§4) — confirm the inline `reconcileReviewLoopDoneFromCiSignal` flips outcome→success webhook-only for a dormant session.
- **Sandbox warm on dispatch** — dormant sessions have reaped sandboxes; the epoch-dispatch path (`processEpoch`→`enqueueSessionPrompt`) runs the work, so confirm it warms a dead sandbox (the human-reengage path warms; verify the epoch path).
- **Admission-cap freeing** — confirm no consumer of `countActiveSessionsForBusiness` assumed review-listening rows were counted.
- **`EXISTS` subquery cost** — the sweep-skip adds a second correlated subquery to `listReviewListeningGithubPrRefs`; confirm the existing epoch index covers `(session_id, pr_url, status)` so the per-row check stays cheap.
