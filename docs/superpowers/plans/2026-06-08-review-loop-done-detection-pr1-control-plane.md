# Review-Loop Done-Detection — PR1: Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute a deterministic per-PR review-loop done-state every sweep tick, persist it on the session DO + mirror to the list index, and reconcile two GitHub labels.

**Architecture:** A pure rollup predicate (review-loop-rollup.ts) over at-head epoch summaries + a reduced CI state, invoked inside reconcileReviewListeningSessions above the steady-state early-continues with its own per-tick CI poll. Result persisted via a new DO internal route, mirrored to session_index, broadcast to subscribers, and reflected as GitHub labels.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, D1 (raw prepared statements), Vitest. Spec: `docs/superpowers/specs/2026-06-08-review-loop-done-detection-design.md`.

## Conventions (read once)

- **Tests** are NOT colocated. Control-plane unit/integration tests live in `tests/test_cloudflare/` (D1 via in-memory better-sqlite3 `SqliteD1`); UI tests live in `tests/test_ui/` and render via `renderToStaticMarkup` from `react-dom/server` (no `@testing-library/react` is installed — do not import it).
- **Run a test:** `npx vitest run <path>` from the repo root (e.g. `npx vitest run tests/test_cloudflare/review-loop-rollup.test.ts`).
- **Typecheck:** `npm run -w @cycloid/control-plane-worker typecheck`.
- **After adding a D1 migration:** run `npx vitest run tests/test_cloudflare/migration-integrity.test.ts` and commit the updated `migration-integrity.test.ts`.
- **Git:** if a worker runs in an isolated worktree it must NOT run git; the orchestrator performs every commit shown in the Step "Commit" blocks.
- Line anchors (`path:NN`) are approximate — confirm against the live file before editing.

---

### Task 1: Add `ReviewLoopDoneState` type to shared/session/phase.ts

**Files:**

- Modify: `shared/session/phase.ts:19` (insert immediately after the `Phase` union, which ends `| "archived";` on line 19)

- [ ] **Step 1: Write the failing test**

```ts
// tests/test_cloudflare/review-loop-done-state-type.test.ts
import { describe, expect, it } from "vitest";

import type { ReviewLoopDoneState } from "../../shared/session/phase";

describe("ReviewLoopDoneState", () => {
  it("admits exactly the three live states and null is the no-claim sentinel", () => {
    // Compile-time anchor: every literal must be assignable.
    const working: ReviewLoopDoneState = "working";
    const green: ReviewLoopDoneState = "done_green";
    const exhausted: ReviewLoopDoneState = "done_exhausted";
    const all: ReviewLoopDoneState[] = [working, green, exhausted];
    expect(all).toEqual(["working", "done_green", "done_exhausted"]);

    // null is NOT part of the union; the persisted/threaded value is `ReviewLoopDoneState | null`.
    const threaded: ReviewLoopDoneState | null = null;
    expect(threaded).toBeNull();
  });
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/review-loop-done-state-type.test.ts` — FAIL: `ReviewLoopDoneState` not exported from `shared/session/phase`.
- [ ] **Step 3: Add the type next to `Phase`**
      Insert after line 19 (`  | "archived";`, closing the `Phase` union), before the blank line preceding `export type SandboxSubstate`:

```ts
// Review-loop "caught up" claim threaded onto the session and rendered as a
// dot/badge. `working` = still listening/processing; `done_green` = nothing left
// to address and CI is green/absent; `done_exhausted` = caught up but CI is not
// green and the loop did all it could. The persisted/threaded value is
// `ReviewLoopDoneState | null` (null = no claim / render nothing).
export type ReviewLoopDoneState = "working" | "done_green" | "done_exhausted";
```

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/review-loop-done-state-type.test.ts` — PASS
- [ ] **Step 5: Commit**

```bash
git add shared/session/phase.ts tests/test_cloudflare/review-loop-done-state-type.test.ts && git commit -m "feat(session): add ReviewLoopDoneState phase type"
```

---

### Task 2: review-loop-rollup core (reduceCiState + computeReviewLoopRollup + constants + types)

**Files:**

- Create: `apps/control-plane-worker/src/services/review-loop-rollup.ts`
- Test: `tests/test_cloudflare/review-loop-rollup.test.ts`

Context (verified from real files):

- `CommitCheckRun` (`pr.ts:85`): `{ id: number; name: string | null; status: string; conclusion: string | null; appSlug: string | null; appName: string | null; detailsUrl: string | null }`.
- `CommitStatusContext` (`pr.ts:75`): `{ id: number; context: string | null; state: string; description: string | null; targetUrl: string | null; creatorLogin: string | null; creatorType: string | null }`.
- `FAILING_CHECK_RUN_CONCLUSIONS` (`pr.ts:768`) = `{ "failure", "timed_out", "action_required", "startup_failure" }`; `hasPendingCheckRuns` (`pr.ts:775`) = `runs.some(r => r.status !== "completed")`; `isFailingCheckRun` (`pr.ts:784`) = `status === "completed" && conclusion != null && FAILING_CHECK_RUN_CONCLUSIONS.has(conclusion)`. All three are already exported.
- `ReviewLoopEpochStatus` (`review-loop-epochs.ts:16`) union: `collecting | ready | reserving | enqueued | processing | waiting_for_owner | publishing | completed | blocked`.
- This task DECLARES `ReviewLoopEpochSummary` here (the DAO task imports it from this module — cleaner since the constants and consuming predicate live here).

- [ ] **Step 1: Failing test** — harness copied from `tests/test_cloudflare/review-loop-ci-checks.test.ts` (vitest `describe/it/expect`, `run()` factory, import from `../../apps/control-plane-worker/src/...`).

```ts
// tests/test_cloudflare/review-loop-rollup.test.ts
import { describe, expect, it } from "vitest";

import { FAILING_CHECK_RUN_CONCLUSIONS } from "../../apps/control-plane-worker/src/github/pr";
import type { CommitCheckRun, CommitStatusContext } from "../../apps/control-plane-worker/src/github/pr";
import type { ReviewLoopEpochStatus } from "../../apps/control-plane-worker/src/services/review-loop-epochs";
import {
  computeReviewLoopRollup,
  DISABLED_BLOCKED_REASONS,
  EXHAUSTED_BLOCKED_REASONS,
  reduceCiState,
  type ReviewLoopCiState,
  type ReviewLoopEpochSummary,
} from "../../apps/control-plane-worker/src/services/review-loop-rollup";

const run = (o: Partial<CommitCheckRun>): CommitCheckRun => ({
  id: o.id ?? 1,
  name: o.name ?? "ci",
  status: o.status ?? "completed",
  conclusion: o.conclusion ?? "success",
  appSlug: o.appSlug ?? null,
  appName: o.appName ?? null,
  detailsUrl: o.detailsUrl ?? null,
});

const ctx = (o: Partial<CommitStatusContext>): CommitStatusContext => ({
  id: o.id ?? 1,
  context: o.context ?? "ctx",
  state: o.state ?? "success",
  description: o.description ?? null,
  targetUrl: o.targetUrl ?? null,
  creatorLogin: o.creatorLogin ?? null,
  creatorType: o.creatorType ?? null,
});

const epoch = (status: ReviewLoopEpochStatus, blockedReason: string | null = null): ReviewLoopEpochSummary => ({
  status,
  blockedReason,
});

describe("reduceCiState", () => {
  it("empty both sources -> absent", () => {
    expect(reduceCiState([], [])).toBe<ReviewLoopCiState>("absent");
  });

  it("every FAILING_CHECK_RUN_CONCLUSIONS member yields failing (completed)", () => {
    for (const conclusion of FAILING_CHECK_RUN_CONCLUSIONS) {
      expect(reduceCiState([run({ status: "completed", conclusion })], [])).toBe("failing");
    }
  });

  it("excluded conclusions (cancelled/neutral/skipped/success) are NOT failing", () => {
    expect(reduceCiState([run({ status: "completed", conclusion: "cancelled" })], [])).toBe("absent");
    expect(reduceCiState([run({ status: "completed", conclusion: "neutral" })], [])).toBe("absent");
    expect(reduceCiState([run({ status: "completed", conclusion: "skipped" })], [])).toBe("absent");
    expect(reduceCiState([run({ status: "completed", conclusion: "success" })], [])).toBe("green");
  });

  it("pending check run dominates a failing one -> pending", () => {
    expect(
      reduceCiState(
        [run({ status: "in_progress", conclusion: null }), run({ status: "completed", conclusion: "failure" })],
        [],
      ),
    ).toBe("pending");
  });

  it("queued check run is pending", () => {
    expect(reduceCiState([run({ status: "queued", conclusion: null })], [])).toBe("pending");
  });

  it("failing dominates ok signal when nothing pending -> failing", () => {
    expect(
      reduceCiState(
        [run({ id: 1, conclusion: "success" }), run({ id: 2, status: "completed", conclusion: "failure" })],
        [],
      ),
    ).toBe("failing");
  });

  it("status contexts: failure and error are failing; success is ok; pending is pending", () => {
    expect(reduceCiState([], [ctx({ state: "failure" })])).toBe("failing");
    expect(reduceCiState([], [ctx({ state: "error" })])).toBe("failing");
    expect(reduceCiState([], [ctx({ state: "success" })])).toBe("green");
    expect(reduceCiState([], [ctx({ state: "pending" })])).toBe("pending");
  });

  it("status contexts: unknown state contributes neither signal", () => {
    expect(reduceCiState([], [ctx({ state: "expected" })])).toBe("absent");
  });

  it("status contexts: null context names are ignored", () => {
    expect(reduceCiState([], [ctx({ context: null, state: "failure" })])).toBe("absent");
  });

  it("collapses to the latest (highest id) context per name before classifying", () => {
    // older failure (id 1) superseded by newer success (id 2) for the SAME context name -> green.
    expect(
      reduceCiState(
        [],
        [ctx({ id: 1, context: "build", state: "failure" }), ctx({ id: 2, context: "build", state: "success" })],
      ),
    ).toBe("green");
    // reverse: newest is the failure -> failing.
    expect(
      reduceCiState(
        [],
        [ctx({ id: 5, context: "build", state: "success" }), ctx({ id: 3, context: "build", state: "failure" })],
      ),
    ).toBe("green"); // id 5 (success) is latest, wins
    expect(
      reduceCiState(
        [],
        [ctx({ id: 3, context: "build", state: "success" }), ctx({ id: 9, context: "build", state: "failure" })],
      ),
    ).toBe("failing"); // id 9 (failure) is latest
  });

  it("combines across both sources: any pending dominates", () => {
    expect(reduceCiState([run({ status: "queued", conclusion: null })], [ctx({ state: "failure" })])).toBe("pending");
  });

  it("combines across both sources: failing beats green when nothing pending", () => {
    expect(reduceCiState([run({ conclusion: "success" })], [ctx({ state: "failure" })])).toBe("failing");
  });
});

