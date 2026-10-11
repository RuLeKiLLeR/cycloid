# 👀 acknowledgement reaction on ingested PR reviews

**Status:** design approved (brainstorming), pending implementation plan
**Date:** 2026-07-07
**Branch:** `Jag/review-ack-eyes`

## Goal

When a PR review is received and accepted by Cycloid's review loop — including when it is queued behind an in-flight epoch — leave a 👀 reaction on the review's comment(s) so the reviewer knows it was seen and is not being ignored. Many reviews arriving at once are queued for later epochs; the reaction is the cheap "seen it" signal that closes that silence.

## Motivation & worth-it

Speculative UX (no metric yet proving queued reviews read as ignored, but it is a plausible real annoyance). Verdict: **build-smaller** — smallest version that produces signal, reusing the existing 👀 idiom. Signal that **kills** it: nobody notices, or it reads as noise. Signal that **scales** it: reviewers report reassurance / fewer "did it get my review?" pings.

Cost: one small new REST wrapper (mirror of an existing one), one best-effort post-ingest hook, gating + tests. Buys: closes a real acknowledgement gap using infra that already exists.

## Hard constraint (shapes the whole design)

GitHub's reactions API **cannot** react to a `pull_request_review` submission itself — a review is not a reactable subject in REST or GraphQL (`PullRequestReview` is not `Reactable`). Reactable subjects are: issue/PR-conversation comments, **inline PR review comments**, the PR/issue body, commit comments, releases, discussions. So the 👀 lands on the review's **comments**, never on the review bubble.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Emoji target | On the review's **comments** (no fallback comment for summary-only reviews) |
| Trigger | On **every review Cycloid accepts** (queued or dispatched), not only the deferred case |
| Whose reviews | **Human and bot** (third-party bots included; Cycloid's own excluded) |
| Bot status-noise | **Suppress** 👀 on a known bot's "no findings" / "in progress" placeholder via the existing noise classifier |
| Inline fan-out | React on **every** inline comment of the review, with a **~50 cap** |

## Behavior spec

Fire a 👀 reaction when, and only when, a review webhook is **accepted into the review loop** — i.e. the ingest call returns `{ status: "handled" }` (`review-loop-epochs.ts:2457-2458`). This is the single point where a review is matched to a live review-listening session and folded into / opens an epoch. Every existing `{ status: "ignored", reason }` path is skipped for free: `no_session_for_pr`, `no_review_listening_session`, `empty_approval`/self-trigger (dropped upstream in the handler before ingest), `stale_head`, `actor_not_configured_bot`, `missing_head_sha`, `qa_verdict_not_actionable`.

**Exclude Cycloid-owned authors at the ack, not just upstream.** Most Cycloid-authored reviews are dropped before ingest via `isCycloidAppLogin` (`webhooks/github.ts:2493/2937`) and the self-reply guard, so they never reach `handled`. But `resolveIngestBotKey` (`github/pr-review-bots.ts:209`) carves a single exception — the QA managed comment (`cycloid-qa[bot]`) is admitted to `handled` (`qa-verdict` source). The ack scheduler must therefore **independently skip any Cycloid-owned author** (app login / `cycloid-qa[bot]`) so Cycloid never reacts to its own comment. This check lives in the scheduler, not relied upon from the upstream guards.

### Reaction target per surface

The three review-bearing webhook handlers each resolve a set of `(targetKind, commentId, body)` reaction targets:

| Webhook event | Handler (`webhooks/github.ts`) | Reaction target(s) | Endpoint |
|---|---|---|---|
| `pull_request_review` (submitted) | `handlePullRequestReviewEvent` (`:2823`) | each **inline comment** of the review (`getPrReviewComments` filtered to `comment.reviewId === reviewId`) | `pulls/comments/{id}/reactions` (**new**) |
| `pull_request_review_comment` (created) | `handlePullRequestReviewCommentEvent` (`:2287`) | that one **inline comment** | `pulls/comments/{id}/reactions` (**new**) |
| `issue_comment` on a PR (created) | `handleIssueCommentEvent` (`:1273`) | that one **top-level comment** | `issues/comments/{id}/reactions` (**existing**, `github/issues.ts:38`) |

**Accepted gap:** a review that is only an Approve/Request-changes summary with **zero inline comments** has no reactable target → no 👀. This includes a common case (human "Request changes" with a summary note and no inline comments). Accepted per the emoji-target decision. Re-enabling a signal for it is a one-line fallback (post/edit a single 👀 comment) if we later change our mind — explicitly out of scope here.

### Bot status-noise suppression

Before reacting to a target, run `classifyReviewLoopNoise({ botKey, body })` (`github/review-loop-noise-gate.ts:144`) on that target's body:

- `botKey` = the matched bot key (`known:<id>` | `custom:<login>`) from `matchReviewLoopBot` (`github/pr-review-bots.ts:163`) using the review/comment author.
- The classifier **fail-opens** on humans and custom bots (returns `{ gated: false }`), so those are always reacted to.
- For a **known** bot whose body is a pure "no findings" / "in progress" placeholder (`{ gated: true }`), **skip** the 👀 — reacting there would imply "picked this up" on a comment the worklist noise gate then drops. This keeps 👀 honest.

The noise gate binds only the **single-body surfaces** (`issue_comment` and the inline `review_comment`), where a known bot's placeholder body is the whole payload. A **review submission** is gated on **owned-author only** — never on its summary body: a no-findings summary has no reactable inline target (so it gets no 👀 for free), and a review that carries real inline comments is genuine feedback that Cycloid processes, so its inline comments are acked even if the summary reads like "LGTM".

## Implementation

### 1. New REST wrapper — `github/issues.ts`

Mirror `postIssueCommentReaction` (`:38`) for inline review comments:

```ts
export const GITHUB_REVIEW_ACK_REACTION: GithubIssueCommentReactionContent = "eyes";

export async function postReviewCommentReaction(
  env, installationId, owner, repo, commentId, content,
): Promise<void> {
  const token = await createInstallationToken(env, installationId);
  const response = await tracedFetch(
    `${GITHUB_API}/repos/${enc(owner)}/${enc(repo)}/pulls/comments/${commentId}/reactions`,
    { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ content }) },
    "github.postReviewCommentReaction",
  );
  await assertGithubOk(response, "GitHub review comment reaction creation");
}
```

Reuse the existing `postIssueCommentReaction` for the top-level `issue_comment` target.

### 2. Best-effort ack scheduler — `webhooks/github.ts`

Mirror `scheduleGithubIssueCommentReaction` (`:893`) — fire-and-forget via `executionCtx.waitUntil`, `.catch(warn)`, never blocks or fails ingest:

```ts
function scheduleReviewAckReactions(
  env, executionCtx, targets: ReviewAckTarget[],
): void { /* for each target: noise-gate check, then post*Reaction, cap at 50, waitUntil */ }
```

`ReviewAckTarget = { kind: "review_comment" | "issue_comment"; commentId; body; botKey; installationId; owner; repo }`. Cap the target list at **50** and `log.warn` when truncated (no silent cap). Deduplicate `commentId`s.

### 3. Wire into the handlers

In each of the three handlers, after the existing post-ingest hooks that already gate on `result.status === "handled"` (`shadowEmitReviewReceivedForIngest` `:2469`, `emitReviewLoopWebhookIngestOutcome` `:2486`), call `scheduleReviewAckReactions` with the resolved targets. Compute `botKey` via `matchReviewLoopBot` from the author. Only build targets when `result.status === "handled"`.

- The `pull_request_review` human loop already fetches `getPrReviewComments` (`:2573`); reuse it. The bot branch / other paths fetch lazily inside the fire-and-forget task (off the response path) when target bodies aren't already in hand.

## Idempotency & failure

GitHub's reaction `POST` is **naturally idempotent** — re-posting the same reaction returns the existing one (200), never a duplicate. Combined with the bot-path webhook-delivery idempotency claim (`claimGithubWebhook`), redeliveries and many-reviews-at-once cannot produce duplicate 👀s. Fire-and-forget + natural idempotency is the smallest safe version. Failures are logged (`log.warn`) and swallowed — the ack never affects ingest success or the webhook response.

Deferred (not in v1): keying an `ack` operation in `pr_review_response_operations` to suppress *redundant API calls* on redelivery. Natural idempotency already prevents duplicate reactions; the ops-table only saves wasted calls. Add only if telemetry shows meaningful redundant-call volume.

## Telemetry (optional, low cost)

Piggyback the existing ingest-outcome event or add a bounded counter `review_loop.ack_reaction` tagged `{ surface, sourceKind, outcome: posted|skipped_noise|skipped_no_target|error }`. Lets us size adoption and the summary-only gap. Include only if it fits the existing metric emission with no new dashboard burden; otherwise defer.

## Testing

- **Unit** — `postReviewCommentReaction` posts to `pulls/comments/{id}/reactions` with `"eyes"` (mirror `tests/test_cloudflare/github/issues.test.ts`).
- **Noise-gate reuse** — a known-bot "in progress" / "no findings" body yields no reaction (assert scheduler skips); a human body reacts.
- **Webhook ingest** — extend `github-pr-review-webhook.test.ts`, `github-issue-comment-webhook.test.ts`, `review-loop-webhook-service.test.ts`:
  - `handled` → 👀 on the expected comment target(s).
  - each `ignored` reason → **no** 👀.
  - summary-only review (no inline comments) → no 👀, no error.
  - inline fan-out cap at 50 → warns, reacts to 50.
  - Cycloid's own review (self) → no 👀 (dropped before ingest).
  - `cycloid-qa[bot]` QA verdict comment (admitted to ingest via the `resolveIngestBotKey` carve-out) → no 👀 (scheduler-level Cycloid-owned skip).

## Out of scope / accepted gaps

- No 👀 on summary-only reviews (no reactable target) — accepted.
- No reaction on the review submission bubble — impossible via the API.
- No `pr_review_response_operations` ack row in v1 — natural idempotency suffices.
- No PR-body / label / status-comment signal — deliberately avoided (team removed status comments in PR-E1).

## Risks

- **Bot fan-out volume:** a large bot review (many inline comments) → many reactions. Bounded by the 50 cap and GitHub App rate limits (generous; fire-and-forget). Acceptable.
- **Over-inclusion on the summary path:** none — summary-only reviews simply get no target.
- **Reacting to a later-noise-gated bot comment:** mitigated by running the noise classifier at ack time on each target body.
