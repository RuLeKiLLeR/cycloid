# Review-Loop "Superseded" Neutral State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop painting _good_ PRs red in the UI: when the review-loop publish guard blocks for a **benign** reason (the PR moved on / merged / closed, or the session moved on), render a distinct neutral **"Superseded"** state instead of the red **"Blocked/Failed"**.

**Architecture:** The red UI is driven **solely** by the review-loop publish guard (`blockReviewLoopPublish`) setting `session.publishStatus = "blocked_by_verification"` (the ~5% guard path; the 95% benign _sweep_ epoch blocks never reach the UI). We classify each guard failure as **benign** vs **genuine** at the source, add a new terminal-but-neutral `superseded` value to the `PublishStatus` and `Phase` contracts, route benign guard blocks to it (and to a neutral PR-timeline event instead of the scary `pr_failed`), and render it neutrally across the four red surfaces. Genuine failures are unchanged.

**Tech Stack:** TypeScript; Cloudflare Workers + Durable Objects (control plane); React + Vite (UI); Vitest (`tests/test_cloudflare/**` for worker, `npm -w cycloid-ui test` for colocated UI tests). Shared contracts live in `shared/session/*` and `shared/types/*`.

---

## Worth-it Verdict

New surface area: one new `PublishStatus` value, one new canonical `Phase` value, and a new user-visible session state. **Cost:** the `Phase` union is a canonical contract consumed by worker projection, UI, CLI watchers, and D1 `rich_status` SQL — a new value must be threaded through every `Phase` switch + the terminal-phase sets. **Buys:** removes a recurring, high-visibility false-alarm — prod data shows benign reasons are the dominant driver of the guard-path red UI, so good/merged PRs routinely show red "Blocked/Failed."

- **80/20 (not chosen):** route benign guard blocks to the existing `completed` phase. ~1 file in the control plane, zero new contract values, kills the red. **Signal it captures:** "do users stop reporting good PRs as blocked." **Loses:** the distinct "the loop stopped because the PR moved on" label — folds into a green "Completed."
- **Durable (chosen — user picked distinct neutral state for legibility):** new `superseded` phase end-to-end. Wider blast radius (the `Phase` contract) but gives a legible, distinct neutral pill on every surface.

**Verdict: `build`** — the durable distinct-state version, per the explicit product decision. Reversible (additive enum value; no migration; forward-only).

---

## Global Constraints

- **New contract value name:** `superseded` — used identically for `PublishStatus`, `Phase`, and the UI `DisplayStatus`. User-facing label: **"Superseded"** (see Decision D4 for the alternative copy).
- **Forward-only.** No D1 backfill of existing `blocked_by_verification` sessions (Decision D3). Existing rows keep showing red; only new benign guard blocks render neutral.
- **Genuine failures are unchanged.** Only the benign set (Decision D1) is rerouted; everything else still sets `blocked_by_verification` and renders red.
- **Layering:** control plane owns the classification + state write; the UI only renders. Do not classify reasons in the UI.
- **Reuse, don't reinvent:** the benign/genuine taxonomy partially exists in `apps/control-plane-worker/src/services/review-loop-rollup.ts` (`DISABLED_BLOCKED_REASONS`, `EXHAUSTED_BLOCKED_REASONS`; `head_changed` is already "filtered as stale before render"). The guard reasons are _prefixed sentences_, not bare tokens, so we classify at the guard via a `benign` flag rather than string-matching downstream.
- **Tests required in the same PR** as each behavioral change (repo invariant).

---

## Decisions (override before execution if any are wrong)

- **D1 — Benign reason set (→ `superseded`).** Reason: these mean "the PR/session moved on," not "something is wrong":
  - `the PR is merged`, `the PR is closed`, `PR head changed while responding to review` (from `assertReviewLoopHeadUnchanged`)
  - `session is not active` (guard `:2131`)
  - `this session is no longer working on the review iteration's PR` (guard `:2139`)
  - `review iteration belongs to a different session` (guard `:2133`) and `review iteration is attached to a different prompt` (guard `:2136`) — rare-race, not user failures.
  - **Genuine (stay red):** `current PR head could not be verified`, `missing publish readiness evidence`, `database is unavailable`, `review iteration was not found`, and all eligibility reasons (`installation_capabilities_missing`, `empty_expected_bots`, `expected_bots_changed`). _Default assumption:_ eligibility/installation stays red because it needs user action (`installation_capabilities_missing` has a re-approve CTA). **Recommendation:** keep as listed; revisit eligibility separately.
  - Sensitive-paths owner-approval already routes to `waiting_for_owner` (not `blocked_by_verification`) — **out of scope**, unaffected.
