# Review Loop v1.2 — Design

## Goal

Ship v1.2 of the review-loop ("respond on PRs") feature on top of v1.1: two bug fixes and
two new features. Merge-conflict handling was scoped in and then **cut** (see Out of scope).

All behavior stays behind the existing `users.pr_review_auto_response_enabled` gate and the
installation-capability checks in `resolveReviewLoopChecklist` / `resolveReviewLoopHumanEligibility`.

## Scope

In scope (4 work units):

1. **Bug** — Suppress review-loop follow-up requests in Slack for slack-triggered sessions.
2. **Bug** — Strip the redundant PR header from the follow-up request body.
3. **Feature** — A draft PR (verification skipped/failed) skips review-looping, with a PR comment + a non-alerting skip counter.
4. **Feature** — Failing CI checks trigger the loop until the check-run table is all green/skipped, capped at 3 consecutive CI-fix attempts per change (streak resets on any new external signal).

Out of scope (deferred, must not block this release):

- **Merge-conflict resolution.** Likely "can of worms" (force-resolving another dev's
  behavior change is high-risk). Punted to a future release.
- **`commit_status` ingestion for CI failures.** Legacy commit statuses carry no PR linkage
  in the payload (consistent with the deferral in
  `2026-05-27-review-loop-check-run-ingestion-design.md`). Item 4 covers `check_run` only,
  which GitHub Actions and modern CI emit. Product owner confirmed all target repos' CI
  reports via `check_run`; commit-status CI failures are a follow-up only if a status-only
  integration appears later.

---

## Item 1 — Suppress review-loop follow-up requests in Slack

**Problem.** For a slack-triggered session, each review-loop follow-up prompt's completion
is mirrored into the Slack thread — noise the user did not ask for.

**Seam.** `DurableObject.notifySlackThread(sessionId, promptId, success)`
(`apps/control-plane-worker/src/session/durable-object.ts:8633`), invoked on prompt
finalization from `prompt-queue.ts` (lines ~1111, ~1459, ~1742). The finalized prompt row
carries `review_loop_epoch_id` (`schema.ts:97`), threaded end-to-end from
`enqueueSessionPrompt` (`state.ts:622`) → `prompt-queue.ts` enqueue (line ~533).

**Change.** When the finalized prompt has a non-empty `reviewLoopEpochId`, skip the Slack
thread notification. Gate where the finalized prompt object is in scope at the
`notifySlackThread` call sites; if a call site lacks the flag, `notifySlackThread` loads
the prompt by `promptId` and early-returns on `reviewLoopEpochId`. Log the skip at info
with `{sessionId, promptId, epochId}`.

**Untouched.** `PrWorkflowNotifications.notifySlackPrCreated` / `notifySlackPrMerged`
(`session/pr-notifications.ts`) — final outcomes / PR-ready notifications still post
("inbound follow-up requests only" decision).

**Tests.** Unit: finalized review-loop prompt (with `reviewLoopEpochId`) does not call the
Slack post; a normal prompt does; PR-created/merged notifications fire regardless.

---

## Item 2 — Strip the redundant PR header from the follow-up body

**Problem.** `buildGithubPrReviewLoopPrompt` (`webhooks/prompts.ts:1055`) and
`buildGithubPrReviewLoopHumanPrompt` (`prompts.ts:1091`) emit a 4-line header —
`Repository:`, `GitHub Pull Request: #N`, `PR URL:`, `Head SHA:` — duplicating context the
session already holds.

**Change.**

- Drop `Repository:`, `GitHub Pull Request: #N`, and `PR URL:` from both builders.
- **Keep `Head SHA:`** (anchors which commit the worklist was built against).
- Keep the `[cycloid:review-loop epoch=…]` marker (machine-parsed) and the full worklist
  block — per-item `Source` / `URL` links are the action items.
- Human-path builder: replace the opening
  `"There is unaddressed PR review feedback … on: {prUrl}"` line with a URL-free variant
  (`"There is unaddressed PR review feedback from a human reviewer (and possibly bots)."`);
  keep the `Head SHA:` line.

