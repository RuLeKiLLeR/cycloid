# UI

React 18 + Vite + Tailwind frontend. Single-page app for managing coding sessions with real-time WebSocket updates.

## Key patterns

- **WebSocket lifecycle**: `useSessionWebSocket.ts` manages the durable-object WebSocket, reconnect backoff, ping/pong, and blocked-WS fallback to polling. `useSessionReplay.ts` calls it and `useSessionFallbackPolling.ts` keeps a resilience poll running for reconnect gaps.
- **promptsRef.current**: Stays synced with `prompts` state so WebSocket handlers avoid stale closures when routing events to the active prompt.
- **Event flattening**: `shared/transcript/projector.ts` is the canonical durable-event projector. UI session API helpers call it directly so transcript rendering stays aligned with CLI and Slack.
- **Transcript state**: `Map<promptId, ActivityEvent[]>` is rebuilt each render cycle from durable events and prompt history. Prompt history is the canonical transcript for completed prompts; for active prompts it is accepted only when not older than live durable events. On `prompt_result`, full history is fetched and becomes the transcript if not stale.
- **PR UI split**: PR creation/view state lives in `PrSection.tsx`. `SessionDetail.tsx` coordinates session hooks rather than implementing every sub-flow inline.
- **LayoutContext**: Top-level state (sessions, repos, models, user, base branch) managed in `Layout.tsx`, passed via `useLayoutContext()`. Mutation functions live in Layout.
- **No external state management**: All state in component hierarchy + LayoutContext. React Router v7.
- **Optimistic updates**: Answer question and archive session update local state before SSE confirms.

## Non-obvious gotchas

- **Tailwind classes must use tokens defined in `App.css`'s `@theme` block.** Valid surface colors: `surface-0` through `surface-3`. Verify against `@theme` before using a color utility.
- **Loading states must resolve on failure, not just success.** If you add a `loaded` boolean that gates a skeleton/spinner, set it to `true` in both the success and error paths (or use `.finally()`). #849 was reverted because `sessionsLoaded` was only set on fetch success, causing infinite skeleton bars when the API failed.
- Vite proxies `/api` and `/auth` to `http://localhost:3000` in dev.
- Builds to `../../dist/ui` (two levels up from app root).
- No auth state client-side -- relies on `/auth/me` endpoint. Refreshes on window focus.

## Key files

| File                                     | What it does                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/api/`                               | Domain API client modules, WebSocket URL helpers, and prompt replay helpers                       |
| `src/types.ts`                           | Core domain types (SessionStatus, ActivityEvent, etc.)                                            |
| `src/components/SessionDetail.tsx`       | Session route: coordinates hooks and renders transcript composition                               |
| `src/hooks/useSessionState.ts`           | Session state hook for detail view and Layout session list; reducer in `src/hooks/session-state/` |
| `src/hooks/session-state/`               | Pure reducer, durable-event ingestion, transcript helpers, and state types                        |
| `src/hooks/useSessionActionRunner.ts`    | Prompt, question, PR, stop, warm, archive, and repo action orchestration                          |
| `src/hooks/useSessionBootstrap.ts`       | HTTP/WebSocket bootstrap, prompt history hydration, session data refresh                          |
| `src/hooks/useSessionReplay.ts`          | WebSocket subscription, replay pagination, real-time event dispatch                               |
| `src/hooks/useSessionFallbackPolling.ts` | Resilience and aggressive fallback polling for WebSocket gaps                                     |
| `src/hooks/useSessionRepoFallback.ts`    | Repo list retry logic for orphaned sessions; surfaces SSO-withheld orgs                           |
| `src/components/PrSection.tsx`           | PR create/view UI and status display                                                              |
| `src/components/Layout.tsx`              | Top-level state, repo/model/base-branch selection, session management                             |
| `src/components/Transcript.tsx`          | Renders event stream with collapsed tool runs, diffs                                              |
| `src/components/PromptForm.tsx`          | Textarea input: Enter sends, Shift+Enter inserts newline, Cmd/Ctrl+Enter also sends               |
| `src/hooks/useSessionWebSocket.ts`       | Durable-object WebSocket client with reconnect and blocked-WS fallback                            |
| `../../shared/transcript/projector.ts`   | Canonical durable-event projection shared with CLI and Slack                                      |
