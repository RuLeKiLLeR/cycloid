import type { AgentConfig } from "../../../../shared/agent/schema.js";

export class AgentConfigError extends Error {
  readonly code = "config_error";

  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/**
 * Resolve the final set of agents from multiple sources.
 * Resolution order: built-in -> repo config.
 * Later sources override earlier by name for public agent metadata.
 */
export function resolveAgents(
  builtIn: Record<string, AgentConfig>,
  repoAgents?: Record<string, Partial<AgentConfig>>,
): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {};

  // Start with built-in agents
  for (const [name, agent] of Object.entries(builtIn)) {
    result[name] = { ...agent };
  }

  // Merge repo-level overrides
  if (repoAgents) {
    for (const [name, partial] of Object.entries(repoAgents)) {
      result[name] = mergeAgentConfig(result[name], partial, name);
    }
  }

  return result;
}

export function sanitizeResolvedAgents(
  agents: Record<string, AgentConfig> | null | undefined,
): Record<string, AgentConfig> | null {
  if (!agents) return null;
  const sanitized: Record<string, AgentConfig> = {};
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.mode === "primary") {
      sanitized[name] = agent;
    }
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function mergeAgentConfig(base: AgentConfig | undefined, override: Partial<AgentConfig>, name: string): AgentConfig {
  if (override.mode !== undefined && override.mode !== "primary") {
    throw new AgentConfigError(`Agent override "${name}" uses unsupported mode "${String(override.mode)}"`);
  }

  if (!base) {
    return {
      description: name,
      mode: "primary" as const,
      ...(override.description !== undefined ? { description: override.description } : {}),
      ...(override.mode !== undefined ? { mode: override.mode } : {}),
      name, // name is always the map key, cannot be overridden
    };
  }

  const merged = { ...base };

  if (override.description !== undefined) merged.description = override.description;
  if (override.mode !== undefined) merged.mode = override.mode;

  return merged;
}
