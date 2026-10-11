# MCP

Cycloid supports two MCP configuration paths:

1. **Business-managed MCP servers**: Configured in the UI at Settings > Workspace integrations > MCP servers. Business admins can add HTTP, SSE, or stdio MCP servers scoped to the entire business or specific repositories. Secrets are resolved from business credentials at session spawn time.

2. **Repo-local MCP config**: Committed project files [`.mcp.json`](../.mcp.json) (claude_code backend) and [`.codex/config.example.toml`](../.codex/config.example.toml) (codex backend).

Sandbox runtime sessions ship no first-party Cycloid MCP servers; the old runtime-only debugging, observability, and child-session MCP surfaces are removed.

## Business-managed MCP servers

Business admins configure MCP servers in the UI at Settings > Workspace integrations > MCP servers. The configuration is stored in D1 (`mcp_servers` table) and resolved at session spawn time.

Key behaviors:

- **Scope**: Servers can be business-wide or scoped to specific repositories (owner/name matching).
- **Secrets**: Reference env var names (e.g., `MY_MCP_TOKEN`) in `secretRefs`; values are resolved from business credentials at session spawn.
- **Headers**: For HTTP/SSE servers, headers can reference secrets via `{"secretRef": "MY_SECRET"}`.
- **Validation**: HTTP servers support tool discovery via JSON-RPC `initialize` + `tools/list`; stdio/SSE servers require runtime discovery.
- **Egress**: Remote MCP server hosts must be in the business egress allowlist for validation to succeed.

The control plane builds `managedMcpServers` into `SESSION_CONFIG` and injects secret values as sandbox env vars. The bridge parses the config and builds backend-specific MCP configuration (Codex TOML or Claude SDK `mcpServers`).

## How customer `.mcp.json` reaches sessions

For `claude_code` sessions, the bridge projects the customer repo's committed `.mcp.json` into the Agent SDK at query open (`apps/sandbox-bridge/src/services/claude-mcp-config.ts`):

- Only `.mcp.json` is read — never `settings.json`, hooks, or other project settings (those stay platform-owned).
- Fail-safe: a missing file means no servers; a malformed file or entry is logged and skipped, never fatal.
- Tool calls from projected servers still pass the in-process `canUseTool` safety gate.
- `${VAR}` / `${VAR:-default}` references expand from the sandbox environment, matching Claude Code CLI semantics. A reference to an unset variable with no default drops that server.
- Repo-local remote `http`/`sse` servers cannot expand trusted integration credential env vars in `url` or `headers`. Put secret-bearing remote MCP servers in business-managed MCP registration instead.

For `codex` sessions, MCP servers come from the Codex config (`.codex/config.toml`, seeded from `config.example.toml`).

## `.mcp.json` examples

Supported server shapes (stdio, sse, http; `"type": "streamable-http"` is accepted as an alias and normalized to `http`):

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "npx",
      "args": ["-y", "@acme/mcp-tools"],
      "env": { "ACME_ENV": "ci" }
    },
    "internal-api": {
      "type": "http",
      "url": "https://${MCP_HOST:-mcp.internal.example.com}",
      "headers": { "X-Workspace": "${WORKSPACE_SLUG}" }
    },
    "events": {
      "type": "sse",
      "url": "https://mcp.example.com/sse"
    }
  }
}
```

Notes:

- `type` defaults to `stdio` when `command` is present.
- Secrets must never be literal values in the committed file. Repo-local remote MCP `url` and `headers` may reference only non-secret env vars.
- stdio servers run inside the sandbox; the command must exist in the sandbox image or the repo (e.g. `npx`-resolvable).

## Changing project MCP config

- update `.mcp.json`
- update `.codex/config.example.toml`
- update `scripts/sync-codex-config.mjs` if runtime seeding or stale-entry pruning changes

Runtime `.codex/config.toml` remains gitignored and is synced per-user by `scripts/sync-codex-config.mjs` during local `prepare` and `scripts/worktree-setup.sh`.