**Tests.** Snapshot/string assertions on both builders: header lines absent, `Head SHA:`
present, epoch marker present, worklist item URLs present.

---

## Item 3 — Draft PR skips review-looping

**Decision (reversed from the original idea).** A draft means verification was
skipped/failed, so the code is unverified; review-looping on unverified code risks
spiraling. Therefore **any** Cycloid-raised draft PR does **not** enter review-listening.
Record frequency and revisit on **2026-06-05**.

**Seam.** `PublishService.enterReviewListeningIfEligible`
(`session/publish-service.ts:1497`), called after PR creation (lines ~820, ~908). Draft
flag available on the publish path as `options.draft` (and
`verification.publishMode === "draft"`, `publish-service.ts:370`).

**Change.** Thread the `draft` flag into `enterReviewListeningIfEligible`. Order matters:

1. Resolve `resolveReviewLoopChecklist` first (existing). Feature not enabled → return as
   today (no skip comment for users without the feature).
2. Feature enabled **and** draft: do not arm review-listening, do not sync the status
   comment. Instead:
   - Post one PR issue comment: _"Skipping Cycloid review-loop: this PR was opened as a draft
     because verification was skipped or failed. This change needs human attention before automated
     review handling resumes."_
   - Emit the skip counter (below).
   - Return early.
3. Otherwise proceed to `enterReviewListening` as today.

**Telemetry (non-alerting).**

- Datadog **counter** `arcanist.review_loop.skipped_draft` to `https://us5.datadoghq.com`,
  tagged `repo`, `owner_user_id`, `session_id`. Counts once per draft-caused skip.
- Structured log line `review_loop.skipped_draft` with the same fields.
- **No Datadog monitor** on this metric; the name is distinct enough that existing
  catch-all monitors do not match it, so it never reaches the Slack Datadog channel.

**Revisit (2026-06-05).** Chart `sum:arcanist.review_loop.skipped_draft{*}` (by `repo`) in
Datadog us5 over the trailing week. If skips are frequent, reconsider whether drafts
should ever enter the loop. This metric name + query is the single source of truth.

**Tests.** Unit on `enterReviewListeningIfEligible`: feature-enabled + draft ⇒ no
`enterReviewListening` call, skip comment posted once, counter emitted; feature-enabled +
non-draft ⇒ arms as before; feature-disabled + draft ⇒ no comment, no counter (silent return).

---

## Item 4 — Failing CI checks trigger the loop until checks are green

**Problem.** v1.1 ingests `check_run` events only as _terminal wait_ signals for
configured review bots (`ingestReviewLoopCheckRunWebhook`); a CI check from a non-bot app
(GitHub Actions, etc.) is dropped as `actor_not_configured_bot`. Failing CI (tests,
migrations, lint) never drives a fix.

**Scope (confirmed).** Failing terminal `check_run` conclusions — `failure`, `timed_out`,
`action_required` — on the current head SHA of a PR Cycloid is already review-listening
on. Ignore `success`, `skipped`, `neutral`, `cancelled`, `stale`. Producer may be **any**
app, not just configured review bots. `commit_status` deferred (see Out of scope).

**Trigger + ingestion.** Extend `handleCheckRunEvent` (`webhooks/github.ts:1162`): in
addition to the existing bot-terminal path, when a completed `check_run` has a failing
conclusion and routes to a review-listening session whose
`reviewListeningHeadSha === check_run.head_sha`, record a `ci_failure` activity and drive
epoch processing — re-engaging the idle session via the existing
`reengageSessionForReview` path if needed. Failing CI from a non-configured app is allowed
on this branch (gated by review-listening + head-SHA match, not bot config).
Cycloid-owned actors remain filtered.

**Debounce (avoid firing mid-suite).** Before enqueuing a CI-fix epoch, fetch the head
SHA's full check-run list via the GitHub API. Proceed only when no checks are
`queued`/`in_progress`. If checks are still pending, defer and re-evaluate when the next
check completes.

**Worklist + prompt.** A new worklist source renders the head SHA's failing checks (name,
conclusion, `details_url`/logs) as actionable items alongside any bot/human review items.
Prompt: fix the failing checks with the smallest safe diff and push; use the guarded
publish path. Reuse the existing prompt builders, extended to carry CI-failure items.

