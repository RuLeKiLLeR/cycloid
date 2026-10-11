# Review-loop check_run terminal-signal ingestion

## Problem

The review-loop epoch state machine moves a session from `collecting` to `ready` once every expected bot has emitted a _terminal_ signal. Terminal signals are currently observed from three webhook events:

- `pull_request_review` (submitted) — review_submission
- `pull_request_review_comment` (created) — non-terminal activity only
- `issue_comment` on a PR — issue_comment_final for bots that summarise via PR comments

The bot capability table at `apps/control-plane-worker/src/github/pr-review-bots.ts` already enumerates additional terminal signals — `check_run` and `commit_status` — but the webhook router never ingests those events. On PR #3513 the epoch waited for the 10-minute fallback even though Cursor BugBot's GitHub check had completed in seconds.

This spec adds ingestion for the `check_run` half of that gap. `commit_status` is deferred.

## Scope

In scope:

- Recognise GitHub `check_run` webhook events whose sender matches a configured known bot's `actorAliases` and whose capability lists `check_run` as a terminal signal.
- Promote the epoch from `collecting` to `ready` without changing any other epoch invariant.

Out of scope:

- `commit_status` ingestion. Status payloads include no PR URL; routing would require a GitHub API lookup or a new head-SHA-indexed webhook ref. Deferred to a follow-up.
- Editing any bot's capability config (e.g., adding `check_run` to Strix); Strix benefits when its config is updated separately.
- Parsing check_run output bodies into the worklist — this change is about waiting, not content.

## Background: how `check_run` differs from `commit_status`

Both render in the PR's "Checks" panel but flow through different webhook events:

| Event       | PR linkage in payload                                            | Identifier                           |
| ----------- | ---------------------------------------------------------------- | ------------------------------------ |
| `check_run` | `payload.check_run.pull_requests[]` with `number` and `head.sha` | `check_run.app.slug`, `sender.login` |
| `status`    | none (only `sha`, `branches`)                                    | `context`, `sender.login`            |

`check_run` carries the PR list inline, so we can route by existing PR-URL webhook refs without a new index.

## Design

### Ingestion service

In `apps/control-plane-worker/src/github/pr-review-bots.ts`:

1. The `matchReviewLoopBot` function's `PrReviewBotMatchSignal` type includes `"check_run"`. For known bots, `matchReviewLoopBot` requires `capability.terminalSignals.includes(signal)` for terminal signals; custom bots are never matchable via `check_run`/`commit_status`/`issue_comment_final` (custom bots don't post checks or PR-comment summaries).
2. Add `ingestReviewLoopCheckRunWebhook(input: ReviewLoopCheckRunWebhookInput): Promise<ReviewLoopWebhookIngestResult>`. Fields:

   ```ts
   interface ReviewLoopCheckRunWebhookInput {
     env: Env;
     deliveryId: string | null;
     sourceId: string; // "check-run:{checkRunId}:{prNumber}"
     checkRunId: number;
     checkRunName: string | null; // logged only
     checkRunStatus: string; // "completed" expected
     checkRunConclusion: string | null;
     actorLogin: string | null;
     actorType: string; // "Bot" / "App" expected
     repoOwner: string;
     repoName: string;
     prNumber: number;
     prUrl: string;
     headSha: string;
   }
   ```

3. Implementation mirrors `ingestReviewLoopPullRequestReviewWebhook` exactly:
   - Look up sessions via `listSessionIdsByWebhookRef(SESSION_WEBHOOK_REF_SOURCE_GITHUB_PR, prUrl)`.
   - For each session: archived/active gate, `reviewListeningPrUrl === prUrl`, head-SHA match (`session.reviewListeningHeadSha === headSha`), checklist resolution, bot match with `signal: "check_run"`.
   - Call `upsertReviewLoopEpochActivity` with `terminal: true` and evidence `{type: "check_run", checkRunId, status: checkRunStatus, conclusion: checkRunConclusion, sourceId, deliveryId}`.
   - Return `{status: "handled", epoch}` or `{status: "ignored", reason}`.

The `statusForObserved` logic already promotes the epoch to `ready` once `observedTerminalBotKeys ⊇ expectedBotKeys`; no state-machine change.

### Webhook router

In `apps/control-plane-worker/src/webhooks/github.ts`:

