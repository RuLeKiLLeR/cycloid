# Session Waiting State Cleanup

## Summary

Replace the misleading user-facing `needs_input` display state with two distinct states: `idle` (no active prompt running) and `waiting_for_input` (active prompt has `has_pending_question = true`).

## Worktree

- If `.worktrees/session-waiting-state` does not already exist, create it with `git worktree add .worktrees/session-waiting-state -b codex/session-waiting-state`.
- Work from `.worktrees/session-waiting-state`, run `bash scripts/worktree-setup.sh` there, and keep the dirty main checkout untouched.

## Server Status Projection

- Extend `apps/control-plane-worker/src/session/rich-status.ts` so `computeRichStatus` can receive the active prompt's pending-question flag.
- Return `waiting_for_input` only when: session is active, an active prompt exists with `has_pending_question = true`, and sandbox status is not `spawning`, `stopped`, `reconnecting`, or `stopping`.
- Exact precedence for persisted rich status:
  - archived session -> `archived`
  - sandbox `spawning` -> `sandbox_creating`
  - sandbox `stopped` -> `stopped` or `stopped_resumable`
  - sandbox `reconnecting` -> `running`
  - sandbox `stopping` -> `running`
  - active prompt with pending question -> `waiting_for_input`
  - active prompt without pending question -> `running`
  - no active prompt -> `idle`
- Do not introduce a `waiting` status string.
- Keep the live response overlay separate from persisted rich status:
  - `getSessionStatusForResponse` keeps returning `reconnecting` for live reconnecting responses.
  - `session_index.rich_status` must not persist `reconnecting` or `stopping`; those transient sandbox states project as `running`.
  - `waiting_for_input` must not mask `reconnecting` or stopped variants.
- Add a `do-db` helper that reads `prompts.has_pending_question` for a prompt id through a prepared statement; do not duplicate raw SQL at call sites.
- Update every direct `computeRichStatus` and `getSessionStatusForResponse` call site to pass the flag, including: `syncCurrentRichStatus`, `buildSessionDoResponse`, `buildSessionViewPayload`, `/session/events` and subscription/bootstrap status payloads, `/session/unarchive`, title-generation projection sync.
- Persist `session_index.rich_status` only through the existing projection path (`syncCurrentRichStatus` / `syncRichStatusToD1` / `scheduleSessionProjectionSync`); no direct `session_index` D1 updates from `SessionDO`.
- Add a lazy resync from DO-backed status/view/subscribe paths: if the active prompt already has `has_pending_question = true` and the computed status differs from `session_index.rich_status`, schedule the existing projection sync. Handles live sessions already waiting for input before the deploy, without a migration.

## Pending Question Lifecycle

- Centralize pending-question mutation so all clear paths reproject and broadcast status after the flag changes. The existing `setHasPendingQuestion(false)` callers in prompt queue, stop/failure/spawn-timeout/disconnect paths must not leave `waiting_for_input` stale.
- Question persistence durability order: flush buffered text deltas with `flushTextDeltaBuffer()`; set `has_pending_question = true` on the active prompt; append and mirror the `question` event; update the session event id; then sync rich status and broadcast `session_status: "waiting_for_input"`.
- Do not broadcast `waiting_for_input` before the question event is durable and replay-visible.
- On answer: clear `has_pending_question`, send the sandbox `respond` command, persist the answer event, update the event id, then re-sync and broadcast the next status.
- On prompt completion, failure, enqueue-interruption supersede, stop, spawn timeout, or disconnect clearing pending state: re-sync and broadcast after the pending flag and active-prompt state are current.
- Do not alter bridge event translation, text flushing, `seenPartIds`, usage accumulation, token attribution, or tool-call counting.

## API And Actions

- Add raw `SessionStatus` value `waiting_for_input` wherever raw session statuses are typed in the UI and API-facing client models.
- `apps/control-plane-worker/src/services/session-view.ts` action computation: `canStop` true for `running` and `waiting_for_input`; `canCreatePr` stays false for `waiting_for_input` (active prompt state, not idle); `canSendPrompt` keeps the existing non-terminal/non-stopped behavior unless tests show a narrower rule already exists.
- HTTP session detail/view responses, WebSocket `subscribed` payloads, and `session_status` broadcasts all use the same computed status contract.
- `waiting_for_input` is non-terminal for CLI watch/create. Do not add it to `WATCH_TERMINAL_STATUSES`; the CLI keeps waiting while rendering the question event; the answer flow remains UI/API-owned.

## UI State Model

