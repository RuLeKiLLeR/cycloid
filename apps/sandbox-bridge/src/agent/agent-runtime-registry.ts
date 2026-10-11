import { type AgentRuntimeBackend } from "../../../../shared/agent/agent-runtime-backend.js";
import {
  type AgentRuntimeAdapter,
  type AgentRuntimeAdapterDeps,
  CodexRuntimeAdapter,
} from "./agent-runtime-adapter.js";
import { ClaudeCodeRuntimeAdapter } from "./claude-runtime-adapter.js";
import { OpencodeRuntimeAdapter } from "./opencode-runtime-adapter.js";

export type AgentRuntimeAdapterFactory = (deps: AgentRuntimeAdapterDeps) => AgentRuntimeAdapter;

const ADAPTER_REGISTRY: Record<AgentRuntimeBackend, AgentRuntimeAdapterFactory> = {
  codex: (deps) => new CodexRuntimeAdapter(deps),
  claude_code: (deps) => new ClaudeCodeRuntimeAdapter(deps),
  opencode: (deps) => new OpencodeRuntimeAdapter(deps),
};

export function createAgentRuntimeAdapter(
  backend: AgentRuntimeBackend,
  deps: AgentRuntimeAdapterDeps,
): AgentRuntimeAdapter {
  return ADAPTER_REGISTRY[backend](deps);
}
