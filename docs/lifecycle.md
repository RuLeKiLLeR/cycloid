# Session lifecycle

This page is the event-transport + phase map (IDs, event flow, replay/export). The **post-publish coordination state machine** — review loop → QA → merge-ready — is the [lifecycle FSM](fsm.md), the source of truth for post-publish lifecycle state. Read `fsm.md` for lifecycle state and projections; read this for the event/transport plumbing.

Shortest prompt-to-PR map. Canonical sources:

| Source                                                    | Owns                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `shared/events/schema.ts`                                 | `CycloidEvent`, `PHASES`, payload validation                                                 |
| `shared/correlation.ts`                                   | `x-cycloid-correlation`, `ARCANIST_CORRELATION`, traceparent serialization                   |
| `shared/observability/logger.ts`                          | `phaseLogFields()`, `dd.trace_id`, `dd.span_id`, `dd.parent_span_id`, correlation log fields |
| `apps/sandbox-bridge/src/events/translate.ts`             | Bridge event to canonical transport translation                                              |
| `apps/control-plane-worker/src/session/durable-object.ts` | Per-session WebSocket ingest, persistence, replay, prompt finalization                       |
| `apps/control-plane-worker/src/session/feed-do.ts`        | Per-business realtime sidebar feed (SessionFeedDO)                                           |
| `apps/control-plane-worker/src/session/feed-delta.ts`     | Feed delta resolution and publishing from mutation sites                                     |
| `shared/transcript/projector.ts`                          | UI, CLI, Slack, MCP, and export projection                                                   |

## IDs

| ID                                                                     | Source                                        | Durable/query surface                           |
| ---------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| `sessionId`                                                            | Session create/webhook/CLI route              | Session DO, `session_index`, replay metadata    |
| `promptId`                                                             | Session DO prompt enqueue                     | `prompt_runs`, DO `prompts`, replay rows        |
| `sandboxId`                                                            | Sandbox spawn and bridge config               | DO sandbox state, bridge logs, E2B state        |
| `traceparent`                                                          | Active control-plane span                     | `x-cycloid-correlation`, `ARCANIST_CORRELATION` |
| `dd.trace_id` / `dd.span_id` / `dd.parent_span_id`                     | Shared logger helpers or direct-post exporter | Datadog log/APM correlation                     |
| `correlationTraceId` / `correlationSpanId` / `correlationParentSpanId` | Shared logger correlation provider            | Runtime correlation logs                        |

## Flow

1. Route/webhook validates auth and repo access, then creates or resumes Session DO state.
2. Prompt enqueue creates `promptId`, persists queue state, and records `prompt.enqueue`.
3. Prompt dispatch serializes correlation, starts or reuses a sandbox, and sends one command to the bridge.
4. Sandbox startup forwards `ARCANIST_CORRELATION`; bridge opens the DO WebSocket with `x-cycloid-correlation`.
5. Bridge translates agent runtime stream parts (Codex or Claude Code) into canonical `CycloidEvent` envelopes.
6. Session DO validates with `validateCycloidEvent()`, persists raw transport rows, and projects only for durable readers.
7. `execution_complete` flushes text deltas, persists `prompt.complete`, backfills telemetry, and posts trace finalization.
8. Post-execution git/PR work reports back; DO PR workflow opens or updates the PR and persists the PR event.

## Phases

| Phase                  | Meaning                                                     |
| ---------------------- | ----------------------------------------------------------- |
| `session.create`       | Session state established                                   |
| `sandbox.spawn`        | Sandbox spawn milestone                                     |
| `bridge.connect`       | Bridge connect, disconnect, reconnect, or heartbeat         |
| `bridge.event`         | Unpromoted bridge payload                                   |
| `prompt.enqueue`       | Prompt added to queue                                       |
| `prompt.context`       | System-context build, event subscribe, Braintrust hand-off  |
| `prompt.dispatch`      | Prompt accepted or dispatch progress                        |
| `agent.session.create` | Agent-runtime start, restore, retry, completion, or failure |
| `tool.call`            | Tool call                                                   |
| `tool.result`          | Tool result                                                 |
| `text.delta`           | Output or reasoning text                                    |
| `prompt.complete`      | Prompt terminal result or close milestone                   |
| `timeline`             | Agent timeline observation                                  |
| `git.push`             | Branch push result                                          |
| `pr.open`              | PR open result when represented as canonical transport      |
| `error`                | Runtime error                                               |
| `user_question`        | User input request                                          |
| `idle`                 | Bridge idle report                                          |

Promote a new phase only when operators need it as a lifecycle query key or durable readers need a first-class shape. Otherwise use `bridge.event`.

## Review loop + QA testing (RLA v2)

