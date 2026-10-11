# Review-listening "merge-ready" dormancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Caught-up sessions become "merge-ready", drop out of the 5-minute review-loop reconcile, resume automatically when work arrives, stop inflating the active-session count, and show a "Merge ready" label.

**Architecture:** Dormancy is _derived_ from already-mirrored `session_index` columns (`review_loop_done_state='done'` + `arcanist_done_state='done'`) **plus the absence of an in-flight epoch** — no migration. One epoch-aware clause in the sweep's session-selection query skips caught-up sessions and **auto-readmits** them the instant any feedback webhook creates a (`ready`/`collecting`) epoch — so there is **no explicit wake handler**. The active-session counters exclude merge-ready rows; the UI derives a "Merge ready" sub-label; metrics make the change measurable. The ARC-1330 FSM design doc is annotated.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, D1 (raw prepared statements), Vitest (`tests/test_cloudflare/**`, `tests/test_ui/**`), React (apps/ui).

**Spec:** `docs/superpowers/specs/2026-06-29-review-listening-merge-ready-dormancy-design.md`

## Post-rebase reconciliation (2026-06-29) — Task 2 dropped

Rebased onto `main` after it merged **#6110 "Exclude review listening from active cap"** (`25bf7afc8`), which subsumes **Task 2** (counter/cap exclusion — main now excludes all `review_listening` from the active cap/count). Task 2 and the **DRY refactor** (only 2 sites remained after dropping Task 2) were dropped; **Tasks 1 (sweep-skip), 3 (label), 4 (metric) shipped** with inline predicates. The Task 2 / DRY sections below are retained for history.

## Global Constraints

- D1 access only via raw prepared statements in DAO functions; routes→services→DAOs.
- **No migration** — `review_loop_done_state` (0142), `arcanist_done_state`/`arcanist_done_outcome` (0199) already exist on `session_index`.
- No new dependencies, no feature flags.
- **Dormancy (authoritative, sweep-skip):** `review_loop_done_state='done' AND arcanist_done_state='done' AND <no non-terminal epoch for the ref>`. The first two columns are NULL/`'working'`-safe (swept until truly done); the epoch term auto-readmits on new work.
- **Counters use the cheaper 3-column predicate** (no epoch subquery) — `rich_status='review_listening' AND review_loop_done_state='done' AND arcanist_done_state='done'`.
- **NULL-safety (required everywhere):** compare via `COALESCE(review_loop_done_state, '') = 'done'`, never bare `review_loop_done_state = 'done'`. The column is NULLable; under SQL three-valued logic a bare `= 'done'` inside `NOT(...)` makes a NULL row evaluate to NULL → excluded, violating "never exclude NULL/'working'". (`arcanist_done_state` is `NOT NULL DEFAULT 'working'`, so it needs no guard.)
- **"Merge ready" label** additionally gates on `arcanist_done_outcome='success'`.
- Tests live beside the code. Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **PR grouping:** Task 1 = PR1, Task 2 = PR2, Task 3 = PR3, Task 4 = PR4 (worker metrics) + a **separate `infra/` PR** for the Datadog dashboard, Task 5 = PR5 (docs, separate branch). Stack with Graphite.

---

## Task 1: Epoch-aware sweep-skip — stop reconciling caught-up sessions (the whole mechanism)

**Files:**