describe("computeReviewLoopRollup", () => {
  it("1. empty epochs -> working", () => {
    expect(computeReviewLoopRollup({ epochs: [], ci: "green" })).toBe("working");
  });

  it("2. any in-flight (status not completed/blocked) -> working", () => {
    const inflight: ReviewLoopEpochStatus[] = [
      "collecting",
      "ready",
      "reserving",
      "enqueued",
      "processing",
      "waiting_for_owner",
      "publishing",
    ];
    for (const status of inflight) {
      expect(computeReviewLoopRollup({ epochs: [epoch(status)], ci: "green" })).toBe("working");
    }
  });

  it("3. any failed (blocked w/ unrecognized or null reason) -> working", () => {
    // null reason counts as failed
    expect(computeReviewLoopRollup({ epochs: [epoch("blocked", null)], ci: "green" })).toBe("working");
    const failedReasons = [
      "github_auth_lost",
      "repo_gone",
      "github_validation_failed",
      "missing_installation",
      "installation_capabilities_missing",
      "prompt_enqueue_failed",
      "prompt_send_not_ready",
      "github_poll_failed",
      "sweep_failed",
      "head_changed",
    ];
    for (const reason of failedReasons) {
      expect(EXHAUSTED_BLOCKED_REASONS.has(reason)).toBe(false);
      expect(DISABLED_BLOCKED_REASONS.has(reason)).toBe(false);
      expect(computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "green" })).toBe("working");
    }
  });

  it("4. any disabled (blocked w/ disabled reason) and none failed/in-flight -> null", () => {
    for (const reason of DISABLED_BLOCKED_REASONS) {
      expect(computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "green" })).toBeNull();
    }
  });

  it("5. all settled (completed or exhausted-blocked): ci drives the verdict", () => {
    for (const reason of EXHAUSTED_BLOCKED_REASONS) {
      expect(computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "green" })).toBe("done_green");
      expect(computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "absent" })).toBe("done_green");
      expect(computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "failing" })).toBe("done_exhausted");
      expect(computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "pending" })).toBe("working");
    }
    expect(computeReviewLoopRollup({ epochs: [epoch("completed")], ci: "green" })).toBe("done_green");
    expect(computeReviewLoopRollup({ epochs: [epoch("completed")], ci: "absent" })).toBe("done_green");
    expect(computeReviewLoopRollup({ epochs: [epoch("completed")], ci: "failing" })).toBe("done_exhausted");
    expect(computeReviewLoopRollup({ epochs: [epoch("completed")], ci: "pending" })).toBe("working");
  });

  it("precedence: failed beats disabled beats settled", () => {
    // failed (null reason) + disabled present -> working (failed wins)
    expect(
      computeReviewLoopRollup({
        epochs: [epoch("blocked", null), epoch("blocked", "auto_response_disabled"), epoch("completed")],
        ci: "green",
      }),
    ).toBe("working");
    // disabled + settled present, no failed/in-flight -> null (disabled wins over settled)
    expect(
      computeReviewLoopRollup({
        epochs: [epoch("blocked", "ci_response_disabled"), epoch("completed")],
        ci: "failing",
      }),
    ).toBeNull();
    // in-flight beats everything
    expect(
      computeReviewLoopRollup({
        epochs: [epoch("processing"), epoch("blocked", null), epoch("blocked", "session_mismatch"), epoch("completed")],
        ci: "failing",
      }),
    ).toBe("working");
  });

  it("EXHAUSTIVENESS: every known blocked_reason string is classified into exactly one of failed/exhausted/disabled", () => {
    const exhausted = ["attempt_cap_reached", "ci_attempt_cap_reached", "ci_checks_pending_cap_reached"];
    const disabled = [
      "auto_response_disabled",
      "ci_response_disabled",
      "empty_expected_bots",
      "expected_bots_changed",
      "session_not_review_listening",
      "session_mismatch",
    ];
    const failed = [
      "github_auth_lost",
      "repo_gone",
      "github_validation_failed",
      "missing_installation",
      "installation_capabilities_missing",
      "prompt_enqueue_failed",
      "prompt_send_not_ready",
      "github_poll_failed",
      "sweep_failed",
      "head_changed",
    ];

    // The two named sets match the contract exactly.
    expect([...EXHAUSTED_BLOCKED_REASONS].sort()).toEqual([...exhausted].sort());
    expect([...DISABLED_BLOCKED_REASONS].sort()).toEqual([...disabled].sort());

    for (const reason of [...exhausted, ...disabled, ...failed]) {
      const inExhausted = EXHAUSTED_BLOCKED_REASONS.has(reason);
      const inDisabled = DISABLED_BLOCKED_REASONS.has(reason);
      const classes = [inExhausted, inDisabled, !inExhausted && !inDisabled].filter(Boolean);
      expect(classes.length).toBe(1); // exactly one bucket

      const verdict = computeReviewLoopRollup({ epochs: [epoch("blocked", reason)], ci: "green" });
      if (inDisabled) expect(verdict).toBeNull();
      else expect(verdict).toBe(inExhausted ? "done_green" : "working");
    }
  });
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/review-loop-rollup.test.ts` — FAIL: module `apps/control-plane-worker/src/services/review-loop-rollup` does not exist.
- [ ] **Step 3: Create the implementation**

```ts
// apps/control-plane-worker/src/services/review-loop-rollup.ts
import type { CommitCheckRun, CommitStatusContext } from "../github/pr";
import { hasPendingCheckRuns, isFailingCheckRun } from "../github/pr";
import type { ReviewLoopDoneState } from "../../../../shared/session/phase.js";
import type { ReviewLoopEpochStatus } from "./review-loop-epochs";

/** Coarse CI verdict for a single head, derived from check-runs + commit-status contexts. */
export type ReviewLoopCiState = "pending" | "failing" | "green" | "absent";

/** Minimal epoch projection the rollup reasons over (status + why-blocked). */
export interface ReviewLoopEpochSummary {
  status: ReviewLoopEpochStatus;
  blockedReason: string | null;
}

/**
 * Blocked reasons that mean "the loop ran out of road" — it tried and capped out.
 * These count as SETTLED (no more work pending), so the CI state alone decides
 * between done_green and done_exhausted.
 */
export const EXHAUSTED_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "attempt_cap_reached",
  "ci_attempt_cap_reached",
  "ci_checks_pending_cap_reached",
]);

/**
 * Blocked reasons that mean "the loop is intentionally not acting" (turned off,
 * scoped out, or no longer this session's job). These make NO done-claim at all
 * (render nothing) rather than asserting caught-up.
 */
export const DISABLED_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "auto_response_disabled",
  "ci_response_disabled",
  "empty_expected_bots",
  "expected_bots_changed",
  "session_not_review_listening",
  "session_mismatch",
]);

/**
 * Collapse check-runs + commit-status contexts for one head into a single CI
 * verdict. Pending dominates (we don't claim caught-up while CI is still
 * running); then failing; then any positive signal -> green; otherwise absent
 * (no CI configured / nothing reported).
 */
export function reduceCiState(checkRuns: CommitCheckRun[], statusContexts: CommitStatusContext[]): ReviewLoopCiState {
  let pending = hasPendingCheckRuns(checkRuns);
  let failing = checkRuns.some(isFailingCheckRun);
  let okSignal = checkRuns.some((r) => r.status === "completed" && !isFailingCheckRun(r));

  // Collapse status contexts to the latest entry per context name (highest id
  // wins). GitHub re-posts the same context name as a commit progresses; only
  // the most recent state is authoritative. Null context names are ignored.
  const latestByContext = new Map<string, CommitStatusContext>();
  for (const sc of statusContexts) {
    if (sc.context == null) continue;
    const existing = latestByContext.get(sc.context);
    if (!existing || sc.id > existing.id) latestByContext.set(sc.context, sc);
  }
  for (const sc of latestByContext.values()) {
    if (sc.state === "pending") pending = true;
    else if (sc.state === "failure" || sc.state === "error") failing = true;
    else if (sc.state === "success") okSignal = true;
    // other states (e.g. "expected") contribute neither signal.
  }

  if (pending) return "pending";
  if (failing) return "failing";
  if (okSignal) return "green";
  return "absent";
}

/**
 * Reduce the per-head epoch summaries + CI verdict into the session's review-loop
 * done-claim. Predicate order is significant (failed-before-disabled-before-
 * settled); see inline comments and the contract.
 */
export function computeReviewLoopRollup(input: {
  epochs: ReviewLoopEpochSummary[];
  ci: ReviewLoopCiState;
}): ReviewLoopDoneState | null {
  const { epochs, ci } = input;

  // 1. No epochs on this head yet -> still working (haven't even started).
  if (epochs.length === 0) return "working";

  // 2. Anything still moving (not completed and not blocked) -> working.
  const anyInFlight = epochs.some((e) => e.status !== "completed" && e.status !== "blocked");
  if (anyInFlight) return "working";

  // 3. Any FAILED epoch: blocked with an unrecognized reason (or null reason) is
  //    a real failure the loop may still recover from -> working. Checked BEFORE
  //    disabled so a genuine failure is never masked by a co-present disabled epoch.
  const anyFailed = epochs.some(
    (e) =>
      e.status === "blocked" &&
      (e.blockedReason == null ||
        (!EXHAUSTED_BLOCKED_REASONS.has(e.blockedReason) && !DISABLED_BLOCKED_REASONS.has(e.blockedReason))),
  );
  if (anyFailed) return "working";

  // 4. Any DISABLED epoch (and nothing failed/in-flight): the loop is
  //    intentionally not acting -> make no claim.
  const anyDisabled = epochs.some(
    (e) => e.status === "blocked" && e.blockedReason != null && DISABLED_BLOCKED_REASONS.has(e.blockedReason),
  );
  if (anyDisabled) return null;

  // 5. Everything settled (completed, or blocked with an exhausted reason). CI
  //    decides: still-running CI keeps us working; red CI -> did all it could;
  //    green/absent CI -> caught up.
  if (ci === "pending") return "working";
  if (ci === "failing") return "done_exhausted";
  return "done_green"; // "green" or "absent"
}
```

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/review-loop-rollup.test.ts` — PASS (all cases)
- [ ] **Step 5: Typecheck:** `npm run -w @cycloid/control-plane-worker typecheck` — PASS
- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-rollup.ts tests/test_cloudflare/review-loop-rollup.test.ts && git commit -m "feat(review-loop): add rollup core (reduceCiState + computeReviewLoopRollup)"
```

---

### Task 3: Epoch summary DAO — `getReviewLoopEpochSummariesForHead`

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-epochs.ts` (append new fn after `hasCiReviewLoopEpochForHead` at `review-loop-epochs.ts:859`; add type import near the existing `import type { CommitCheckRun, CommitStatusContext } from "../github/pr";` at `review-loop-epochs.ts:4`)
- Test: `tests/test_cloudflare/review-loop-epochs-summaries.test.ts` (new file; sibling-style harness copied from `tests/test_cloudflare/review-loop-epochs.test.ts`)

**Context (verified from real files):**

- Table `pr_review_response_epochs` columns used: `session_id`, `pr_url`, `head_sha`, `status`, `blocked_reason`, `source_kind` (`blocked_reason` at `migrations/0114...sql:40`; `source_kind` CHECK widened to include `'ci'` only in `migrations/0122_review_loop_ci_source_kind.sql:41`).
- DAO prepare/bind/first/all style to copy: `hasReviewLoopEpochForHead` at `review-loop-epochs.ts:822-835` (uses `.prepare(...).bind(...).first<T>()`); `listCollectingReviewLoopEpochs` at `:899-913` uses `.all<T>()` then `(rows.results ?? []).map(...)`.
- `ReviewLoopEpochStatus` type is exported at `review-loop-epochs.ts:16`.
- A CI epoch is seeded via `upsertReviewLoopEpochActivity(db, { ..., sourceKind: "ci" })` (sourceKind override path proven by the `source_kind round-trip` test at `review-loop-epochs.test.ts:1198-1238`). Because `source_kind='ci'` violates the `0119` CHECK, the test's `beforeEach` MUST also load migration `0122`.
- Re-export decision: `ReviewLoopEpochSummary` is canonically defined in `review-loop-rollup.ts` per CONTRACTS (rollup owns the shape; its reducer is the primary consumer). This task IMPORTS it from there and RE-EXPORTS it from the DAO so callers avoid a second import.

- [ ] **Step 1: Failing test**

