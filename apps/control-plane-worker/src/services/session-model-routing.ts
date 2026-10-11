import {
  type AgentRuntimeBackend,
  CODEX_AGENT_RUNTIME_BACKEND,
} from "../../../../shared/agent/agent-runtime-backend.js";
import { CLAUDE_CODE_AGENT_RUNTIME_BACKEND } from "../../../../shared/agent/agent-runtime-backend.js";
import {
  extractModelId,
  extractSessionStartModelIdAnyBackend,
  getAgentRuntimeBackendForModel,
  getDefaultSessionStartModelIdForBackend,
  isSessionStartModelAllowedForBackend,
  normalizeRetiredBasetenModelId,
} from "../../../../shared/constants/models.js";

export function resolvePrReviewModel(
  author: {
    authorModel: string | null | undefined;
    authorAgentRuntimeBackend: AgentRuntimeBackend | null | undefined;
  },
  { anthropicAvailable }: { anthropicAvailable: boolean },
): { currentModel: string; agentRuntimeBackend: AgentRuntimeBackend } {
  const authorModel = extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(author.authorModel));
  const authorBackend = author.authorAgentRuntimeBackend;
  const authorPairIsValid =
    authorModel !== undefined &&
    authorBackend !== undefined &&
    authorBackend !== null &&
    isSessionStartModelAllowedForBackend(authorModel, authorBackend);

  const reviewerBackend =
    authorPairIsValid && authorBackend === CLAUDE_CODE_AGENT_RUNTIME_BACKEND
      ? CODEX_AGENT_RUNTIME_BACKEND
      : authorPairIsValid && authorBackend === CODEX_AGENT_RUNTIME_BACKEND && anthropicAvailable
        ? CLAUDE_CODE_AGENT_RUNTIME_BACKEND
        : CODEX_AGENT_RUNTIME_BACKEND;
  const reviewerModel = getDefaultSessionStartModelIdForBackend(reviewerBackend);
  return {
    currentModel: isSessionStartModelAllowedForBackend(reviewerModel, reviewerBackend)
      ? reviewerModel
      : getDefaultSessionStartModelIdForBackend(CODEX_AGENT_RUNTIME_BACKEND),
    agentRuntimeBackend: reviewerBackend,
  };
}

export function resolveBaseModelForAutomaticRouting(model: string | null | undefined): {
  currentModel: string;
  agentRuntimeBackend: AgentRuntimeBackend;
} {
  const requestedModelId = extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(model));
  const agentRuntimeBackend =
    (requestedModelId ? getAgentRuntimeBackendForModel(requestedModelId) : undefined) ?? CODEX_AGENT_RUNTIME_BACKEND;
  return {
    currentModel: requestedModelId ?? getDefaultSessionStartModelIdForBackend(agentRuntimeBackend),
    agentRuntimeBackend,
  };
}

/**
 * Resolve the model+backend a verification session should run on.
 *
 * A known, valid parent backend/model pair verifies on that same backend/model.
 * A parent that is absent, retired, unknown, or has an invalid pair falls back
 * to the requesting user's stored default model (`userDefaultModel`, manual QA
 * only — automated callers pass null) and, absent a usable default, to the
 * default Codex verifier instead of deriving backend from model alone.
 */
export function resolveVerificationModel(
  parent: {
    parentModel: string | null | undefined;
    parentAgentRuntimeBackend: AgentRuntimeBackend | null | undefined;
  },
  userDefaultModel?: string | null,
): {
  currentModel: string;
  agentRuntimeBackend: AgentRuntimeBackend;
} {
  const parentModelId = extractModelId(normalizeRetiredBasetenModelId(parent.parentModel));
  if (
    parentModelId &&
    parent.parentAgentRuntimeBackend &&
    isSessionStartModelAllowedForBackend(parentModelId, parent.parentAgentRuntimeBackend)
  ) {
    return { currentModel: parentModelId, agentRuntimeBackend: parent.parentAgentRuntimeBackend };
  }
  // Manual QA with no explicit/parent model: verify on the requesting user's
  // stored default model. It is stored backend-agnostically, so derive the
  // backend from the model and validate the pair before trusting it; an unknown
  // or disallowed default falls through to the global Codex default.
  const userDefaultModelId = extractSessionStartModelIdAnyBackend(normalizeRetiredBasetenModelId(userDefaultModel));
  if (userDefaultModelId) {
    const userDefaultBackend = getAgentRuntimeBackendForModel(userDefaultModelId);
    if (userDefaultBackend && isSessionStartModelAllowedForBackend(userDefaultModelId, userDefaultBackend)) {
      return { currentModel: userDefaultModelId, agentRuntimeBackend: userDefaultBackend };
    }
  }
  return resolveBaseModelForAutomaticRouting(null);
}
