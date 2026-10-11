# Session-creation entry points

Every way Cycloid can create a session, and the rule that keeps them in sync:
**when you change session-creation behavior in one place, you almost always have to change it in all of them.** This doc is the checklist so a future agent does not add a field to `POST /api/sessions` and silently break the Jira webhook, the scheduler, or automatic QA testing.

## First-class PR takeover

The web UI and CLI can deliberately continue an existing same-repository pull request by sending continuePrUrl with continueMode: "update-pr" to POST /api/sessions.

The control plane fetches and validates the PR before initialization.
It requires an open, non-fork PR with a safe head ref, and rejects supplied startBranch or baseBranch values that do not match the PR.

The resolved PR head becomes the session's startBranch, and adoptedExternalPr makes the sandbox check out that branch strictly.
Publish updates the existing PR, preserves its title, body, labels, and draft state, and never opens a second PR.

Takeover creation returns stable error codes for invalid URLs, closed or fork PRs, unsafe or mismatched branches, GitHub fetch failures, and pr_takeover_conflict when another non-terminal session already coordinates the PR.
The conflict response includes the existing session id and, when configured, its public session URL.

## The one chokepoint

All session creation funnels through a single function:

`createSessionState(env, sessionId, ownerUserId, options)` -- `apps/control-plane-worker/src/session/state.ts:534`

Structural, not a convention you can opt out of. Cross-cutting concerns live here so no caller can forget them:

- business-ownership resolution (`businessId` from `ownerUserId`, fail-closed)
- model -> agent-runtime-backend derivation and session-start model validation
- provider-credential gate (`assertEffectiveProviderCredentialForModel`)
- the Slack-thread single-session claim (idempotent, fail-closed)

There are **no raw `INSERT INTO session_index` paths** that bypass this. A new way to start a session MUST go through `createSessionState`. Do not write a direct DB insert.

## The two-stage shape

Creating a usable session is two steps:

1. **Initialize** -- `createSessionState(...)` creates the session state in its Durable Object and returns `{ session, replay }`.
2. **Persist projection** -- write the `session_index` + replay-metadata projection to D1 (and optional webhook-ref row) so the session shows up in listings, the sidebar feed, and webhook dedup.

Two helpers wrap this, both in `apps/control-plane-worker/src/services/session-create.ts`:

- `initializeAndProjectSession(env, input)` (line 121) -- does both stages atomically, throws `SessionCreateError` tagged with the failed stage. **Preferred for new callers** (scheduler/automation use it).
- `persistInitialSessionProjection(env, input)` (line 53) -- just stage 2. The interactive `POST /api/sessions` route calls stage 1 and stage 2 separately so it can run a cross-owner 409 check between them; webhook callers call `createSessionState` then `syncSessionProjection` directly.

If you call `createSessionState` directly, you must persist the projection yourself (`syncSessionProjection` or `persistInitialSessionProjection`). Forgetting it produces a session that runs but never appears in the UI.

## All entry points (keep this table complete)

Every non-QA caller below ends at `createSessionState`.
Manual `qa=true` exceptions delegate to `requestCoordinatedVerification`, which schedules the verifier through the shared auto-QA scheduler.
The outer surface column is what a user/system does to trigger it.