- **D2 — New `Phase` vs reuse `completed`.** Chosen: new `superseded` phase (user wants a distinct legible state). Default if you disagree at execution: fall back to the 80/20 (`completed`) — but that contradicts the stated decision, so confirm first.
- **D3 — Backfill.** Forward-only; no migration. **Recommendation:** ship forward-only; if existing red rows matter, do a one-off D1 `UPDATE` in a follow-up.
- **D4 — Label copy.** "Superseded". Alternatives: "PR moved on", "No longer applicable". **Recommendation:** "Superseded" (terse, accurate); easy to change in one constant.

---

## File Structure

**PR 1 — shared contracts (no emitter yet; safe no-op).**

- Modify `shared/types/publish.ts` — add `superseded` to `PUBLISH_STATUSES`.
- Modify `shared/session/publish.ts` — add `isPublishSuperseded`; keep `isPublishBlocked` matching only `blocked_by_verification`; treat `superseded` as publish-terminal where "stop expecting a PR URL" matters.
- Modify `shared/session/phase.ts` — add `superseded` to `Phase`; map `publishStatus === "superseded"` in `computePhase`; add `superseded` to `TERMINAL_PHASES_ARRAY`.
- Tests: `shared/session/__tests__/phase.test.ts` (or the existing phase test file — locate it), plus a publish-helper test.

**PR 2 — UI render (handles `superseded` neutrally; still nothing emits it).**

- Modify `apps/ui/src/types.ts` — add `superseded` to the UI `Phase` mirror.
- Modify `apps/ui/src/utils/status-display.ts` — `DisplayStatus` + `flattenStatus` + `STATUS_DISPLAY_LABEL`.
- Modify `apps/ui/src/constants.ts` — `STATUS_DISPLAY_RAIL` neutral entry.
- Modify `apps/ui/src/api/sessions.ts` — `normalizeListSessionPhase` allow-list.
- Modify `apps/ui/src/components/Transcript.tsx` — `postExecutionStatus` + `postExecutionStatusTone` render the benign PR-timeline event neutrally.
- Tests: `apps/ui/src/utils/status-display.test.ts` + a Transcript post-execution test.

**PR 3 — control-plane emit (the behavior flip).**

- Modify `apps/control-plane-worker/src/session/publish-service.ts` — thread `benign` through `assertReviewLoopHeadUnchanged` + `validateReviewLoopPublishGuard`'s `fail()` + `ReviewLoopPublishGuardResult`; branch `blockReviewLoopPublish` on `benign`.
- Modify `apps/control-plane-worker/src/session/pr-notifications.ts` — add `emitPublishSuperseded` (neutral PR-timeline event + `publish.superseded` durable event; **no** `pr_failed` broadcast).
- Modify `apps/ui/src/utils/durable-event-dispatch.ts` — handle `publish.superseded` → `publishStatus: "superseded"`.
- Tests: `tests/test_cloudflare/session/pr-workflow.test.ts` (guard classification + superseded path) + a `durable-event-dispatch` UI test.

---

## PR 1 — Shared contracts

### Task 1: Add `superseded` to `PublishStatus` + publish helpers

**Files:**

- Modify: `shared/types/publish.ts:1-10`
- Modify: `shared/session/publish.ts`
- Test: locate the publish-helpers test (`grep -rl "isPublishBlocked" --include="*.test.ts" shared apps`); create `shared/session/publish.test.ts` if none exists.

**Interfaces:**

- Produces: `PublishStatus` now includes `"superseded"`; new `isPublishSuperseded(publishStatus): boolean`.

- [ ] **Step 1: Write the failing test**

In the publish-helpers test file:

```ts
import { describe, it, expect } from "vitest";
import { isPublishBlocked, isPublishSuperseded, isPublishTerminalFailure } from "./publish.js";

describe("superseded publish status", () => {
  it("is not treated as blocked (no red UI)", () => {
    expect(isPublishBlocked("superseded")).toBe(false);
  });
  it("has a dedicated predicate", () => {
    expect(isPublishSuperseded("superseded")).toBe(true);
    expect(isPublishSuperseded("blocked_by_verification")).toBe(false);
  });
  it("is not a publish *failure*", () => {
    expect(isPublishTerminalFailure("superseded")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run shared/session/publish.test.ts`