**No fixed ordering — CI and review work interleave.** Fixing a failing test can change
code a review bot then comments on; addressing a review comment can change code that then
fails CI. An epoch's worklist may mix CI-failure and bot/human review items, and either
event type may trigger an epoch. Do not assume "reviews first, then CI" (or the reverse) —
whatever is actionable on the latest head SHA gets worked.

**Loop.** Agent pushes → head SHA advances → review-listening tracks the new SHA (existing
head-SHA-on-push mechanism) → new checks run → re-evaluate. Terminates when every check on
the latest head SHA is green or skipped: no failing checks ⇒ no CI worklist items ⇒ the
epoch no-ops to completion.

**Self-push guard.** Reuse the existing guard (commit `17cd699b`) so Cycloid's own
response push is awaited for its checks rather than treated as a fresh external signal.

**Attempt cap = 3 per head (streak that resets on any new external signal).** Not PR-wide:
exhausting it must not permanently abandon CI work, because a later head can fail for a
genuinely different reason. Mechanics:

- Maintain a **CI-fix streak** counter for the PR; increment each time a CI-fix epoch (an
  epoch whose worklist includes CI-failure items) is enqueued.
- **Reset the streak to 0 whenever the head advances from a non-CI-fix cause** — a human
  push, or an epoch that included review-comment items (bot or human). (Naive per-git-SHA
  counting is wrong: every Cycloid fix push advances the SHA, so a per-SHA counter would
  give each SHA exactly one attempt and never bound the same failing line failing across
  consecutive fix pushes. The streak bounds that case; the reset honors interleaving.)
- When the streak reaches 3 with CI still red and no intervening external signal, stop
  enqueuing CI-fix epochs and surface via the live status comment: _"CI is still failing
  after 3 automated fix attempts on this change. This PR needs human attention."_ The next
  external signal (new review comment or human push) resets the streak and CI-fixing resumes.

Worked scenario: CI fails at head H1; 3 consecutive failing CI-fix attempts → streak hits
3 → stop + escalate. A review bot then comments; Cycloid fixes it (review item ⇒ streak
resets); the resulting head fails CI for a _different_ reason → Cycloid attempts that
fresh failure rather than blanket-skipping it.

Implementation note: derive the streak from epoch history — count consecutive
`ci_failure`-bearing epochs since the last epoch that carried a review item or the last
human push. No new column.

**Tests.**

- Webhook: failing `check_run` (conclusion `failure`) from a non-bot app on a
  review-listening PR records `ci_failure` and triggers processing; `success`/`skipped` do
  not; non-review-listening PR ignored; stale head SHA ignored; Cycloid-owned actor filtered.
- Debounce: enqueue deferred while a check is `in_progress`; proceeds once all settled.
- Worklist/prompt: failing checks render as items; passing run yields no CI items.
- Attempt cap: 4th consecutive CI-fix attempt is blocked and posts the status-comment
  escalation; an intervening review item (or human push) resets the streak so a fresh CI
  failure is attempted.

---

## Packaging / rollout

One **release branch** `review-loop-v1.2` cut from `main`. Each work unit is its own PR
targeting the release branch, then a single PR `review-loop-v1.2` → `main`.

Landing order (low-risk → high-risk):

1. Item 2 (prompt body strip) — pure prompt text.
2. Item 1 (Slack suppression) — single gate.
3. Item 3 (draft skip + telemetry).
4. Item 4 (CI-failure loop) — riskiest, lands last.

Each PR carries its own tests and local verification per repo conventions. The final
release-branch → `main` PR is the integration checkpoint, merged manually (no auto-merge).
No migrations (Items 1–4 are behavioral; the skip counter and CI-fix attempt count avoid
schema changes). All paths stay behind the existing feature gate.

## Verification

- Unit tests per item (above), via the repo's Vitest suites.
- Item 4 end-to-end (replay a failing `check_run` on a review-listening PR) observed in
  staging / via a Cycloid session per `docs/testing.md`; no QA harness for `check_run`
  replay exists, so staging replay is the path.
