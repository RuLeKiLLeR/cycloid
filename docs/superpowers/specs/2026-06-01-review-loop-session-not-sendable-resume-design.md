# Review-loop response: resume a stopped sandbox instead of permanently pausing

Date: 2026-06-01
Branch: `fix-review-loop-session-not-sendable`

## Problem

When the review-loop sweep fires for a `review_listening` session whose sandbox is
**stopped + non-resumable**, the response-prompt enqueue is rejected with
`409 { error: "session_not_sendable", reason: "stopped" }`. The sweep misclassifies that as a fatal
`prompt_enqueue_failed` on attempt 1, terminally blocks the epoch, and posts the customer-facing copy
"Paused — couldn't start responding. I'll retry, but this PR may need a human." It never actually
retries (`attempt_count=1`, `last_prompt_id=null`). The PR's reviews are never answered.

### Proven root-cause chain (code-confirmed, prod D1 + Datadog)

1. `review-loop-sweep.ts` `processEpoch` calls `enqueueSessionPrompt(...)`. On `!ok` it routes through
   `isPromptContentionFailure` (`review-loop-sweep.ts:160`); anything not matched →
   `blockClaimedEpoch("prompt_enqueue_failed", error)` (`:810`).
2. `isPromptContentionFailure` only treats `status===429`, or `status===409` whose `reason` contains
   `running|waiting_for_input|sandbox_creating|reconnecting`, as retryable. `stopped` /
   `session_not_sendable` is **not** in that set → fatal.
3. The 409 comes from `prompt-queue.ts` `validatePromptEnqueueResumeState` (`:90`): when
   `resume.stopped && !resume.resumable` it returns `{ ok:false, reason:"stopped" }`. Here
   `resumable = stopped && (paused || stopReason !== "user")` (`:86`). The sandbox was stopped with
   `stopReason="user"` and not paused → `resumable=false` → reject.
4. Customer copy: `review-loop-blocked-reason.ts:18` maps `prompt_enqueue_failed` → the "Paused —
   couldn't start responding…" line.

Prod evidence: epoch `pr_review_response_epochs` `f3f9580d…`, session
`cf36f695-dc09-442c-b151-bd5ba0806718`, PR #3837 head `68f3d99`: `status=blocked`,
`blocked_reason=prompt_enqueue_failed`, `last_error=session_not_sendable`, `attempt_count=1`,
`last_prompt_id=null`.

### Correction to the original diagnosis

The idle auto-stop path already stops with `stopReason="reaped"` (`durable-object.ts:9097`), which is
**resumable**. The only path setting `stopReason="user"` is the explicit user-stop
(`handleStopRequest` → `stopIdleSessionAtDurabilityBoundary`, `durable-object.ts:1115`). So the proven
failure is a **user-stopped** review-listening session, not an idle-reap; changing the idle-reaper's
stop reason would not fix it. The invariant "a `review_listening` session can always be re-driven to
respond" must be enforced at the **enqueue gate**, not the stop path.

## Goal / invariant

A review-loop-originated enqueue (carries `reviewLoopEpochId`) for a `review_listening` session must be
able to cold-resume a stopped sandbox regardless of `stopReason`, and the sweep must treat a transient
`session_not_sendable` as a bounded retry — never a one-shot permanent pause — while genuinely-terminal
states still fail fast.

## Approach (decisions locked with the user)

Two coordinated code changes plus a guardrail test. No schema change. No new flags beyond plumbing the
existing `reviewLoopEpochId` signal one level deeper.

### Fix 1 — Enqueue gate cold-resumes review-loop enqueues (primary fix)

In `prompt-queue.ts`, thread an `isReviewLoopEnqueue` boolean (derived from the request's
`reviewLoopEpochId`) into `validatePromptEnqueueResumeState`. When the gate would reject with
`stopped`, a review-loop enqueue instead returns `{ ok: true, isResumableSend: true }`, routing through
the existing `spawnSandbox.resume.cold` path (the same path a normal resumable-stopped enqueue takes).

```ts
function validatePromptEnqueueResumeState(
  effectiveActivePromptId: string | null,
  resume: SandboxResumeState,
  isReviewLoopEnqueue: boolean,
): PromptEnqueueValidation {
  if (effectiveActivePromptId) return { ok: true, isResumableSend: false };
  if (resume.stopped && !resume.resumable) {
    // A review_listening session is expected to be cold; a review-loop-originated enqueue must always
    // be able to cold-resume it. Genuinely-terminal phases (archived/failed/blocked/finalizing) are
    // already rejected above by the isPromptSendDisabled phase gate, so the only state reachable here
    // is a stopped sandbox that can always be cold-spawned fresh.
    if (isReviewLoopEnqueue) return { ok: true, isResumableSend: true };
    return { ok: false, reason: "stopped" };
  }
  return { ok: true, isResumableSend: resume.resumable };
}
```

Caller (`handlePromptEnqueueRequest`): compute `isReviewLoopEnqueue` from the already-parsed
`reviewLoopEpochId` (payload field read at `prompt-queue.ts:850`) and pass it in. The `stopped` phase
is explicitly exempt from the `isPromptSendDisabled` phase gate (`:787-793`), so a
`review_listening` + stopped session reaches this validator; archived returns 409 earlier (`:762`), and
failed/blocked/finalizing are caught by `isPromptSendDisabled`. Forcing `isResumableSend:true` here
therefore only ever converts a stopped sandbox into a cold resume.