- Replace display status `needs_input` with `idle` and `waiting_for_input`. Display statuses: `working`, `waiting_for_input`, `idle`, `stopped`, `archived`.
- `flattenStatus`: raw `waiting_for_input` -> `waiting_for_input`; raw `idle` -> `idle`; raw `running`/`reconnecting`/`sandbox_creating` -> `working`; stopped variants -> `stopped`; `archived` -> `archived`.
- Labels: `idle` -> `Idle`; `waiting_for_input` -> `Waiting for input`.
- Styling: `waiting_for_input` keeps the existing accent/diamond treatment; `idle` uses a neutral treatment.
- Replace `needs_input` in sidebar rows, status chips, headers, detail activity bar, aria labels, mobile layout filters, and tests. No backwards-compatibility display shim for `needs_input`.
- Add explicit UI helpers instead of checking only `session.status === "running"`:
  - `ACTIVE_PROMPT_STATUSES = new Set(["running", "waiting_for_input"])`
  - `LIVE_SESSION_STATUSES = new Set(["idle", "running", "waiting_for_input", "reconnecting", "sandbox_creating"])`
- Use the active-prompt helper for stop controls, transcript active-turn rendering, WebSocket watchdog `isPromptActive`, detail activity state, and pending-question affordances; the live-session helper for sidebar/list live behavior and end-session affordances. Keep `idle` out of active-prompt-only behavior.
- Show the pending-question banner for `waiting_for_input`. If the status arrives before the question event hydrates, show only a generic waiting indicator until the question event is available.
- Do not locally synthesize `waiting_for_input` from `sandbox_ready`; the authoritative subscribed payload or `session_status` event sets it.

## Documentation

- Update `apps/control-plane-worker/README.md` so the rich-status bullet documents pending question -> `waiting_for_input`.
- Update nearby stale comments that still describe `idle` flattening to `needs_input`, including rich-status and stop-boundary comments.

## Data And Migrations

- No D1 migration: `session_index.rich_status` is `TEXT` in existing migrations.
- No DO SQLite migration: `prompts.has_pending_question INTEGER NOT NULL DEFAULT 0` already exists in `apps/control-plane-worker/src/session/schema.ts`.
- No infrastructure, Wrangler, env var, secret, or deploy workflow changes.

## Tests

- Rich-status unit tests: active prompt + pending question + ready sandbox -> `waiting_for_input`; active prompt + no pending question -> `running`; idle stays `idle`; `spawning`/`stopped`/`stopped_resumable`/`reconnecting`/`stopping` precedence over `waiting_for_input`; persisted projection vs live response behavior for `reconnecting`.
- DO database tests for the pending-question read helper.
- SessionDO question tests: persisted question produces `waiting_for_input` sync/broadcast only after the question event is appended and session event id updated; answering clears back to `running` while the prompt continues; completion clears back to `idle`; stop, failure, spawn-timeout, disconnect, and enqueue interruption clear stale `waiting_for_input`.
- Session view tests for actions and route/view status surfaces, including `canStop` for `waiting_for_input` and `canCreatePr === false`.
- UI tests: `flattenStatus("idle") === "idle"`; `flattenStatus("waiting_for_input") === "waiting_for_input"`; labels `Idle` and `Waiting for input`; sidebar/mobile filters use `idle` and `waiting_for_input`, not `needs_input`; pending-question banner and session-detail actions work for `waiting_for_input`.
- CLI tests: `waiting_for_input` not terminal for watch/create.

Run:

- `npx vitest run tests/test_cloudflare/compute-rich-status.test.ts tests/test_cloudflare/session/rich-status.test.ts`
- `npx vitest run tests/test_cloudflare/session/broadcast-before-persist.test.ts tests/test_cloudflare/session/spawn-timeout.test.ts tests/test_cloudflare/session/auto-close-on-disconnect.test.ts`
- `npx vitest run tests/test_cloudflare/session-view-service.test.ts tests/test_cloudflare/session-view-route.test.ts`
- `npx vitest run tests/test_ui/status-display.test.ts tests/test_ui/mobile-layout.test.tsx tests/test_ui/session-detail-actions.test.tsx`
- `npx vitest run tests/test_cli/commands.test.ts`
- `npm run typecheck`

UI runtime verification: start the local dev server only if needed and inspect session list/detail at desktop and mobile widths. Confirm no console errors, no overlapping status text, neutral `Idle`, accent `Waiting for input`, and the pending-question banner/action controls render coherently.

## Assumptions

- Existing historical `idle` rows display as `Idle`, not user-action-needed.
- Existing active sessions with stale `session_index.rich_status` are handled by lazy DO resync, not a migration or one-off backfill.
- `waiting_for_input` is a non-terminal session status for CLI watch/create.