- Modify: `apps/control-plane-worker/src/webhooks/db.ts` (`listReviewListeningGithubPrRefs`, the `conditions` array at `:1384-1393`)
- Test: `tests/test_cloudflare/review-loop-reconciler-listing.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `listReviewListeningGithubPrRefs` excludes rows where `review_loop_done_state='done' AND arcanist_done_state='done'` **and there is no non-terminal epoch** for the ref. A caught-up session re-appears automatically once any ingest creates a `ready`/`collecting` epoch (the reconcile then resets its done-state to `working`). No wake handler exists or is needed.

- [ ] **Step 1: Write the failing tests.** In `tests/test_cloudflare/review-loop-reconciler-listing.test.ts`: add the two columns to the in-memory `session_index` schema, extend `insertSession`, and add a `describe` block. The file already has an `insertEpoch(sessionId, status)` helper.

Replace the `CREATE TABLE IF NOT EXISTS session_index (...)` block in `beforeEach` with:

```ts
sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_index (
      session_id TEXT PRIMARY KEY,
      owner_user_id INTEGER,
      status TEXT,
      rich_status TEXT,
      review_loop_done_state TEXT,
      arcanist_done_state TEXT NOT NULL DEFAULT 'working',
      updated_at TEXT
    )
  `);
```

Replace `insertSession` with:

```ts
function insertSession(
  sessionId: string,
  richStatus: string,
  prUrl = PR_URL,
  doneStates: { reviewLoopDoneState?: string | null; cycloidDoneState?: string } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO session_index (session_id, owner_user_id, status, rich_status, review_loop_done_state, arcanist_done_state, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      101,
      richStatus,
      doneStates.reviewLoopDoneState ?? null,
      doneStates.cycloidDoneState ?? "working",
      "2026-01-01T00:00:00.000Z",
    );
  insertSessionWebhookRef(sessionId, prUrl);
}
```

Add this `describe` block at the end of the file:

```ts
describe("listReviewListeningGithubPrRefs merge-ready dormancy (epoch-aware)", () => {
  it("skips a caught-up session with NO in-flight epoch", async () => {
    insertSession("sess-dormant", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
    });
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).not.toContain("sess-dormant");
  });

  it("auto-readmits a caught-up session once a non-terminal epoch exists (the wake)", async () => {
    insertSession("sess-woken", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
    });
    insertEpoch("sess-woken", "collecting"); // a fresh feedback epoch
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-woken");
  });

  it("keeps a caught-up session dormant when its only epoch is terminal", async () => {
    insertSession("sess-terminal", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "done",
    });
    insertEpoch("sess-terminal", "completed");
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).not.toContain("sess-terminal");
  });

  it("still sweeps a done review-loop whose verification has not settled", async () => {
    insertSession("sess-verifying", "review_listening", PR_URL, {
      reviewLoopDoneState: "done",
      cycloidDoneState: "working",
    });
    const page = await listReviewListeningGithubPrRefs(db, { limit: 25 });
    expect(page.data.map((r) => r.sessionId)).toContain("sess-verifying");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npx vitest run tests/test_cloudflare/review-loop-reconciler-listing.test.ts`
Expected: "skips a caught-up session with NO in-flight epoch" and "keeps a caught-up session dormant when its only epoch is terminal" FAIL (still listed — no exclusion yet). The auto-readmit + verifying tests pass.

- [ ] **Step 3: Add the epoch-aware exclusion clause.** In `apps/control-plane-worker/src/webhooks/db.ts`, append a fourth entry to the `conditions` array in `listReviewListeningGithubPrRefs` (after the existing `EXISTS(...)` element):