**Manual "Verify" button = force a fresh verifier.** The user-initiated QA entries — the PR-section "Verify" button (#2, via `createChildSession`) and the global "QA Test PR" paste-a-URL entry (#1, via `createSessionAndSend`) — send `forceNewSession: true`. In `requestCoordinatedVerification` that flag (a) skips the advisory `findActiveVerificationSession` dedup and (b) when the PR coordinator is already `VERIFYING`, drives the forced `verification.requested` FSM edge, which supersedes the in-flight verifier (kills its child + admits a fresh run) instead of returning the running one as a `duplicate`. It is still bounded by the per-PR run cap (`MAX_VERIFICATION_RUNS_PER_PR`): past the cap it fails closed with `run_limit_reached`. The flag defaults to `false`, so auto-QA (#10) and every webhook/automation surface keep their single-verifier reuse semantics.

| #   | Surface                                                                                                      | Entry file                                                                                                                                                                | Calls                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /api/sessions` (HTTP API; also backs **CLI** `cycloid sessions create` and the **web UI** create flow) | `apps/control-plane-worker/src/routes/sessions.ts:1302`                                                                                                                   | `createSessionState` + `persistInitialSessionProjection` (`:1369`) | The main interactive path. CLI (`apps/cli/src/commands/create.ts`) and UI (`apps/ui/src/api/sessions.ts`) both POST here -- they are not separate chokepoints. `qa=true` is the exception: the route validates the repo/PR, then delegates to `requestCoordinatedVerification` and returns the coordinator-spawned verifier session with `promptAlreadyEnqueued: true`.                                                                                                                                       |
| 2   | `POST /api/sessions/:sessionId/child-sessions` (parent session spawns a child)                               | `apps/control-plane-worker/src/routes/sessions.ts:2875`                                                                                                                   | `createSessionState` + `syncSessionProjection`                     | Depth/limit caps; see [child-sessions.md](child-sessions.md). `qa=true` child requests delegate to `requestCoordinatedVerification` and return the coordinator-spawned verifier session as the child session id.                                                                                                                                                                                                                                                                                              |
| 3   | Slack app-mention / DM / `qa` directive                                                                      | `apps/control-plane-worker/src/webhooks/shared.ts:2261` (`createSlackSessionRecord`, called from `handleSlackNewSession` :2569, dispatched by `webhooks/slack-events.ts`) | `createSessionState` + `syncSessionProjection`                     | Pre-claims the Slack thread before init. `qa=true` delegates to `requestCoordinatedVerification` after repo/PR authorization. Legacy `verify` directive is accepted during migration.                                                                                                                                                                                                                                                                                                                         |
| 4   | Slack channel automation rule fires                                                                          | `apps/control-plane-worker/src/automation/slack-channel-service.ts:360`                                                                                                   | `initializeAndProjectSession`                                      | Injected as a dep for testability.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | Jira issue webhook (trigger label)                                                                           | `apps/control-plane-worker/src/webhooks/jira-handler.ts:832`                                                                                                              | `createSessionState` + `syncSessionProjection`                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | Linear issue webhook (trigger label)                                                                         | `apps/control-plane-worker/src/webhooks/shared.ts:3770` (`createAndPersistLinearWebhookSession`, called from `webhooks/linear-bootstrap.ts:268`)                          | `createSessionState` + `syncSessionProjection`                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 7   | PagerDuty incident-open webhook                                                                              | `apps/control-plane-worker/src/webhooks/pagerduty-handler.ts:423`                                                                                                         | `createSessionState` + `persistInitialSessionProjection`           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | GitHub issue-comment webhook (`@cycloid`)                                                                    | `apps/control-plane-worker/src/webhooks/github.ts:923`                                                                                                                    | `createSessionState` + `syncSessionProjection`                     | `qa=true` delegates to `requestCoordinatedVerification` after actor/repo authorization and keeps duplicate/run-limit replies on the GitHub comment thread.                                                                                                                                                                                                                                                                                                                                                    |
| 9   | Scheduled automation rule (cron tick)                                                                        | `apps/control-plane-worker/src/automation/scheduler.ts:359`                                                                                                               | `initializeAndProjectSession`                                      | Rule defined via `POST /api/automation/schedules`; the session is created when the rule fires, not when the rule is created.                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | Auto-QA testing after review-loop completes                                                                  | `apps/control-plane-worker/src/session/verification-auto-scheduler.ts:333` (`scheduleAutoVerificationAfterReviewLoopDone`)                                                | `createSessionState` + `syncSessionProjection`                     | Triggered from `verification-request-sweeper.ts`, `prompt-queue.ts`, `durable-object.ts`, and `webhooks/github.ts`; all route through the one scheduler fn. First automated QA pass creates the verifier session; subsequent passes within the same PR lifecycle reuse that session (refresh PR head, clear per-pass evidence). Manual QA surfaces route through the PR coordinator before this scheduler creates the verifier.                                                                               |
| 11  | Unowned GitHub PR `@cycloid` mention bootstrap (top-level comment, review-comment reply, or review body)     | `apps/control-plane-worker/src/services/github-mention-bootstrap.ts` (called from `webhooks/github.ts`)                                                                   | `createSessionState` + `persistInitialSessionProjection`           | Internal-gated (`isCycloidMember`). When no business-scoped, verifier-filtered eligible session is bound, requires actor write/maintain/admin permission and an open same-repo non-fork PR; claims it in `mention_bootstrap_claims`, passes `admitSessionCreate`, adopts via `resolveSessionContinuation` (`update-pr`), creates with `SessionEntrypoint.GITHUB`, `adoptedExternalPr: true`, and `autoVerify: false`, binds the `github_pr_url` ref, then drives `CREATED -> REVIEW` via `publish.pr_opened`. |
| 12  | GitHub PR `@cycloid-review` top-level comment                                                                | `apps/control-plane-worker/src/webhooks/github.ts`                                                                                                                        | `spawnPrReviewTrigger`                                             | Internal member and repo-write gated. Creates a fresh verification-role `review` profile session at the PR head without registering an implementation-session webhook ref.                                                                                                                                                                                                                                                                                                                                    |
| 13  | Automatic review after a Cycloid-owned PR is genuinely created                                               | `apps/control-plane-worker/src/session/publish-service.ts`                                                                                                                | `spawnPrReviewTrigger`                                             | Internal-business only. Uses `SessionEntrypoint.AUTO_PR_REVIEW`, trusted publish authorization, and a durable publish step; adopted or updated PR publishes and review/plan/QA/onboarding sessions are excluded.                                                                                                                                                                                                                                                                                              |
| 14  | Configured failed GitHub check rule                                                                          | `apps/control-plane-worker/src/automation/github-check-dispatch.ts`                                                                                                       | `initializeAndProjectSession`                                      | One fresh session per rule, pull request, and head. Existing Cycloid-owned PR review-loop CI remains authoritative.                                                                                                                                                                                                                                                                                                                                                                                           |

`initializeAndProjectSession` itself (`services/session-create.ts:121`) is the wrapper, not a separate surface -- reached only via #4, #9, and #14.

Each surface passes a `SessionEntrypoint` (`enums/session-entrypoint.ts`) to `createSessionState` so the customer-session-tracking Slack alert can show where the session came from: #1 `api`, #2 `child_session`, #3 `slack`, #4 `slack_automation`, #5 `jira`, #6 `linear`, #7 `pagerduty`, #8 `github`, #9 `scheduled`, #10 `auto_qa` (set for uniformity, but `auto_qa` sessions are `agentRole: "verification"` and filtered out of the alert, so `auto_qa` is not rendered today), #11 `github`, #12 `github`, #13 `auto_pr_review`, #14 `github_check_automation`. It is in-memory only (read by the alert at creation; not persisted). `createSessionState` defaults a missing value to `api`, so a new surface that forgets still never renders an "unknown" entrypoint -- but set it explicitly anyway.

To re-derive this list after the code moves:

```
rg -n "createSessionState\(" apps/control-plane-worker/src --type ts | grep -v test
rg -n "initializeAndProjectSession\(" apps/control-plane-worker/src --type ts | grep -v test
```

The definition site and type-only references show up too; real call sites pass `(env, ...)`.

## When you change something, change it everywhere

### Adding a new session-creation surface (a new integration, route, trigger)

- Funnel through `createSessionState` -- never a direct DB insert.
- Prefer `initializeAndProjectSession` so you get projection + sidebar publish for free. If you call `createSessionState` directly, also persist the projection.
- Resolve the real `ownerUserId` / business membership; fail closed if you cannot prove it.
- Add a row to the table above in the same PR.

### Adding a new per-session field or option

Easy to get half-done. A new field typically has to be threaded through **all** of:

`entrypoint` is immutable creation provenance persisted in both SessionDO and
`session_index`. Every new creation surface must supply an exact value. Legacy
nulls stay null through later projections; never infer them from coarse
`initiationMode` unless durable source-specific identity proves the source.

1. `CreateSessionOptions` and the destructure in `createSessionState` (`session/state.ts:534`).
2. `InitializeAndProjectSessionInput` and its passthrough to `createSessionState` (`services/session-create.ts:84`, `:128`) -- otherwise schedule/Slack-automation sessions silently miss the field.
3. The session projection / `session_index` write (`services/session-projection.ts`, `session/db.ts`) plus an append-only migration if it is a new persisted column -- see [database.md](database.md).
4. Every caller in the table that should set it. A field added only at `POST /api/sessions` will be absent on the 8 other paths. Decide per field whether each surface should set it, default it, or omit it -- deliberately, do not just forget the webhooks.
5. The HTTP request schema + validation if it is user-supplied (`routes/sessions.ts`), and the CLI/UI if they should expose it.

Plan-mode creation accepts `planMode` as `"off" | "on" | "auto"`. `"auto"` runs the plan-necessity classifier once at creation; a null result resolves off. Only interactive `api` (UI/API/CLI) and `slack` (mention/DM) entrypoints honor it; unattended entrypoints and the existing QA Tester, onboarding, target-PR, and child-session carve-outs resolve off.

The tri-state is resolved before persistence. Immutable SessionDO fields `planMode` and `planApprovalRequired` remain booleans and are not projected into `session_index`; `planApprovalRequired` controls the approval gate and reads as `false` for older sessions.

### Adding cross-cutting logic (a new guard, claim, or side effect at creation)

Put it inside `createSessionState` so every path inherits it (this is why the Slack-thread claim and credential gate live there). Do not copy it into individual callers -- that is how paths drift.

## Verification

New DAO/service functions, branching routes, and shared parsing need tests in the same PR ([conventions.md](conventions.md)). For session-creation changes specifically, assert the post-state of both stages (DO state and the D1 projection), not just that the call returned -- see [docs/workflow.md](workflow.md) on tracing the reducer apply path.