```ts
// tests/test_cloudflare/review-loop-summaries.test.ts
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  getReviewLoopEpochSummariesForHead,
  markReviewLoopEpochCompleted,
  claimReviewLoopEpochForPrompt,
  upsertReviewLoopEpochActivity,
} from "../../apps/control-plane-worker/src/services/review-loop-epochs";

class SqliteD1Statement {
  private boundValues: unknown[] = [];
  constructor(
    private readonly db: Database.Database,
    private readonly query: string,
  ) {}
  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.boundValues) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.boundValues) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const info = this.db.prepare(this.query).run(...this.boundValues);
    return { success: true, meta: { changes: info.changes } };
  }
}
class SqliteD1 {
  constructor(readonly db: Database.Database) {}
  prepare(query: string): SqliteD1Statement {
    return new SqliteD1Statement(this.db, query);
  }
}

let sqlite: Database.Database;
let db: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0114_pr_review_bot_settings_and_epochs.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0117_pr_review_response_operations.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0119_review_loop_human_source.sql", "utf8"));
  // 0122 widens source_kind CHECK to allow 'ci' — required because this DAO must count ci epochs.
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0122_review_loop_ci_source_kind.sql", "utf8"));
  sqlite.exec(readFileSync("apps/control-plane-worker/migrations/0126_review_loop_prompted_source_ids.sql", "utf8"));
  db = new SqliteD1(sqlite) as unknown as D1Database;
});

// Force an epoch into status='blocked' with a chosen reason via a raw UPDATE — the test file
// already drives raw sqlite UPDATEs for setup (see review-loop-epochs.test.ts:1003-1007). This
// avoids the multi-step CAS state machine and lets us assert reason pass-through directly.
function forceBlocked(epochId: string, reason: string | null) {
  sqlite
    .prepare("UPDATE pr_review_response_epochs SET status = 'blocked', blocked_reason = ? WHERE id = ?")
    .run(reason, epochId);
}

const PR_URL = "https://github.com/acme/repo/pull/500";

async function seedReviewEpoch(sessionId: string, headSha: string, sourceId: string, nowMs: number) {
  return upsertReviewLoopEpochActivity(db, {
    sessionId,
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 500,
    prUrl: PR_URL,
    headSha,
    expectedBots: [{ type: "known", id: "cursor-bugbot" }],
    expectedBotsHash: "hash-summary",
    sourceId,
    botKey: "known:cursor-bugbot",
    botActorLogin: "cursor[bot]",
    terminal: true,
    evidence: { type: "review_submission", sourceId },
    nowMs,
  });
}

async function seedCiEpoch(sessionId: string, headSha: string, sourceId: string, nowMs: number) {
  return upsertReviewLoopEpochActivity(db, {
    sessionId,
    ownerUserId: 101,
    repoOwner: "acme",
    repoName: "repo",
    prNumber: 500,
    prUrl: PR_URL,
    headSha,
    expectedBots: [],
    expectedBotsHash: "ci-fixes",
    sourceId,
    botKey: "ci",
    botActorLogin: null,
    terminal: false,
    evidence: null,
    nowMs,
    sourceKind: "ci",
  });
}

describe("getReviewLoopEpochSummariesForHead", () => {
  it("returns only current-head rows with {status, blockedReason}, includes ci epochs, ignores other heads/prs/sessions", async () => {
    const sessionId = "s-summary";
    const headCurrent = "head-current";
    const headOld = "head-old";

    // Current head: a review epoch left in-flight (collecting), a review epoch blocked with a reason,
    // and a ci epoch — all three must come back.
    await seedReviewEpoch(sessionId, headCurrent, "review:inflight", 1_000);
    const blockedReview = await seedReviewEpoch(sessionId, headCurrent, "review:blocked", 1_100);
    forceBlocked(blockedReview.id, "attempt_cap_reached");
    await seedCiEpoch(sessionId, headCurrent, "ci:fix-1", 1_200);

    // Old head on the SAME pr+session must NOT come back.
    await seedReviewEpoch(sessionId, headOld, "review:old", 900);

    // Different PR (same session) must NOT leak.
    await upsertReviewLoopEpochActivity(db, {
      sessionId,
      ownerUserId: 101,
      repoOwner: "acme",
      repoName: "repo",
      prNumber: 999,
      prUrl: "https://github.com/acme/repo/pull/999",
      headSha: headCurrent,
      expectedBots: [{ type: "known", id: "cursor-bugbot" }],
      expectedBotsHash: "hash-summary",
      sourceId: "review:other-pr",
      botKey: "known:cursor-bugbot",
      botActorLogin: "cursor[bot]",
      terminal: true,
      evidence: { type: "review_submission", sourceId: "review:other-pr" },
      nowMs: 1_300,
    });

    // Different session (same pr+head) must NOT leak.
    await seedReviewEpoch("s-other", headCurrent, "review:other-session", 1_400);

    const summaries = await getReviewLoopEpochSummariesForHead(db, {
      sessionId,
      prUrl: PR_URL,
      headSha: headCurrent,
    });

    expect(summaries).toHaveLength(3);
    // The blocked review epoch carries its reason through verbatim.
    expect(summaries).toContainEqual({ status: "blocked", blockedReason: "attempt_cap_reached" });
    // The ci epoch is counted (no source_kind filter). It and the in-flight review epoch have null reason.
    const nullReason = summaries.filter((s) => s.blockedReason === null);
    expect(nullReason).toHaveLength(2);
    expect(nullReason.every((s) => s.status !== "blocked")).toBe(true);
  });

  it("maps a NULL blocked_reason on a blocked row to blockedReason: null", async () => {
    const sessionId = "s-null-reason";
    const head = "head-null";
    const epoch = await seedReviewEpoch(sessionId, head, "review:null", 2_000);
    forceBlocked(epoch.id, null);

    const summaries = await getReviewLoopEpochSummariesForHead(db, {
      sessionId,
      prUrl: PR_URL,
      headSha: head,
    });

    expect(summaries).toEqual([{ status: "blocked", blockedReason: null }]);
  });

  it("returns [] when no epochs exist for the head", async () => {
    const summaries = await getReviewLoopEpochSummariesForHead(db, {
      sessionId: "s-empty",
      prUrl: PR_URL,
      headSha: "head-none",
    });
    expect(summaries).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/review-loop-summaries.test.ts` (from repo root `.`) — FAIL: `getReviewLoopEpochSummariesForHead is not a function`

- [ ] **Step 3: Add the type import + re-export and implement the DAO fn**

3a. Add the import next to the existing `../github/pr` import at `review-loop-epochs.ts:4`:

```ts
import type { CommitCheckRun, CommitStatusContext } from "../github/pr";
import type { ReviewLoopEpochSummary } from "./review-loop-rollup";
```

And re-export the shape from this module (place beside the `ReviewLoopEpochStatus` export at `review-loop-epochs.ts:16`):

```ts
// Canonical home is review-loop-rollup.ts (the rollup reducer is the primary consumer);
// re-exported here so epoch-DAO callers get the shape without a second import.
export type { ReviewLoopEpochSummary } from "./review-loop-rollup";
```

3b. Append the DAO immediately after `hasCiReviewLoopEpochForHead` (which ends at `review-loop-epochs.ts:859`). Copy the `.prepare().bind().all<T>()` then `(rows.results ?? []).map(...)` shape from `listCollectingReviewLoopEpochs` at `:899-913`. NO `source_kind` filter — counts BOTH review and ci epochs:

```ts
/**
 * All epoch summaries (review AND ci) for a single PR head, for the review-loop done-state rollup.
 * Deliberately has NO `source_kind` filter: the rollup reduces over the full epoch set for the head,
 * so a ci-fix epoch must be counted alongside bot/human review epochs (contrast
 * `hasReviewLoopEpochForHead`, which excludes ci rows).
 */
export async function getReviewLoopEpochSummariesForHead(
  db: D1Database,
  options: { sessionId: string; prUrl: string; headSha: string },
): Promise<ReviewLoopEpochSummary[]> {
  const rows = await db
    .prepare(
      `SELECT status, blocked_reason FROM pr_review_response_epochs
       WHERE session_id = ? AND pr_url = ? AND head_sha = ?`,
    )
    .bind(options.sessionId, options.prUrl, options.headSha)
    .all<{ status: ReviewLoopEpochStatus; blocked_reason: string | null }>();
  return (rows.results ?? []).map((row) => ({
    status: row.status as ReviewLoopEpochStatus,
    blockedReason: (row.blocked_reason as string | null) ?? null,
  }));
}
```

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/review-loop-summaries.test.ts` — PASS (3 tests). Regression check: `npx vitest run tests/test_cloudflare/review-loop-epochs.test.ts` (49 tests pass).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-epochs.ts tests/test_cloudflare/review-loop-summaries.test.ts && git commit -m "feat(review-loop): add getReviewLoopEpochSummariesForHead DAO counting review+ci epochs"
```

---

**NOTES for the orchestrator / dependent clusters:**

- This task imports `ReviewLoopEpochSummary` from `./review-loop-rollup`; Step 3 won't typecheck until that file exists. Sequence AFTER (or with) the rollup file, OR temporarily define `ReviewLoopEpochSummary` inline here and have rollup re-export FROM here. Canonical home per CONTRACTS is `review-loop-rollup.ts`, so the import-from-rollup direction above is contract-aligned.
- CONTRACT note (not a conflict): the contract's DAO snippet maps `{ status: row.status as ReviewLoopEpochStatus, blockedReason: ... }`. Real column is `blocked_reason` (snake_case, `migrations/0114...sql:40`); the SQL and mapping use it, matching intent.
- Verified vitest command (ran live, 49 tests green): `npx vitest run <path>` from repo root `.`. `apps/control-plane-worker` has no local vitest; all control-plane tests run from the root `vitest.config.ts` (include glob `tests/**/*.{test,spec}.*`).

---

### Task 4: pr-labels constants (CYCLOID_REVIEW_DONE labels)

**Files:**

- Modify: `apps/control-plane-worker/src/constants/pr-labels.ts` (currently 2 exports, anchor at `pr-labels.ts:2`)

Pure-constant addition, no branching: no dedicated unit test (covered transitively by the `removeLabel` and label-ensure tasks). Single tiny commit.

- [ ] **Step 1: Append the two constants**

Insert after the existing `ARCANIST_SCHEDULED_LABEL` line. The current file is exactly:

```ts
export const CYCLOID_PR_LABEL = "cycloid";
export const ARCANIST_SCHEDULED_LABEL = "cycloid:scheduled";
```

Add below it:

```ts
export const CYCLOID_REVIEW_DONE_LABEL = "cycloid:review-done";
export const CYCLOID_REVIEW_DONE_CI_RED_LABEL = "cycloid:review-done-ci-red";
```

- [ ] **Step 2: Typecheck:** `npm --prefix apps/control-plane-worker run typecheck` — PASS

- [ ] **Step 3: Commit**

```bash
git add apps/control-plane-worker/src/constants/pr-labels.ts && git commit -m "feat(labels): add review-done PR label constants"
```

---

### Task 5: removeLabel in github/pr.ts

**Files:**

- Modify: `apps/control-plane-worker/src/github/pr.ts` — add `removeLabel` next to `addLabels` (anchor: `addLabels` at `pr.ts:928`; 404-tolerant DELETE pattern mirrors `deleteIssueComment` at `pr.ts:348-362`)
- Modify (test): `tests/test_cloudflare/github-pr-labels.test.ts` (existing harness stubs global `fetch`; `tracedFetch` calls global `fetch` per `observability/wrappers.ts:224`, so the stub intercepts it)

Real facts used: `GITHUB_API = "https://api.github.com"` (`pr.ts:15`), `githubHeaders(token)` (`pr.ts:19`), `tracedFetch` import (`pr.ts:8`). The `deleteIssueComment` 404 contract: `if (response.status === 404) return; if (!response.ok) { const errorBody = await response.text(); throw new Error(...(${response.status})...); }`.

- [ ] **Step 1: Write the failing tests**

Append a `describe("removeLabel", ...)` block inside the existing top-level `describe("GitHub PR labels", ...)` in `tests/test_cloudflare/github-pr-labels.test.ts` (file already imports `{ afterEach, beforeEach, describe, expect, it, vi }` and stubs global `fetch` via `fetchMock` in `beforeEach`). Replace the existing `type GithubPrModule = {...}` declaration with one that also declares `removeLabel`, and add the describe block before the final closing `});`:

```ts
type GithubPrModule = {
  addLabels: (token: string, owner: string, repo: string, issueNumber: number, labels: string[]) => Promise<void>;
  removeLabel: (token: string, owner: string, repo: string, issueNumber: number, label: string) => Promise<void>;
};
```

```ts
describe("removeLabel", () => {
  const modulePath: string = "../../apps/control-plane-worker/src/github/pr";

  it("DELETEs the URL-encoded label and resolves on 204", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    const mod = (await import(modulePath)) as unknown as GithubPrModule;
    await expect(mod.removeLabel("token123", "owner", "repo", 42, "cycloid:review-done")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchMock.mock.calls[0] as [string, { method?: string }];
    // Label segment must be percent-encoded (":" -> "%3A").
    expect(calledUrl).toContain("cycloid%3Areview-done");
    expect(calledUrl).toBe("https://api.github.com/repos/owner/repo/issues/42/labels/cycloid%3Areview-done");
    expect(calledOptions.method).toBe("DELETE");
  });

  it("resolves (no throw) when the label is already absent (404)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve("Label does not exist") });

    const mod = (await import(modulePath)) as unknown as GithubPrModule;
    await expect(mod.removeLabel("token123", "owner", "repo", 42, "cycloid:review-done")).resolves.toBeUndefined();
  });

  it("throws with the status embedded on a non-404 error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: () => Promise.resolve("Forbidden") });

    const mod = (await import(modulePath)) as unknown as GithubPrModule;
    await expect(mod.removeLabel("token123", "owner", "repo", 42, "cycloid:review-done")).rejects.toThrow("(403)");
  });
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/github-pr-labels.test.ts` — FAIL: `mod.removeLabel is not a function`. (The encode-URL test would additionally fail on the URL assertion if the function exists but is wrong.)

- [ ] **Step 3: Implement removeLabel**

Insert in `apps/control-plane-worker/src/github/pr.ts` immediately after `addLabels` (closing `}` at `pr.ts:945`), before `export type EnsureRepoLabelResult` at `pr.ts:947`:

```ts
export async function removeLabel(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    {
      method: "DELETE",
      headers: githubHeaders(token),
    },
  );

  if (response.status === 404) return;
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub remove label failed (${response.status}): ${errorBody}`);
  }
}
```

Note: the `(${response.status})` substring (e.g. `(403)`) is what `classifyGithubPollFailure` parses, matching the `deleteIssueComment`/`addLabels` message shape.

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/github-pr-labels.test.ts` — PASS (all `addLabels` + `removeLabel` tests)

- [ ] **Step 5: Typecheck:** `npm --prefix apps/control-plane-worker run typecheck` — PASS

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane-worker/src/github/pr.ts tests/test_cloudflare/github-pr-labels.test.ts && git commit -m "feat(github): add 404-tolerant removeLabel helper"
```

NOTE: `apps/control-plane-worker/package.json` has no `test` script; repo-root `package.json` has `"test": "vitest run"` with a single root `vitest.config.ts`, so run all vitest commands from repo root via `npx vitest run <test-path>`. Owner/repo are `encodeURIComponent`-wrapped in `removeLabel` (stricter than `addLabels` at `pr.ts:935`); intentional, matches the CONTRACT signature — owner/repo are simple so the encoded URL still equals `.../repos/owner/repo/...`.

---

### Task 6: SessionState field for reviewLoopDoneState

> Depends on Task 1, which already added `export type ReviewLoopDoneState` to `shared/session/phase.ts`. This task only adds the `SessionState` field that references it.

**Files:**

- Modify: `apps/control-plane-worker/src/types.ts:188` (after `reviewListeningEnteredAt?`)

- [ ] **Step 1: Add the field to `SessionState`**
      In `apps/control-plane-worker/src/types.ts`, the anchor is:

```ts
  reviewListeningHeadSha?: string | null;
  reviewListeningEnteredAt?: number | null;
