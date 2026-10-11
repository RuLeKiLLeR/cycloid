# ARC-1330 — Design delta: collapse CI/code-review, durable-execution + happy-path latency

- **Date:** 2026-06-27 · **Owner:** Jag · **Status:** ✅ **THREADED into the v7 consolidated design on 2026-06-27 — retained for rationale / diff trail; the [v7 design](./2026-06-26-arc-1330-lifecycle-fsm-v4-consolidated-design.md) is authoritative.** (Originally a reviewable change-set on top of v6, pre-threading; the design/tech-spec/tracker now carry these changes — this file is the "why" record.)
- **Scope:** reopens a bounded part of the v6 post-PR machinery (the CI-first gate, the no-show wait, timer placement). **It does not touch the merge-ready conjunction or the cascade rows** (§6/§9) — see the soundness check (§D). The review cycle stays closed for the cascade; this is a gate-removal + trigger refinement + an execution-model statement.
- **Drivers:** two directives — (1) **design under the durable-execution model** (on the existing DO+D1 substrate, *no new framework*), (2) **minimize happy-path latency.**

---

## A. Summary of changes (6)

| # | Change | Removes |
| - | ------ | ------- |
| 1 | Collapse `CI_REVIEW` + `CODE_REVIEW` → one combined **`REVIEW`** state that triages CI failures + actionable reviews on one worklist. | the one-time CI-first **queue** (`queue_review`/CI-first `release_queued_reviews`), the B2 CI-first-queue-drain edges, §15 inv 6(a), the `CI_REVIEW` state. |
| 2 | **CI-settled fires epoch 1** (`reduceCiState ≠ pending`, incl. `absent`) with whatever's actionable; reviews not yet in form a second wave. | the "CI must be **green** before reviews are released" rule. |
| 3 | **Eager dispatch + the two-waits rule** — after epoch 1, epochs dispatch on `no_inflight_epoch ∧ actionable`, never gated on CI; CI is validated reactively per pushed head. | the implicit "wait for CI to confirm the last push before the next epoch" serialization. |
| 4 | **Per-PR no-show latch** (paid once, first-contact) + **no re-review blocking**. | the per-epoch re-arming of the no-show window (the "10 min every epoch" waste). |
| 5 | **Optimistic `MERGE_READY` + re-open** — settle without waiting for re-reviews; a late reviewer re-opens. | (nothing new — uses v6's existing re-open edges; just stops blocking.) |
| 6 | **Durable execution on DO+D1** + happy-path-latency principles (event-driven; immediate in-process side-effects; **alarms not cron** for happy-path timers; parallel dispatch). | the happy path's dependence on the `*/5` cron tick (no-show settle moves to an alarm). |

**Post-PR spine, before → after:**

```
v6:    PUBLISHING → CI_REVIEW → CODE_REVIEW ⇄ QA → MERGE_READY
delta: PUBLISHING → REVIEW ⇄ QA → MERGE_READY
```

States: 17 → **16** (`REVIEW` replaces `CI_REVIEW` + `CODE_REVIEW`).

---

## B. The changes in detail

### 1. Collapse to one `REVIEW` state

v6's `CODE_REVIEW` cascade already handles CI (rows 3/4 dispatch ciFix on `ci_red`, row 5 waits on `ci_pending`) and the reactive `ci.signal(failing)` self-loops. So `CI_REVIEW` is essentially "`CODE_REVIEW` with reviews held behind a CI-green gate." Removing the gate merges them.

- **`REVIEW`** triages CI failures and actionable reviews on **one worklist** (the disposition store; `ReviewLoopSourceKind` already includes `ci`, bot, human). The disposition store **is** the holding area — reviews are *registered as actionable* on arrival, not parked in a separate queue.
- **No CI-first queue.** The thing that made reviews wait was the queue; with the disposition store holding items and dispatch gated by `no_inflight ∧ actionable` (+ the epoch-1 trigger), no separate queue is needed.
- **The QA transient hold stays** (different reason): during `QA`, the verification child owns the head, so a code-fix epoch can't dispatch (it would move the head and invalidate the run). Items arriving during `QA` accumulate in the store and dispatch is **re-evaluated on QA exit** — they're never lost, just not dispatched while QA runs. (This replaces "release_queued_reviews on QA exit" with "re-evaluate dispatch on QA exit.")
- **By construction this deletes the B2 wedge class:** there is no CI-first queue left to strand on an exhaustion exit.

### 2. CI-settled fires epoch 1

The first epoch dispatches when **CI settles** — `reduceCiState(head) ≠ pending` (all checks reached a terminal conclusion), or `absent` (no-CI repo) — carrying whatever is actionable at that moment (CI failures + any reviews already present). We do **not** wait for reviewers.

- If CI settles **green with nothing else actionable** (no failures, no reviews yet), epoch 1 does not fire — the PR moves toward the no-show window / `caught_up` (§B4).
- **Late-check guard:** "all checks terminal *right now*" can false-fire because GitHub registers check runs late. The trigger keys on **required** checks and/or a short debounce, not "every check object currently present." (Pin in the tech spec.)
- No-CI repos: `absent` is produced by the cron re-poll (no webhook exists), so epoch 1 for that cohort is cron-paced — accepted (minority, no faster signal).

### 3. Eager dispatch + the two-waits rule

After epoch 1, the **only** gate on the next epoch is `no_inflight_epoch ∧ actionable-items-exist`. CI-green is **not** a dispatch precondition — it is required only at the merge-ready gate, re-checked there.

- **The loop has exactly two intentional waits:** (a) CI-settled for epoch 1, (b) the first-contact no-show window before the first `caught_up = true` (§B4). Everything else is eager.
- CI is validated **reactively per pushed head**: `ci.signal(failing)[no_inflight ∧ under_ci_fix_cap] / dispatch ciFix`; `ci.signal(failing)[in_flight] / log_noop` (note, don't double-dispatch); a head advance supersedes a stale CI result.
- Cost: if a pushed head is red, you may spend one extra ciFix epoch (bounded by `ci_fix_rounds` → `NEEDS_YOU(ci_fix_exhausted)`). Never a correctness issue — the merge-ready gate still requires `ci_green`.

### 4. Per-PR no-show latch + no re-review blocking

The "10 min **every epoch**" waste comes from re-arming the no-show window on every head. Fix: latch the decision per-PR-per-reviewer.

- Per-PR per-reviewer settle state: `pending → responded | no_show`, **persisted across heads** (a small per-PR-per-reviewer record; tech spec pins storage — a sibling of the disposition store or a JSON column on `pr_coordination`).
- **First-contact window, armed once** (a per-session **DO alarm**, §B6). A reviewer settles by posting (`responded`) or the window elapsing (`no_show`).
- **`no_show` is sticky** — dropped from "expected" for the rest of the PR; later heads never re-wait. (If it later posts, that's a normal `review.received` → re-open; we just stop *blocking* on it.)
- **No re-review blocking:** after first contact, `caught_up` does not wait for a `responded` reviewer to re-review subsequent pushes. New comments re-open via the normal path.
- **Expected set** comes from a concrete source — installed/configured review apps + requested humans + a learned "has reviewed this repo before" signal — and **fails toward not-waiting**: a reviewer we can't confirm is expected is not blocked on (it re-opens via §B5 if it later posts).
- Net: the no-show window is paid **at most once per reviewer per PR**, and in the common case it elapses *in parallel* with real work, costing ~0 added wall-clock.

### 5. Optimistic `MERGE_READY` + re-open

`caught_up` settles when the **currently-registered** actionable items are dispositioned (+ `ci_green` + QA fresh) — it does not wait for a slow reviewer's re-review. The PR reaches `MERGE_READY` (signal-only, human merges). A reviewer that posts afterward re-opens it via the existing `MERGE_READY — review.received[actionable] → REVIEW` edge.

- **Trade owned:** "ready" can precede a `responded` reviewer's re-review of the latest fix. The re-open is the safety net; the human merge is the final gate. If we later want to avoid this, the alternative is a *short* bounded re-review wait (~60–90s), not the full no-show window — revisit with §18 dwell data.

### 6. Durable execution (on DO+D1) + happy-path latency principles

**Read (b), confirmed:** durable execution is realized on the **existing Durable Object + D1 substrate** — not a new framework (Temporal/CF Workflows). The spine already has the primitives: the event log (`pr_coordination_events`) is the journal, `transition()` is the deterministic replay function, the single-writer CAS is the durable versioned state, commit-before-side-effects + cron redelivery (D17) is at-least-once idempotent side-effects, DO alarms are durable timers. This delta makes the following **first-class invariants:**

- **DE-1 (event-driven):** every external signal (CI/review/head/QA webhook) → `applyEvent` **immediately**. The happy path must never require a `*/5` cron tick to advance. Cron is a backstop for *dropped* webhooks only.
- **DE-2 (immediate side-effects):** side-effects dispatch in-process right after the CAS commit (spawn sandbox / dispatch epoch / request QA). Cron redelivery is the **crash** backstop, not the delivery path.
- **DE-3 (alarms, not cron, for happy-path timers):** the first-contact no-show window and all state deadlines are **per-session DO alarms** firing precisely at T — not the coarse `*/5` sweep. *(Concrete change: v6/PR-43 routes the no-show settle through the cron; it moves to an alarm.)* Cron keeps only cross-session reconciles (dropped-webhook merge/close poll, absent-CI re-poll, loud-signal redelivery).
- **DE-4 (parallel dispatch):** independent side-effects on a commit fire concurrently.
- **DE-5 (durability licenses aggression):** because every eager/optimistic step is committed-before-acting, idempotent (version-keyed), and crash-resumable, the latency aggression above cannot cost correctness — a crash mid-dispatch resumes from the journal, a redelivered side-effect dedups, an optimistic `MERGE_READY` re-opens.

---

## C. The latency invariant (the one-liner to hold the line)

> On the happy path, the FSM **waits exactly twice** — CI-settled (epoch 1) and the first-contact no-show window (first `caught_up`) — and **never** waits on a cron tick, a CI re-confirmation between epochs, or a re-review. Every other transition fires immediately on its event, committed-then-dispatched.

---

## D. Soundness check (nothing weakens merge-ready)

- **The merge-ready conjunction is byte-for-byte v6:** `state == REVIEW ∧ caught_up ∧ qa_pass ∧ qa_fresh ∧ ci_green ∧ ¬code_changed_since_qa`, sole emitter the `REVIEW.caught_up` edge (D10). Unchanged.
- **The cascade (PR 16) is unchanged** — it was already the `CODE_REVIEW` cascade; the collapse just renames the host state to `REVIEW` and removes the upstream CI-first hop. Totality / determinism / single-emitter / the directional-implication residual (SF8) all carry over from the closed review. **No cascade re-verification needed beyond confirming the rename.**
- **`ci_green` still gates merge.** CI-settled-epoch-1 and eager dispatch act on `ci_settled`/`actionable`, never on `ci_green` — but the gate still requires `ci_green`, so no red PR can reach `MERGE_READY`. The ciFix loop stays bounded by `ci_fix_rounds` → `NEEDS_YOU(ci_fix_exhausted)`.
- **No actionable item is dropped.** The disposition store is the authoritative item set `caught_up` reads. A no-show reviewer contributes zero items (nothing undispositioned). A late/re-review comment arrives as a new actionable item → re-open. Optimistic settle defers items to re-open, never discards them.
- **No-show latch is sound:** a latched `no_show` reviewer is treated as "settled" exactly as v6's window-elapsed case; latching only stops *re-paying* the wait — it changes timing, not the `caught_up` predicate.
- **Eager dispatch is sound:** an epoch on a non-green head produces a new head that re-runs CI; the cascade re-checks `ci_green` at the gate. The `in_flight_epoch` guard + head-advance prevent double-dispatch and stale-CI action.
- **Removed bug classes:** the B2 CI-first-queue wedge (no queue to strand) and the per-epoch no-show re-arm (latched) are eliminated by construction.

**Residual to verify in the tech spec (not soundness of the gate, but new surface):** the late-check debounce for the CI-settled trigger (§B2), the expected-reviewer detection source (§B4), and the DO-alarm wiring for the no-show window (§B6/DE-3).

---

## E. Impact on the existing artifacts (threading is a follow-up)

- **Design v6:** §1/§3 (spine + states: `CI_REVIEW`/`CODE_REVIEW` → `REVIEW`), §6 (`caught_up` reviewer-settle becomes latched; add the CI-settled epoch-1 trigger), §9 (merge the two states' edges; eager-dispatch wording; alarm-driven no-show), §10 (one `REVIEW` deadline; alarm placement), §15 (inv 6 rewritten — no CI-first queue; the two-waits rule; add the DE invariants), §16/§17 (alarm-not-cron for the no-show settle).
- **Tech spec:** fold **PR 14** into the `REVIEW` edges; rework **PR 15/16** as `REVIEW` (cascade unchanged); the **CI-settled epoch-1 trigger** + **late-check debounce** are net-new; add the **per-PR-per-reviewer settle store** + **first-contact alarm** (new small surface, near PR 22's store); **PR 43** no-show settle moves cron → alarm; producers unchanged. The **§18 observability** rides along unchanged (it already logs every transition; `REVIEW` sub-stages distinguish CI-fix vs review-addressing via the `event`/`metadata`).
- **Deletion tracker:** the CI-first gate machinery is mostly net-new-not-built (don't build the queue); the legacy `isAwaitingFirstVerificationVerdict` CI-first gate stays a DELETE (Area 4) — now with no FSM re-home of the queue, only the disposition-store + CI-settled trigger.
- **Session prompts / deployment plan:** G4's PR 14 folds away; G5/G6 adjust to the `REVIEW` rename + the new trigger/latch/alarm. Re-cut after this delta is approved.

---

## F. Open confirmations

1. **`REVIEW` as the merged state name** (vs keeping `CODE_REVIEW`). Rec: `REVIEW` — it now owns CI + reviews.
2. **First-contact window default** (the one paid-once wait). Rec: start at the current ~10 min as a DO-alarm, then tune per-reviewer from §18 p95 data.
3. **Optimistic vs short re-review wait** (§B5). Rec: optimistic + re-open now; revisit with dwell data.
