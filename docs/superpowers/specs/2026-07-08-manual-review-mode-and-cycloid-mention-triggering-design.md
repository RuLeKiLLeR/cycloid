# Manual Review Mode + `@cycloid` Mention Triggering — Design

- **Linear:** ARC-1514 (parent), ARC-1513 (business-level scope, deferred)
- **Date:** 2026-07-08
- **Status:** Implemented (manual review mode + @cycloid mention triggering with ARC-1514 fix)

## Summary

Give users control over when Cycloid engages with PR reviews. Today automatic
review handling always arms for capable repos — there is no master toggle
(removed by ARC-1288). This work adds:

1. **Manual review mode** — a per-user, default-OFF setting that makes Cycloid
   ignore reviews and work only CI-to-green. Manual becomes the product default.
2. **`@cycloid` mention triggering** — explicit mentions in a PR pull Cycloid
   into a specific piece of feedback, regardless of the toggle.

Manual mode is the smaller first part; mention triggering is the larger second
part (its own sub-stack).

## Goals

- A default-OFF per-user toggle that disables automatic review handling.
- In manual mode, CI auto-fixing and CI-green → done keep working unchanged.
- In manual mode, Cycloid leaves **no** acknowledgement on reviews (no 👀), does
  not respond to reviewer comments, and does not resolve merge conflicts.
- `@cycloid` mentions trigger work from any PR surface: a top-level PR comment, a
  reply to a specific review comment, and (reachable) a review body.
- A reply-to-comment mention prepends the replied-to comment (+ diff context) and
  sends a **targeted** prompt scoped to that comment.
- Mentions re-engage finished sessions: reuse a warm sandbox if resumable, else
  cold-boot a fresh session bound to the same PR.

## Non-goals

- Business-level default + per-user override — deferred to **ARC-1513**. PR1 ships
  the per-user setting behind a resolver seam so this is a near-zero-migration
  follow-up.
- **Mentions on PRs Cycloid did not author** — deferred to **ARC-1515**. Mention
  triggering here is scoped to **Cycloid-owned PRs** (those with a bound session
  via `session_webhook_refs` `github_pr_url` / `pr_coordination`, registered at PR
  publish). A mention on a human-authored PR with no bound session is out of scope
  (no session is spun up / bound to an arbitrary PR).
- Changing the QA verifier (`auto_verify`) axis — it stays independent.
- Changing CI-fix behavior or the path to `MERGE_READY`.

## Decisions

| Question | Decision |
| --- | --- |
| Default | Manual mode is the **default for everyone** (`automatic_reviews_enabled` default OFF). |
| Scope | **Per-user** in PR1, read through a `resolveAutomaticReviewsEnabled()` seam. Business default + override → ARC-1513. |
| Read timing | **Live-read** at gate time (matches "flip off pauses the loop"; not snapshot). |
| CI in manual mode | **Stays automatic.** Manual suppresses reviews only; CI-green → done unchanged. |
| Merge-conflict resolution | **OFF** in manual mode (reviewer-side work). |
| QA verifier | **Independent** (untouched `auto_verify` axis). |
| Mentions vs toggle | Mentions **always work**, bypassing the toggle (explicit invocation). |
| Re-engage finished sessions | **Reuse warm sandbox if resumable (≤~72h), else cold-boot** a fresh PR-bound session. |

## Background: how the review loop works today (the load-bearing finding)

The CI-fix arm and the reviewer-handling arm are **already cleanly separated** in
the FSM:

- `MERGE_READY` (done) has exactly one entering edge: `ci_green ∧ no_inflight_epoch`
  (the `REVIEW.caught_up` cascade rung). `cycloidDone` is `state === MERGE_READY`
  (`session/fsm/project.ts`).
- `caughtUp = noInflightEpoch ∧ store.countUndispositionedActionable() === 0`
  (`session/fsm/guards.ts:211`). The reviewer-settle conjunct was deleted — a
  session **never waits for reviewers to arrive**.
- `resolveReviewLoopCiEligibility` (`services/review-loop-settings.ts:432`) reads
  **only** GitHub install capabilities; it never consults any review setting. The
  green-CI → FSM `ci.signal` path (`services/review-loop-ci-signal.ts`) reads no
  review settings at all.

**Consequence:** reviews only entangle completion by *registering* — a review
epoch sets `in_flight_epoch_id`, and its registered items count in
`countUndispositionedActionable()`, both of which hold `caught_up` false. So
**manual mode = prevent review epochs/items from ever being created/registered,
while leaving the CI arm untouched.** CI-green → done keeps working for free.