```

Insert right after `reviewListeningEnteredAt?` (line 188):

```ts
  reviewLoopDoneState?: import("../../../shared/session/phase.js").ReviewLoopDoneState | null;
```

(`SessionDOResponse` at types.ts:241 is `Omit<SessionState, "status"> & {...}` and inherits this field automatically — do NOT re-declare it there.)

- [ ] **Step 2: Typecheck:** `npm run -w @cycloid/control-plane-worker typecheck` — PASS. Exercised end-to-end by the do-db round-trip test in Task 8.

- [ ] **Step 3: Commit**

```bash
git add apps/control-plane-worker/src/types.ts && git commit -m "feat(session): add SessionState reviewLoopDoneState field"
```

---

### Task 7: DO schema migration (review_loop_done_state column)

**Files:**

- Modify: `apps/control-plane-worker/src/session/schema.ts:459` (append to `MIGRATIONS[]` after `id: 73`)
- Modify: `tests/test_cloudflare/session/do-db.test.ts:392` (append migration 74 to the exact-match assertion)

- [ ] **Step 1: Add the failing assertion for migration 74**
      In `tests/test_cloudflare/session/do-db.test.ts`, the `it("includes the snapshot credential metadata migration", ...)` test asserts `expect(MIGRATIONS).toEqual([...])`; last entry is `id: 73`. Add after it, before the closing `])`:

```ts
      {
        id: 73,
        sql: "ALTER TABLE sandbox_state ADD COLUMN prev_sandbox_auth_token_expires_at INTEGER;",
        ignoreDuplicateColumn: true,
      },
      {
        id: 74,
        sql: "ALTER TABLE session ADD COLUMN review_loop_done_state TEXT;",
        ignoreDuplicateColumn: true,
      },
```

(The `id: 73` block already exists — only the `id: 74` block is new; keep `id: 73` exactly once.)

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/session/do-db.test.ts -t "snapshot credential metadata migration"` — FAIL: `MIGRATIONS` ends at 73, missing `id: 74`.

- [ ] **Step 3: Append migration 74 in schema.ts**
      In `apps/control-plane-worker/src/session/schema.ts`, the anchor is the final array entry:

```ts
  {
    id: 73,
    sql: "ALTER TABLE sandbox_state ADD COLUMN prev_sandbox_auth_token_expires_at INTEGER;",
    ignoreDuplicateColumn: true,
  },
];
```

Insert a new entry before the closing `];`:

```ts
  {
    id: 74,
    sql: "ALTER TABLE session ADD COLUMN review_loop_done_state TEXT;",
    ignoreDuplicateColumn: true,
  },
];
```

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/session/do-db.test.ts -t "snapshot credential metadata migration"` — PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/schema.ts tests/test_cloudflare/session/do-db.test.ts && git commit -m "feat(session): DO migration 74 add review_loop_done_state column"
```

---

### Task 8: do-db getSessionExtended read + updateSessionFields write

**Files:**

- Modify: `apps/control-plane-worker/src/session/do-db.ts:309` (`SessionExtendedFields`), `:362` (`getSessionExtended` read), `:428` (`updateSessionFields` mapping)
- Modify: `tests/test_cloudflare/session/do-db.test.ts` (new test in the `describe("session CRUD", ...)` block, near line 579)

- [ ] **Step 1: Failing round-trip test** — in `tests/test_cloudflare/session/do-db.test.ts`, inside `describe("session CRUD", ...)` (after the `"reads and writes extended fields"` test ending ~line 579):

```ts
it("round-trips reviewLoopDoneState including null", () => {
  createSession(sql, { sessionId: "s-rl", ownerUserId: "u-1" });

  // Defaults to null before any claim is written.
  expect(getSessionExtended(sql, "s-rl")!.reviewLoopDoneState).toBeNull();

  updateSessionFields(sql, "s-rl", { reviewLoopDoneState: "done_green" });
  expect(getSessionExtended(sql, "s-rl")!.reviewLoopDoneState).toBe("done_green");

  updateSessionFields(sql, "s-rl", { reviewLoopDoneState: "done_exhausted" });
  expect(getSessionExtended(sql, "s-rl")!.reviewLoopDoneState).toBe("done_exhausted");

  updateSessionFields(sql, "s-rl", { reviewLoopDoneState: "working" });
  expect(getSessionExtended(sql, "s-rl")!.reviewLoopDoneState).toBe("working");

  // Explicit null clears the claim.
  updateSessionFields(sql, "s-rl", { reviewLoopDoneState: null });
  expect(getSessionExtended(sql, "s-rl")!.reviewLoopDoneState).toBeNull();
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/session/do-db.test.ts -t "round-trips reviewLoopDoneState"` — FAIL: `reviewLoopDoneState` is `undefined` (property not read; `updateSessionFields` ignores the unknown key), so `toBe("done_green")` fails.

- [ ] **Step 3a: Add the field to `SessionExtendedFields`**
      In `do-db.ts`, the anchor (end of the interface, ~line 309):

```ts
  reviewListeningHeadSha?: string | null;
  reviewListeningEnteredAt?: number | null;
}
```

Insert before the closing `}`:

```ts
  reviewListeningHeadSha?: string | null;
  reviewListeningEnteredAt?: number | null;
  reviewLoopDoneState?: ReviewLoopDoneState | null;
}
```

And add the import near the other shared imports at the top of `do-db.ts` (next to `import type { SessionReplayEvent } from "../../../../shared/types/session-replay.js";`, ~line 29):

```ts
import type { ReviewLoopDoneState } from "../../../../shared/session/phase.js";
```

- [ ] **Step 3b: Read the column in `getSessionExtended`**
      In `do-db.ts`, the anchor in the returned object (~line 362):

```ts
    reviewListeningHeadSha: row.review_listening_head_sha as string | null,
    reviewListeningEnteredAt: row.review_listening_entered_at as number | null,
  };
```

Insert before the closing `};`:

```ts
    reviewListeningHeadSha: row.review_listening_head_sha as string | null,
    reviewListeningEnteredAt: row.review_listening_entered_at as number | null,
    reviewLoopDoneState: reviewLoopDoneStateOrNull(row.review_loop_done_state),
  };
```

Add this normalizer helper near the other `*OrNull` helpers (after `runtimeBackendOrNull` at ~line 109):

```ts
function reviewLoopDoneStateOrNull(value: unknown): ReviewLoopDoneState | null {
  return value === "working" || value === "done_green" || value === "done_exhausted" ? value : null;
}
```

- [ ] **Step 3c: Write the column in `updateSessionFields`**
      In `do-db.ts`, the anchor (last entry of the `mapping` array, ~line 428):

```ts
    ["reviewListeningEnteredAt", "review_listening_entered_at", (v) => (v as number | null) ?? null],
  ];
```

Insert before the closing `];`:

```ts
    ["reviewListeningEnteredAt", "review_listening_entered_at", (v) => (v as number | null) ?? null],
    ["reviewLoopDoneState", "review_loop_done_state", (v) => reviewLoopDoneStateOrNull(v)],
  ];
```

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/session/do-db.test.ts -t "round-trips reviewLoopDoneState"` — PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/do-db.ts tests/test_cloudflare/session/do-db.test.ts && git commit -m "feat(session): persist reviewLoopDoneState in do-db read/write"
```

---

### Task 9: session_index column `review_loop_done_state` — migration + SessionRow + toSessionApiShape

**Files:**

- Create: `apps/control-plane-worker/migrations/0139_session_index_review_loop_done_state.sql`
- Modify: `apps/control-plane-worker/src/session/db.ts:444` (SessionRow interface), `:812` (toSessionApiShape), `:718` (listSessions COLUMNS)
- Modify: `tests/test_cloudflare/session-db.test.ts:30` (makeRow harness — add field), add 2 new `it()` cases
- Run lock: `npx vitest run tests/test_cloudflare/migration-integrity.test.ts`

- [ ] **Step 1: Failing test** — append inside `describe("session db listSessions", ...)` in `tests/test_cloudflare/session-db.test.ts` (describe closes at `});` on line 294):

```ts
it("surfaces review_loop_done_state in the api shape when present", () => {
  const greenRow = { ...makeRow("session-green", "2026-06-08T00:00:00.000Z"), review_loop_done_state: "done_green" };
  expect(toSessionApiShape(greenRow as never)).toMatchObject({ reviewLoopDoneState: "done_green" });

  const exhaustedRow = {
    ...makeRow("session-amber", "2026-06-08T00:00:01.000Z"),
    review_loop_done_state: "done_exhausted",
  };
  expect(toSessionApiShape(exhaustedRow as never)).toMatchObject({ reviewLoopDoneState: "done_exhausted" });
});

it("omits reviewLoopDoneState when the column is null", () => {
  expect(toSessionApiShape(makeRow("session-null", "2026-06-08T00:00:02.000Z"))).not.toHaveProperty(
    "reviewLoopDoneState",
  );
});

it("selects review_loop_done_state for the list rows", async () => {
  const { db, getSql } = makeDb();
  await listSessions(db, "user-1", null, undefined, { limit: 10 });
  expect(getSql()).toContain("review_loop_done_state");
});
```

Also add the field to the `makeRow` return object (after `match_score: options.matchScore,` at line 53 — inside the object literal) and to the `SessionListRow` type (after line 27 `match_score?: number | null;`):

```ts
// in SessionListRow type (after match_score):
  review_loop_done_state?: "working" | "done_green" | "done_exhausted" | null;
```

```ts
// in makeRow() return literal (after match_score: options.matchScore,):
    review_loop_done_state: null,
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/session-db.test.ts` — FAIL: `surfaces review_loop_done_state...` (no `reviewLoopDoneState` key on api shape) and `selects review_loop_done_state...` (SQL `COLUMNS` lacks the column).

- [ ] **Step 3: Create the migration** — new file `apps/control-plane-worker/migrations/0139_session_index_review_loop_done_state.sql` (mirrors `0137_session_index_callback_context.sql`):

```sql
ALTER TABLE session_index ADD COLUMN review_loop_done_state TEXT;
```

- [ ] **Step 4: Add the field to `SessionRow`** — in `apps/control-plane-worker/src/session/db.ts`, after `cron_snapshot: string | null;` (line 474, the last field of the interface before the closing `}` at 475):

```ts
  review_loop_done_state?: "working" | "done_green" | "done_exhausted" | null;
```

- [ ] **Step 5: Add the column to the `listSessions` SELECT** — in `db.ts:718`, the `COLUMNS` const string ends with `..., cron_snapshot`. Append the new column so the list query reads it:

```ts
const COLUMNS =
  "session_id, owner_user_id, business_id, status, created_at, updated_at, closed_at, last_event_id, title, rich_status, model, reasoning_effort, session_kind, repo_owner, repo_name, parent_session_id, spawn_depth, initiation_mode, scheduled_rule_id, rule_name_snapshot, cron_snapshot, review_loop_done_state";
```

- [ ] **Step 6: Surface it in `toSessionApiShape`** — in `db.ts:847`, the object ends with `...(row.cron_snapshot ? { cronSnapshot: row.cron_snapshot } : {}),` then `};` at 848. Add a conditional spread (omit when null, matching the publish-field pattern) immediately before the closing `};`:

```ts
    ...(row.review_loop_done_state ? { reviewLoopDoneState: row.review_loop_done_state } : {}),
```

- [ ] **Step 7: Verify pass:** `npx vitest run tests/test_cloudflare/session-db.test.ts` — PASS

- [ ] **Step 8: Regenerate the migration lock:** `npx vitest run tests/test_cloudflare/migration-integrity.test.ts`

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane-worker/migrations/0139_session_index_review_loop_done_state.sql tests/test_cloudflare/migration-integrity.test.ts apps/control-plane-worker/src/session/db.ts tests/test_cloudflare/session-db.test.ts && git commit -m "feat(session-index): surface review_loop_done_state in list api shape"
```

---

### Task 10: `mirrorReviewLoopDoneStateToIndex` — write path that mirrors the DO field into session_index

**Files:**

- Modify: `apps/control-plane-worker/src/session/db.ts` (add exported fn next to `buildSyncRichStatusStatement` at :251)
- Modify/Create test: `tests/test_cloudflare/services/session-projection.test.ts` (add a handler branch to the `FakeStatement.run()` + a new `it()`)

**Cluster D contract:** the done-state route handler in `durable-object.ts` calls `mirrorReviewLoopDoneStateToIndex(db, sessionId, doneState)` after writing the DO SQLite column. Exact signature below.

- [ ] **Step 1: Failing test** — in `tests/test_cloudflare/services/session-projection.test.ts`:
  - Add to the `SessionIndexRow` type (after `cron_snapshot: string | null;` at line 49):

```ts
  review_loop_done_state?: string | null;
