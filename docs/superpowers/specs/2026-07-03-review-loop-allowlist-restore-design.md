# Review-loop bot ingest: allow-list restore

**Date:** 2026-07-03
**Status:** Approved (design), pending implementation
**Owner:** Jag
**Fixes:** review loop ingesting `linear[bot]` linkback comments as actionable reviewer feedback (prod exhibit PR #6652, session `e1258f07`)
**Regression source:** `830d13572` / PR #6558 (ARC-1330 Phase B, 2026-07-03) — the "D3 bot-ingest gate" that was flagged pending sign-off.

## Problem

After #6558, the review loop ingests a PR comment/review from **any** GitHub App `[bot]` account that isn't Cycloid-owned. A `linear[bot]` "linkback" comment (pure ticket-summary metadata, marker `<!-- linear-linkback -->`) is therefore minted into a review epoch, triaged by an agent, and answered with a verdict-reply (`🤖 Cycloid review status — No actionable items… informational only`). Pure metadata gets looped on.

This is a **failure class**, not one bot. The same `resolveIngestBotKey` fallback backs all three content-ingest paths (review submission, inline review comment, issue comment) plus the worklist builder, so every non-review App that comments on a session-bearing PR is admitted: `github-actions[bot]`, `graphite-app[bot]` (fires on our own gt-stack PRs), `codecov`, `vercel`, `netlify`, `cloudflare-workers-and-pages`, `changeset-bot`, `sentry`, `dependabot`/`renovate`, etc. Confirmed recurring on PRs #6654/6653/6652/6651.

### Root cause (traced)

`webhooks/github.ts` passes the comment author (`linear[bot]`, `type:"Bot"`) into `ingestReviewLoopPrIssueCommentWebhook` → `resolveIngestBotKey({signal:"activity"})` (`github/pr-review-bots.ts:155`). `matchReviewLoopBot` returns null (not on the allowlist), then the D3 fallback admits any Bot/App that isn't Cycloid-owned, returning `custom:linear`. The epoch is minted; the noise gate (`classifyReviewLoopNoise`) can't help — it only classifies **known** review bots and fails open for any `custom:` key.

Pre-#6558 this path used allowlist-only `matchReviewLoopBot`, so `linear[bot]` was correctly dropped as `actor_not_configured_bot`.

## Decision

A **deny-list** of non-review bots would work but has an unbounded maintenance surface — every new customer CI/deploy/status bot must be chased. **Invert to an allow-list instead**: reviewers are a small, slow-moving set that the product *already* maintains (the known-bot registry + per-repo user-configured reviewers). Metadata bots are legion; reviewers are few. Curating the small set is the low-maintenance posture.

Rejected alternatives:
- **Static deny-list** — maintenance treadmill.
- **LLM substance-gate + learned per-repo deny-list** (an adaptive gate-by-actionability, self-populating) — genuinely good if/when the customer bot ecosystem outgrows a curated registry, but over-built for today's known, bounded reality. Filed as a future ticket.

## Design

### Policy

A PR comment/review is ingested into the review loop **only if its author is a recognized reviewer**:
1. a **known review bot** in the curated registry (`PR_REVIEW_BOT_CAPABILITIES`), or
2. a **custom reviewer the user configured** for that repo (`expectedBots`).

Everything else is dropped with existing reason `actor_not_configured_bot`. Cycloid-owned actors remain excluded (unchanged).

**Two independent layers** (do not conflate): the **allow-list** (this fix) answers *"is this actor a reviewer at all?"* — `linear`/CI/metadata bots are not, so they're dropped. The **noise gate** (`classifyReviewLoopNoise`, D4, unchanged) answers *"did a known reviewer post a no-op?"* — e.g. Strix "No security issues found" is gated `no_findings`. A reviewer with a real finding passes both and is looped on. The noise gate only fires on `known:<id>` keys — which is why the change below keys unconfigured-but-known reviewers as `known:<id>`, not `custom:`, so their no-findings output is still gated (today's D3 keys them `custom:` and the gate fails open on them).

### The change (single chokepoint)

`resolveIngestBotKey` (`apps/control-plane-worker/src/github/pr-review-bots.ts`) currently returns `custom:<anyBot>` for any non-owned Bot/App on a content signal. Change the fallback predicate from "any bot" to **"any bot whose normalized login is a known-registry alias"** (`PR_REVIEW_BOT_ACTOR_ALIAS_LOGINS`, already defined). Concretely, after `matchReviewLoopBot` misses:

- keep the existing guards (`UNLISTED_INGEST_SIGNALS` membership, `isBotOrAppAuthor`, not `ARCANIST_OWNED`);
- **add**: if the normalized actor is not in `PR_REVIEW_BOT_ACTOR_ALIAS_LOGINS`, return `null` (drop);
- a known-registry bot the repo did **not** configure is still admitted but **respond-only** — return `{ key: "known:<id>", configured: false }` (resolve alias→id). `configured:false` keeps it out of the no-show latch; `known:<id>` (vs `custom:`) lets the noise gate act on its no-findings output.

One predicate change; it propagates to every caller because all three webhook ingest fns (`review-loop-epochs.ts:2719/2825/2924`) and the worklist builders (`github/pr.ts:2017/2239`) funnel through `resolveIngestBotKey`. The QA/verification-intake path is **not** affected — it already uses allowlist-only `matchReviewLoopBot` (`pr.ts:2232`).

### Copilot seeding