```ts
    // Merge-ready dormancy (epoch-aware): skip a caught-up session (review-loop done + Cycloid done /
    // verification settled) ONLY while it has no in-flight epoch. The moment any feedback webhook records
    // work it creates a ready/collecting (non-terminal) epoch, the NOT EXISTS flips false and the session
    // is re-admitted on the next tick — reconcileReviewLoopDoneState then resets done-state to 'working'.
    // No explicit wake handler is needed. NULL/'working' done-states are never excluded.
    `NOT (
      s.review_loop_done_state = 'done'
      AND s.arcanist_done_state = 'done'
      AND NOT EXISTS (
        SELECT 1 FROM pr_review_response_epochs e
        WHERE e.session_id = s.session_id
          AND e.pr_url = refs.external_ref
          AND e.status NOT IN ('completed', 'blocked', 'stale')
      )
    )`,
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npx vitest run tests/test_cloudflare/review-loop-reconciler-listing.test.ts`
Expected: PASS (all new tests + the unchanged FIX #15 / cursor / null-owner tests — the clause only affects `done+done` rows with no live epoch).

- [ ] **Step 5: Typecheck.**

Run: `npm run -w @cycloid/control-plane-worker typecheck`
Expected: exit 0.

- [ ] **Step 6: Resolve the CI-recovery edge (spec §4) before committing.** Read `reconcileReviewLoopDoneFromCiSignal` (the inline `check_run`/`status` success handler) and confirm it recomputes `arcanist_done_outcome` (needs_attention→success, clears `ci_red`) for a session that is currently dormant (webhook-only, no sweep). If it does not, note it as a follow-up in the PR description (a dormant `needs_attention` session whose CI recovers stays mislabeled until other activity). This is a read-only check; no code change unless it reveals a functional drop.

- [ ] **Step 7: Commit (PR1).**

```bash
git add apps/control-plane-worker/src/webhooks/db.ts tests/test_cloudflare/review-loop-reconciler-listing.test.ts
git commit -m "$(cat <<'EOF'
Stop reconciling caught-up review-listening sessions (epoch-aware)

A caught-up session (review-loop done + Cycloid done) with no in-flight epoch
drops out of the sweep's session-reconcile selection. It auto-readmits the moment
any feedback webhook records work (a ready/collecting epoch), so no explicit wake
handler is needed; the reconcile then resets its done-state to working.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 (DROPPED): Exclude merge-ready sessions from the active count + admission cap

> DROPPED: superseded by #6110, which already excludes all review_listening from the active cap/count. Retained for history; do NOT implement. The steps below are pre-checked so an agentic executor skips them.

**Files:**

- Modify: `apps/control-plane-worker/src/session/db.ts` (`countActiveSessionsForBusiness`, `:520-526`)
- Modify: `apps/control-plane-worker/src/services/admin-console.ts` (`countNonTerminalSessions`, `:464-468`)
- Modify: `apps/control-plane-worker/src/automation/db.ts` (`countActiveAutomationSessionsForBusiness`, `:1064-1068`)
- Test: `tests/test_cloudflare/session-admission.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: the three counters drop rows where `rich_status='review_listening' AND review_loop_done_state='done' AND arcanist_done_state='done'`. `hasInFlightSessionForRule` is intentionally **not** changed.

- [x] **Step 1: Write the failing tests.** In `tests/test_cloudflare/session-admission.test.ts`, add the two columns to the schema, extend `insertSession`, add exclusion tests.

Replace the `CREATE TABLE session_index (...)` block with:

```ts
sqlite.exec(`
    CREATE TABLE session_index (
      session_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      business_id TEXT,
      status TEXT NOT NULL,
      rich_status TEXT,
      review_loop_done_state TEXT,
      arcanist_done_state TEXT NOT NULL DEFAULT 'working'
    );
  `);
```

Replace the `insertSession` helper with:

```ts
function insertSession(
  businessId: string | null,
  status: string,
  richStatus: string | null = null,
  doneStates: { reviewLoopDoneState?: string | null; cycloidDoneState?: string } = {},
): void {
  nextId += 1;
  sqlite
    .prepare(
      "INSERT INTO session_index (session_id, created_at, business_id, status, rich_status, review_loop_done_state, arcanist_done_state) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `s-${nextId}`,
      String(1700000000000 + nextId),
      businessId,
      status,
      richStatus,
      doneStates.reviewLoopDoneState ?? null,
      doneStates.cycloidDoneState ?? "working",
    );
}
```

Add to the `describe("countActiveSessionsForBusiness", ...)` block:

```ts
it("excludes a merge-ready review_listening session (done + cycloid done) from the active count", async () => {
  insertSession("biz-1", "active", "running"); // live, counted
  insertSession("biz-1", "active", "review_listening", {
    reviewLoopDoneState: "done",
    cycloidDoneState: "done",
  }); // merge-ready, excluded
  expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(1);
});

it("still counts a caught-up review_listening session whose verification has not settled", async () => {
  insertSession("biz-1", "active", "review_listening", {
    reviewLoopDoneState: "done",
    cycloidDoneState: "working",
  });
  expect(await countActiveSessionsForBusiness(db, "biz-1")).toBe(1);
});
```

- [x] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/test_cloudflare/session-admission.test.ts -t "merge-ready"`
Expected: the exclusion test FAILS (count is 2).

- [x] **Step 3: Add the clause to `countActiveSessionsForBusiness`** (`session/db.ts`):

```ts
      `SELECT COUNT(*) AS count FROM session_index
       WHERE business_id = ?
         AND status != 'closed' AND status != 'archived'
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))
         AND NOT (rich_status = 'review_listening' AND COALESCE(review_loop_done_state, '') = 'done' AND arcanist_done_state = 'done')`,
```

- [x] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/test_cloudflare/session-admission.test.ts`
Expected: PASS.

- [x] **Step 5: Apply the same clause to the two sibling counters.** `admin-console.ts` (`countNonTerminalSessions`):

```ts
      `SELECT COUNT(*) AS n FROM session_index
       WHERE status != 'closed' AND status != 'archived'
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))
         AND NOT (rich_status = 'review_listening' AND COALESCE(review_loop_done_state, '') = 'done' AND arcanist_done_state = 'done')`,
```