1. Add `case "check_run"` to `handleGithubWebhook`'s event switch, dispatching to a new `handleCheckRunEvent(payload, rawBody, request, env)`.
2. `handleCheckRunEvent` flow:
   - Skip unless `payload.action === "completed"` (other actions are `created`, `rerequested`, `requested_action`).
   - Parse `check_run.id`, `check_run.status`, `check_run.conclusion`, `check_run.head_sha`, `check_run.name`, `check_run.app.slug`, `check_run.pull_requests[]`, `repository.{owner.login,name}`, `installation.id`, `sender.{login,type}`.
   - Derive the producing-bot identity from `check_run.app.slug` (formatted as `${slug}[bot]`, `actorType = "Bot"`). Fall back to `sender.{login,type}` only when `check_run.app.slug` is absent. Rationale: `sender` is whoever triggered the event (can be a human on a rerequest); `check_run.app` is the bot that produced the check. Capability matching and the cycloid filter need the producing bot.
   - Skip if `check_run.status !== "completed"` (defence in depth — action gate already covers this).
   - Skip if `pull_requests` is missing/empty (push-to-branch checks with no PR association).
   - Skip if the derived actor login is in `ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET` (defence in depth — our own checks must not terminate our own epochs).
   - Claim webhook idempotency once at the delivery level (`claimGithubWebhook`). On duplicate, return the duplicate response.
   - For each `pull_requests[i]` whose `head.sha === check_run.head_sha`:
     - Build `prUrl = https://github.com/{repoOwner}/{repoName}/pull/{pr.number}`.
     - Call `ingestReviewLoopCheckRunWebhook` with `sourceId = "check-run:{checkRunId}:{pr.number}"` and the derived `actorLogin`/`actorType`.
     - Aggregate handled/ignored outcomes.
   - Track entries skipped at the routing layer (missing `pr.number`/`head.sha`, or `pr.head.sha !== check_run.head_sha`) in a `mismatched` counter.
   - Respond with `{ok: true, reviewLoop: true, total, handled, ignored, mismatched, reasons}`. `total = pull_requests.length` so an operator can distinguish routing-level drops (`mismatched`) from service-level ignores (`ignored`, with a non-empty `reasons`).

### Identifier / `sourceId` choice

`sourceId` is the unique key `upsertReviewLoopEpochActivity` uses to deduplicate webhook deliveries. Existing values: `"review:{reviewId}"`, `"review-comment:{commentId}"`, `"issue-comment:{commentId}"`. Use `"check-run:{checkRunId}:{prNumber}"` so a single check_run associated with multiple PRs produces one source id per PR — otherwise the second PR's claim would no-op as a duplicate.

### Conclusions we treat as terminal

Any `check_run` with `action === "completed"` (and thus `status === "completed"`) is terminal, regardless of `conclusion` (`success`, `failure`, `neutral`, `skipped`, `cancelled`, `timed_out`, `stale`, `action_required`). Rationale: the bot has finished its work — what it found is something the worklist would parse later, not something the wait-loop needs to discriminate. Conclusion is stored as evidence for observability.

## Testing

### Unit tests — `tests/test_cloudflare/review-loop-webhook-service.test.ts`

- Terminal check_run for `cursor-bugbot` (capability includes `check_run`) flips epoch to `ready` and records `observedTerminalBots: ["cursor"]`.
- Bot configured without `check_run` (e.g., `chatgpt-codex`) returns `actor_not_configured_bot`; no epoch row inserted.
- Stale-head check_run returns `stale_head`; no epoch row inserted.
- Cycloid-owned sender (`cycloid-dev[bot]`) is filtered upstream in the webhook router; ingest is not called. (Covered in webhook tests.)
- Session without `reviewListeningActive` skipped.

### Unit tests — `tests/test_cloudflare/github-pr-review-webhook.test.ts`

- `action: "completed"` check_run with `pull_requests[]` matching head_sha routes into `ingestReviewLoopCheckRunWebhook` with the correct parsed fields. Response shape includes `reviewLoop: true`.
- `action: "created"` returns `{skipped: true, reason: "unsupported_action"}` without ingest.
- `pull_requests: []` returns `{skipped: true, reason: "no_pull_requests"}` without ingest.
- Sender login in `ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET` returns `{skipped: true, reason: "cycloid_owned_sender"}` without ingest.

### Manual verification

Out of scope for this PR (no QA harness for check_run replay). Observed in staging by replaying a known-bot check_run on a review-listening PR.

## Migration / rollout

- No schema change; the epoch table already accepts arbitrary evidence shapes via `terminal_evidence_json`.
- No new env vars, no Wrangler binding changes.
- The GitHub App must subscribe to the `check_run` event. Subscriptions are managed at the App level; the App is already subscribed for existing customers via the standard manifest, so the change is transparent.

## Risks and follow-ups

- **CodeRabbit and Greptile both list `commit_status` as a terminal signal.** Until status ingestion lands, CodeRabbit's path remains fallback-bound. Tracked in the deferred status-ingestion follow-up.
- **Strix capability config** does not list `check_run`, so Strix's check_run events are correctly classified as `actor_not_configured_bot`. One-line follow-up.
- **Re-run/rerequested checks**: only `action: "completed"` is processed. Reruns generate a fresh `check_run.id` and a fresh `action: "completed"`, so they're covered naturally.