Add `copilot` to the curated registry so a genuine unlisted reviewer is caught by default:
- `shared/constants/pr-review-bots.ts`: add `"copilot"` to `PR_REVIEW_BOT_IDS` + a `PR_REVIEW_BOT_LABELS` entry ("Copilot"). It becomes selectable in Settings.
- `apps/control-plane-worker/src/github/pr-review-bots.ts`: add a `PR_REVIEW_BOT_CAPABILITIES.copilot` entry.
- **Verify during implementation** (do not hardcode blind): Copilot's exact PR-review author login (expected `copilot-pull-request-reviewer[bot]`) and posting signal (expected `review_submission`) against a real Copilot review. `reviewCapable: true`, `terminalSignals: ["review_submission"]` pending that check.

### Cycloid-owned bots stay excluded (do NOT add them)

QA/verifier verdicts reach the loop via the **FSM spine**, not comment ingest: the verifier result becomes a `verification.pass`/`verification.app_breaks` event (`session/fsm/verification-event.ts`), is stored as `session.verificationResult`, and the loop **synthesizes** its needs-work worklist item from that stored verdict (`buildVerificationVerdictWorklistItem`, `github/pr.ts:2482`). The managed QA GitHub comment was deleted in ARC-1330 D-50A. `cycloid-qa[bot]` is already in `ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET` (dropped by ingest) and QA still works — proof the exclusion is correct. Adding `cycloid[bot]`/`cycloid-dev[bot]`/`cycloid-qa[bot]` to the allow-list would make the loop ingest its **own** verdict-replies and status comments (self-loop) — the exact class of bug being fixed, recursively.

### No-show latch: unchanged

The first-contact no-show latch arms only on the repo's configured `expectedBots` (`session/fsm/reviewer-arm-producer.ts:173`), so a drive-by/unconfigured reviewer never causes the loop to wait.

## Observability + debugging signpost

This gate is now the deliberate decision point for *which reviewers get addressed*, so "reviewer X's review isn't being handled" must lead here.

- **Telemetry breadcrumb:** the drop already emits ingest-outcome `ignored: actor_not_configured_bot`, but the event carries no actor login (`observability/review-loop-events.ts`). Add the dropped **`actor_login`** to that structured event/log so a specific missing reviewer is diagnosable ("dropped `X` — not a recognized reviewer"). Bounded/observe-only; no new metric plumbing required beyond the added field.
- **`docs/review-loop.md`:** rewrite the "responds to every comment?" FAQ to state the allow-list precisely and name the gate (`resolveIngestBotKey` + `PR_REVIEW_BOT_CAPABILITIES`).
- **`docs/debugging-runbook.md`:** new symptom→code entry — *"A reviewer's review isn't picked up by the loop → allow-list admission drops any actor that isn't a known-registry review bot or a user-configured custom reviewer. Check (a) registry, (b) repo's configured reviewers, (c) ingest-outcome `ignored: actor_not_configured_bot` (now carries `actor_login`). NOTE: QA/verifier verdicts flow via the FSM `verification.*` spine + stored verdict, NOT this allow-list — don't look here for missing QA feedback."*
- **Code comment** at the fix site: allow-list rationale + the #6558 regression it fixes.

## Error handling / fail-safety

- **Fail-toward-dropping-non-reviewers, not real feedback.** The allow-list can only ever drop an actor that is neither a known reviewer nor user-configured. A genuine reviewer the user forgot to configure and that isn't in the registry (rare) is droppable — mitigated by seeding Copilot and by the actor-login breadcrumb surfacing "a review-shaped drop we didn't recognize."
- No new external calls, no new failure modes, no fallback path that could throw.

## Testing

- **Unit** (`tests/test_cloudflare/pr-review-bots-owned-actors.test.ts`): `linear[bot]`/`github-actions[bot]` → `null`; a configured custom login → `{configured:true}`; an **un**configured known reviewer (Copilot) → `{key:"known:copilot", configured:false}`; a configured known bot still `{configured:true}`.
- **Service** (`tests/test_cloudflare/review-loop-webhook-service.test.ts`): a `linear[bot]` issue comment → `ignored: actor_not_configured_bot`, **0 rows** in `pr_review_response_epochs`; a Copilot review → handled.
- **Copilot registry** (`shared` parity + capability test): new id present in IDs/labels/capabilities; parity test green.
- **Two-layer regression** (`tests/test_cloudflare/review-loop-noise-gate.test.ts` already covers the real Strix footer; add/confirm): an unconfigured-but-known Strix "No security issues found" resolves to `known:strix` and is noise-gated `no_findings` — verifying the allow-list keys unconfigured-known reviewers as `known:<id>` so the noise gate still catches their no-ops (a `custom:` key would fail open). Verified against the real PR #6652 Strix body (`known:strix` → gated; `custom:strix-security` → not gated).

## Sequencing (implementation plan will finalize)

Small Graphite stack of atomic PRs:
1. Allow-list gate in `resolveIngestBotKey` + `actor_login` breadcrumb + tests. **Stops the prod bleeding on its own.**
2. Copilot registry seed (shared IDs/labels + capability + aliases) + tests.
3. Docs: `review-loop.md` FAQ + `debugging-runbook.md` signpost + code comment.

## Out of scope / future

- **Adaptive LLM substance-gate + learned per-repo deny-list** (ARC-####, to file): gate unlisted-bot content by actionability, auto-populate a business+repo-scoped skip cache with a re-probe/TTL so a bot that changes behavior isn't dropped forever. Revisit if/when curated-registry maintenance becomes a real burden across many customer repos.