> The [lifecycle FSM](fsm.md) owns the post-publish coordination **decision** (when the PR is merge-ready), and — as of Wave 11 (2026-07-02) — **epoch creation** (W11-V5), **PR labels** (W11-P2), and the **mirror-column writes** (W11-P1, dual-run). QA is no longer a scheduled gate: the verifier child is spawned at publish and runs off-gate in parallel with the loop. Worklist construction, prompt dispatch, and the UI status mirrors remain legacy-owned; the legacy machinery described below is superseded and scheduled for deletion (Section G, merge-gated on the evidence gate in `fsm.md`). Read `fsm.md`'s live-vs-legacy ownership boundary before changing these paths.

After publish the implementation session enters `review_listening` (unless `autoVerifyDisabled`, which skips the loop entirely), and the verifier child is **spawned at publish** (`SPAWN_VERIFICATION_CHILD` on `publish.pr_opened`) to run off-gate in parallel — it is not scheduled by the review loop. Epoch dispatch runs every minute (`runReviewLoopEpochDispatchSweep`), and the full 5-minute sweep (`runReviewLoopSweep`) adds session reconcile and stuck repair. Webhook-fed epochs (`pr_review_response_epochs`, `source_kind = bot|human|mixed|ci|verification|mention`) are claimed by whichever sweep fires first. Green CI webhooks (`check_run`, `commit status` with `success`) trigger inline `caught_up` recompute, which runs the pure CI ladder and can reach `MERGE_READY`; the sweep backstops the slower worklist poll.

1. **QA runs in parallel, not as a gate.** The verifier child is spawned once at publish and runs alongside the loop; the review loop dispatches `ci`, bot, and human comment epochs on their own cadence. There is no "await the first QA verdict" pause — QA never blocks the review loop or merge-ready.
2. **QA verdict is advisory bookkeeping.** In the off-gate path (parent in `REVIEW`/`MERGE_READY`/`NEEDS_YOU`) every verdict flows through `verificationBookkeeping` as a **record-only self-loop — no state change and no worklist injection**: a `pass`/`skipped`/`app_breaks` verdict is persisted (so QA-rerun triggers and product surfaces can read it) and the verifier child is torn down; a `run_limit`/`stopped`/`failed` outcome emits a **non-blocking** `notify_qa_issue` DM, never a merge block. The `inject_findings` re-intake — folding an `app_breaks` verdict's findings into the worklist as undispositioned review items (via the `cycloid-qa:v1` marker) — fires ONLY on the legacy `VERIFYING → REVIEW` verdict exit, i.e. sessions still draining the old gate. Automated QA reruns in the same PR lifecycle reuse one verifier session/sandbox, refresh the PR head, and clear per-pass evidence before dispatch. Manual GitHub `qa=true`, Slack `qa=true`, and API/manual QA remain fresh verifier sessions. The user-initiated UI "Verify"/"QA Test PR" buttons additionally send `forceNewSession: true`, which makes the PR coordinator skip the active-verifier dedup and **supersede** an already-running verifier for the same PR (kill its child + admit a fresh run via the forced `verification.requested` edge) rather than returning the in-flight one — so each click always starts a new session, still bounded by `MAX_VERIFICATION_RUNS_PER_PR` (`run_limit_reached` past the cap).
3. **Merge-ready is CI-only.** `MERGE_READY` is reached on `ci_green ∧ no in-flight epoch` (the pure CI ladder), independent of the QA verdict. There is no `verification-exhausted` review-gating terminal; the `MAX_VERIFICATION_RUNS_PER_PR` cap now bounds reruns and surfaces via the non-blocking DM — except that sessions still draining the legacy `VERIFYING` gate trip the old blocking `NEEDS_YOU(verification_run_limit)` until that stock drains.
4. Dispatch prompts are LLM-triaged (`review_loop_triage`, platform LLM) into action items; any failure falls open to the deterministic worklist prompt.

Both loops are always-on; the only knob is the expected-bots checklist (code-review loop only). The former `review_timeout_minutes` wall-time collection window was removed (#6999/#7000) — its column is now code-orphaned (see [database.md](database.md#deadunused-schema)). Counters (us5): `arcanist.review_loop.dispatch{dispatch_path:…,source_kind:…}`, `arcanist.review_loop.dispatch_deferred{reason:…}`, `arcanist.review_loop.qa_tester_intake`, `arcanist.review_loop.triage{outcome:…}` (+ `…triage_dropped_items` / `…triage_discarded_action_items`).

## Replay/export

- Session DO SQLite is replay source of truth.
- Canonical transport rows stay raw; `shared/transcript/projector.ts` adapts them for current consumers.
- `/api/sessions/:sessionId/events/history` is incremental replay with sequence cursors and HTTP/MCP-only `prompt_id`.
- WebSocket replay is for reconnect/bootstrap/back-paging, not prompt-scoped reads.
- `/api/sessions/:sessionId/export` is for full-session eval, feedback, repair, and archive reads.

## Datadog

```text
service:cycloid-sandbox-bridge @event:prompt.complete @step:execution @phase_status:completed @prompt_id:<prompt_id>
service:cycloid-control-plane @_direct_post:true @event:prompt.trace.finalized @prompt_id:<prompt_id>
service:cycloid-control-plane @_direct_post:true @event:runtime.terminate @sessionId:<session_id>
```