Expected: FAIL — `isPublishSuperseded` is not exported / `"superseded"` not assignable to `PublishStatus`.

- [ ] **Step 3: Implement**

In `shared/types/publish.ts`, add `"superseded"` to the array (after `"skipped"`):

```ts
export const PUBLISH_STATUSES = [
  "not_started",
  "publishing",
  "published",
  "blocked_by_verification",
  "skipped",
  "superseded",
  "failed",
] as const;
```

In `shared/session/publish.ts`, add below `isPublishBlocked` (do **not** change `isPublishBlocked`):

```ts
/**
 * `true` when the review-loop publish was skipped because the PR/session moved on
 * (merged/closed/head-advanced/session-no-longer-watching). A neutral terminal
 * outcome — distinct from `blocked_by_verification`, which is a red failure.
 */
export function isPublishSuperseded(publishStatus: PublishStatus | null | undefined): boolean {
  return publishStatus === "superseded";
}
```

- [ ] **Step 4: Run it; verify it passes**

Run: `npx vitest run shared/session/publish.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/types/publish.ts shared/session/publish.ts shared/session/publish.test.ts
git commit -m "feat(shared): add superseded PublishStatus + isPublishSuperseded"
```

### Task 2: Map `superseded` in `computePhase` + the `Phase` union

**Files:**

- Modify: `shared/session/phase.ts:10-20` (union), `:300-325` (computePhase repo branch), `:361-367` (`TERMINAL_PHASES_ARRAY`)
- Test: the phase test (`grep -rl "computePhase" --include="*.test.ts" shared apps`)

**Interfaces:**

- Consumes: `PublishStatus` from Task 1.
- Produces: `computePhase` returns `phase: "superseded"` when `publishStatus === "superseded"` (repo sessions); `"superseded"` ∈ `TERMINAL_PHASES`.

- [ ] **Step 1: Write the failing test**

```ts
it("maps publishStatus=superseded to a neutral terminal phase", () => {
  const info = computePhase({
    sessionStatus: "active",
    sandboxStatus: "stopped",
    activePromptId: null,
    reviewListeningActive: false,
    publishStatus: "superseded",
  });
  expect(info.phase).toBe("superseded");
});
it("superseded is terminal", () => {
  expect(isTerminalPhase("superseded")).toBe(true);
});
```

(Note: `sandboxStatus: "stopped"` + `!reviewListeningActive` hits the early `stopped` return at `phase.ts:258`. To exercise the publish branch, set `sandboxStatus: undefined`. Use `sandboxStatus: undefined` in the first test.)

- [ ] **Step 2: Run it; verify it fails**

Run: `npx vitest run <phase test path>`
Expected: FAIL — phase is `idle`/`blocked`, and `"superseded"` is not in the `Phase` union (type error).

- [ ] **Step 3: Implement**

`phase.ts` union (add after `"blocked"`):

```ts
export type Phase =
  | "idle"
  | "running"
  | "waiting_for_input"
  | "finalizing"
  | "review_listening"
  | "completed"
  | "superseded"
  | "blocked"
  | "failed"
  | "stopped"
  | "archived";
```

In `computePhase`, inside the `if (isRepo) {` block, add the `superseded` branch **before** the `blocked_by_verification` branch (so it wins):

```ts
if (publishStatus === "failed") {
  return { phase: "failed", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
}
if (publishStatus === "superseded") {
  return { phase: "superseded", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
}
if (publishStatus === "blocked_by_verification") {
  return { phase: "blocked", sandboxSubstate: "none", stopMode: "none", finalizingStep: "none" };
}
```

Add `"superseded"` to `TERMINAL_PHASES_ARRAY` (so it counts as terminal + releases the child slot like `completed` — `CHILD_SLOT_RELEASE_PHASES` is derived from it minus `stopped`):

```ts
export const TERMINAL_PHASES_ARRAY = [
  "completed",
  "superseded",
  "blocked",
  "failed",
  "stopped",
  "archived",
] as const satisfies ReadonlyArray<Phase>;
```

- [ ] **Step 4: Run it; verify it passes**

Run: `npx vitest run <phase test path>` → PASS.

- [ ] **Step 5: Typecheck the contract consumers**