```

- Add a new `run()` branch inside `FakeStatement.run()` (insert before the `if (this.query.includes("UPDATE session_index SET snapshot_image_id"))` block at line 203):

```ts
if (this.query.includes("UPDATE session_index SET review_loop_done_state")) {
  const [doneState, sessionId] = this.boundValues as [string | null, string];
  const existing = this.db.sessionIndex.get(sessionId);
  if (existing) existing.review_loop_done_state = doneState;
  return { success: true };
}
```

- Add the import at the top alongside `buildUpsertSessionIndexStatement` (line 13):

```ts
import {
  buildUpsertSessionIndexStatement,
  mirrorReviewLoopDoneStateToIndex,
} from "../../../apps/control-plane-worker/src/session/db";
```

- Add a new `it()` before the final `});` of the describe block (line 808):

```ts
it("mirrors review_loop_done_state into the session index row", async () => {
  const db = new FakeProjectionD1();
  await syncSessionProjection({
    db: db as unknown as D1Database,
    sessionId: "session-1",
    session: buildSessionState(),
  });

  await mirrorReviewLoopDoneStateToIndex(db as unknown as D1Database, "session-1", "done_green");
  expect(db.sessionIndex.get("session-1")?.review_loop_done_state).toBe("done_green");

  await mirrorReviewLoopDoneStateToIndex(db as unknown as D1Database, "session-1", null);
  expect(db.sessionIndex.get("session-1")?.review_loop_done_state).toBeNull();
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/services/session-projection.test.ts` — FAIL: `mirrorReviewLoopDoneStateToIndex` not exported (import is `undefined`, call throws `TypeError`).

- [ ] **Step 3: Implement the mirror fn** — in `apps/control-plane-worker/src/session/db.ts`, add the import for the type at the top (group with the existing `import type { ... } from "../types"` at line 9; `ReviewLoopDoneState` comes from shared/session/phase):

```ts
import type { ReviewLoopDoneState } from "../../../../shared/session/phase.js";
```

Then add the exported fn immediately after `buildSyncRichStatusStatement` (which closes with `};` at line 264). It mirrors the simple direct-write shape of `upsertSessionIndex` (db.ts:406) rather than the statement-builder shape, since the route awaits it directly:

```ts
export async function mirrorReviewLoopDoneStateToIndex(
  db: D1Database,
  sessionId: string,
  doneState: ReviewLoopDoneState | null,
): Promise<void> {
  await db
    .prepare("UPDATE session_index SET review_loop_done_state = ? WHERE session_id = ?")
    .bind(doneState ?? null, sessionId)
    .run();
}
```

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/services/session-projection.test.ts` — PASS

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/db.ts tests/test_cloudflare/services/session-projection.test.ts && git commit -m "feat(session-index): mirror review_loop_done_state from DO into list index"
```

---

### Task 11: `assembleSessionView` copies `reviewLoopDoneState` into the view model

**Files:**

- Modify: `apps/control-plane-worker/src/services/session-view.ts:124` (assembleSessionView viewModel literal)
- Modify test: `tests/test_cloudflare/session-view-service.test.ts` (add an assertion)

**Context:** `assembleSessionView` builds `viewModel: SessionViewModel` at session-view.ts:80–125, reading from a `SessionDOResponse` (`session`). The literal ends with `cronSnapshot: session.cronSnapshot ?? null,` then `};` at line 125. `SessionDOResponse` inherits `reviewLoopDoneState` from `SessionState` (per the SessionState contract), so `session.reviewLoopDoneState` is typed.

- [ ] **Step 1: Failing test** — in `tests/test_cloudflare/session-view-service.test.ts`, add inside the existing `describe(...)` (file imports `assembleSessionView` at line 64; has `makeSession`/`makeAuth`/`makePromptState` helpers). Mirror how other tests call `assembleSessionView`:

```ts
it("copies reviewLoopDoneState from the DO session into the view model", async () => {
  const view = await assembleSessionView(
    makeSession({ reviewLoopDoneState: "done_exhausted" }),
    makeAuth(),
    makePromptState(),
  );
  expect(view.session.reviewLoopDoneState).toBe("done_exhausted");

  const noClaim = await assembleSessionView(makeSession(), makeAuth(), makePromptState());
  expect(noClaim.session.reviewLoopDoneState).toBeNull();
});
```

If existing tests call `assembleSessionView` with a different positional/options shape, copy the exact call signature from a sibling `it()`.

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/session-view-service.test.ts` — FAIL: `view.session.reviewLoopDoneState` is `undefined` (not copied; field absent from `SessionViewModel`).

- [ ] **Step 3: Add the field to `SessionViewModel`** — in `shared/types/session-view.ts`, the `SessionViewModel` ends with `cronSnapshot?: string | null;` at line 80 then `};` at 81. Add the import (the file already imports from `../session/phase.js` at line 13) and the field:

```ts
// extend the existing phase import at line 13:
import type { FinalizingStep, Phase, ReviewLoopDoneState, SandboxSubstate, StopMode } from "../session/phase.js";
```

```ts
// add as the last field of SessionViewModel, before the closing };:
  // Review-loop catch-up claim (ARC review-loop indicator). null = no claim / render nothing.
  reviewLoopDoneState?: ReviewLoopDoneState | null;
```

- [ ] **Step 4: Copy it in `assembleSessionView`** — in `apps/control-plane-worker/src/services/session-view.ts`, after `cronSnapshot: session.cronSnapshot ?? null,` (line 124, just before the closing `};` at 125):

```ts
    reviewLoopDoneState: session.reviewLoopDoneState ?? null,
```

- [ ] **Step 5: Verify pass:** `npx vitest run tests/test_cloudflare/session-view-service.test.ts` — PASS

- [ ] **Step 6: Commit**

```bash
git add shared/types/session-view.ts apps/control-plane-worker/src/services/session-view.ts tests/test_cloudflare/session-view-service.test.ts && git commit -m "feat(session-view): thread reviewLoopDoneState into the session view model"
```

---

### Task 12: `ClientSessionSnapshot` DTO field (plain edit, type-only)

**Files:**

- Modify: `shared/types/session-websocket.ts:93` (ClientSessionSnapshot type)

**Context:** `ClientSessionSnapshot` is at session-websocket.ts:57–94; imports phase types from `../session/phase.js` (line 1); ends with `cronSnapshot?: string | null;` at line 93 then `};` at 94. Pure type addition, no runtime branch: no standalone test — `assembleSessionView`/`fetchSessionView` tests exercise the threaded value; `tsc` is the gate.

- [ ] **Step 1: Extend the phase import** — line 1 currently:

```ts
import type { FinalizingStep, Phase, SandboxSubstate, StopMode } from "../session/phase.js";
```

Change to:

```ts
import type { FinalizingStep, Phase, ReviewLoopDoneState, SandboxSubstate, StopMode } from "../session/phase.js";
```

- [ ] **Step 2: Add the field** — in the `ClientSessionSnapshot` type, after `cronSnapshot?: string | null;` (line 93, last field before `};` at 94):

```ts
  reviewLoopDoneState?: ReviewLoopDoneState | null;
```

- [ ] **Step 3: Typecheck:** `npx tsc -p apps/control-plane-worker/tsconfig.json --noEmit` (or the repo's `npm run typecheck` if present — confirm in `package.json`) — PASS

- [ ] **Step 4: Commit**

```bash
git add shared/types/session-websocket.ts && git commit -m "feat(types): add reviewLoopDoneState to ClientSessionSnapshot DTO"
```

---

Verified facts for the calling clusters:

- Vitest command (repo root): `npx vitest run <path>` — confirmed: `package.json` `test` = `vitest run`; `test:unauth-exposure` shells `npx vitest run tests/...`. Tests live under `tests/test_cloudflare/`, NOT colocated.
- **Mirror fn Cluster D must call:** `mirrorReviewLoopDoneStateToIndex(db: D1Database, sessionId: string, doneState: ReviewLoopDoneState | null): Promise<void>` — exported from `apps/control-plane-worker/src/session/db.ts`. (rich_status mirror `buildSyncRichStatusStatement` at db.ts:251 is a statement-builder; deliberately used the direct-write `upsertSessionIndex`-style shape at db.ts:406 instead so the route can `await` it without batching.)
- Next migration number is **0139** (latest on disk is `0138_memory_review_candidates.sql`); regenerate `migration-integrity.test.ts` via `npx vitest run tests/test_cloudflare/migration-integrity.test.ts` after adding it.
- `ReviewLoopDoneState` import path: `../../../../shared/session/phase.js` from `apps/control-plane-worker/src/...`; `../session/phase.js` from `shared/types/...` (matching the existing `Phase` imports).
- `toSessionApiShape` (db.ts:812) uses conditional spreads for optional fields; followed so a null/absent column emits no key (list `normalizeSessionMetadata` carries it via spread per Cluster contract — no change needed there).

---

### Task 13: Internal route POST /session/review-loop/done-state (types + map entry)

**Files:**

- Modify: `apps/control-plane-worker/src/session/internal-routes.ts:359` (req/resp types near the review-listening types), `:463` (route map type entry near `reviewListeningEnter`), `:740` (`SESSION_INTERNAL_ROUTES` runtime entry)

- [ ] **Step 1: No separate unit test** — type-only plumbing; correctness enforced by `tsc` (Step 3c) and exercised by the handler test (next task) and client-fn test.

- [ ] **Step 2: Add request/response types**
      In `internal-routes.ts`, the anchor (~line 359, after `UpdateSessionReviewListeningHeadResponse`):

```ts
export interface UpdateSessionReviewListeningHeadResponse {
  ok: boolean;
  updated?: boolean;
  reason?: string;
}
```

Insert right after it:

```ts
export interface UpdateSessionReviewLoopDoneStateRequest {
  requestId: string;
  doneState: import("../../../../shared/session/phase.js").ReviewLoopDoneState | null;
}

export interface UpdateSessionReviewLoopDoneStateResponse {
  ok: boolean;
  updated: boolean;
}
```

- [ ] **Step 3a: Add the route-map type entry**
      The anchor in `interface SessionInternalRouteMap` (~line 458):

```ts
reviewListeningEnter: {
  method: "POST";
  path: "/session/review-listening/enter";
  request: EnterSessionReviewListeningRequest;
  response: EnterSessionReviewListeningResponse;
}
```

Insert right after it:

```ts
reviewLoopDoneState: {
  method: "POST";
  path: "/session/review-loop/done-state";
  request: UpdateSessionReviewLoopDoneStateRequest;
  response: UpdateSessionReviewLoopDoneStateResponse;
}
```

- [ ] **Step 3b: Add the runtime route entry**
      The anchor in `SESSION_INTERNAL_ROUTES` (~line 740):

```ts
  reviewListeningEnter: { method: "POST", path: "/session/review-listening/enter" },
```

Insert right after it:

```ts
  reviewLoopDoneState: { method: "POST", path: "/session/review-loop/done-state" },
```

- [ ] **Step 3c: Typecheck:** `npm run -w @cycloid/control-plane-worker typecheck` — PASS (`SESSION_INTERNAL_ROUTES satisfies SessionInternalRouteDefinitions` still holds: every map key has a runtime entry and vice versa).

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane-worker/src/session/internal-routes.ts && git commit -m "feat(session): add review-loop/done-state internal route contract"
```

---

### Task 14: setSessionReviewLoopDoneState client fn (state.ts)

**Files:**

- Modify: `apps/control-plane-worker/src/session/state.ts:1301` (after `updateSessionReviewListeningHead`) + its import block
- Modify: `tests/test_cloudflare/session-state.test.ts` (new cases in `describe("typed SessionDO route helpers", ...)`; extend the `SessionStateModule` type ~line 178)

- [ ] **Step 1: Failing client-fn tests (ok / DO non-ok / updated=false)**
      In `tests/test_cloudflare/session-state.test.ts`, add the method to the `SessionStateModule` type (anchor: closing `};`, after `getSessionReplayPageAuthed`, ~line 178):

```ts
  setSessionReviewLoopDoneState: (
    env: Record<string, unknown>,
    sessionId: string,
    options: { doneState: "working" | "done_green" | "done_exhausted" | null },
    requestId?: string | null,
  ) => Promise<{ status: number; ok: boolean; payload: { ok: boolean; updated: boolean } | null }>;
};
```

Then add tests inside `describe("typed SessionDO route helpers", ...)` (after the `"updates callback context through the shared route contract"` test, ~line 1128):

```ts
it("sends review-loop done-state through the shared route contract", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, updated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const env = {
    SESSION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: fetchMock }),
    },
  };

  const result = await stateMod.setSessionReviewLoopDoneState(
    env,
    "session-123",
    { doneState: "done_green" },
    "req-123",
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toEqual({ ok: true, updated: true });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://internal/session/review-loop/done-state");
  expect(init.method).toBe("POST");
  expectHeaders(init, {
    "content-type": "application/json",
    "x-request-id": "req-123",
    "x-session-id": "session-123",
  });
  const body = JSON.parse(init.body as string) as { requestId: string; doneState: string | null };
  expect(body.doneState).toBe("done_green");
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
});

