# Review-loop session_not_sendable Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans, task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the review-loop from permanently pausing a PR when the response enqueue hits a stopped, user-stopped sandbox — cold-resume it instead, and treat any residual `session_not_sendable` as a bounded retry.

**Architecture:** Two coordinated control-plane changes. (1) The DO enqueue gate (`validatePromptEnqueueResumeState`) cold-resumes a stopped sandbox when the enqueue is review-loop-originated (carries `reviewLoopEpochId`). (2) The review-loop sweep reclassifies a `409 session_not_sendable/stopped` enqueue failure as a bounded transient retry (limit 5 → then blocks with retry-aware copy) instead of a one-shot fatal `prompt_enqueue_failed`. No schema change.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, D1 (raw prepared statements), Vitest (`tests/test_cloudflare`).

**Spec:** `docs/superpowers/specs/2026-06-01-review-loop-session-not-sendable-resume-design.md`

---

## File Structure

- `apps/control-plane-worker/src/session/prompt-queue.ts` — Fix 1: export + extend `validatePromptEnqueueResumeState`; pass `isReviewLoopEnqueue` from the caller.
- `apps/control-plane-worker/src/services/review-loop-sweep.ts` — Fix 2: add `isResumableEnqueueFailure`; reroute both enqueue-failure sites (bot/human + CI).
- `apps/control-plane-worker/src/services/review-loop-blocked-reason.ts` — Fix 2: map `prompt_send_not_ready` to retry-aware customer copy.
- `tests/test_cloudflare/session/prompt-queue-helper.test.ts` — Fix 1 unit tests (pure helper).
- `tests/test_cloudflare/review-loop-sweep.test.ts` — Fix 2 sweep classification tests.
- `tests/test_cloudflare/review-loop-blocked-reason.test.ts` — **new** — Fix 2 copy-mapping test.

---

## Task 1: Fix 1 — Enqueue gate cold-resumes review-loop enqueues

**Files:**

- Modify: `apps/control-plane-worker/src/session/prompt-queue.ts:90-101` (function), `:807` (caller)
- Test: `tests/test_cloudflare/session/prompt-queue-helper.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe("prompt-queue helper", ...)` block in `tests/test_cloudflare/session/prompt-queue-helper.test.ts`. Add `validatePromptEnqueueResumeState` to the existing import block from `../../../apps/control-plane-worker/src/session/prompt-queue` (the one ending at line 29).

```ts
describe("validatePromptEnqueueResumeState", () => {
  const stoppedNonResumable = { stopped: true, paused: false, expired: false, resumable: false };

  it("rejects a stopped non-resumable sandbox for a normal enqueue", () => {
    expect(validatePromptEnqueueResumeState(null, stoppedNonResumable, false)).toEqual({
      ok: false,
      reason: "stopped",
    });
  });

  it("cold-resumes a stopped non-resumable sandbox for a review-loop enqueue", () => {
    expect(validatePromptEnqueueResumeState(null, stoppedNonResumable, true)).toEqual({
      ok: true,
      isResumableSend: true,
    });
  });

  it("never marks a resumable send when a prompt is already active, even for a review-loop enqueue", () => {
    expect(validatePromptEnqueueResumeState("p-1", stoppedNonResumable, true)).toEqual({
      ok: true,
      isResumableSend: false,
    });
  });

  it("preserves the normal resumable-stopped cold-resume path", () => {
    const resumable = { stopped: true, paused: false, expired: false, resumable: true };
    expect(validatePromptEnqueueResumeState(null, resumable, false)).toEqual({
      ok: true,
      isResumableSend: true,
    });
  });

  it("treats a live (non-stopped) sandbox as a normal send", () => {
    const live = { stopped: false, paused: false, expired: false, resumable: false };
    expect(validatePromptEnqueueResumeState(null, live, false)).toEqual({
      ok: true,
      isResumableSend: false,
    });
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run tests/test_cloudflare/session/prompt-queue-helper.test.ts -t "validatePromptEnqueueResumeState"`
Expected: FAIL — `validatePromptEnqueueResumeState is not exported` / import error.

- [ ] **Step 3: Export the helper and add the `isReviewLoopEnqueue` parameter**

In `apps/control-plane-worker/src/session/prompt-queue.ts`, replace the function at lines 90-101:

```ts
export function validatePromptEnqueueResumeState(
  effectiveActivePromptId: string | null,
  resume: SandboxResumeState,
  isReviewLoopEnqueue: boolean,
): PromptEnqueueValidation {
  if (effectiveActivePromptId) {
    return { ok: true, isResumableSend: false };
  }
  if (resume.stopped && !resume.resumable) {
    // A review_listening session is expected to be cold; a review-loop-originated enqueue must always
    // be able to cold-resume it. Genuinely-terminal phases (archived/failed/blocked/finalizing) are
    // already rejected by the isPromptSendDisabled phase gate before this point, so the only state
    // reachable here is a stopped sandbox that can always be cold-spawned fresh.
    if (isReviewLoopEnqueue) {
      return { ok: true, isResumableSend: true };
    }
    return { ok: false, reason: "stopped" };
  }
  return { ok: true, isResumableSend: resume.resumable };
}
```

- [ ] **Step 4: Pass `isReviewLoopEnqueue` from the caller**

In the same file, just after `const resume = getSandboxResumeState(sandboxState);` (line 795), add:

```ts
const isReviewLoopEnqueue =
  typeof payload.reviewLoopEpochId === "string" && payload.reviewLoopEpochId.trim().length > 0;
```

Then update the call at line 807 from:

```ts
const enqueueValidation = validatePromptEnqueueResumeState(effectiveActivePromptIdFromDb, resume);
```

to:

```ts
const enqueueValidation = validatePromptEnqueueResumeState(effectiveActivePromptIdFromDb, resume, isReviewLoopEnqueue);
```

- [ ] **Step 5: Verify it passes**

Run: `npx vitest run tests/test_cloudflare/session/prompt-queue-helper.test.ts -t "validatePromptEnqueueResumeState"`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run -w @cycloid/control-plane-worker typecheck` — expect no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane-worker/src/session/prompt-queue.ts tests/test_cloudflare/session/prompt-queue-helper.test.ts
git commit -m "fix(review-loop): cold-resume stopped sandbox for review-loop enqueues"
```

---

## Task 2: Fix 2 — Sweep reclassifies session_not_sendable as a bounded transient retry

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-sweep.ts:160-165` (new helper), `:711-718` (CI site), `:804-811` (bot/human site)
- Test: `tests/test_cloudflare/review-loop-sweep.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these `it(...)` blocks inside the top-level `describe` in `tests/test_cloudflare/review-loop-sweep.test.ts` (alongside the existing "defers contention…" test at line 245). They reuse the file's existing helpers (`claimedEpoch`, `mockListDueReviewLoopEpochs`, `mockClaimReviewLoopEpochForPrompt`, `mockEnqueueSessionPrompt`, `mockMarkReviewLoopEpochTransientFailure`, `mockMarkReviewLoopEpochBlocked`, `env`, `logger`).

```ts
it("defers session_not_sendable as a bounded transient retry instead of blocking", async () => {
  const epoch = claimedEpoch();
  mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
  mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
  mockEnqueueSessionPrompt.mockResolvedValueOnce({
    ok: false,
    status: 409,
    error: "session_not_sendable",
    reason: "stopped",
    payload: null,
  });

  const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
  const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

  expect(mockMarkReviewLoopEpochTransientFailure).toHaveBeenCalledWith(
    env.DB,
    "epoch-1",
    expect.objectContaining({ reason: "prompt_send_not_ready", error: "session_not_sendable" }),
  );
  expect(mockMarkReviewLoopEpochBlocked).not.toHaveBeenCalledWith(
    env.DB,
    "epoch-1",
    expect.objectContaining({ reason: "prompt_enqueue_failed" }),
  );
  expect(result.transientDeferred).toBe(1);
  expect(result.blocked).toBe(0);
});

it("blocks session_not_sendable once the transient retry limit is exhausted", async () => {
  const epoch = claimedEpoch();
  mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
  mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
  mockEnqueueSessionPrompt.mockResolvedValueOnce({
    ok: false,
    status: 409,
    error: "session_not_sendable",
    reason: "stopped",
    payload: null,
  });
  // DAO converts the deferral to a terminal block when transient_failure_count hits the limit.
  mockMarkReviewLoopEpochTransientFailure.mockResolvedValueOnce(claimedEpoch({ status: "blocked" }));

  const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
  const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

  expect(result.blocked).toBe(1);
  expect(result.transientDeferred).toBe(0);
});

it("still fails fast on a terminal enqueue reason", async () => {
  const epoch = claimedEpoch();
  mockListDueReviewLoopEpochs.mockResolvedValueOnce([epoch]);
  mockClaimReviewLoopEpochForPrompt.mockResolvedValueOnce(epoch);
  mockEnqueueSessionPrompt.mockResolvedValueOnce({
    ok: false,
    status: 409,
    error: "session_not_sendable",
    reason: "archived",
    payload: null,
  });

  const { runReviewLoopSweep } = await import("../../apps/control-plane-worker/src/services/review-loop-sweep");
  const result = await runReviewLoopSweep(env, { nowMs: 789_000, logger: logger as never });

  expect(mockMarkReviewLoopEpochBlocked).toHaveBeenCalledWith(
    env.DB,
    "epoch-1",
    expect.objectContaining({ reason: "prompt_enqueue_failed" }),
  );
  expect(mockMarkReviewLoopEpochTransientFailure).not.toHaveBeenCalled();
  expect(result.blocked).toBe(1);
});
```