The docs are stale: `docs/review-loop.md` still describes the removed master
toggle ("Respond on PRs from your sessions") and a per-repo "fix red CI" toggle;
`settings/db.ts` confirms `pr_review_auto_response_enabled`, `ci_response_enabled`,
and `review_timeout_minutes` are orphaned columns no code reads.

---

## Part 1 — Manual Mode

### Setting & storage

- New per-user column: `user_settings.automatic_reviews_enabled INTEGER NOT NULL DEFAULT 0`.
- Precedent to mirror end-to-end: `auto_verify_enabled` (added in migration 0227,
  flipped default-off in 0242).
- Do **not** revive the dead `pr_review_auto_response_enabled` column — orphaned
  under append-only discipline and its opt-OUT semantics are inverted from a
  default-OFF opt-IN.
- **Live-read** via a single resolver so all gate call sites read one seam:

```
resolveAutomaticReviewsEnabled({ db, ownerUserId }): Promise<boolean>
  // PR1: return getUserSettings(db, ownerUserId).automatic_reviews_enabled === 1
  // ARC-1513 later: user override ?? business default ?? false — call sites unchanged
```

All review-loop gates key on `ownerUserId`, so the resolver reads
`getUserSettings(db, ownerUserId)` and needs no new plumbing.

### The gate

Thread manual mode into the shared chokepoint,
`services/review-loop-settings.ts`, leaving `resolveReviewLoopCiEligibility`
untouched:

1. **`resolveReviewLoopChecklist`** (`:344`) — return a new **arm-only** failure
   reason `review_handling_disabled` when manual. Propagates to all bot ingest,
   sweep dispatch, sweep worklist rebuild, and publish arming.
2. **`isCodeReviewArmOnlyChecklistFailure`** (`:55`) — classify
   `review_handling_disabled` as arm-only (`return true`) so the CI-fix arm keeps
   running everywhere the sweep checks it (`review-loop-sweep.ts:3024`).
3. **`resolveReviewLoopHumanEligibility`** (`:376`) — not-ok when manual. Closes
   the re-engage path (`review-loop-reengage.ts:178`) and the human/mixed dispatch
   branch.
4. **`resolveReviewLoopMergeConflictEligibility`** (`:398`) — not-ok when manual
   (merge-conflict resolution is reviewer-side; OFF in manual mode).

### The two bypass paths (the failure-class catch)

Two human-review paths **skip the checklist entirely** and must get an explicit
manual-mode check, or human reviews on a live-listening session slip through:

- The `if (input.humanSource)` branch in `ingestReviewLoopPullRequestReviewWebhook`
  (`services/review-loop-epochs.ts:2782`) — folds/creates a human epoch and
  `return`s *before* the `resolveReviewLoopChecklist` call.
- The `isListening` branch in `handlePullRequestReviewEventHumanLoop`
  (`webhooks/github.ts:2671`) — calls the `humanSource` ingest directly; only the
  else-branch (`reengageSessionForReview`) is gated.

This is the "audit equivalent code paths" invariant: the single gate is necessary
but not sufficient.

### 👀 suppression falls out for free

The eyes review-ack reaction (`webhooks/review-ack-reaction.ts`) is only scheduled
when review-loop ingest returns `status === "handled"`. In manual mode the gate
makes ingest return `ignored`, so the ack is never scheduled. **No special-casing
needed** — but the manual-mode tests must assert it (regression guard against a
future direct-ack call site).

### What stays on in manual mode

- CI-fix arm (`resolveReviewLoopCiEligibility` untouched).
- CI-green → `MERGE_READY`.
- The at-publish QA verifier spawn (separate `auto_verify` axis).
- The session still enters `review_listening` at publish — required for CI ingest
  and re-engage. Manual mode does **not** hook `reviewVerificationExemptReason` /
  publish arming (`publish-service.ts`), which would disarm CI too.
- Whether allow-listed reviewer comments still fire the internal Slack
  human-action alert DM (`dispatchHumanGithubPrActionAlert`): **yes** — the alert
  is an internal ops signal, not PR-visible; keep it, just don't act on the PR.

### Migration

- Isolated bottom-of-stack PR (CI forbids mixing migration + dependent code).
- Additive: `ALTER TABLE user_settings ADD COLUMN automatic_reviews_enabled INTEGER NOT NULL DEFAULT 0`.
- Run `npx vitest run tests/test_cloudflare/migration-integrity.test.ts`, commit the lock with the migration.
- Pick the migration number vs `origin/main` (not a stale checkout).

### Settings plumbing (mirror `auto_verify_enabled`)