`automation/db.ts` (`countActiveAutomationSessionsForBusiness`):

```ts
      `SELECT COUNT(*) as c FROM session_index
       WHERE business_id = ?
         AND initiation_mode = 'automation'
         AND (rich_status IS NULL OR rich_status NOT IN (${placeholders}))
         AND NOT (rich_status = 'review_listening' AND COALESCE(review_loop_done_state, '') = 'done' AND arcanist_done_state = 'done')`,
```

- [x] **Step 6: Add a regression guard for the intentional `hasInFlightSessionForRule` divergence.** In the automation DAO test suite (`tests/test_cloudflare/` — the file covering `automation/db.ts`; create a focused case if none exists), assert that a merge-ready automation session (`rich_status='review_listening'`, `review_loop_done_state='done'`, `arcanist_done_state='done'`, with a `scheduled_rule_id`) **still** returns `true` from `hasInFlightSessionForRule` — i.e. it is excluded from the cap but NOT from the rule-overlap guard. (A scheduled rule must not re-fire while its prior run's PR is open.)

- [x] **Step 7: Typecheck + sibling regressions.**

Run: `npm run -w @cycloid/control-plane-worker typecheck`
Run: `npx vitest run tests/test_cloudflare/admin-console-routes.test.ts tests/test_cloudflare/session-features.test.ts`
Expected: exit 0 / PASS.

- [x] **Step 8: Commit (PR2).**

```bash
git add apps/control-plane-worker/src/session/db.ts apps/control-plane-worker/src/services/admin-console.ts apps/control-plane-worker/src/automation/db.ts tests/test_cloudflare/session-admission.test.ts
git commit -m "$(cat <<'EOF'
Drop merge-ready sessions from active-session counts and cap

Exclude caught-up merge-ready sessions (review_listening + done + cycloid done)
from the active-session display counts and the per-business admission cap, freeing
a concurrency slot. hasInFlightSessionForRule is intentionally left counting them
(a scheduled rule must not re-fire while its PR is open).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: "Merge ready" UI label

**Files:**

- Modify: `apps/ui/src/components/ReviewLoopIndicator.tsx`
- Modify: `apps/ui/src/components/SessionList.tsx:206`
- Modify: `apps/ui/src/components/PrSection.tsx:117`
- Test: `tests/test_ui/review-loop-indicator.test.tsx`

**Interfaces:**

- Consumes: `session.cycloidDoneState` (`"working"|"done"`) and `session.cycloidDoneOutcome` (`"success"|"needs_attention"|null`) — already on the UI view model (`apps/ui/src/types.ts:66-67`).
- Produces: `ReviewLoopIndicator` renders "Merge ready" when `state==='done' && cycloidDoneState==='done' && cycloidDoneOutcome==='success'`; otherwise unchanged. Two optional, back-compatible new props.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_ui/review-loop-indicator.test.tsx`:

```ts
describe("ReviewLoopIndicator merge-ready", () => {
  it("shows a Merge ready chip when done + cycloid done + success (badge)", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLoopIndicator, {
        variant: "badge",
        state: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "success",
      }),
    );
    expect(html).toContain("Merge ready");
    expect(html).toContain('aria-label="Review loop: merge ready"');
    expect(html).toContain("text-success");
    expect(html).not.toContain("Caught up");
  });

  it("keeps Caught up for a done-but-needs-attention session", () => {
    const html = renderToStaticMarkup(
      createElement(ReviewLoopIndicator, {
        variant: "badge",
        state: "done",
        cycloidDoneState: "done",
        cycloidDoneOutcome: "needs_attention",
      }),
    );
    expect(html).toContain("Caught up");
    expect(html).not.toContain("Merge ready");
  });

  it("keeps Caught up when the cycloid done props are absent (back-compat)", () => {
    const html = renderToStaticMarkup(createElement(ReviewLoopIndicator, { variant: "badge", state: "done" }));
    expect(html).toContain("Caught up");
    expect(html).not.toContain("Merge ready");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run tests/test_ui/review-loop-indicator.test.tsx -t "merge-ready"`
Expected: "shows a Merge ready chip ..." FAILS (renders "Caught up").

- [ ] **Step 3: Implement the label.** In `apps/ui/src/components/ReviewLoopIndicator.tsx`:

(a) Extend the import:

```ts
import {
  normalizeReviewLoopDoneState,
  type CycloidDoneOutcome,
  type CycloidDoneState,
  type ReviewLoopDoneState,
} from "../../../../shared/session/phase.js";
```

(b) Extend the props interface:

```ts
export interface ReviewLoopIndicatorProps {
  variant: "dot" | "badge";
  state: ReviewLoopDoneState | null;
  cycloidDoneState?: CycloidDoneState | null;
  cycloidDoneOutcome?: CycloidDoneOutcome | null;
}
```

(c) Add the merge-ready presentation after the `PRESENTATION` const:

```ts
// Merge-ready: caught up, no automated work left, clean (outcome=success). Terminal-success resting
// state — human review is optional, the session is never "waiting" on it.
const MERGE_READY_PRESENTATION: StatePresentation = {
  dotColor: "bg-success",
  chipTone: "border-success-soft-border bg-success-soft text-success",
  breathing: false,
  label: "Review loop: merge ready",
  copy: "Merge ready",
};
```

(d) Change the signature + presentation selection:

```ts
export function ReviewLoopIndicator({ variant, state, cycloidDoneState, cycloidDoneOutcome }: ReviewLoopIndicatorProps) {
  const normalized = normalizeReviewLoopDoneState(state);
  if (normalized === null) {
    return null;
  }
  const mergeReady = normalized === "done" && cycloidDoneState === "done" && cycloidDoneOutcome === "success";
  const p = mergeReady ? MERGE_READY_PRESENTATION : PRESENTATION[normalized];
```

(Leave the rest unchanged — `settle`/glyph already branch on `state === "working"`.)

- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run tests/test_ui/review-loop-indicator.test.tsx`
Expected: PASS.

- [ ] **Step 5: Thread the props at both call sites.** `SessionList.tsx:206`:

```tsx
<ReviewLoopIndicator
  variant="dot"
  state={session.reviewLoopDoneState ?? null}
  cycloidDoneState={session.cycloidDoneState ?? null}
  cycloidDoneOutcome={session.cycloidDoneOutcome ?? null}
/>
```

`PrSection.tsx:117`:

```tsx
<ReviewLoopIndicator
  variant="badge"
  state={session.reviewLoopDoneState ?? null}
  cycloidDoneState={session.cycloidDoneState ?? null}
  cycloidDoneOutcome={session.cycloidDoneOutcome ?? null}
/>
```

- [ ] **Step 6: Typecheck.**

Run: `npm run -w cycloid-ui typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit (PR3).**

```bash
git add apps/ui/src/components/ReviewLoopIndicator.tsx apps/ui/src/components/SessionList.tsx apps/ui/src/components/PrSection.tsx tests/test_ui/review-loop-indicator.test.tsx
git commit -m "$(cat <<'EOF'
Label caught-up sessions "Merge ready" in the review-loop indicator

When the review loop is done, Cycloid is done, and the outcome is clean, show
"Merge ready" instead of "Caught up" — human review is optional, the session is
never presented as waiting. Done-but-needs-attention keeps "Caught up".

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Observability — make the reduction measurable

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-sweep.ts` (emit a dormant-skip metric per tick)
- Modify: the review-loop observability module (`apps/control-plane-worker/src/observability/review-loop-events.ts` — where `emitReviewLoop*` events live)
- Test: `tests/test_cloudflare/` (the suite covering review-loop observability emits)
- **Separate `infra/` PR:** Terraform Datadog dashboard panel.

**Interfaces:**

- Produces: a Datadog metric for the count of review-listening sessions skipped as dormant per sweep tick (and/or a dormant/active split), following the existing `emitReviewLoop*` emit pattern.

- [ ] **Step 1: Find the emit pattern.** Read `apps/control-plane-worker/src/observability/review-loop-events.ts` and one existing caller (e.g. `emitReviewLoopSettledEvent` usage in `durable-object.ts:7291`) to copy the exact emit signature/shape used for review-loop metrics. (Do not invent an emitter — mirror an existing one.)

- [ ] **Step 2: Write the failing test.** In the review-loop observability test suite, assert the sweep emits a `review_loop.dormant_skipped` (or the project's naming convention) metric with the count of dormant-skipped refs for a tick where caught-up sessions are present. Model the harness on the existing review-loop event test.

- [ ] **Step 3: Emit the metric.** In `reconcileReviewListeningSessions` (`review-loop-sweep.ts`), the page fetched from `listReviewListeningGithubPrRefs` already excludes dormant rows; compute the dormant-skipped count for telemetry — simplest is a sibling count query (caught-up rows for the swept refs) emitted once per tick — and emit via the review-loop emitter found in Step 1. Keep it `waitUntil`/best-effort so a telemetry hiccup never blocks the sweep.

- [ ] **Step 4: Run the test; typecheck.**

Run: `npx vitest run <the observability suite>`
Run: `npm run -w @cycloid/control-plane-worker typecheck`

- [ ] **Step 5: Commit the worker metric (PR4).** Then, as a **separate `infra/` PR** (merge infra first, let TFC apply, per docs/infrastructure.md): add/extend a Datadog dashboard panel for the new metric; declare units if it is a duration; keep the resource key stable.

```bash
git add apps/control-plane-worker/src/services/review-loop-sweep.ts apps/control-plane-worker/src/observability/review-loop-events.ts tests/test_cloudflare/<suite>.test.ts
git commit -m "$(cat <<'EOF'
Emit a dormant-skip metric for review-listening sessions

Counts caught-up sessions the sweep now skips, so the polling reduction is
measurable and "sessions never go dormant" / "stuck dormant" regressions are
visible. Datadog dashboard panel lands in a separate infra PR.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Mirror the live fix into the ARC-1330 FSM design doc (docs, separate branch)

**Files:**

- Modify (on the FSM design branch, NOT this worktree): `docs/superpowers/specs/2026-06-26-arc-1330-lifecycle-fsm-v4-consolidated-design.md`

**Context:** The FSM design doc is not on `main`; the canonical copy is in the FSM design worktree (`.claude/worktrees/jagrit+arc-1330-lifecycle-fsm-design/...`); two other copies drifted. Docs-only, committed on the FSM design branch.

- [ ] **Step 1: Locate the canonical doc** in the FSM design worktree (the most-complete copy). If copies diverge, edit it and reconcile.

- [ ] **Step 2: Append a mirror annotation** near §16/§17:

```markdown
## Live-fix mirror — review-listening merge-ready dormancy (2026-06-29)

Near-term live fix (`docs/superpowers/specs/2026-06-29-review-listening-merge-ready-dormancy-design.md`)
implements this state's behavior on the legacy review-loop sweep:

- **caught-up → merge-ready** mirrors the `caught_up` guard + cascade row 7 (sole `MERGE_READY` emitter, D10; §6 L164, §9 L274). Live signal: `review_loop_done_state='done' AND arcanist_done_state='done'`.
- **"Merge ready" label, human-optional** mirrors `MERGE_READY` (signal-only, terminal-success, humans=0 no-show; §3 L86, §12 L350, §B5 L71).
- **dormant + epoch-aware re-open** mirrors `MERGE_READY`'s no-active-deadline + cron-demotion (DE-3; §3 L94, §10 L318, §16 PR4c L437) and the `MERGE_READY → REVIEW` re-open edges (§9 L296-300): the live skip clause re-admits the instant a (ready/collecting) epoch exists, with no explicit wake.

**Accepted divergence:** the live fix is webhook-only with no safety-net poll, whereas this design retains a coarse cron reconcile as the dropped-merge/close-webhook backstop (§3 L94, §10 L318, D17 L66). Consequence accepted: a dropped `pr.merged`/`pr.closed` webhook strands a session at "Merge ready" with post-merge processing skipped. Restore the coarse reconcile backstop at FSM cutover per D17.
```

- [ ] **Step 3: Commit (PR5, on the FSM design branch).**

```bash
git add docs/superpowers/specs/2026-06-26-arc-1330-lifecycle-fsm-v4-consolidated-design.md
git commit -m "$(cat <<'EOF'
Mirror review-listening merge-ready dormancy into the FSM design

Record that the near-term live fix implements MERGE_READY behavior (caught-up →
merge-ready, dormant, epoch-aware webhook re-open) on the legacy sweep, and the
accepted webhook-only divergence vs the FSM's retained dropped-webhook backstop.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)

- [ ] Full typecheck: `npm run typecheck` → exit 0.
- [ ] Lint changed files: `npm run lint:changed` → clean.
- [ ] Targeted suites: `npx vitest run tests/test_cloudflare/review-loop-reconciler-listing.test.ts tests/test_cloudflare/session-admission.test.ts tests/test_cloudflare/admin-console-routes.test.ts tests/test_ui/review-loop-indicator.test.tsx`
- [ ] Regression: `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts tests/test_cloudflare/cycloid-done-state.test.ts tests/test_cloudflare/github-pr-review-webhook.test.ts`

## Open risks (resolve during implementation)

- **CI recovery for dormant `needs_attention`** (Task 1 Step 6 / spec §4) — confirm the inline `reconcileReviewLoopDoneFromCiSignal` flips outcome→success webhook-only.
- **Sandbox warm on dispatch** — dormant sessions have reaped sandboxes; confirm `processEpoch`→`enqueueSessionPrompt` warms a dead sandbox before dispatch.
- **`EXISTS` subquery cost** — confirm the epoch index covers `(session_id, pr_url, status)` so the sweep-selection stays cheap.
- **Multi-session-per-PR** (spec §4) — non-human webhooks auto-readmit only the first session sharing a PR; document the single-winner rule or change the ingest to fan epochs to all matched sessions.
