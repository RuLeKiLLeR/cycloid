# Live review-loop status comment

**Date:** 2026-05-28
**Status:** Design — pending implementation plan

## Goal

While Cycloid is review-looping on a PR, post a single top-level PR comment showing, live,
which configured review bots it has observed and which it is still waiting on.
Informational only; edits itself in place as state changes.

## Behavior summary

| Decision           | Choice                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Comment scope      | One comment per PR, edited in place across every wave (new commit).                              |
| First post         | When Cycloid starts watching the PR — full checklist, nothing observed yet.                     |
| Gating             | Always-on whenever the review loop is active for the repo. No new setting.                       |
| Liveness           | Edit immediately on each bot webhook; the reconcile sweep re-syncs as a backup.                  |
| On completion      | Keep the comment, edited to a terminal "Done" state. Reused if a later commit starts a new wave. |
| No bots configured | Post nothing. The comment only appears when there is a real checklist to track.                  |

## Background

The review-loop feature already tracks everything needed, per epoch
(`pr_review_response_epochs`, see `apps/control-plane-worker/src/services/review-loop-epochs.ts`):

- `expectedBots` / `expectedBotKeys` — the configured checklist for this epoch.
- `observedTerminalBotKeys` — bots that posted a terminal review signal; same key format
  as expected keys (`known:<id>` / `custom:<login>`), so observed ⊆ expected.
- timed-out bots — derived at render time: once an epoch leaves `collecting` (all bots
  arrived or the fallback timer fired), any still-unobserved bot is "proceeded without".
  (`timed_out_bot_keys_json` is never populated by the epoch machine, so the renderer
  derives this from `status`.)
- `status` — `collecting | ready | reserving | enqueued | processing | waiting_for_owner | publishing | completed | blocked`.
- `headSha`, `wave`.

"Waiting on" = `expected − observed` while collecting; once the epoch has proceeded, the
unobserved remainder moves to "Proceeded without (timed out)".

GitHub comment primitives exist in `apps/control-plane-worker/src/github/pr.ts`:
`createPrIssueComment(token, owner, repo, prNumber, body)` and
`updateIssueComment(token, commentId, body)`.

Loop safety: webhook ingestion ignores Cycloid's own actor via
`ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET`, so editing our own comment won't re-trigger the
loop. The "no actionable items" preface is belt-and-suspenders and signals other bots to
ignore it.

## Architecture

### 1. Data model — migration `0118_pr_review_status_comments.sql`

Per-PR comment that survives across waves (each wave is a new epoch row), keyed by the
wave-stable part of the epoch key: `(session_id, pr_url)`.

```sql
CREATE TABLE pr_review_status_comments (
  session_id            TEXT    NOT NULL,
  pr_url                TEXT    NOT NULL,
  owner_user_id         INTEGER NOT NULL,
  repo_owner            TEXT    NOT NULL,
  repo_name             TEXT    NOT NULL,
  pr_number             INTEGER NOT NULL,
  github_comment_id     INTEGER,            -- null until first posted
  last_rendered_body_hash TEXT,             -- skip no-op GitHub edits
  posting_lease_until   INTEGER,            -- guards concurrent first-post and edit (epoch ms)
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (session_id, pr_url)
);
```

Append-only migration, raw prepared statements in a DAO module, per repo conventions.

### 2. Module — `apps/control-plane-worker/src/services/review-loop-status-comment.ts`

**`renderReviewLoopStatusComment(input)` — pure function.**
Input: `{ expectedBots, observedBotKeys, status, headSha, blockedReason?, sessionId?, prNumber? }`.
Output: `{ body, bodyHash }` (hash via existing `computeSha256Hex`). No I/O, no clock —
fully unit-testable. Bot labels via the shared helper below.

Status → headline mapping:

| Status                                                           | Headline                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `collecting` (some waiting)                                      | Watching for reviews on `<sha>`. I'll address feedback once the reviewers below weigh in. |
| `ready` / `reserving` / `enqueued` / `processing` / `publishing` | All reviewers in — addressing feedback on `<sha>`…                                        |
| `ready` via fallback (timed-out non-empty)                       | Proceeding on `<sha>` — addressing the reviews that arrived.                              |
| `waiting_for_owner`                                              | Waiting on repo-owner approval before responding.                                         |
| `completed`                                                      | Done — addressed this round of reviews on `<sha>`.                                        |
| `blocked`                                                        | Friendly copy from `describeReviewLoopBlockedReason(blockedReason)` (never raw code).     |

Body groups (only when non-empty): **✅ Reviewed**, **⏳ Waiting on**,
**⏭️ Proceeded without (timed out)**. Always prefixed with the preface line; ends with the
fallback-window hint while still collecting.

Example (collecting):

```
> 🤖 **Cycloid review status** — _No actionable items in this comment; informational only._

Watching for reviews on `a1b2c3d`. I'll address feedback once the reviewers below weigh in.

**✅ Reviewed**
- Greptile
- CodeRabbit

**⏳ Waiting on**
- Cursor Bugbot
- @my-custom-bot

<sub>Auto-proceeds ~10 min after the first review if a reviewer stays quiet.</sub>
```

**`syncReviewLoopStatusComment(env, { sessionId, prUrl, repoOwner, repoName, prNumber, nowMs, logger, tokenHint?, sessionOverride?, capabilityBlockedOverride?, botNoShowOverride? })` — orchestration.**
Best-effort: wraps everything in try/catch, logs a warning on failure, never throws (must
not break webhook ingestion, publish, or the sweep).

Steps:

1. Load session state (or reuse caller-provided `sessionOverride`). Resolve `installationId`, `ownerUserId`, `repoOwner/Name`.
2. Load the latest epoch for the PR (new DAO query: latest by `session_id + pr_url`,
   ordered by `created_at DESC, wave DESC` — a new commit opens a fresh wave-1 epoch, so
   recency, not wave, identifies the current head). If none, fall back to the resolved
   checklist (`resolveReviewLoopChecklist`) with empty observed — the start-of-watching state.
3. If the checklist is not OK / empty **and** no existing comment row → skip (post nothing).
4. Render → `{ body, bodyHash }`.
5. `INSERT OR IGNORE` the comment row.
6. If `github_comment_id` present **and** `last_rendered_body_hash === bodyHash` → skip
   (no token, no GitHub call). The common redundant-webhook case.
7. Resolve token: `tokenHint ?? createInstallationToken(env, installationId)`.
8. **Create path** (`github_comment_id` is null): CAS-claim `posting_lease_until`
   (`UPDATE … SET posting_lease_until=? WHERE github_comment_id IS NULL AND (posting_lease_until IS NULL OR posting_lease_until < ?)`).
   Loser → skip (a later sync edits it). Winner → `createPrIssueComment`, then persist
   `github_comment_id`, `last_rendered_body_hash`, clear the lease. Creation requires
   active review listening; editing does not (so the terminal "Done" edit still lands
   after listening flips off).
9. **Edit path** (`github_comment_id` is present): CAS-claim `posting_lease_until`
   (edit lease: `UPDATE … SET posting_lease_until=? WHERE github_comment_id IS NOT NULL AND (posting_lease_until IS NULL OR posting_lease_until < ?)`).
   Loser → skip (a later sync retries). Winner → re-read the row under the lease, then
   `updateIssueComment`. On no-op (hash already matches) → release the lease. On 404
   (comment deleted) → clear `github_comment_id` (ownership-guarded on `leaseUntil`) and
   fall through to the create path. On transient error → release the lease before surfacing.
   Persist `last_rendered_body_hash` (also ownership-guarded on `leaseUntil`, releases the
   lease in the same write). The lease and persist are both CAS-guarded on `leaseUntil` so
   a holder whose GitHub round-trip overran the lease window cannot clobber a successor's
   freshly-claimed lease or hash.

Concurrency: both creation and editing are lease-serialized. The create lease and edit
lease are mutually exclusive (create claims only when `github_comment_id IS NULL`, edit
claims only when `github_comment_id IS NOT NULL`), so at most one sync can hold a lease
for a given row. This prevents concurrent webhook + sweep edits from landing their GitHub
edits out of order from their DB writes, which could strand the comment on a stale body
whose stored hash still matches (silencing the hash-deduped heal).

### 3. Bot label helper — `shared/constants/pr-review-bots.ts`

```ts
export function prReviewBotKeyLabel(key: string): string {
  // "known:<id>" -> PR_REVIEW_BOT_LABELS[id]; "custom:<login>" -> "@<login>"
}
```

Reuses existing `PR_REVIEW_BOT_LABELS`. Used by the renderer for expected and observed keys.

## Call sites (one helper, three triggers)

1. **Initial post** — `enterReviewListeningIfEligible` in
   `apps/control-plane-worker/src/session/publish-service.ts` (~line 1309). Already
   resolves the checklist and runs exactly when watching begins. Call
   `syncReviewLoopStatusComment` best-effort after `enterReviewListening`, passing the
   already-resolved installation token as `tokenHint`.

2. **Live edits** — the five `ingestReviewLoop*Webhook` functions in
   `review-loop-epochs.ts` (review submission, review comment, PR issue comment, check
   run, commit status). After `upsertReviewLoopEpochActivity` returns the epoch, call the
   helper. Each has `input.env`.

3. **Backup + terminal states** — the sweep in
   `apps/control-plane-worker/src/services/review-loop-sweep.ts`: in the collecting
   reconcile pass and after `processEpoch`. Catches comments missed by a failed webhook
   edit and reflects transitions outside webhooks (responding → done → blocked).

## Edge cases

- **No epoch yet at watch-start** → render from the resolved checklist, all bots waiting.
- **No bots configured / loop disabled** → post nothing (guarded in step 3).
- **New commit (new wave)** → new epoch; helper renders from the latest epoch and edits
  the same comment, re-titled to the new SHA with lists reset.
- **Fallback timeout** → quiet bots move to "Proceeded without (timed out)".
- **No-show (zero signals)** → if no bot/human epoch exists for the head and the collection window has elapsed, render "No reviews arrived... proceeding without" instead of the open-ended "Waiting on" state. A later real review still creates an epoch via webhook and reverses this.
- **Comment manually deleted** → 404 on edit → recreate.
- **Listening turned off after completion** → edit still allowed when a row exists, so the
  terminal "Done" state lands.
- **Redundant webhooks** → body-hash guard skips the GitHub call entirely.

## Testing

- **Renderer (unit)** — every status: collecting (partial), all-observed/responding,
  fallback-timeout, completed, blocked, `waiting_for_owner`; known + custom bot labels;
  empty-checklist guard; body-hash stability for identical state.
- **Sync (integration, fake GitHub client + D1)** — create → edit → no-op-skip (hash) →
  404-recreate; concurrent-create lease yields exactly one comment; concurrent-edit lease
  serializes overlapping syncs; edit lease released on no-op, transient error, and token
  fetch failure; skip when no checklist and no existing row; edit allowed with listening
  inactive but a row present.
- **DAO (unit)** — insert-or-ignore, latest-epoch-for-PR query, create/edit lease CAS,
  lease release, hash/comment-id persistence (ownership-guarded on `leaseUntil`), lapsed
  holder does not clobber successor's reclaimed lease.

## Out of scope

- No new UI surface (GitHub-side artifact).
- No new user setting.
- No change to epoch state machine or loop-trigger logic.