it("serializes a null done-state claim", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, updated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const env = {
    SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: fetchMock }) },
  };

  await stateMod.setSessionReviewLoopDoneState(env, "session-123", { doneState: null });

  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(JSON.parse(init.body as string)).toMatchObject({ doneState: null });
});

it("reports updated=false from the DO payload without throwing", async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, updated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const env = {
    SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: fetchMock }) },
  };

  const result = await stateMod.setSessionReviewLoopDoneState(env, "session-123", { doneState: "working" });
  expect(result.ok).toBe(true);
  expect(result.payload).toEqual({ ok: true, updated: false });
});

it("surfaces a DO non-ok response as ok:false with null payload", async () => {
  const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
  const env = {
    SESSION: { idFromName: (name: string) => name, get: () => ({ fetch: fetchMock }) },
  };

  const result = await stateMod.setSessionReviewLoopDoneState(env, "missing", { doneState: "done_green" });
  expect(result.status).toBe(404);
  expect(result.ok).toBe(false);
  expect(result.payload).toBeNull();
});
```

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/session-state.test.ts -t "review-loop done-state"` — FAIL: `stateMod.setSessionReviewLoopDoneState is not a function`.

- [ ] **Step 3: Implement the client fn**
      In `apps/control-plane-worker/src/session/state.ts`, add to the existing `internal-routes` import block (search for `UpdateSessionReviewListeningHeadRequest` near the top):

```ts
  type UpdateSessionReviewLoopDoneStateRequest,
  type UpdateSessionReviewLoopDoneStateResponse,
```

Then add the function right after `updateSessionReviewListeningHead` (anchor at state.ts:1301):

```ts
export async function setSessionReviewLoopDoneState(
  env: Env,
  sessionId: string,
  options: { doneState: import("../../../../shared/session/phase.js").ReviewLoopDoneState | null },
  requestId?: string | null,
): Promise<SessionFetchResult<UpdateSessionReviewLoopDoneStateResponse>> {
  const body = {
    requestId: requestId ?? crypto.randomUUID(),
    doneState: options.doneState,
  } satisfies UpdateSessionReviewLoopDoneStateRequest;
  return fetchSessionRouteResult(env, sessionId, "reviewLoopDoneState", {
    requestId,
    body,
  });
}
```

(`crypto.randomUUID()` is available in the Workers runtime; `requestId` in the body is the idempotency key required by the route contract, distinct from the `x-request-id` header.)

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/session-state.test.ts -t "review-loop done-state"` then the null/updated-false/non-ok cases via `npx vitest run tests/test_cloudflare/session-state.test.ts -t "done-state"` — PASS (all 4 cases)

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/state.ts tests/test_cloudflare/session-state.test.ts && git commit -m "feat(session): setSessionReviewLoopDoneState client fn"
```

---

### Task 15: DO route handler + broadcast + builder hops (durable-object.ts)

**Files:**

- Modify: `apps/control-plane-worker/src/session/durable-object.ts:5398` (new handler after the `/session/review-listening/head` block), `:3217` (buildSessionDoResponse), `:3372` (buildClientSessionSnapshot)
- Test: `tests/test_cloudflare/session/review-loop-done-state-route.test.ts` (new; copies the DO harness from `helpers.ts`)

NOTE: Before this compiles, the DTO field must exist: `reviewLoopDoneState?: import("../session/phase.js").ReviewLoopDoneState | null;` (path-adjust) on `ClientSessionSnapshot` in `shared/types/session-websocket.ts` — `SessionDOResponse` inherits via `Omit<SessionState,...>` (already added in Task 1). The DTO cluster owns that line; if running standalone, add it here.

- [ ] **Step 1: Failing handler test (branches: 400 / 404 / write+updated:true / mirror called / broadcast)**
      Create `tests/test_cloudflare/session/review-loop-done-state-route.test.ts`, copying sibling DO test harness wiring (`mockCloudflareWorkers`, `mockSentryCloudflare`, `createFakeState`, `createTestEnv` from `./helpers.ts`; exact import shape at `tests/test_cloudflare/session/broadcast-before-persist.test.ts:48`). Skeleton:

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { createFakeState, createTestEnv, mockCloudflareWorkers, mockSentryCloudflare } from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

const INTERNAL = "https://internal";