- DAO: `settings/db.ts` (`UserSettingsRow`, `USER_SETTINGS_COLUMNS`, upsert in
  `updateUserSettings`).
- Service: `settings/service.ts` (`mapSettingsResponse`, `updateSettingsPayload`).
- Route: `settings/routes.ts` (`handlePutSettings` boolean validation + forward).
- Bootstrap echo: `services/bootstrap.ts` (`resolveBootstrapSettings`) +
  `shared/types/bootstrap.ts`.
- UI: `apps/ui/src/types.ts` + a `SettingsRow`/`<Toggle>` in
  `apps/ui/src/components/settings/GeneralSettings.tsx`. Copy label style is
  "Off by default"; framing is opt-IN to automatic review handling.

### Docs

Reconcile `docs/review-loop.md` in the same PR: remove the stale removed-toggle
description and document the new `automatic_reviews_enabled` semantics.

### Tests (Part 1)

- Resolver returns false by default, true when set.
- Each gate returns the arm-only / not-ok result under manual mode; CI eligibility
  is unaffected.
- The two human-bypass paths do not register a review epoch/item under manual mode.
- CI-green still reaches `MERGE_READY` with reviews present but manual on.
- Eyes reaction not scheduled when manual (ingest returns `ignored`).
- DAO/service/route round-trip for the new boolean.

---

## Part 2 — `@cycloid` Mention Triggering

### Trigger surfaces & what exists today

- Mention detector exists: `extractPromptFromIssueComment` (`webhooks/github.ts:203`),
  regex `@${appSlug}` case-insensitive (`:209`); `appSlug` = the installed app
  login (prod `cycloid`). Prompt = text after the match.
- **Top-level PR comment** (`issue_comment`): handler branches into a `qa=true`
  path and an unconditional review-loop ingest. A plain `@cycloid work on X` on a
  PR currently does **nothing actionable** — free-text dispatch only runs for
  non-PR issues.
- **Reply to a review comment** (`pull_request_review_comment`): handler exists
  (`handlePullRequestReviewCommentEvent`, `:2300`) but parses only
  `id/pull_request_review_id/body/commit_id/user` — it **drops** `in_reply_to_id`,
  `diff_hunk`, `path`. No mention check, no auth (bot-only path). The dropped
  fields **are** in the payload and already normalized by the passive audit tap
  (`webhooks/pr-activity-capture.ts:207-224`). The parent comment **body** is not
  on the reply payload — needs a `GET /pulls/comments/{in_reply_to_id}` fetch.
- **Review body** (`pull_request_review` submitted): reachable; a human review body
  is already folded into the epoch as an instruction, but with no mention/intent
  parse.
- PR → session mapping: `listSessionIdsByWebhookRef(DB, "github_pr_url", prUrl)`
  over `session_webhook_refs` (returns an array; can map multiple sessions).
  `getTrackingSessionIdForPrUrl` (`pr_coordination`) is the single FSM tracking
  session — use it to pick when multiple map.
- Enqueue primitive: `enqueueSessionPrompt` (`session/state.ts:977`) with a
  `replyToText` option.

### The `mention` epoch source-kind & prompt builders

Route mention triggers through a **new `mention` epoch source-kind** rather than a
raw enqueue. This reuses, for free: transcript safety, tool-gating, threaded
replies, dedupe, and the stopped-session cold-resume waiver.

Add prompt builders in `webhooks/prompts.ts`:

- **Targeted single-comment** — modeled on `buildGithubIssuePrompt`'s
  `Triggering comment:` prepend (`:1291`), NOT the whole-worklist builders. Scopes
  to one comment + its replied-to parent + diff hunk.
- **Free-text directive** — for top-level `@cycloid work on X`. "Resolve all
  reviews" is free text that triggers a full-worklist directive (reusing the
  existing worklist path on demand).

Add matching `buildReviewLoopHumanSummary` cases and a `reviewLoopSourceKind`
metadata value that decides which bridge tools unlock (`review_summary_comment`,
`review_loop_reply`).

Single-comment scoping requires bypassing the whole-head worklist rebuild: either a
new `getPrReviewLoopWorklist` (`github/pr.ts:2506`) option that hard-restricts
`items` to one `sourceId` (+ its parent), or hand-build a one-item prompt.

### Delivery & transcript safety (invariant)

- Delivery: `enqueueSessionPrompt` → DO `promptsEnqueue` →
  `handlePromptEnqueueRequest`. Terminal guards: archived → 409; blocked/failed/
  finalizing → 409; then `validatePromptEnqueueResumeState`.