**Why this altitude:** smallest change that makes the invariant true at the source; benefits both the
bot/human review enqueue (`:800`) and the CI-fix enqueue (`:700`) since both pass `reviewLoopEpochId`.
A truly un-spawnable session (e.g. repo gone) still fails at spawn time → the prompt fails → the epoch
is left in-flight and reclaimed by the stuck-epoch sweep, bounded by the attempt cap (no infinite loop).
We do **not** broaden the `resumable()` formula for all callers: a user-initiated UI/Slack/MCP prompt to
a deliberately user-stopped session keeps its current behavior.

### Fix 2 — Sweep reclassifies `session_not_sendable` as a bounded transient retry (guardrail)

Per the failure-class invariant (CLAUDE.md), keep a guardrail even though Fix 1 prevents the sweep's own
enqueue from returning `stopped`. In `review-loop-sweep.ts`, add a classifier for resumable/warmable
enqueue failures and route them to the existing transient-failure deferral instead of a fatal block.

```ts
// A 409 whose reason indicates the sandbox is stopped/warmable — the session can be re-driven, so this
// is a bounded retry, not a permanent pause. Terminal phases (archived/blocked/failed/finalizing) are
// NOT included and continue to fail fast via prompt_enqueue_failed.
function isResumableEnqueueFailure(result: { status: number; error?: string | null; reason?: string | null }): boolean {
  if (result.status !== 409) return false;
  const reason = String(result.reason ?? result.error ?? "").toLowerCase();
  return reason.includes("stopped") || reason.includes("session_not_sendable");
}
```

Apply at both enqueue-failure sites (bot/human `:804-811` and CI `:711-718`), ordered after the existing
contention check:

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

**Retry budget:** the transient bucket (`markReviewLoopEpochTransientFailure`,
`REVIEW_LOOP_TRANSIENT_FAILURE_LIMIT=5`) is correct here — it decrements `attempt_count` so a deferral
does not burn the attempt cap, increments `transient_failure_count`, and flips the epoch to `blocked`
once the count reaches the limit. So a session that genuinely can never send still terminates after 5
tries instead of pausing on attempt 1 or looping forever. We deliberately do **not** use the contention
bucket (no count cap → could defer indefinitely) and do **not** add a proactive `warmSession` in the
sweep (Fix 1's enqueue already cold-resumes; `reengage.ts` already warms on the human re-entry path).

The new transient reason `prompt_send_not_ready` only lands in `blocked_reason` when the transient
limit is exhausted (the DAO writes `blocked_reason` only on the blocked transition). Map it in
`review-loop-blocked-reason.ts` so the exhausted case shows retry-aware copy rather than the generic
fallback:

```ts
prompt_send_not_ready: "Paused after repeated attempts to wake this session up. This PR may need a human.",
```

### Fix 3 — Sibling-caller audit (failure-class closure)

- `reengage.ts` (human-review re-entry) already warms the sandbox before enqueue (step 5,
  `:191-199`) → not affected; no change.
- `webhooks/shared.ts` and `webhooks/github.ts` surface `session_not_sendable` for user-initiated
  Slack/Linear/bootstrap prompts. These intentionally stay rejected for a deliberately user-stopped
  session, so no behavior change — the cold-resume override is scoped to enqueues carrying
  `reviewLoopEpochId`. Document this boundary in the spec/PR; no code change.

## Files touched

- `apps/control-plane-worker/src/session/prompt-queue.ts` — Fix 1: `validatePromptEnqueueResumeState`
  signature + caller.
- `apps/control-plane-worker/src/services/review-loop-sweep.ts` — Fix 2: `isResumableEnqueueFailure` +
  both enqueue-failure sites.
- `apps/control-plane-worker/src/services/review-loop-blocked-reason.ts` — Fix 2: map
  `prompt_send_not_ready`.

## Tests (same PR)

- `tests/test_cloudflare/session/lifecycle/*` (or the prompt-queue enqueue suite): a stopped,
  `stopReason="user"`, non-paused sandbox —
  - review-loop enqueue (`reviewLoopEpochId` set) → `ok`, cold-resume (`spawnSandbox.resume.cold`),
    not rejected.
  - non-review-loop enqueue → still `409 session_not_sendable / stopped` (boundary pinned).
- `tests/test_cloudflare/review-loop-sweep.test.ts`:
  - enqueue returns `409 { reason: "stopped" }` → epoch goes `transient_deferred` (not blocked) on
    early attempts; `transient_failure_count` increments; `attempt_count` not consumed.
  - after `REVIEW_LOOP_TRANSIENT_FAILURE_LIMIT` transient failures → `blocked` with
    `prompt_send_not_ready`.
  - a terminal-reason 409 (e.g. `archived`/`blocked`) → still `prompt_enqueue_failed` fast (boundary
    pinned so the misclassification can't silently return).
- `review-loop-blocked-reason` unit: `prompt_send_not_ready` → mapped copy, not generic fallback.

## Verification

- `npm run typecheck`
- Targeted Vitest: `review-loop-sweep.test.ts`, the prompt-queue/lifecycle enqueue suite,
  `review-loop-blocked-reason` test, `tests/test_shared/eligibility.test.ts`.
- `npm run dev:full` not required (unit only).

## Out of scope

- Idle-reaper `stopReason` changes (idle reaps are already resumable).
- Broadening `resumable()` or changing user-stop semantics for non-review-loop callers.
- Any schema/migration change.
