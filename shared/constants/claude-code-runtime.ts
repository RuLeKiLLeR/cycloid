// Pinned Claude Code runtime versions baked into the E2B sandbox image and
// treated as a runtime contract (parallel to PINNED_CODEX_CLI_VERSION).
//
// The claude_code bridge backend drives the Agent SDK
// (`@anthropic-ai/claude-agent-sdk`), which ships its OWN version-locked CLI as
// a native-binary optional dependency — the bridge does NOT drive raw `claude`
// CLI flags anymore (no stream-json in/out, --session-id/--resume, --mcp-config,
// --permission-prompt-tool, --append-system-prompt). On a SDK bump, re-verify
// the SDK options/messages used by claude-session.ts + claude-event-translator.ts
// (query options, SDKMessage shapes, canUseTool, setModel) against the installed
// `.d.ts`, and confirm the SDK's bundled native binary launches in-sandbox.
export const PINNED_CLAUDE_AGENT_SDK_VERSION = "0.3.170";
