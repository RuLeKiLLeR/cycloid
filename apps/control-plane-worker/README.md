# Control-plane-worker

Cloudflare Workers + Durable Objects orchestration layer. Routes HTTP, manages session lifecycle, coordinates with E2B sandboxes, bridges webhooks (GitHub, Slack, Linear, PagerDuty).

## Key patterns

- **Routing**: 8 route modules with auth tiers: `public` > `webhook` > `internal` > `authenticated`. Auth tier applied in `router.ts` before handler runs.
- **SessionDO**: Durable Object per session. ~50 internal routes at `https://internal/session/*`. Stores session state, event stream, repo context, and prompt queue in DO storage.
- **Planned control-plane handoff**: During reconnect grace, an authenticated same-runtime reconnect with a fresh generation and different bounded `version_metadata.id` persists an adoption record before the reducer's `sandbox.ws_connected` event clears deadlines. The existing prompt and disconnect retry budget remain intact; genuine grace expiry still owns clone-and-fresh-sandbox recovery.
- **DO communication**: Always via `env.SESSION.get(id).fetch("https://internal/...")`. Responses are JSON-wrapped. Never access DO properties directly.
- **Event transport**: Bridge now transports canonical `CycloidEvent` envelopes over the websocket. SessionDO persists those transport events verbatim, then projects them into the current durable UI event shape only when broadcasting or reading them back out.
- **Event compaction**: Text deltas merged per `partId`, capped at 500 events. Prevents streaming responses from pushing tool_call/question events out of replay window.
- **Prompt queue**: One prompt at a time. Sandbox callback triggers `drainQueue()` for next. 15-min stale timeout marks prompt as failed.
- **Webhook idempotency**: All handlers claim `buildWebhookIdempotencyKey(source, eventId, payloadHash)` before processing. Duplicates return early.
- **Session status**: Computed rich status (see `shared/session/phase.ts`): closed > archived, stopped > stopped, active prompt with pending question > waiting_for_input, active prompt > running (with sandbox substate decorating reconnecting/creating/stopping), review_listening (when no active prompt, post-publish, review loop is enabled for the owner/repo, and the session did not opt out via autoVerifyDisabled), publish-terminal states (failed/blocked/finalizing/completed) > transport substates (reconnecting/spawning/stopping) when no active prompt, else idle. Legacy aliases `sandbox_creating` and `stopped_resumable` no longer appear in `rich_status`; substate is carried separately.

## Non-obvious gotchas

- Auth order matters: bearer token (API or session) > session cookie > smoke token (dev only). See `router.ts`.
- D1 migrations in `/migrations/` are immutable once deployed. Never edit an applied file -- create a new one.
- WebSocket: SessionDO maintains separate `clientSockets` (UI) and `sandboxSocket` (sandbox bridge). Bridge events arrive on the sandbox socket, get translated, then broadcast to client sockets.
- `session/state.ts` contains proxy functions (not the DO class). The DO class is `session/durable-object.ts`.
- **DO in-memory fields are ephemeral.** DO instances can be evicted and recreated between requests (especially in wrangler dev but also in production under memory pressure). Never use in-memory fields (`private foo = false`) to coordinate across separate HTTP requests or between an HTTP request and a later WebSocket upgrade. Instead, derive the needed state from durable storage, or write flags to `this.state.storage` if they must survive. In-memory fields are only safe within a single request or for caching storage reads within the same instance lifetime.

## Projection write ownership

- `shared/transcript/projector.ts` is the canonical durable-event projection path for UI, CLI, and Slack surfaces.
- `src/services/session-projection.ts` is the only write path for `session_index` and `durable_event_replay_metadata`.
- Routes, webhooks, Durable Object flows, and background services must use `syncSessionProjection()` or `scheduleSessionProjectionSync()` rather than writing projection tables directly.
- Projection writes happen on the canonical mutation path: lifecycle reducer decisions, question-event handlers, `setHasPendingQuestion`, and similar state changes. Read endpoints (`/session/state`, `/session/events`, `/session/export`, and WebSocket bootstrap) must not re-project on read. If a read computes a different `rich_status` than `session_index` holds, fix the upstream mutation path instead of adding a read-time repair.
- Canonical lifecycle phase transitions must await the `rich_status` write before broadcasting `session_status`. Use `syncRichStatusProjection()` from the DO's `persistAndBroadcastSessionStatus` and `persistCurrentRichStatus` helpers; it throws `MissingSessionIndexRowError` on zero-row updates. Do not introduce a parallel fire-and-forget lifecycle path. Non-lifecycle projection traffic such as snapshot, runtime, and title may still broadcast before persistence.
- Any `SessionDO` code path that persists critical events while text deltas may still be buffered must call `await this.flushTextDeltaBuffer()` first. Missing that flush causes replay-ordering bugs that are hard to detect later.

## SessionDO side effects

- For side effects with external systems such as E2B, GitHub, Slack, and D1 inside `SessionDO`, use `durableStep(storage, name, fn)` from `src/session/durable-step.ts`. It memoizes `fn`'s result in DO storage so a DO restart between `fn` succeeding and the caller's next await does not re-invoke `fn`.
- `durableStep` is memoize-on-success, not at-most-once. If the DO crashes between `fn()` resolving and `storage.put` landing, `fn` runs again on replay. Pair it with a recovery mechanism: provider idempotency key, deterministic recovery query, background reaper, or D1 lease/expiry.
- PR-create recovery embeds `<!-- cycloid-dedup: <sessionId>:<promptId> -->` from `src/github/pr-dedup-marker.ts` into the PR body, then matches it on `GET /repos/.../pulls?head=...&state=open`. Match by branch head only for historical PRs without a marker.
- Step names use `{operation}_{stable_key}`. Keys must be stable across replays; do not include branch tip SHAs or other identifiers that change between attempts. Per-attempt IDs are fine when the same attempt should memoize.
- Side effects that are not idempotent, including event emission and notifications, must be gated behind a separate DO-storage flag inside the wrapped block. A cached `durableStep` result on replay should not re-broadcast.
- Clear per-attempt steps when the attempt is abandoned or completed. `clearDurableStepsByPrefix(prefix)` handles terminal lifecycle cleanup.
- DO storage values are capped at 128 KiB and `durableStep` warns at 32 KiB of UTF-8 bytes. Do not memoize raw large external responses such as full PR diffs or E2B logs; project to the fields the caller needs.

## Key files

| File                                 | What it does                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `src/index.ts`                       | Worker entry point (Sentry, CORS, requestId)                                          |
| `src/router.ts`                      | Request dispatcher, auth tier enforcement                                             |
| `src/session/durable-object.ts`      | SessionDO class (~2000 lines)                                                         |
| `src/session/feed-do.ts`             | SessionFeedDO — per-business realtime sidebar feed                                    |
| `src/session/feed-delta.ts`          | Feed delta resolution and publishing from mutation sites                              |
| `src/session/feed-publish.ts`        | Fire-and-forget delta transport to SessionFeedDO                                      |
| `src/session/state.ts`               | Proxy functions to invoke DO methods via stubs                                        |
| `src/session/cycloid-event-store.ts` | Canonical transport projection between `CycloidEvent` envelopes and durable UI events |
| `src/session/events.ts`              | Durable append helpers, replay shaping, and event compaction                          |
| `src/webhooks/handlers.ts`           | Slack/Linear/GitHub webhook processing                                                |
| `src/auth/routes.ts`                 | OAuth callbacks, token validation                                                     |
| `src/settings/db.ts`                 | Per-user settings, API key encryption/storage, and PR review bot checklists           |