Run: `npx tsc -p apps/control-plane-worker/tsconfig.json --noEmit && npx tsc -p apps/cli/tsconfig.json --noEmit`
Expected: any non-exhaustive `switch (phase)` that the compiler flags (e.g. CLI watch terminal logic `apps/cli/src/constants/watch.ts`) is updated to treat `superseded` like `completed` (terminal, benign). Fix each flagged site by adding `superseded` alongside the existing `completed`/terminal handling. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add shared/session/phase.ts <phase test path> <any consumer files touched>
git commit -m "feat(shared): add superseded Phase + computePhase mapping (terminal, neutral)"
```

---

## PR 2 — UI render

### Task 3: Render `superseded` neutrally in the sidebar pill + rail

**Files:**

- Modify: `apps/ui/src/types.ts` (Phase mirror — confirm it re-declares the union; add `"superseded"`)
- Modify: `apps/ui/src/utils/status-display.ts:3-48`
- Modify: `apps/ui/src/constants.ts` (`STATUS_DISPLAY_RAIL`)
- Modify: `apps/ui/src/api/sessions.ts:31-47` (`normalizeListSessionPhase`)
- Test: `apps/ui/src/utils/status-display.test.ts`

**Interfaces:**

- Consumes: `Phase` includes `"superseded"` (Task 2).
- Produces: `flattenStatus("superseded") === "superseded"`; `DisplayStatus` includes `"superseded"`; neutral rail/label.

- [ ] **Step 1: Write the failing test** (`status-display.test.ts`)

```ts
it("flattens superseded to its own neutral display status (not failed)", () => {
  expect(flattenStatus("superseded")).toBe("superseded");
});
it("labels superseded", () => {
  expect(STATUS_DISPLAY_LABEL.superseded).toBe("Superseded");
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npm -w cycloid-ui test -- status-display`
Expected: FAIL (`flattenStatus` returns `idle`; `STATUS_DISPLAY_LABEL.superseded` undefined). _(Per repo memory: UI colocated tests run via the `cycloid-ui` workspace, not root vitest.)_

- [ ] **Step 3: Implement**

`status-display.ts` — add to `DisplayStatus`, `flattenStatus`, `STATUS_DISPLAY_LABEL`:

```ts
export type DisplayStatus =
  | "working"
  | "waiting_for_input"
  | "review_listening"
  | "completed"
  | "superseded"
  | "failed"
  | "idle"
  | "stopped"
  | "archived";
```

```ts
    case "review_listening":
      return "review_listening";
    case "superseded":
      return "superseded";
    case "blocked":
    case "failed":
      return "failed";
```

```ts
export const STATUS_DISPLAY_LABEL: Record<DisplayStatus, string> = {
  working: "Working",
  waiting_for_input: "Waiting for input",
  completed: "Completed",
  review_listening: "Review listening",
  superseded: "Superseded",
  failed: "Failed",
  idle: "Idle",
  stopped: "Stopped",
  archived: "Archived",
};
```

`apps/ui/src/types.ts` — add `"superseded"` to the `Phase` union mirror (match `shared/session/phase.ts` ordering).

`apps/ui/src/api/sessions.ts` `normalizeListSessionPhase` — add the case (after `"completed"`):

```ts
    case "completed":
    case "superseded":
    case "blocked":
```

`apps/ui/src/constants.ts` `STATUS_DISPLAY_RAIL` — add a **neutral** entry mirroring `completed`/muted, NOT `failed`'s `bg-error`. Read the existing `completed` entry and copy its neutral classes for `superseded`. Example shape:

```ts
  superseded: { bg: "bg-text-muted", opacity: "opacity-60" },
```

(Use the exact key/value shape of the existing entries in that file; mirror the `completed` entry's neutral tone, not `failed`.)

- [ ] **Step 4: Run; verify pass**

Run: `npm -w cycloid-ui test -- status-display` → PASS.
Run: `npx tsc -p apps/ui/tsconfig.json --noEmit` → exit 0 (catches any `Record<DisplayStatus,...>` map that now needs a `superseded` key — fix each by mirroring the `completed`/neutral entry).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/utils/status-display.ts apps/ui/src/utils/status-display.test.ts apps/ui/src/types.ts apps/ui/src/api/sessions.ts apps/ui/src/constants.ts
git commit -m "feat(ui): render superseded session phase as a neutral pill"
```

### Task 4: Render the benign post-execution event neutrally

**Files:**

- Modify: `apps/ui/src/components/Transcript.tsx:683-698` (`postExecutionStatus`, `postExecutionStatusTone`), `:731-735` (`isBlockedPrPublishEvent`)
- Test: `apps/ui/src/components/Transcript.test.tsx` (or the existing Transcript test; locate via `grep -rl "postExecutionStatus" --include="*.test.tsx" apps/ui`)

**Interfaces:**

- Consumes: the neutral PR-timeline event PR 3 will emit — a `pr.open` agent-timeline event with `status: "completed"` and `metadata.superseded === true` (Task 6 defines this contract). This task makes the UI render that event as "Superseded" with a neutral tone; it must land before PR 3 emits it.

- [ ] **Step 1: Write the failing test**

```tsx
it("shows Superseded (neutral) for a superseded pr.open event", () => {
  const events = [
    {
      eventType: "pr.open",
      status: "completed",
      metadata: { superseded: true },
      summary: "Review loop superseded — PR moved on",
    },
  ] as AgentTimelineEvent[];
  expect(postExecutionStatus(events)).toBe("Superseded");
  expect(postExecutionStatusTone("Superseded")).not.toContain("text-error");
});
```

(Export `postExecutionStatus`/`postExecutionStatusTone` from `Transcript.tsx` if they aren't already, so the test can import them. If they're module-private, add `export`.)

- [ ] **Step 2: Run; verify fail**

Run: `npm -w cycloid-ui test -- Transcript`
Expected: FAIL — currently returns "PR opened"/"Blocked", tone path wrong.

- [ ] **Step 3: Implement**

In `postExecutionStatus` (`:683`), add a superseded check **before** the blocked/completed checks:

```ts
function postExecutionStatus(events: AgentTimelineEvent[]): string {
  const prEvent = latestByEventType(events, "pr.open");
  const terminalVerification = latestTerminalVerificationEvent(events);
  if (prEvent && prEvent.metadata?.superseded === true) return "Superseded";
  if (isBlockedPrPublishEvent(prEvent) || prEvent?.status === "failed") return "Blocked";
  ...
}
```

In `postExecutionStatusTone` (`:693`), add a neutral tone (mirror the muted/`No PR` tone, not the error tone):

```ts
function postExecutionStatusTone(status: string): string {
  if (status === "Blocked") return "bg-error-soft text-error";
  if (status === "Superseded") return "bg-surface-2 text-text-muted";
  if (status === "Running") return "bg-warning-soft text-warning";
  ...
}
```

Guard `isBlockedPrPublishEvent` against the superseded event (a superseded event has `status: "completed"`, so it won't trip the `failed`/`blocked` branch — but make it explicit so a future status change can't regress):

```ts
function isBlockedPrPublishEvent(event: AgentTimelineEvent | undefined): boolean {
  if (event?.metadata?.superseded === true) return false;
  return Boolean(
    event && (event.status === "blocked" || (event.status === "failed" && metadataString(event, "reason"))),
  );
}
```

- [ ] **Step 4: Run; verify pass**

Run: `npm -w cycloid-ui test -- Transcript` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/components/Transcript.tsx <transcript test>
git commit -m "feat(ui): render superseded post-execution event as neutral, not Blocked"
```

---

## PR 3 — Control-plane emit (behavior flip)

### Task 5: Classify guard failures as benign vs genuine

**Files:**

- Modify: `apps/control-plane-worker/src/session/publish-service.ts` — `assertReviewLoopHeadUnchanged` (`:2023-2046`), `validateReviewLoopPublishGuard` (`:2109-2181`), and the `ReviewLoopPublishGuardResult` type (`grep -n "ReviewLoopPublishGuardResult" apps/control-plane-worker/src/session/publish-service.ts`)
- Test: `tests/test_cloudflare/session/pr-workflow.test.ts`

**Interfaces:**

- Produces: `ReviewLoopPublishGuardResult`'s `{ ok: false }` variant gains `benign?: boolean`. `assertReviewLoopHeadUnchanged` returns `{ ok: false; reason; benign }`.

- [ ] **Step 1: Write the failing test** (`pr-workflow.test.ts`)

```ts
it("classifies a merged-PR guard block as benign", async () => {
  // Arrange a review-loop publish whose PR is merged (getPrMergeStatus -> state "merged").
  // Drive publishReviewLoopPush/validateReviewLoopPublishGuard and assert the guard result.
  const guard = await service.validateReviewLoopPublishGuard(request, session, ext, auth);
  expect(guard.ok).toBe(false);
  expect((guard as { benign?: boolean }).benign).toBe(true);
});
it("classifies a missing-readiness guard block as genuine (not benign)", async () => {
  const guard = await service.validateReviewLoopPublishGuard(
    { ...request, prReadiness: undefined },
    session,
    ext,
    auth,
  );
  expect(guard.ok).toBe(false);
  expect((guard as { benign?: boolean }).benign).toBeFalsy();
});
```

(Mirror existing `pr-workflow.test.ts` setup for review-loop epochs + `getPrMergeStatus` mocking.)

- [ ] **Step 2: Run; verify fail**

Run: `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts -t "benign"`
Expected: FAIL — `benign` is undefined.

- [ ] **Step 3: Implement**

Add `benign?: boolean` to the `{ ok: false }` arm of `ReviewLoopPublishGuardResult`.

`assertReviewLoopHeadUnchanged` — return `benign` (`true` for merged/closed/head-changed; `false` for the "could not be verified" failures):

```ts
    } catch {
      return { ok: false, reason: "current PR head could not be verified", benign: false };
    }
    if (mergeStatus.state === null) return { ok: false, reason: "current PR head could not be verified", benign: false };
    if (mergeStatus.state === "closed" || mergeStatus.state === "merged") {
      return { ok: false, reason: `the PR is ${mergeStatus.state}`, benign: true };
    }
    const currentHead = mergeStatus.headSha;
    if (!currentHead) return { ok: false, reason: "current PR head could not be verified", benign: false };
    if (currentHead !== epoch.headSha && (!expectedPushedHead || currentHead !== expectedPushedHead)) {
      return { ok: false, reason: "PR head changed while responding to review", benign: true };
    }
```

(Update the return type of `assertReviewLoopHeadUnchanged` to `{ ok: true; currentHead } | { ok: false; reason: string; benign: boolean }`.)

`validateReviewLoopPublishGuard` — extend `fail()` to accept `benign`, default `false`:

```ts
const fail = (
  reason: string,
  opts: { ownerApprovalRequired?: boolean; benign?: boolean } = {},
): ReviewLoopPublishGuardResult => ({
  ok: false,
  epochId,
  reason,
  ...(opts.ownerApprovalRequired ? { ownerApprovalRequired: true } : {}),
  ...(opts.benign ? { benign: true } : {}),
});
```

Mark the benign lifecycle reasons (Decision D1) and thread the head result's `benign`:

```ts
if (session.status !== "active") return fail("Review-loop publish blocked: session is not active.", { benign: true });
if (epoch.sessionId !== request.sessionId || epoch.ownerUserId !== Number(session.ownerUserId)) {
  return fail("Review-loop publish blocked: review iteration belongs to a different session.", { benign: true });
}
if (epoch.lastPromptId && epoch.lastPromptId !== request.promptId) {
  return fail("Review-loop publish blocked: review iteration is attached to a different prompt.", { benign: true });
}
if (!sessionPrMatchesReviewLoopEpoch(ext, epoch)) {
  return fail("Review-loop publish blocked: this session is no longer working on the review iteration's PR.", {
    benign: true,
  });
}
// eligibility stays GENUINE (red) — needs user action:
if (!eligibility.ok) return fail(`Review-loop publish blocked: ${eligibility.reason}.`);
const head = await this.assertReviewLoopHeadUnchanged(
  epoch,
  auth.installationToken ?? auth.token,
  request.commitSha?.trim() || null,
);
if (!head.ok) return fail(`Review-loop publish blocked: ${head.reason}.`, { benign: head.benign });
// missing readiness stays GENUINE:
if (!readiness) return fail("Review-loop publish blocked: missing publish readiness evidence.");
```

(Leave `database is unavailable` / `review iteration was not found` as genuine — no `benign`.)

- [ ] **Step 4: Run; verify pass**

Run: `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts -t "benign"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/publish-service.ts tests/test_cloudflare/session/pr-workflow.test.ts
git commit -m "feat(control-plane): classify review-loop guard failures as benign vs genuine"
```

### Task 6: Route benign blocks to `superseded` + a neutral PR event

**Files:**

- Modify: `apps/control-plane-worker/src/session/publish-service.ts` — `blockReviewLoopPublish` (`:2183-2211`)
- Modify: `apps/control-plane-worker/src/session/pr-notifications.ts` — add `emitPublishSuperseded` (mirror `emitPublishBlocked` `:336`, but neutral)
- Test: `tests/test_cloudflare/session/pr-workflow.test.ts`

**Interfaces:**

- Consumes: `guard.benign` (Task 5); `isPublishSuperseded`/`PublishStatus` (Task 1).
- Produces: a benign guard block writes `publishStatus: "superseded"`, emits a `pr.open` agent-timeline event with `status: "completed"` + `metadata: { superseded: true }`, and a `publish.superseded` durable event. **No** `pr_failed` broadcast. Genuine blocks unchanged.

- [ ] **Step 1: Write the failing test**

```ts
it("benign guard block sets publishStatus=superseded and emits no pr_failed", async () => {
  // merged-PR review-loop publish
  const result = await service.publishSessionResult(mergedPrRequest);
  const ext = doDb.getSessionExtended(sql, sessionId);
  expect(ext?.publishStatus).toBe("superseded");
  // pr.open timeline event is neutral, not failed:
  const prOpen = latestAgentTimeline(sessionId, "pr.open");
  expect(prOpen.status).toBe("completed");
  expect(prOpen.metadata.superseded).toBe(true);
  // no pr_failed broadcast captured:
  expect(broadcasts.filter((b) => b.type === "pr_failed")).toHaveLength(0);
});
it("genuine guard block still sets blocked_by_verification (red) and pr_failed", async () => {
  const result = await service.publishSessionResult(missingReadinessRequest);
  expect(doDb.getSessionExtended(sql, sessionId)?.publishStatus).toBe("blocked_by_verification");
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts -t "superseded"`
Expected: FAIL — both currently set `blocked_by_verification` + emit `pr_failed`.

- [ ] **Step 3: Implement**

In `pr-notifications.ts`, add beside `emitPublishBlocked`:

```ts
async emitPublishSuperseded(sessionId: string, reason: string, branchName: string, promptId?: string): Promise<void> {
  const provenance = readPublishProvenanceTags(this.sql, sessionId);
  this.host.log.info(
    { event: "publish_superseded", sessionId, branchName, reason, ...provenance },
    "Review-loop publish superseded — PR/session moved on",
  );
  // NOTE: deliberately NO `pr_failed` broadcast — this is a neutral outcome.
  await this.appendEntries(
    sessionId,
    [
      {
        type: "publish.superseded",
        timestamp: nowIso(),
        data: { sessionId, ...(promptId ? { promptId } : {}), reason, branchName },
      },
      {
        type: "agent_timeline",
        timestamp: nowIso(),
        data: {
          eventType: "pr.open",
          source: "observed",
          observer: "control_plane",
          status: "completed",
          summary: "Review loop superseded — PR moved on.",
          metadata: { superseded: true, reason },
          ...(promptId ? { promptId } : {}),
        },
      },
    ],
    // (mirror emitPublishBlocked's trailing args)
  );
}
```

(Read `emitPublishBlocked` `:336-380` and mirror its `appendEntries` call shape exactly — same trailing arguments/options. Confirm `agent_timeline` events accept a `metadata` field via `shared/types/agent-timeline.ts`; if `metadata` isn't already on the agent-timeline event type, add `superseded?: boolean` to it.)

In `blockReviewLoopPublish`, branch on `guard.benign`:

```ts
  private async blockReviewLoopPublish(sessionId, branch, guard, promptId?) {
    const benign = guard.benign === true && guard.ownerApprovalRequired !== true;
    if (guard.epochId && this.host.env.DB) {
      const update = guard.ownerApprovalRequired ? markReviewLoopEpochWaitingForOwner : markReviewLoopEpochBlocked;
      await update(this.host.env.DB, guard.epochId, { nowMs: Date.now(), reason: guard.reason, expectedPromptId: promptId ?? null }).catch(/* unchanged */);
    }
    if (benign) {
      await this.setPublishState(sessionId, { publishStatus: "superseded", publishStage: "done", publishError: null });
      await this.notifications.emitPublishSuperseded(sessionId, guard.reason, branch, promptId);
      await this.notifications.emitPublishCompleted(sessionId, "superseded", promptId);
      return { ok: true, status: "superseded", reason: guard.reason };
    }
    await this.setPublishState(sessionId, { publishStatus: "blocked_by_verification", publishStage: "done", publishError: guard.reason });
    await this.notifications.emitPublishBlocked(sessionId, guard.reason, branch, promptId);
    await this.notifications.emitPublishCompleted(sessionId, "blocked_by_verification", promptId);
    return { ok: true, status: "blocked_by_verification", reason: guard.reason };
  }
```

(Add `"superseded"` to the `PublishResult` union the method returns — `grep -n 'status: "blocked_by_verification"' publish-service.ts` `:379`. Confirm `emitPublishCompleted` accepts `"superseded"`; widen its param type if it's a narrowed union.)

- [ ] **Step 4: Run; verify pass**

Run: `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts -t "superseded"` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/session/publish-service.ts apps/control-plane-worker/src/session/pr-notifications.ts
git commit -m "feat(control-plane): route benign review-loop guard blocks to superseded (neutral)"
```

### Task 7: Map the `publish.superseded` durable event in the UI dispatcher

**Files:**

- Modify: `apps/ui/src/utils/durable-event-dispatch.ts:225-230` (mirror the `publish.blocked_by_verification` case)
- Test: the dispatcher test (`grep -rl "publish.blocked_by_verification" --include="*.test.ts*" apps/ui`)

**Interfaces:**

- Consumes: `publish.superseded` durable event (Task 6); `PublishStatus` includes `"superseded"` (Task 1).
- Produces: dispatching `publish.superseded` sets `publishStatus: "superseded"` on the UI session state.

- [ ] **Step 1: Write the failing test**

```ts
it("maps publish.superseded to publishStatus superseded", () => {
  const next = dispatchDurableEvent(state, { type: "publish.superseded", data: { reason: "the PR is merged" } });
  expect(next.publishStatus).toBe("superseded");
});
```

- [ ] **Step 2: Run; verify fail**

Run: `npm -w cycloid-ui test -- durable-event-dispatch`
Expected: FAIL — event unhandled.

- [ ] **Step 3: Implement** (mirror the blocked case at `:225`)

```ts
    case "publish.superseded": {
      return {
        ...state,
        publishStatus: "superseded",
        publishError: null,
      };
    }
```

- [ ] **Step 4: Run; verify pass**

Run: `npm -w cycloid-ui test -- durable-event-dispatch` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/utils/durable-event-dispatch.ts <dispatcher test>
git commit -m "feat(ui): map publish.superseded durable event to superseded status"
```

---

## Final verification (before opening PRs)

- [ ] `npx tsc -p apps/control-plane-worker/tsconfig.json --noEmit` → 0
- [ ] `npx tsc -p apps/ui/tsconfig.json --noEmit` → 0
- [ ] `npx tsc -p apps/cli/tsconfig.json --noEmit` → 0
- [ ] `npx vitest run tests/test_cloudflare/session/pr-workflow.test.ts` → green
- [ ] `npm -w cycloid-ui test` → green
- [ ] Manual reasoning check: a merged-PR review-loop publish now yields `publishStatus: "superseded"` → phase `superseded` → neutral pill + "Superseded" post-execution badge, **no** red rail, **no** `pr_failed` broadcast. A genuine block (missing readiness) is unchanged (red).

## Self-Review (run after drafting; already applied)

1. **Spec coverage:** symptom = benign guard blocks paint good PRs red on 4 surfaces (sidebar rail, post-exec badge, PR-section error, admin row). Sidebar+admin read `phase`/`richStatus` → fixed by Tasks 2-3 (phase `superseded` → neutral). Post-exec badge reads `pr.open` event → Task 4 + Task 6 (neutral event). PR-section reads `isPublishBlocked(publishStatus)` → unaffected because `superseded ≠ blocked_by_verification` (Task 1 keeps `isPublishBlocked` narrow), so the red error message simply doesn't render. ✅ all four covered.
2. **Placeholder scan:** UI rail/`Record<>` entries and the `emitPublishSuperseded` `appendEntries` trailing args are "mirror the existing X" because the exact local shape must be copied at execution — each names the exact line to mirror. No TODO/TBD.
3. **Type consistency:** `superseded` used identically across `PublishStatus`, `Phase`, `DisplayStatus`, `publishStatus` writes, and the `publish.superseded`/`pr.open metadata.superseded` event contract. `guard.benign` flows guard → `blockReviewLoopPublish` only.

---

## Open follow-ups (out of scope; flag, don't build here)

- The 95% benign **sweep** epoch blocks (`head_changed`, `session_not_review_listening`) are invisible to the session UI but DO drive the GitHub PR status comment; that path already hides `head_changed` (`review-loop-status-comment.ts:226`). No UI change needed; revisit only if the PR comment is the surface in question.
- The eligibility-humanizer prefix bug ([[rla-publish-block-reasons-audit]]) is a separate 0.1% cleanup.