- **Cold-resume waiver:** the stopped-session cold-resume waiver
  (`prompt-queue.ts` `validatePromptEnqueueResumeState:323`) is keyed on
  `reviewLoopEpochId` being present. Routing mentions through a `mention` epoch
  keeps the waiver; a raw non-epoch enqueue would be **rejected** on a stopped
  session.
- **Transcript-safety invariant (PR #7109/#7110):** the agent prompt string carries
  the `[cycloid:review-loop epoch=…]` scaffolding marker; the human-facing
  transcript is a *parallel* clean build passed as `replyToText`. Any new builder
  must keep the marker on the agent prompt AND supply a scaffolding-free
  `replyToText`, or `derivePromptDisplayText` / `safeDisplayPrompt`
  (`shared/transcript/prompt-display.ts`) fail closed to the raw prompt. Never
  forget `replyToText` — it defaults to the raw prompt.

### Re-engagement (warm-else-cold-boot)

- Sandbox lifecycle: live-idle ≤15 min → paused/resumable ~72h
  (`E2B_RUNTIME_RETENTION_HOURS`) → terminated. `isRuntimeGone` /
  `isSessionRuntimeLive` (`review-loop-reengage.ts:110-135`) already encode the
  reuse-vs-cold-boot read.
- `reengageSessionForReview` (`review-loop-reengage.ts:155`) already does
  unarchive → warm-if-resumable-else-cold-boot → re-park, but review-scoped.
  **Generalize** its scaffold into a shared "ensure session live for PR" helper
  used by both review re-engage and mentions, dropping the review-specific
  eligibility gates for the mention path (a mention is a task, not a review).
- A cold-booted fresh session must register the `github_pr_url` webhook ref
  (`session_webhook_refs`) to receive future CI/review webhooks for the same PR,
  and check out the PR head.

### Auth & loop safety

- Reuse `resolveGithubIssueCommentActor` / `authorizeGithubIssueCommentActor`
  (`webhooks/github.ts:689/:744`) for actor → Cycloid-user resolution + repo
  access. The reply-to-comment handler has **no** auth today — it must be added.
- Loop safety: `senderType !== "User"` skip, `senderLogin === appSlug`
  self-trigger skip, `ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET` fence
  (`github/pr-review-bots.ts`). Applies to every new mention branch so Cycloid
  never triggers on its own comments.

### Tests (Part 2)

- Mention detection on each surface; owned/bot/self skips.
- Reply case: dropped fields parsed; parent fetched; targeted prompt prepends
  parent + hunk; auth enforced.
- Re-engage: warm reuse when resumable; cold-boot + webhook-ref registration when
  runtime gone; archived session unarchived.
- Delivery: mention epoch keeps the cold-resume waiver on a stopped session; clean
  `replyToText` supplied (transcript never shows scaffolding).
- Mentions fire regardless of the manual/auto toggle.

---

## PR stack (Graphite)

Bottom → top. Part 2 boundaries finalized in the implementation plan.

1. **Migration** (isolated): add `automatic_reviews_enabled` column + lock.
2. **Manual-mode behavior**: resolver + gates (checklist arm-only, human, merge-
   conflict) + the two human-bypass plugs + settings plumbing + UI toggle + docs +
   tests. (👀 suppression verified.)
3. **`mention` epoch source-kind + builders**: targeted single-comment + free-text
   directive builders, human-summary cases, transcript-safety, cold-resume waiver.
4. **Top-level `@cycloid …` on a PR**: resolve tracking session, enqueue via
   mention epoch. ("work on X", "resolve all reviews".)
5. **Reply-to-review-comment**: parse dropped fields, mention-gate, fetch parent,
   targeted prompt, add auth.
6. **Re-engage finished/archived sessions**: generalize the reengage scaffold,
   register the PR webhook ref.

## Invariants & landmines

- **CI must never be gated by manual mode** — only the review arms. Do not hook
  publish arming / `reviewVerificationExemptReason`.
- **The two checklist-bypassing human paths must be plugged explicitly.**
- **Transcript safety**: keep the `[cycloid:review-loop]` marker on the agent
  prompt and always pass a clean `replyToText`.
- **Cold-resume waiver** rides on `reviewLoopEpochId` — mentions must carry an
  epoch id to reach a stopped session.
- **Migration isolation** at the bottom of the stack; number vs `origin/main`.
- **Resolver seam** is the contract that makes ARC-1513 (business default +
  override) a resolver-internal change with no call-site churn.
- Stacked PRs get bots-only CI until on main — run vitest locally per branch.

## Follow-ups

- **ARC-1513** — business-level default + per-user override (resolver-internal).