describe("POST /session/review-loop/done-state", () => {
  let SessionDO: typeof import("../../../apps/control-plane-worker/src/session/durable-object.ts").SessionDO;
  let state: ReturnType<typeof createFakeState>;
  let env: ReturnType<typeof createTestEnv>;
  let agent: InstanceType<typeof SessionDO>;

  beforeAll(async () => {
    ({ SessionDO } = await import("../../../apps/control-plane-worker/src/session/durable-object.ts"));
  });

  beforeEach(() => {
    state = createFakeState();
    env = createTestEnv();
    agent = new SessionDO(state as never, env as never);
    // Seed a session + mark review-listening active so the handler's normal path runs.
    doDb.createSession(state.storage.sql, { sessionId: "s-1", ownerUserId: "1" });
    doDb.updateSessionFields(state.storage.sql, "s-1", { reviewListeningActive: true });
  });

  afterEach(() => vi.restoreAllMocks());

  function post(body: unknown): Request {
    return new Request(`${INTERNAL}/session/review-loop/done-state`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "s-1" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a missing requestId with 400", async () => {
    const res = await agent.fetch(post({ doneState: "done_green" }));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await agent.fetch(
      new Request(`${INTERNAL}/session/review-loop/done-state`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "missing" },
        body: JSON.stringify({ requestId: "r-1", doneState: "done_green" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("writes the column, mirrors to session_index, broadcasts, and returns updated:true", async () => {
    const broadcastSpy = vi.spyOn(agent as unknown as { broadcast: (m: unknown) => void }, "broadcast");
    const res = await agent.fetch(post({ requestId: "r-1", doneState: "done_green" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: true });

    // Column written on the DO.
    expect(doDb.getSessionExtended(state.storage.sql, "s-1")!.reviewLoopDoneState).toBe("done_green");
    // session_index mirror issued.
    expect(env.DB.__statements()).toContain("UPDATE session_index SET review_loop_done_state = ? WHERE session_id = ?");
    // Snapshot broadcast carries the new claim.
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it("returns updated:false when the claim is unchanged (idempotent re-post)", async () => {
    await agent.fetch(post({ requestId: "r-1", doneState: "working" }));
    const res = await agent.fetch(post({ requestId: "r-2", doneState: "working" }));
    expect(await res.json()).toEqual({ ok: true, updated: false });
  });

  it("clears the claim on null and returns updated:true", async () => {
    await agent.fetch(post({ requestId: "r-1", doneState: "done_exhausted" }));
    const res = await agent.fetch(post({ requestId: "r-2", doneState: null }));
    expect(await res.json()).toEqual({ ok: true, updated: true });
    expect(doDb.getSessionExtended(state.storage.sql, "s-1")!.reviewLoopDoneState).toBeNull();
  });
});
```

First open `tests/test_cloudflare/session/helpers.ts`: confirm the exported names (`createFakeState`, `createTestEnv`) and whether the fake `env.DB` records executed SQL. If it has no `__statements()`, assert the mirror by spying instead: import `* as sessionDb` from `../../../apps/control-plane-worker/src/session/db.ts`, `vi.spyOn(sessionDb, "mirrorReviewLoopDoneStateToIndex")` — keep whichever one assertion the harness supports.

- [ ] **Step 2: Verify fail:** `npx vitest run tests/test_cloudflare/session/review-loop-done-state-route.test.ts` — FAIL: route unhandled, `agent.fetch(...)` returns the DO's default 404/unknown-route response (the `updated:true` case fails first).

- [ ] **Step 3a: Add the handler**
      In `durable-object.ts`, the anchor is the end of the `/session/review-listening/head` block (the `return jsonResponse({ ok: true, updated: true });` that closes that `if`, ~line 5397):

```ts
          return jsonResponse({ ok: true, updated: true });
        }

        if (request.method === "POST" && url.pathname === "/session/review-listening/enter") {
```

Insert a new block between the `head` block's closing `}` and the `enter` block:

```ts
if (request.method === "POST" && url.pathname === "/session/review-loop/done-state") {
  const sid = this.resolveSessionId();
  if (!sid) return jsonErrorResponse("Session not found", 404);
  const session = doDb.getSession(this.sql, sid);
  if (!session) return jsonErrorResponse("Session not found", 404);
  const payload = (await parseJsonBody(request)) as Partial<{
    requestId: string;
    doneState: ReviewLoopDoneState | null;
  }> | null;
  const requestId = asNonEmptyString(payload?.requestId);
  if (!requestId) return jsonErrorResponse("Invalid review loop done-state update", 400);
  const doneState = normalizeReviewLoopDoneState(payload?.doneState);
  const ext = doDb.getSessionExtended(this.sql, sid);
  const current = ext?.reviewLoopDoneState ?? null;
  if (current === doneState) {
    return jsonResponse({ ok: true, updated: false });
  }
  doDb.updateSessionFields(this.sql, sid, { reviewLoopDoneState: doneState });
  await this.persistReviewLoopDoneStateToD1(sid, doneState);
  await this.broadcastSessionSnapshot(sid);
  return jsonResponse({ ok: true, updated: true });
}
```

Add the import for `ReviewLoopDoneState` near the other `shared/session/phase.js` type imports at the top of `durable-object.ts` (grep `from "../../../../shared/session/phase.js"`), and add this module-level normalizer next to the other small helpers (e.g. near `richStatusFromPhase` usage / the top-of-file helpers ~line 340):

```ts
function normalizeReviewLoopDoneState(value: unknown): ReviewLoopDoneState | null {
  return value === "working" || value === "done_green" || value === "done_exhausted" ? value : null;
}
```

- [ ] **Step 3b: Add the D1 mirror method (next to persistRichStatusToD1)**
      The anchor is `persistRichStatusToD1` (durable-object.ts:3580). Insert a sibling method right after it (after its closing `}` at ~line 3591):

```ts
  // Mirror the review-loop done-state claim onto session_index so the session
  // list renders the indicator without waking each DO — same write-ownership
  // contract as persistRichStatusToD1. No-op when D1 is unbound (tests/local).
  private async persistReviewLoopDoneStateToD1(
    sessionId: string,
    reviewLoopDoneState: ReviewLoopDoneState | null,
  ): Promise<void> {
    const db = (this.env as Env).DB;
    if (!db) return;
    await mirrorReviewLoopDoneStateToIndex(db, sessionId, reviewLoopDoneState);
  }
```

Add `mirrorReviewLoopDoneStateToIndex` to the existing `./db.js` import in `durable-object.ts` (same module as `buildSyncRichStatusStatement`). This is the Task 10 mirror fn — it has no unbound-DB guard; that guard lives in this wrapper. The DO route is its only production caller.

- [ ] **Step 3c: Add the required snapshot broadcast helper**
      Add a method that rebuilds and broadcasts the full `subscribed` snapshot (which carries `session: ClientSessionSnapshot`, now including `reviewLoopDoneState`). Place it next to `broadcast` (durable-object.ts:11271):

```ts
  // Required broadcast for out-of-band session-field mutations (review-loop
  // done-state) that are not phase transitions: rebuild the client snapshot and
  // push it to every subscribed socket so the indicator updates live.
  private async broadcastSessionSnapshot(sessionId: string): Promise<void> {
    const snapshot = await this.buildClientSessionSnapshot(sessionId);
    this.broadcast({
      type: "session_snapshot",
      session: snapshot.session,
    } as ServerMessage);
  }
```

If `ServerMessage` (`shared/types/session-websocket.ts`) has no `"session_snapshot"` variant, re-broadcast the existing `subscribed` v2 message instead (reuse the object built at durable-object.ts:3405 via a small shared helper) — pick a variant the wire union already supports so no FE message-type change is forced in this PR; grep `ServerMessage` in `apps/control-plane-worker/src/ws/types.ts` before choosing. The contract requires the broadcast to fire; the exact message type is an implementation detail.

- [ ] **Step 3d: Builder hops — copy reviewLoopDoneState from ext**
      In `buildSessionDoResponse`, the anchor (durable-object.ts:3217):

```ts
      reviewListeningHeadSha: ext?.reviewListeningHeadSha ?? null,
      reviewListeningEnteredAt: ext?.reviewListeningEnteredAt ?? null,
```

Insert after `reviewListeningEnteredAt`:

```ts
      reviewLoopDoneState: ext?.reviewLoopDoneState ?? null,
```

In `buildClientSessionSnapshot`, the anchor (durable-object.ts:3372, inside the `session: { ... }` literal, after `cronSnapshot`):

```ts
        ruleNameSnapshot: session.ruleNameSnapshot ?? null,
        cronSnapshot: session.cronSnapshot ?? null,
      },
```

Insert `reviewLoopDoneState` before the closing `},`:

```ts
        cronSnapshot: session.cronSnapshot ?? null,
        reviewLoopDoneState: ext?.reviewLoopDoneState ?? null,
      },
```

Audit other ext-spread builder sites: `buildSessionViewPayload` (durable-object.ts:3263) reuses `buildSessionDoResponse` — no extra edit. Grep `getSessionExtended(this.sql` in durable-object.ts to confirm no other site hand-builds a client-facing session object; if one does, copy the same `reviewLoopDoneState: ext?.reviewLoopDoneState ?? null` line there.

- [ ] **Step 4: Verify pass:** `npx vitest run tests/test_cloudflare/session/review-loop-done-state-route.test.ts` — PASS (all branches: 400, 404, write+mirror+broadcast+updated:true, updated:false unchanged, null-clear updated:true). Then `npm run -w @cycloid/control-plane-worker typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/durable-object.ts tests/test_cloudflare/session/review-loop-done-state-route.test.ts && git commit -m "feat(session): review-loop/done-state DO handler, D1 mirror, broadcast, builder hops"
```

---

### Task 16: Extract `reconcileReviewLoopDoneState` helper in review-loop-sweep.ts

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-sweep.ts` (imports block `1-69`; new helper inserted before `reconcileReviewListeningSessions` at `1031`; wiring at `1133-1154`, `1186`, `1219`, `1252`)
- Test (integration, same file as wiring test below): `tests/test_cloudflare/review-loop-sweep.test.ts`

The helper is unit-light (orchestration over mocked DAO/GitHub/state fns); proof lives in the next task's integration test. This task adds helper + imports + call sites. Do both tasks together; commit once.

- [ ] **Step 1: Add imports for the new contract symbols**

Anchor — the `github/pr` import block at `pr.ts` lines `5-16`:

```ts
import {
  createPrIssueComment,
  failingCheckFingerprint,
  failingCheckRunWorklistItems,
  getCommitCheckRuns,
  getCommitStatusContexts,
  getPrHeadSha,
  getPrReviewLoopWorklist,
  getPrState,
  hasPendingCheckRuns,
  isFailingCheckRun,
} from "../github/pr";
```

Add `addLabels`, `ensureRepoLabel`, `removeLabel` to it, plus the new module imports. Replace that block and the `session/state` block (`23-30`) and the `CommitCheckRun` type import (`4`):

```ts
import type { CommitCheckRun, CommitStatusContext } from "../github/pr";
import {
  addLabels,
  createPrIssueComment,
  ensureRepoLabel,
  failingCheckFingerprint,
  failingCheckRunWorklistItems,
  getCommitCheckRuns,
  getCommitStatusContexts,
  getPrHeadSha,
  getPrReviewLoopWorklist,
  getPrState,
  hasPendingCheckRuns,
  isFailingCheckRun,
  removeLabel,
} from "../github/pr";
```

Then change the `session/state` import block (`23-30`) to add `setSessionReviewLoopDoneState`:

```ts
import {
  closeSessionForWebhook,
  enqueueSessionPrompt,
  getSessionState,
  listSessionPrompts,
  notifySessionPrMerged,
  setSessionReviewLoopDoneState,
  updateSessionReviewListeningHead,
} from "../session/state";
```

And add three new import statements right after the `review-loop-status-comment` import (`69`):

```ts
import { CYCLOID_REVIEW_DONE_CI_RED_LABEL, CYCLOID_REVIEW_DONE_LABEL } from "../constants/pr-labels";
import { getReviewLoopEpochSummariesForHead } from "./review-loop-epochs";
import { computeReviewLoopRollup, reduceCiState } from "./review-loop-rollup";
import type { ReviewLoopDoneState } from "../../../../shared/session/phase.js";
```

(Delete the now-unused `import type { CommitCheckRun } from "../github/pr";` at line `4` — replaced by the combined type import. `getReviewLoopEpochSummariesForHead` may go in the existing `./review-loop-epochs` import block at `33-67` instead of a second statement — either works; I merged it into the existing block.)

- [ ] **Step 2: Add the label-reconcile + done-state helper before `reconcileReviewListeningSessions`**

Insert immediately before line `1031` (`async function reconcileReviewListeningSessions(`):

```ts
// Best-effort label reconcile for the review-loop done-state. Never throws: a label write failing
// must not abort the sweep ref or roll back the persisted done-state (state is the source of truth,
// labels are a cosmetic mirror). ensureRepoLabel before addLabels because addLabels on a missing
// label 422s.
async function syncReviewLoopDoneLabels(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  doneState: ReviewLoopDoneState | null,
  logger: Logger,
): Promise<void> {
  const add =
    doneState === "done_green"
      ? CYCLOID_REVIEW_DONE_LABEL
      : doneState === "done_exhausted"
        ? CYCLOID_REVIEW_DONE_CI_RED_LABEL
        : null;
  const remove =
    add === CYCLOID_REVIEW_DONE_LABEL
      ? CYCLOID_REVIEW_DONE_CI_RED_LABEL
      : add === CYCLOID_REVIEW_DONE_CI_RED_LABEL
        ? CYCLOID_REVIEW_DONE_LABEL
        : null;
  try {
    if (add) {
      const color = add === CYCLOID_REVIEW_DONE_LABEL ? "0e8a16" : "d4a72c";
      const description =
        add === CYCLOID_REVIEW_DONE_LABEL
          ? "Review loop caught up — nothing left to address"
          : "Review loop caught up — CI not green, did all it could";
      await ensureRepoLabel(token, owner, repo, add, color, description);
      await addLabels(token, owner, repo, prNumber, [add]);
      if (remove) await removeLabel(token, owner, repo, prNumber, remove);
    } else {
      // working / null → clear BOTH done labels.
      await removeLabel(token, owner, repo, prNumber, CYCLOID_REVIEW_DONE_LABEL);
      await removeLabel(token, owner, repo, prNumber, CYCLOID_REVIEW_DONE_CI_RED_LABEL);
    }
  } catch (error) {
    logger.warn(
      { owner, repo, prNumber, doneState, error: String(error) },
      "Review-loop done-state label reconcile failed",
    );
  }
}

// Computes the review-loop done-state rollup for a settled review-listening PR ref and, only when it
// changed vs the persisted value, persists it first (source of truth) then reconciles labels
// best-effort. Its OWN per-tick CI poll (not the conditional CI-recovery fetch): on poll failure it
// keeps the prior value so a transient GitHub blip cannot flip a green PR to working. Returns nothing;
// failures are logged and swallowed so a single ref never aborts the sweep page.
async function reconcileReviewLoopDoneState(
  env: Env,
  options: {
    token: string;
    sessionId: string;
    prUrl: string;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    priorDoneState: ReviewLoopDoneState | null;
    logger: Logger;
  },
): Promise<void> {
  const { token, sessionId, prUrl, owner, repo, prNumber, headSha, priorDoneState, logger } = options;
  let ci: ReviewLoopCiState;
  try {
    const [checkRuns, statusContexts] = await Promise.all([
      getCommitCheckRuns(token, owner, repo, headSha),
      getCommitStatusContexts(token, owner, repo, headSha),
    ]);
    ci = reduceCiState(checkRuns, statusContexts);
  } catch (error) {
    // Poll failure → keep the prior value this tick (do not change state). classifyGithubPollFailure
    // distinguishes auth-lost vs transient; either way we hold steady and the next sweep retries.
    const classified = classifyGithubPollFailure(error);
    logger.warn(
      { sessionId, prUrl, headSha, reason: classified.reason, error: String(error) },
      "Review-loop done-state CI poll failed; keeping prior done-state",
    );
    return;
  }

  const epochs = await getReviewLoopEpochSummariesForHead(env.DB, { sessionId, prUrl, headSha });
  const next = computeReviewLoopRollup({ epochs, ci });
  if (next === priorDoneState) return; // dedup: only act on change.

  const persisted = await setSessionReviewLoopDoneState(env, sessionId, { doneState: next });
  if (!persisted.ok) {
    logger.warn(
      { sessionId, prUrl, headSha, doneState: next },
      "Review-loop done-state persist failed; skipping label reconcile",
    );
    return;
  }
  await syncReviewLoopDoneLabels(token, owner, repo, prNumber, next, logger);
}
```

Add `ReviewLoopCiState` to the type import at the top: extend the `review-loop-rollup` import to `import { computeReviewLoopRollup, reduceCiState, type ReviewLoopCiState } from "./review-loop-rollup";`.

- [ ] **Step 3: Wire the merged/closed path to remove labels before close**

Anchor — the merged/closed branch at `1087-1115`, specifically just before the `closeSessionForWebhook` call at `1104`:

```ts
          const closeResult = await closeSessionForWebhook(env, env.DB, ref.sessionId, {
```

Insert immediately before it (after the `prState === "merged"` notify block closes at `1103`):

```ts
// Clear both done labels before close (best-effort, never block the close). Use the head
// we last knew; close does not depend on labels so a failure here is purely cosmetic.
try {
  await removeLabel(token, parsed.owner, parsed.repo, parsed.prNumber, CYCLOID_REVIEW_DONE_LABEL);
  await removeLabel(token, parsed.owner, parsed.repo, parsed.prNumber, CYCLOID_REVIEW_DONE_CI_RED_LABEL);
} catch (error) {
  options.logger.warn(
    { sessionId: ref.sessionId, prUrl, error: String(error) },
    "Review-loop reconciliation failed to clear done labels before close",
  );
}
```

- [ ] **Step 4: Wire head-change reset (force working, remove both labels)**

Anchor — the head-change block at `1133-1154`. Right after the successful head update at `1153` (`if (updateResult.payload?.updated !== false) result.reviewListeningHeadChanged += 1;`), and still inside the `if (previousHeadSha !== currentHeadSha)` block, add:

```ts
// Head moved this tick → the loop is working again on the new head. Force "working" and
// clear both done labels; skip done-eval for this ref this tick (re-evaluated next sweep
// once epochs settle on the new head).
if ((session.reviewLoopDoneState ?? null) !== "working") {
  const reset = await setSessionReviewLoopDoneState(env, ref.sessionId, { doneState: "working" });
  if (!reset.ok) {
    options.logger.warn(
      { sessionId: ref.sessionId, prUrl, headSha: currentHeadSha },
      "Review-loop done-state head-change reset failed",
    );
  }
}
try {
  await removeLabel(token, parsed.owner, parsed.repo, parsed.prNumber, CYCLOID_REVIEW_DONE_LABEL);
  await removeLabel(token, parsed.owner, parsed.repo, parsed.prNumber, CYCLOID_REVIEW_DONE_CI_RED_LABEL);
} catch (error) {
  options.logger.warn(
    { sessionId: ref.sessionId, prUrl, error: String(error) },
    "Review-loop reconciliation failed to clear done labels on head change",
  );
}
continue;
```

Note: the `continue` exits the ref iteration after a head change (epochs just marked stale; nothing settled to roll up this tick). It sits inside the existing `if (previousHeadSha !== currentHeadSha)` block, replacing the implicit fall-through to the checklist/epoch logic.

- [ ] **Step 5: Wire the unconditional done-eval for fully-settled PRs**

The rollup must run for fully-settled PRs that hit the early `continue` at `1186` (`if (botEpochExists && ciEpochExists) continue;`). Anchor `1186`:

```ts
if (botEpochExists && ciEpochExists) continue;
```

Replace it with a done-eval-then-continue (this is the "fully settled, both epoch kinds exist" path — exactly where the rollup belongs):

```ts
if (botEpochExists && ciEpochExists) {
  await reconcileReviewLoopDoneState(env, {
    token,
    sessionId: ref.sessionId,
    prUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    headSha: currentHeadSha,
    priorDoneState: session.reviewLoopDoneState ?? null,
    logger: options.logger,
  });
  continue;
}
```

Minimal, correct placement: a PR is "fully settled" exactly when both epoch kinds exist on the head (catch-up paths have no work left). The other early-continues at `1219` (`if (botEpochExists) continue;`) and `1252` (no-new-feedback) are NOT settled (a CI-fix or bot epoch may still be bootstrapping), so they correctly skip done-eval; the next sweep re-evaluates once both kinds exist. State this reasoning in the PR body. `reconcileReviewLoopDoneState` swallows its own errors, so it cannot turn a settled ref into a `reviewListeningErrors` increment.

- [ ] **Step 6: Verify wiring via the next task's integration test:** `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts` — PASS (all existing 61 tests + the new done-state block)

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-sweep.ts tests/test_cloudflare/review-loop-sweep.test.ts && git commit -m "feat(review-loop): compute and persist done-state rollup + labels in sweep (ARC-XXXX)"
```

---

### Task 17: Sweep integration test for review-loop done-state rollup

**Files:**

- Modify: `tests/test_cloudflare/review-loop-sweep.test.ts` (add mocks at the top mock block `3-119`, defaults in `beforeEach` `158-231`, and a new `describe` block after the existing `scheduled epoch bootstrap from head signals` block which ends around line `1300`)

The cluster's integration test: drives the public `runReviewLoopSweep` and asserts the contracted behaviors. Write it BEFORE the helper above passes (watch it fail, implement the helper task, watch it pass).

- [ ] **Step 1: Add the new module mocks**

The test mocks `github/pr` (`83-94`), `session/state` (`96-103`), and `review-loop-epochs` (`42-77`) by partial factory. Extend each, and add the two new module mocks (`review-loop-rollup`, `constants/pr-labels`).

Add these mock fn declarations next to the existing ones (after line `40`):

```ts
const mockAddLabels = vi.fn();
const mockEnsureRepoLabel = vi.fn();
const mockRemoveLabel = vi.fn();
const mockGetReviewLoopEpochSummariesForHead = vi.fn();
const mockComputeReviewLoopRollup = vi.fn();
const mockReduceCiState = vi.fn();
const mockSetSessionReviewLoopDoneState = vi.fn();
```

Add to the `github/pr` mock factory (`83-94`), inside the returned object:

```ts
  addLabels: (...args: unknown[]) => mockAddLabels(...args),
  ensureRepoLabel: (...args: unknown[]) => mockEnsureRepoLabel(...args),
  removeLabel: (...args: unknown[]) => mockRemoveLabel(...args),
  hasPendingCheckRuns: (runs: { status?: string | null; conclusion?: string | null }[]) =>
    runs.some((r) => r.status !== "completed"),
  FAILING_CHECK_RUN_CONCLUSIONS: new Set(["failure", "timed_out", "action_required", "startup_failure"]),
```

Add to the `session/state` mock factory (`96-103`):

```ts
  setSessionReviewLoopDoneState: (...args: unknown[]) => mockSetSessionReviewLoopDoneState(...args),
```

Add `getReviewLoopEpochSummariesForHead` to the `review-loop-epochs` mock factory (inside the returned object at `42-77`):

```ts
  getReviewLoopEpochSummariesForHead: (...args: unknown[]) => mockGetReviewLoopEpochSummariesForHead(...args),
```

Add two NEW `vi.mock` blocks after the `review-loop-settings` mock (`116-119`):

```ts
vi.mock("../../apps/control-plane-worker/src/services/review-loop-rollup", () => ({
  computeReviewLoopRollup: (...args: unknown[]) => mockComputeReviewLoopRollup(...args),
  reduceCiState: (...args: unknown[]) => mockReduceCiState(...args),
}));

vi.mock("../../apps/control-plane-worker/src/constants/pr-labels", () => ({
  CYCLOID_REVIEW_DONE_LABEL: "cycloid:review-done",
  CYCLOID_REVIEW_DONE_CI_RED_LABEL: "cycloid:review-done-ci-red",
}));
```

- [ ] **Step 2: Add `beforeEach` defaults**

Add to the `beforeEach` body (after line `228`, the `mockHasCiReviewLoopEpochForHead` reset):

```ts
mockAddLabels.mockReset().mockResolvedValue(undefined);
mockEnsureRepoLabel.mockReset().mockResolvedValue({ ok: true, created: false });
mockRemoveLabel.mockReset().mockResolvedValue(undefined);
mockGetReviewLoopEpochSummariesForHead.mockReset().mockResolvedValue([]);
mockReduceCiState.mockReset().mockReturnValue("green");
mockComputeReviewLoopRollup.mockReset().mockReturnValue(null);
mockSetSessionReviewLoopDoneState.mockReset().mockResolvedValue({ ok: true, updated: true });
```

- [ ] **Step 3: Verify fail:** `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts -t "review-loop done-state rollup"` — FAIL: describe missing; once added but unimplemented, `mockSetSessionReviewLoopDoneState`/`mockComputeReviewLoopRollup` never called (helper/wiring absent). Passes after the helper task.

- [ ] **Step 4: Add the integration `describe` block**

Append after the `scheduled epoch bootstrap from head signals` describe block closes (around line `1300`), still inside the top-level `describe("review-loop sweep", ...)`:

```ts
describe("review-loop done-state rollup", () => {
  function settledSessionRefs() {
    mockListReviewListeningGithubPrRefs.mockResolvedValueOnce({
      data: [
        {
          sessionId: "sess-1",
          prUrl: "https://github.com/acme/repo/pull/42",
          updatedAt: "2026-05-26T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  }

  // A PR is "fully settled" when both a bot/human and a ci-fix epoch already exist on the head, so
  // both early-continue catch-up paths are exhausted and the done-state rollup runs.
  function fullySettled() {
    mockHasReviewLoopEpochForHead.mockResolvedValue(true);
    mockHasCiReviewLoopEpochForHead.mockResolvedValue(true);
  }

  it("fires done_green once + adds the review-done label for a fully-settled green PR", async () => {
    settledSessionRefs();
    fullySettled();
    mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([
      { status: "completed", blockedReason: null },
      { status: "completed", blockedReason: null },
    ]);
    mockReduceCiState.mockReturnValueOnce("green");
    mockComputeReviewLoopRollup.mockReturnValueOnce("done_green");
    // Prior state is null → changed → fires.
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: null }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockGetCommitCheckRuns).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
    expect(mockGetCommitStatusContexts).toHaveBeenCalledWith("token-1", "acme", "repo", "old-head");
    expect(mockSetSessionReviewLoopDoneState).toHaveBeenCalledTimes(1);
    expect(mockSetSessionReviewLoopDoneState).toHaveBeenCalledWith(env, "sess-1", { doneState: "done_green" });
    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      "cycloid:review-done",
      "0e8a16",
      "Review loop caught up — nothing left to address",
    );
    expect(mockAddLabels).toHaveBeenCalledWith("token-1", "acme", "repo", 42, ["cycloid:review-done"]);
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done-ci-red");
  });

  it("does not fire again on the next tick when the rollup is unchanged", async () => {
    settledSessionRefs();
    fullySettled();
    mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([{ status: "completed", blockedReason: null }]);
    mockComputeReviewLoopRollup.mockReturnValueOnce("done_green");
    // Prior persisted state already done_green → no change → dedup.
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: "done_green" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockSetSessionReviewLoopDoneState).not.toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockEnsureRepoLabel).not.toHaveBeenCalled();
  });

  it("fires done_exhausted + ci-red label when settled but CI is red", async () => {
    settledSessionRefs();
    fullySettled();
    mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([
      { status: "blocked", blockedReason: "attempt_cap_reached" },
    ]);
    mockReduceCiState.mockReturnValueOnce("failing");
    mockComputeReviewLoopRollup.mockReturnValueOnce("done_exhausted");
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: null }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockSetSessionReviewLoopDoneState).toHaveBeenCalledWith(env, "sess-1", { doneState: "done_exhausted" });
    expect(mockEnsureRepoLabel).toHaveBeenCalledWith(
      "token-1",
      "acme",
      "repo",
      "cycloid:review-done-ci-red",
      "d4a72c",
      "Review loop caught up — CI not green, did all it could",
    );
    expect(mockAddLabels).toHaveBeenCalledWith("token-1", "acme", "repo", 42, ["cycloid:review-done-ci-red"]);
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done");
  });

  it("stays working (no label add, no state write) when the rollup returns working", async () => {
    settledSessionRefs();
    fullySettled();
    // A failed-blocked epoch (blocked with a non-exhausted, non-disabled reason) → rollup "working".
    mockGetReviewLoopEpochSummariesForHead.mockResolvedValueOnce([
      { status: "blocked", blockedReason: "prompt_enqueue_failed" },
    ]);
    mockComputeReviewLoopRollup.mockReturnValueOnce("working");
    // Prior is null → changed to working → persists working, clears both labels, no add.
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: null }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockSetSessionReviewLoopDoneState).toHaveBeenCalledWith(env, "sess-1", { doneState: "working" });
    expect(mockAddLabels).not.toHaveBeenCalled();
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done");
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done-ci-red");
  });

  it("keeps the prior done-state when the per-tick CI poll fails (does not flip green to working)", async () => {
    settledSessionRefs();
    fullySettled();
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: "done_green" }));
    // The done-state CI poll throws a transient 503 → keep prior value, no state write, no labels.
    mockGetCommitCheckRuns.mockRejectedValueOnce(new Error("GitHub check runs failed (503): upstream"));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockGetReviewLoopEpochSummariesForHead).not.toHaveBeenCalled();
    expect(mockSetSessionReviewLoopDoneState).not.toHaveBeenCalled();
    expect(mockAddLabels).not.toHaveBeenCalled();
    // A swallowed poll failure is not a reconciliation error.
    expect(result.reviewListeningErrors).toBe(0);
  });

  it("forces working and removes both labels on a head change, skipping done-eval", async () => {
    settledSessionRefs();
    fullySettled();
    mockGetPrHeadSha.mockResolvedValueOnce("new-head");
    mockMarkReviewLoopEpochsStaleForHeadChange.mockResolvedValueOnce(1);
    mockGetSessionState.mockResolvedValue(
      reviewListeningSession({ reviewListeningHeadSha: "old-head", reviewLoopDoneState: "done_green" }),
    );

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockSetSessionReviewLoopDoneState).toHaveBeenCalledWith(env, "sess-1", { doneState: "working" });
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done");
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done-ci-red");
    // Head-change resets and skips done-eval: the rollup is never computed this tick.
    expect(mockComputeReviewLoopRollup).not.toHaveBeenCalled();
    expect(result.reviewListeningHeadChanged).toBe(1);
  });

  it("removes both done labels before closing a merged PR", async () => {
    settledSessionRefs();
    mockGetPrState.mockResolvedValueOnce("merged");
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: "done_green" }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    const result = await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    // removeLabel must run before close (best-effort), and never block it.
    const removeOrder = Math.max(...mockRemoveLabel.mock.invocationCallOrder);
    const closeOrder = mockCloseSessionForWebhook.mock.invocationCallOrder[0];
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done");
    expect(mockRemoveLabel).toHaveBeenCalledWith("token-1", "acme", "repo", 42, "cycloid:review-done-ci-red");
    expect(removeOrder).toBeLessThan(closeOrder);
    expect(result.reviewListeningClosed).toBe(1);
  });

  it("does not run done-eval for a non-settled PR (only a bot epoch exists)", async () => {
    settledSessionRefs();
    // Bot epoch exists but no ci epoch → not fully settled → bootstrap/CI-recovery path, no done-eval.
    mockHasReviewLoopEpochForHead.mockResolvedValue(true);
    mockHasCiReviewLoopEpochForHead.mockResolvedValue(false);
    mockGetSessionState.mockResolvedValue(reviewListeningSession({ reviewLoopDoneState: null }));

    const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
    await runReviewLoopSweep(env, { nowMs: 456_000, logger: logger as never });

    expect(mockComputeReviewLoopRollup).not.toHaveBeenCalled();
    expect(mockGetReviewLoopEpochSummariesForHead).not.toHaveBeenCalled();
    expect(mockSetSessionReviewLoopDoneState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Verify pass (full file):** `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts` — PASS: all prior 61 tests plus the 8 new done-state tests.

- [ ] **Step 6: Commit** (single commit with the helper task — they are interdependent)

```bash
git add tests/test_cloudflare/review-loop-sweep.test.ts apps/control-plane-worker/src/services/review-loop-sweep.ts && git commit -m "test(review-loop): integration coverage for sweep done-state rollup + labels (ARC-XXXX)"
```

---

Implementation reality notes for the reader:

- `reconcileReviewListeningSessions` (lines `1031-1313`) is private; `runReviewLoopSweep` (exported, `1376`) calls it with default `reconciliationLimit` (`DEFAULT_REVIEW_LISTENING_RECONCILE_LIMIT = 25`, line `73`). The integration test drives the public entrypoint like the `"reconciles review-listening sessions whose PR merged"` test at `945`.
- Token/owner/repo are resolved at `1069` (`parsed = parseGithubPrUrl`), `1085` (`token = await createInstallationToken`). The merged/close branch is `1087-1115`; `getPrHeadSha` at `1125`; head-change block `1133-1154`; the `botEpochExists && ciEpochExists` early-continue is exactly line `1186`; the existing CI fetch (`getCommitCheckRuns`) is at `1198`; the bot early-continue `if (botEpochExists) continue;` at `1219`; the no-new-feedback continue at `1252`.
- `classifyGithubPollFailure` is at `147-159` and already extracts the `(\d{3})` status from the error string — the `(503)` literal in the poll-failure test exercises the real transient branch.
- `addLabels` (`pr.ts:928`), `ensureRepoLabel` (`pr.ts:951`, signature `(token, owner, repo, name, color, description?)`), and `removeLabel` (contracted, mirrors `deleteIssueComment` at `pr.ts:348` — 404 → return, else throw with status). `CommitCheckRun`/`CommitStatusContext` shapes are at `pr.ts:75-94`.
- Verified the exact runner: `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts` (run from repo root `.`) currently passes 61/61.
