# Sandbox-bridge

Translator between agent runtime event streams (Codex or Claude Code) and the control plane. It talks to `codex app-server` or the Claude Agent SDK, enriches raw events, applies safety guards, and orchestrates commit/push behavior after execution.

## Event handling invariants

- Codex tool parts can arrive before `state.input`. Track first sight with `seenPartIds`, but add to `emittedToolParts` only after emitting with input. Never emit a tool call summary before input is available.
- Use `canonicalPartId()` for tool part identity. Prefer `callID` over `id` so updates for the same tool call stay connected.
- Text events need part-specific IDs, not the shared message ID. Otherwise text before and after a tool call can merge into the wrong UI position.
- User-message text parts must not be emitted as assistant narration. Track message roles from `message.updated` and skip text/reasoning parts belonging to user messages.
- Doom-loop handling hashes the last 3 tool calls for non-`apply_patch` tools. If all match, log telemetry and reset the hash without interrupting the prompt. `apply_patch` is excluded from this hash window entirely.
- `session_idle` is policy-carrying. It is emitted only after bridge-side follow-up enforcement decides the prompt outcome, including zero-edit implement handling.
- The event buffer keeps up to 1000 events while the websocket is closed. Flush it in order on reconnect; when full, drops oldest buffered non-ACK events (ACK-required events use a separate durable outbox).

## Prompt and context pointers

- `docs/bridge.md` is the canonical reference for bridge event flow, prompt assembly placement, instruction-file selection, one-shot system context state, and behavioral guidance lifecycle.

## Operational gotchas

- Run `npm run bundle`, not only `npm run build`, before deploy-path validation. `build` runs TypeScript checks; the sandbox deploy path uses `dist/bundle.js` from esbuild.
- Never guess Codex event shapes. Read `$CODEX_SRC` or the local Codex checkout before changing event type handling.
- Protection is layered: regexes for sensitive paths, directory blocklists, and tool-specific path extraction. Keep violations blocking execution and emitting an error event.
- Bash safety depends on `splitBashCommand()` and `parseBashCommand()` respecting quotes, matching `BLOCKED_GIT_PATTERNS` / `BLOCKED_CLI_PATTERNS`, and extracting paths for protection checks.
- Reconnect uses exponential backoff from 2s to 30s. HTTP 404 is retried only before the first successful control-plane WebSocket open and within the 30s startup grace; after either condition is false, 404 stops the bridge.
- Post-edit diagnostics must remain async/non-blocking.
- Git branch/push runs only when `!abortReason`. If the sandbox is on the base branch, it creates or switches to a deterministic `{task-slug}-{session-suffix}` branch before commit/push. Push is skipped if commit fails.

## Key files

| File                          | Purpose                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `src/bridge.ts`               | Main event loop, prompt dispatch, websocket events, completion policy, git orchestration |
| `src/index.ts`                | Entrypoint, env validation, signal handlers, Codex process cleanup                       |
| `src/events/translate.ts`     | Canonical `CycloidEvent` transport translator for websocket emission                     |
| `src/types.ts`                | Bridge event aliases, `SandboxCommand`, and prompt-loop signal types                     |
| `src/constants/bridge.ts`     | Limits, prompt guidance, protection constants, bash blocklist, thresholds                |
| `src/utils/bash-parser.ts`    | Bash tokenization and blocked command detection                                          |
| `src/utils/protection.ts`     | File protection checks and tool-specific path extraction                                 |
| `src/utils/system-context.ts` | One-shot section assembly (diagnostics, attachments, memories, requesting-user identity) |
| `src/prompt-loop-state.ts`    | Per-prompt state for part IDs, counters, and behavioral signals                          |