- [ ] **Step 2: Verify they fail**

Run: `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts -t "session_not_sendable"`
Expected: FAIL — the first two assert transient handling that does not exist yet (epoch is blocked with `prompt_enqueue_failed`); `result.transientDeferred` is 0.

- [ ] **Step 3: Add the classifier helper**

In `apps/control-plane-worker/src/services/review-loop-sweep.ts`, immediately after `isPromptContentionFailure` (ends at line 165), add:

```ts
// A 409 whose reason indicates the sandbox is stopped/not-yet-ready — the session can still be
// re-driven (Fix 1 cold-resumes review-loop enqueues), so this is a bounded transient retry, not a
// permanent pause. Terminal reasons (archived/blocked/failed/finalizing) are deliberately excluded so
// they continue to fail fast via prompt_enqueue_failed.
function isResumableEnqueueFailure(result: { status: number; error?: string | null; reason?: string | null }): boolean {
  if (result.status !== 409) return false;
  const reason = String(result.reason ?? result.error ?? "").toLowerCase();
  return reason.includes("stopped") || reason.includes("session_not_sendable");
}
```

- [ ] **Step 4: Reroute the bot/human enqueue-failure site**

Replace the block at lines 804-812:

```ts
if (!enqueueResult.ok || !enqueueResult.payload) {
  const error = enqueueResult.error ?? `status_${enqueueResult.status}`;
  if (isPromptContentionFailure(enqueueResult)) {
    await deferClaimedEpochForContention("prompt_contention", error);
    return "contention_deferred";
  }
  await blockClaimedEpoch("prompt_enqueue_failed", error);
  return "blocked";
}
```

with:

```ts
if (!enqueueResult.ok || !enqueueResult.payload) {
  const error = enqueueResult.error ?? `status_${enqueueResult.status}`;
  if (isPromptContentionFailure(enqueueResult)) {
    await deferClaimedEpochForContention("prompt_contention", error);
    return "contention_deferred";
  }
  if (isResumableEnqueueFailure(enqueueResult)) {
    const deferred = await deferClaimedEpochForTransientPollFailure("prompt_send_not_ready", error);
    if (!deferred) return "skipped";
    return deferred.status === "blocked" ? "blocked" : "transient_deferred";
  }
  await blockClaimedEpoch("prompt_enqueue_failed", error);
  return "blocked";
}
```

- [ ] **Step 5: Reroute the CI enqueue-failure site**

Replace the block at lines 711-719:

```ts
if (!ciEnqueueResult.ok || !ciEnqueueResult.payload) {
  const error = ciEnqueueResult.error ?? `status_${ciEnqueueResult.status}`;
  if (isPromptContentionFailure(ciEnqueueResult)) {
    await deferClaimedEpochForContention("prompt_contention", error);
    return "contention_deferred";
  }
  await blockClaimedEpoch("prompt_enqueue_failed", error);
  return "blocked";
}
```

with:

```ts
if (!ciEnqueueResult.ok || !ciEnqueueResult.payload) {
  const error = ciEnqueueResult.error ?? `status_${ciEnqueueResult.status}`;
  if (isPromptContentionFailure(ciEnqueueResult)) {
    await deferClaimedEpochForContention("prompt_contention", error);
    return "contention_deferred";
  }
  if (isResumableEnqueueFailure(ciEnqueueResult)) {
    const deferred = await deferClaimedEpochForTransientPollFailure("prompt_send_not_ready", error);
    if (!deferred) return "skipped";
    return deferred.status === "blocked" ? "blocked" : "transient_deferred";
  }
  await blockClaimedEpoch("prompt_enqueue_failed", error);
  return "blocked";
}
```

