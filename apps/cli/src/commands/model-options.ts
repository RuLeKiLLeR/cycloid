import {
  AGENT_RUNTIME_BACKENDS,
  type AgentRuntimeBackend,
  CODEX_AGENT_RUNTIME_BACKEND,
  isAgentRuntimeBackend,
} from "../../../../shared/agent/agent-runtime-backend.js";
import {
  extractModelId,
  getSessionStartModelIdsForBackend,
  isSessionStartModelAllowedForBackend,
} from "../../../../shared/constants/models.js";
import { CliError } from "../errors.js";

export function resolveModelAndBackend(options: { model?: string; backend?: string }): AgentRuntimeBackend {
  let agentRuntimeBackend: AgentRuntimeBackend = CODEX_AGENT_RUNTIME_BACKEND;
  if (options.backend !== undefined) {
    if (!isAgentRuntimeBackend(options.backend)) {
      throw new CliError(
        "user",
        `Invalid --backend '${options.backend}'. Expected ${AGENT_RUNTIME_BACKENDS.join(", ")}.`,
      );
    }
    agentRuntimeBackend = options.backend;
  }

  if (options.model !== undefined) {
    const normalizedModel = extractModelId(options.model);
    if (normalizedModel === undefined || !isSessionStartModelAllowedForBackend(normalizedModel, agentRuntimeBackend)) {
      const allowed = getSessionStartModelIdsForBackend(agentRuntimeBackend).join(", ");
      throw new CliError(
        "user",
        `Model '${options.model}' is not selectable for backend '${agentRuntimeBackend}'. Allowed: ${allowed}.`,
      );
    }
  }

  return agentRuntimeBackend;
}
