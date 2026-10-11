# Child Cycloid sessions

A parent session can create and track child sessions through control-plane routes and CLI/API surfaces.

- the `cycloid.spawn_child_session` first-party dynamic tool is available to sandbox runtime sessions
- the underlying HTTP routes and stored parent/child metadata are in place
- UI, CLI, and direct callers can also use the capability

Limits, lifecycle, and stored metadata:

- `MAX_CHILD_SESSION_SPAWN_DEPTH`
- `MAX_CHILD_SESSIONS_PER_PROMPT`
- `MAX_TOTAL_CHILD_SESSIONS_PER_SESSION`
- `MAX_CONCURRENT_CHILD_SESSIONS_PER_USER`

Backend inheritance:

- Child sessions inherit the parent session's `agent_runtime_backend` (codex, claude_code, or opencode).
- Legacy parent sessions with null `agent_runtime_backend` resolve to `codex` via `resolveAgentRuntimeBackend`.
- The inherited backend scopes the model selection: Codex children use Codex models, Claude Code children use Anthropic models, OpenCode children use Kimi K2.7 Code.

Authoritative backend: `apps/control-plane-worker/src/routes/sessions.ts`; projection logic: `apps/control-plane-worker/src/services/session-projection.ts`.