- [ ] **Step 6: Verify they pass**

Run: `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts -t "session_not_sendable"`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full sweep suite**

Run: `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts`
Expected: PASS (all).

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-sweep.ts tests/test_cloudflare/review-loop-sweep.test.ts
git commit -m "fix(review-loop): retry session_not_sendable instead of permanent pause"
```

---

## Task 3: Fix 2 — Retry-aware customer copy for the exhausted case

**Files:**

- Modify: `apps/control-plane-worker/src/services/review-loop-blocked-reason.ts:14-34` (map)
- Test: `tests/test_cloudflare/review-loop-blocked-reason.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_cloudflare/review-loop-blocked-reason.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { describeReviewLoopBlockedReason } from "../../apps/control-plane-worker/src/services/review-loop-blocked-reason";

describe("describeReviewLoopBlockedReason", () => {
  it("maps prompt_send_not_ready to retry-aware copy, not the generic fallback", () => {
    const copy = describeReviewLoopBlockedReason("prompt_send_not_ready");
    expect(copy).toBe("Paused after repeated attempts to wake this session up. This PR may need a human.");
  });

  it("falls back to the generic message for an unknown reason", () => {
    expect(describeReviewLoopBlockedReason("totally_unknown_reason")).toBe(
      "Paused responding to reviews on this PR. This PR may need a human to take a look.",
    );
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `npx vitest run tests/test_cloudflare/review-loop-blocked-reason.test.ts`
Expected: FAIL — `prompt_send_not_ready` currently hits the generic fallback.

- [ ] **Step 3: Add the mapping**

In `apps/control-plane-worker/src/services/review-loop-blocked-reason.ts`, add to the `FRIENDLY_BLOCKED_REASONS` object (after the `prompt_enqueue_failed` line, line 18):

```ts
  prompt_send_not_ready: "Paused after repeated attempts to wake this session up. This PR may need a human.",
```

- [ ] **Step 4: Verify it passes**

Run: `npx vitest run tests/test_cloudflare/review-loop-blocked-reason.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane-worker/src/services/review-loop-blocked-reason.ts tests/test_cloudflare/review-loop-blocked-reason.test.ts
git commit -m "fix(review-loop): map prompt_send_not_ready to retry-aware copy"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `npm run typecheck` — expect no errors across all workspaces.

- [ ] **Step 2: Run all affected suites together**

Run: `npx vitest run tests/test_cloudflare/review-loop-sweep.test.ts tests/test_cloudflare/session/prompt-queue-helper.test.ts tests/test_cloudflare/review-loop-blocked-reason.test.ts tests/test_shared/eligibility.test.ts`
Expected: PASS (all).

- [ ] **Step 3: Confirm no stray formatting issues**

Run: `npm run format:check`
Expected: pass (or run `npm run format` then re-stage if the hook reformats).

---

## Notes for the implementer

- **Why `reviewLoopEpochId` drives the override:** every review-loop enqueue (bot/human review at `review-loop-sweep.ts:800` and CI fix at `:700`) passes `reviewLoopEpochId`; user-initiated UI/Slack/Linear/MCP enqueues do not. Scoping cold-resume to this signal keeps deliberate user-stop semantics intact for non-review-loop callers — intentional, not an oversight.
- **No proactive warm in the sweep:** Fix 1's enqueue path already cold-resumes (`spawnSandbox.resume.cold`), and `review-loop-reengage.ts` already warms on the human re-entry path; a sweep warm would be redundant.
- **Retry budget:** `markReviewLoopEpochTransientFailure` (limit `REVIEW_LOOP_TRANSIENT_FAILURE_LIMIT = 5`) decrements `attempt_count` (a deferral does not burn the attempt cap), increments `transient_failure_count`, and flips to `blocked` at the limit — a genuinely dead session still terminates instead of pausing on attempt 1 or looping forever.
- **Do not** change the idle-reaper `stopReason` (idle reaps are already resumable) or broaden the `resumable()` formula for all callers — both explicitly out of scope per the spec.
