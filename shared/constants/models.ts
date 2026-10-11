import {
  AGENT_RUNTIME_BACKENDS,
  type AgentRuntimeBackend,
  CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
  CODEX_AGENT_RUNTIME_BACKEND,
  OPENCODE_AGENT_RUNTIME_BACKEND,
} from "../agent/agent-runtime-backend.js";
import { asNonEmptyString } from "../utils/type-guards.js";
import type { ModelPricing } from "./model-pricing.js";

export const OpenAIModel = {
  GPT56: "gpt-5.6",
  GPT56Sol: "gpt-5.6-sol",
  GPT56Terra: "gpt-5.6-terra",
  GPT56Luna: "gpt-5.6-luna",
  GPT55: "gpt-5.5",
  GPT54: "gpt-5.4",
  GPT54Pro: "gpt-5.4-pro",
  GPT54Mini: "gpt-5.4-mini",
  GPT54Nano: "gpt-5.4-nano",
  GPT53CodexSpark: "gpt-5.3-codex-spark",
  GPT53Codex: "gpt-5.3-codex",
  GPT52: "gpt-5.2",
  GPT52ChatLatest: "gpt-5.2-chat-latest",
  GPT52Codex: "gpt-5.2-codex",
} as const;

// Anthropic model ids exposed for the claude_code agent runtime backend. Ids are
// the bare first-party Claude aliases (no date suffix); the bridge passes them
// straight to `claude --model`. Only the current Opus, Sonnet, and Fable tiers
// are exposed. Verified 2026-07-06 against Anthropic model docs and pricing.
export const AnthropicModel = {
  Opus48: "claude-opus-4-8",
  Sonnet46: "claude-sonnet-4-6",
  Sonnet5: "claude-sonnet-5",
  Fable5: "claude-fable-5",
} as const;

// Internal-only Baseten model. Baseten documents Model APIs as OpenAI-compatible
// endpoints; product surfaces expose it only when the user has a validated
// internal Baseten BYOK credential.
export const BasetenModel = {
  KimiK27Code: "kimi-k2.7-code",
} as const;

type OpenAIModelId = (typeof OpenAIModel)[keyof typeof OpenAIModel];
type AnthropicModelId = (typeof AnthropicModel)[keyof typeof AnthropicModel];
type BasetenModelId = (typeof BasetenModel)[keyof typeof BasetenModel];
export type ModelId = Exclude<OpenAIModelId, typeof OpenAIModel.GPT54Pro> | AnthropicModelId | BasetenModelId;
export type ModelProvider = "openai" | "anthropic" | "baseten";
export const MODEL_PROVIDERS_SET: ReadonlySet<ModelProvider> = new Set<ModelProvider>([
  "openai",
  "anthropic",
  "baseten",
]);
// Single source of truth for reasoning effort levels, ordered cheapest/lowest
// first. The `ReasoningEffort` type is derived from this array so callers that
// rank efforts (e.g. picking the lowest a model supports) can index into it
// instead of duplicating the ordering.
export const REASONING_EFFORTS_ASCENDING = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS_ASCENDING)[number];
export type ModelSelection = { providerID: ModelProvider; modelID: string };
export const GPT54_MINI_SIDECAR_REASONING_EFFORT = "low" satisfies ReasoningEffort;

export interface ModelReasoningConfig {
  efforts: ReasoningEffort[];
  default: ReasoningEffort | undefined;
}

export interface ModelDesktopImageFeedbackConfig {
  backend: AgentRuntimeBackend;
  fixture: "known_image_fixture";
  deliveryPath: "native_mcp_tool_result_image" | "synthetic_image_context";
  verifiedAt: string;
}

// Codex and Claude Code image delivery is a verified harness capability. OpenCode
// remains model-allowlisted because image support varies across its provider models.
const BACKEND_DESKTOP_IMAGE_FEEDBACK_CONFIGS: Partial<Record<AgentRuntimeBackend, ModelDesktopImageFeedbackConfig>> = {
  [CODEX_AGENT_RUNTIME_BACKEND]: {
    backend: CODEX_AGENT_RUNTIME_BACKEND,
    fixture: "known_image_fixture",
    deliveryPath: "synthetic_image_context",
    verifiedAt: "2026-07-07",
  },
  [CLAUDE_CODE_AGENT_RUNTIME_BACKEND]: {
    backend: CLAUDE_CODE_AGENT_RUNTIME_BACKEND,
    fixture: "known_image_fixture",
    deliveryPath: "native_mcp_tool_result_image",
    verifiedAt: "2026-07-07",
  },
};

export interface ModelDefinition {
  id: ModelId;
  name: string;
  provider: ModelProvider;
  // Agent runtime backends allowed to run this model. A session create with a
  // (model, agentRuntimeBackend) pair whose backend is not listed here is
  // rejected fail-closed.
  backends: readonly AgentRuntimeBackend[];
  contextWindow?: number;
  reasoning?: ModelReasoningConfig;
  pricing?: ModelPricing;
  costTracked?: false;
  requiresCodexSubscriptionAuth?: true;
  capabilities?: { codexToolSearch: boolean };
  sessionStart?: { eligible: true; isDefault?: true };
  visibility?: "public" | "internal_probe";
  // Upstream provider wire model id, when it differs from the slash-free
  // registry `id`. Baseten Model API ids are namespaced (e.g.
  // `moonshotai/Kimi-K2.7-Code`); the embedded `/` collides with Cycloid's
  // `provider/model` parsing, so the registry id stays slash-free and the
  // real wire id lives here for the runtime adapter to send to the provider.
  providerModelId?: string;
  desktopImageFeedback?: ModelDesktopImageFeedbackConfig;
}

export const GPT54_PRO_MODEL_PRICING = {
  inputPerMillion: 30,
  outputPerMillion: 180,
  longContext: {
    thresholdTokens: 272_000,
    inputPerMillion: 60,
    outputPerMillion: 270,
  },
} as const satisfies ModelPricing;

export interface ModelApiDefinition {
  id: ModelId;
  name: string;
  label: string;
  backends: readonly AgentRuntimeBackend[];
  reasoning?: ModelReasoningConfig;
}

export interface ModelProviderGroup {
  id: ModelProvider;
  name: string;
  models: ModelApiDefinition[];
}

export const MODEL_REGISTRY: ModelDefinition[] = [
  {
    id: OpenAIModel.GPT54,
    name: "GPT-5.4",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 1_000_000,
    // Default codex model after the gpt-5.5 downgrade; carries gpt-5.5's prior
    // "medium" default so default sessions keep the same reasoning effort.
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: "medium" },
    pricing: {
      inputPerMillion: 2.5,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.25,
      longContext: {
        thresholdTokens: 272_000,
        inputPerMillion: 5,
        outputPerMillion: 22.5,
        cacheReadPerMillion: 0.5,
      },
    },
    sessionStart: { eligible: true, isDefault: true },
  },
  {
    id: OpenAIModel.GPT56,
    name: "GPT-5.6",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 1_050_000,
    // Verified 2026-07-09 against OpenAI's GPT-5.6 migration guide and model
    // catalog: the alias routes to gpt-5.6-sol and supports max effort. Pricing
    // mirrors gpt-5.6-sol since the alias resolves to it.
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
    pricing: {
      inputPerMillion: 5,
      outputPerMillion: 30,
      cacheReadPerMillion: 0.5,
      longContext: {
        thresholdTokens: 272_000,
        inputPerMillion: 10,
        outputPerMillion: 45,
        cacheReadPerMillion: 1,
      },
    },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT56Sol,
    name: "GPT-5.6 Sol",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 1_050_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
    pricing: {
      inputPerMillion: 5,
      outputPerMillion: 30,
      cacheReadPerMillion: 0.5,
      longContext: {
        thresholdTokens: 272_000,
        inputPerMillion: 10,
        outputPerMillion: 45,
        cacheReadPerMillion: 1,
      },
    },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT56Terra,
    name: "GPT-5.6 Terra",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 1_050_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
    pricing: {
      inputPerMillion: 2.5,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.25,
      longContext: {
        thresholdTokens: 272_000,
        inputPerMillion: 5,
        outputPerMillion: 22.5,
        cacheReadPerMillion: 0.5,
      },
    },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT56Luna,
    name: "GPT-5.6 Luna",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 1_050_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "medium" },
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 6,
      cacheReadPerMillion: 0.1,
      longContext: {
        thresholdTokens: 272_000,
        inputPerMillion: 2,
        outputPerMillion: 9,
        cacheReadPerMillion: 0.2,
      },
    },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT55,
    name: "GPT-5.5",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 1_000_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: "medium" },
    pricing: {
      inputPerMillion: 5,
      outputPerMillion: 30,
      cacheReadPerMillion: 0.5,
      longContext: {
        thresholdTokens: 272_000,
        inputPerMillion: 10,
        outputPerMillion: 45,
        cacheReadPerMillion: 1,
      },
    },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT54Mini,
    name: "GPT-5.4 Mini",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 400_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
    pricing: {
      inputPerMillion: 0.75,
      outputPerMillion: 4.5,
      cacheReadPerMillion: 0.075,
      // Flex bills at Batch rates: a flat 50% off standard across input,
      // cached input, and output (verified against the OpenAI pricing page,
      // June 2026). Bridge cost estimates deliberately strip this gateway-only
      // axis when deriving MODEL_PRICING.
      flex: { inputPerMillion: 0.375, outputPerMillion: 2.25, cacheReadPerMillion: 0.0375 },
    },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT54Nano,
    name: "GPT-5.4 Nano",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: false },
    contextWindow: 400_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
    pricing: { inputPerMillion: 0.2, outputPerMillion: 1.25, cacheReadPerMillion: 0.02 },
    sessionStart: { eligible: true },
  },
  {
    id: OpenAIModel.GPT53CodexSpark,
    name: "GPT-5.3 Codex Spark",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 128_000,
    reasoning: { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
    costTracked: false,
    requiresCodexSubscriptionAuth: true,
    sessionStart: { eligible: true },
    visibility: "internal_probe",
  },
  {
    id: OpenAIModel.GPT53Codex,
    name: "GPT-5.3 Codex",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 400_000,
    reasoning: { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  },
  {
    id: OpenAIModel.GPT52,
    name: "GPT-5.2",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 400_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  },
  {
    id: OpenAIModel.GPT52ChatLatest,
    name: "GPT-5.2 Chat",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 128_000,
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"], default: undefined },
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  },
  {
    id: OpenAIModel.GPT52Codex,
    name: "GPT-5.2 Codex",
    provider: "openai",
    backends: [CODEX_AGENT_RUNTIME_BACKEND],
    capabilities: { codexToolSearch: true },
    contextWindow: 400_000,
    reasoning: { efforts: ["low", "medium", "high", "xhigh"], default: "high" },
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, cacheReadPerMillion: 0.175 },
  },
  {
    id: AnthropicModel.Opus48,
    name: "Claude Opus 4.8",
    provider: "anthropic",
    backends: [CLAUDE_CODE_AGENT_RUNTIME_BACKEND],
    contextWindow: 1_000_000,
    // Verified 2026-06-29 against Claude Code model config docs and SDK
    // EffortLevel: Opus 4.8 supports low/medium/high/xhigh/max. "none" maps to
    // omitting SDK Options.effort so Claude keeps its adaptive default.
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" },
    // Bridge cost-ESTIMATE only; NOT authoritative for control-plane Anthropic
    // billing. `anthropic/cost.ts` ANTHROPIC_MESSAGES_MODEL_PRICING owns that
    // and is intentionally ~3x divergent until Phase 5.
    pricing: { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 },
    sessionStart: { eligible: true, isDefault: true },
  },
  {
    id: AnthropicModel.Sonnet46,
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    backends: [CLAUDE_CODE_AGENT_RUNTIME_BACKEND],
    contextWindow: 1_000_000,
    // Claude Code model config docs: Sonnet 4.6 supports low/medium/high/max;
    // xhigh falls back to high upstream, so keep it invalid in Cycloid.
    reasoning: { efforts: ["none", "low", "medium", "high", "max"], default: "high" },
    // Bridge cost-ESTIMATE only; NOT authoritative for control-plane Anthropic
    // billing. `anthropic/cost.ts` ANTHROPIC_MESSAGES_MODEL_PRICING owns that
    // and is intentionally ~3x divergent until Phase 5.
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
    sessionStart: { eligible: true },
  },
  {
    id: AnthropicModel.Sonnet5,
    name: "Claude Sonnet 5",
    provider: "anthropic",
    backends: [CLAUDE_CODE_AGENT_RUNTIME_BACKEND],
    contextWindow: 1_000_000,
    // Verified 2026-07-12 against Anthropic's Sonnet 5 launch documentation:
    // adaptive thinking supports low/medium/high/xhigh/max; "none" omits the
    // SDK effort option and lets Claude use its adaptive default.
    reasoning: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], default: "high" },
    // Bridge cost-estimate only; authoritative Anthropic Messages pricing lives
    // in apps/control-plane-worker/src/anthropic/cost.ts.
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
    sessionStart: { eligible: true },
  },
  {
    id: AnthropicModel.Fable5,
    name: "Claude Fable 5",
    provider: "anthropic",
    backends: [CLAUDE_CODE_AGENT_RUNTIME_BACKEND],
    contextWindow: 1_000_000,
    // Fable's adaptive thinking means "none" would safely omit SDK
    // Options.effort, as with Opus/Sonnet. We intentionally require an explicit
    // effort for this higher-cost model and default to the existing Claude
    // Code high effort.
    reasoning: { efforts: ["low", "medium", "high", "xhigh", "max"], default: "high" },
    // Bridge cost-ESTIMATE only; NOT authoritative for control-plane Anthropic
    // billing. `anthropic/cost.ts` ANTHROPIC_MESSAGES_MODEL_PRICING owns that
    // verified Messages API table.
    pricing: { inputPerMillion: 10, outputPerMillion: 50, cacheReadPerMillion: 1, cacheWritePerMillion: 12.5 },
    sessionStart: { eligible: true },
  },
  {
    id: BasetenModel.KimiK27Code,
    name: "Kimi K2.7 Code",
    provider: "baseten",
    backends: [OPENCODE_AGENT_RUNTIME_BACKEND],
    contextWindow: 262_000,
    // Verified 2026-07-04 against Baseten Model APIs docs, model library, and
    // changelog: wire id `moonshotai/Kimi-K2.7-Code`, 262k served
    // context/output, OpenAI SDK compatible, MIT license, tool calling
    // supported for all Model APIs.
    providerModelId: "moonshotai/Kimi-K2.7-Code",
    desktopImageFeedback: {
      backend: OPENCODE_AGENT_RUNTIME_BACKEND,
      fixture: "known_image_fixture",
      deliveryPath: "native_mcp_tool_result_image",
      verifiedAt: "2026-07-07",
    },
    pricing: { inputPerMillion: 0.95, outputPerMillion: 4, cacheReadPerMillion: 0.16 },
    sessionStart: { eligible: true, isDefault: true },
  },
];

export const MODEL_PROVIDER_NAMES: Record<ModelProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  baseten: "Baseten",
};

function buildSessionStartModelIdsByBackend(): Record<AgentRuntimeBackend, readonly ModelId[]> {
  const byBackend = Object.fromEntries(AGENT_RUNTIME_BACKENDS.map((backend) => [backend, [] as ModelId[]])) as Record<
    AgentRuntimeBackend,
    ModelId[]
  >;
  for (const model of MODEL_REGISTRY) {
    if (!model.sessionStart?.eligible) continue;
    for (const backend of model.backends) {
      if (!modelSupportsRequiredSessionStartCapabilities(model, backend)) continue;
      byBackend[backend].push(model.id);
    }
  }
  return byBackend;
}

function modelSupportsRequiredSessionStartCapabilities(model: ModelDefinition, backend: AgentRuntimeBackend): boolean {
  if (backend !== CODEX_AGENT_RUNTIME_BACKEND) return true;
  return model.capabilities?.codexToolSearch === true;
}

function buildDefaultSessionStartModelIdByBackend(): Record<AgentRuntimeBackend, ModelId> {
  const defaults = {} as Record<AgentRuntimeBackend, ModelId>;
  for (const backend of AGENT_RUNTIME_BACKENDS) {
    const backendDefaults = MODEL_REGISTRY.filter(
      (model) =>
        model.sessionStart?.eligible && model.sessionStart.isDefault === true && model.backends.includes(backend),
    );
    if (backendDefaults.length !== 1) {
      throw new Error(`Expected exactly one default session-start model for ${backend}, got ${backendDefaults.length}`);
    }
    defaults[backend] = backendDefaults[0]!.id;
  }
  return defaults;
}

// User-selectable session starts are limited to frontier coding models because
// primary build sessions can run for minutes and own the core implementation
// quality tradeoff. Cheaper models remain internal sidecar choices.
export const SESSION_START_MODEL_IDS_BY_BACKEND = buildSessionStartModelIdsByBackend();

// Default model ids for each backend. Used when a session is created without an
// explicit model selection.
export const DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND = buildDefaultSessionStartModelIdByBackend();

// The bare default stays scoped to the default (codex) backend so existing
// callers that do not thread a backend keep their current behavior.
export const DEFAULT_SESSION_START_MODEL_ID: ModelId =
  DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND[CODEX_AGENT_RUNTIME_BACKEND];

export const VALID_MODEL_IDS = new Set<string>(MODEL_REGISTRY.map((model) => model.id));

export const VALID_SESSION_START_MODEL_IDS_BY_BACKEND: Record<AgentRuntimeBackend, ReadonlySet<string>> = {
  [CODEX_AGENT_RUNTIME_BACKEND]: new Set<string>(SESSION_START_MODEL_IDS_BY_BACKEND[CODEX_AGENT_RUNTIME_BACKEND]),
  [CLAUDE_CODE_AGENT_RUNTIME_BACKEND]: new Set<string>(
    SESSION_START_MODEL_IDS_BY_BACKEND[CLAUDE_CODE_AGENT_RUNTIME_BACKEND],
  ),
  [OPENCODE_AGENT_RUNTIME_BACKEND]: new Set<string>(SESSION_START_MODEL_IDS_BY_BACKEND[OPENCODE_AGENT_RUNTIME_BACKEND]),
};

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  ...Object.fromEntries(
    MODEL_REGISTRY.flatMap((model) => (model.contextWindow === undefined ? [] : [[model.id, model.contextWindow]])),
  ),
};

export const MODEL_PROVIDERS: Record<string, ModelProvider> = {
  ...Object.fromEntries(MODEL_REGISTRY.map((model) => [model.id, model.provider])),
};

export const MODEL_REASONING_CONFIG = Object.fromEntries(
  MODEL_REGISTRY.flatMap((model) => (model.reasoning ? [[model.id, model.reasoning]] : [])),
) as Partial<Record<string, ModelReasoningConfig>>;

const MODEL_DEFINITIONS_BY_ID = Object.fromEntries(MODEL_REGISTRY.map((model) => [model.id, model])) as Record<
  string,
  ModelDefinition
>;

function splitModelIdentifier(value: string): { providerID?: ModelProvider; modelID: string } | undefined {
  let hasSeparator = false;
  for (const separator of [":", "/"] as const) {
    const index = value.indexOf(separator);
    if (index <= 0 || index >= value.length - 1) continue;
    hasSeparator = true;
    const providerID = value.slice(0, index);
    const modelID = value.slice(index + 1);
    if (MODEL_PROVIDERS_SET.has(providerID as ModelProvider) && modelID.length > 0) {
      return { providerID: providerID as ModelProvider, modelID };
    }
  }

  if (hasSeparator) return undefined;
  return value.length > 0 ? { modelID: value } : undefined;
}

function getRawModelValue(raw: unknown): string | undefined {
  if (typeof raw === "string") return asNonEmptyString(raw);
  if (!raw || typeof raw !== "object") return undefined;

  const value = raw as Record<string, unknown>;
  return asNonEmptyString(value.modelID) ?? asNonEmptyString(value.modelId) ?? asNonEmptyString(value.id);
}

function getExplicitProvider(raw: unknown): ModelProvider | undefined {
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    const providerID = asNonEmptyString(value.providerID) ?? asNonEmptyString(value.providerId);
    if (providerID && MODEL_PROVIDERS_SET.has(providerID as ModelProvider)) {
      return providerID as ModelProvider;
    }
  }

  const modelValue = getRawModelValue(raw);
  if (!modelValue) return undefined;
  return splitModelIdentifier(modelValue)?.providerID;
}

export function extractModelId(raw: unknown): string | undefined {
  const value = getRawModelValue(raw);
  if (!value) return undefined;
  return splitModelIdentifier(value)?.modelID;
}

/** Normalize retired Baseten ids only when reading persisted routing state. */
export function normalizeRetiredBasetenModelId(raw: unknown): string | undefined {
  const modelID = extractModelId(raw);
  if (
    modelID === "glm-4.7" ||
    modelID === "zai-org/GLM-4.7" ||
    modelID === "gpt-oss-120b" ||
    modelID === "openai/gpt-oss-120b"
  ) {
    return BasetenModel.KimiK27Code;
  }
  return modelID;
}

/**
 * Resolve a session-start model id accepted by ANY agent runtime backend.
 * Used by surfaces that store a model preference without a fixed backend
 * (user default-model setting); the backend is derived from the model via
 * {@link getAgentRuntimeBackendForModel} at session create.
 */
export function extractSessionStartModelIdAnyBackend(raw: unknown): ModelId | undefined {
  const modelID = extractModelId(raw);
  if (!modelID) return undefined;
  const allowed = AGENT_RUNTIME_BACKENDS.some((backend) =>
    VALID_SESSION_START_MODEL_IDS_BY_BACKEND[backend].has(modelID),
  );
  return allowed ? (modelID as ModelId) : undefined;
}

/**
 * Primary agent runtime backend for `modelId` (first registry entry), or
 * undefined for unknown models.
 *
 * Only safe while every registry model maps to exactly one backend: with a
 * multi-backend model this silently picks the FIRST listed backend, which may
 * be wrong for the request context. If a model ever lists multiple backends,
 * replace implicit derivation with an explicit backend at the call sites.
 */
export function getAgentRuntimeBackendForModel(modelId: string): AgentRuntimeBackend | undefined {
  return getBackendsForModel(modelId)?.[0];
}

/** Session-start model ids selectable for the given agent runtime backend. */
export function getSessionStartModelIdsForBackend(backend: AgentRuntimeBackend): readonly ModelId[] {
  return SESSION_START_MODEL_IDS_BY_BACKEND[backend];
}

/** Default session-start model id for the given agent runtime backend. */
export function getDefaultSessionStartModelIdForBackend(backend: AgentRuntimeBackend): ModelId {
  return DEFAULT_SESSION_START_MODEL_ID_BY_BACKEND[backend];
}

/** Whether `modelId` may start a session on the given agent runtime backend. */
export function isSessionStartModelAllowedForBackend(modelId: string, backend: AgentRuntimeBackend): boolean {
  return VALID_SESSION_START_MODEL_IDS_BY_BACKEND[backend].has(modelId);
}

/**
 * Resolve a session-start model id for a specific backend, returning undefined
 * when the raw value is absent or not allowed for that backend. Callers fall
 * back to {@link getDefaultSessionStartModelIdForBackend} on undefined and
 * reject (400) when a model was explicitly requested but disallowed.
 */
export function extractSessionStartModelIdForBackend(raw: unknown, backend: AgentRuntimeBackend): ModelId | undefined {
  const modelID = extractModelId(raw);
  if (!modelID || !isSessionStartModelAllowedForBackend(modelID, backend)) return undefined;
  return modelID as ModelId;
}

/** Agent runtime backends allowed to run `modelId`, or undefined when unknown. */
export function getBackendsForModel(modelId: string): readonly AgentRuntimeBackend[] | undefined {
  return MODEL_DEFINITIONS_BY_ID[modelId]?.backends;
}

/** Whether `modelId` is a registry model runnable on the given backend. */
export function isModelAllowedForBackend(modelId: string, backend: AgentRuntimeBackend): boolean {
  return getBackendsForModel(modelId)?.includes(backend) ?? false;
}

export function modelSupportsCodexToolSearch(modelId: string): boolean {
  return MODEL_DEFINITIONS_BY_ID[modelId]?.capabilities?.codexToolSearch === true;
}

export function isModelCostTracked(modelId: string): boolean {
  return MODEL_DEFINITIONS_BY_ID[modelId]?.costTracked !== false;
}

export function requiresCodexSubscriptionAuthForModel(modelId: string): boolean {
  return MODEL_DEFINITIONS_BY_ID[modelId]?.requiresCodexSubscriptionAuth === true;
}

export function getProviderForModel(modelId: string): ModelProvider {
  return MODEL_PROVIDERS[modelId] ?? "openai";
}

export function toModelSelection(raw: unknown): ModelSelection | undefined {
  const modelID = extractModelId(raw);
  if (!modelID) return undefined;

  return {
    providerID: getExplicitProvider(raw) ?? getProviderForModel(modelID),
    modelID,
  };
}

export function getModelDefinition(raw: unknown): ModelDefinition | undefined {
  const modelID = extractModelId(raw);
  if (!modelID) return undefined;
  return MODEL_DEFINITIONS_BY_ID[modelID];
}

export function getModelDesktopImageFeedbackConfig(
  raw: unknown,
  backend: AgentRuntimeBackend,
): ModelDesktopImageFeedbackConfig | undefined {
  const model = getModelDefinition(raw);
  if (!model?.backends.includes(backend)) return undefined;

  const modelConfig = model.desktopImageFeedback;
  return modelConfig?.backend === backend ? modelConfig : BACKEND_DESKTOP_IMAGE_FEEDBACK_CONFIGS[backend];
}

export function isValidReasoningEffort(model: unknown, effort: string): boolean {
  const modelID = extractModelId(model);
  if (!modelID || !effort) return false;
  const config = MODEL_REASONING_CONFIG[modelID];
  return config ? config.efforts.includes(effort as ReasoningEffort) : false;
}

export function formatModelLabel(raw: unknown, options: { includeProvider?: boolean } = {}): string | undefined {
  const includeProvider = options.includeProvider ?? false;
  const definition = getModelDefinition(raw);
  if (definition) {
    return includeProvider ? `${MODEL_PROVIDER_NAMES[definition.provider]} / ${definition.name}` : definition.name;
  }

  const selection = toModelSelection(raw);
  if (!selection) return undefined;
  const providerName = MODEL_PROVIDER_NAMES[selection.providerID];
  return includeProvider ? `${providerName} / ${selection.modelID}` : selection.modelID;
}

function buildModelProviderGroups(models: readonly ModelDefinition[]): ModelProviderGroup[] {
  const groups = new Map<ModelProvider, ModelProviderGroup>();

  for (const model of models) {
    let group = groups.get(model.provider);
    if (!group) {
      group = { id: model.provider, name: MODEL_PROVIDER_NAMES[model.provider], models: [] };
      groups.set(model.provider, group);
    }

    group.models.push({
      id: model.id,
      name: model.name,
      label: formatModelLabel(model, { includeProvider: true }) ?? model.name,
      backends: model.backends,
      reasoning: model.reasoning,
    });
  }

  return [...groups.values()];
}

const SESSION_START_MODEL_ID_SET_ANY_BACKEND = new Set<string>(
  AGENT_RUNTIME_BACKENDS.flatMap((backend) => [...SESSION_START_MODEL_IDS_BY_BACKEND[backend]]),
);

export const PUBLIC_SESSION_START_MODEL_PROVIDER_GROUPS: ModelProviderGroup[] = buildModelProviderGroups(
  MODEL_REGISTRY.filter(
    (model) => SESSION_START_MODEL_ID_SET_ANY_BACKEND.has(model.id) && model.visibility !== "internal_probe",
  ),
);

export const CODEX_SUBSCRIPTION_SESSION_START_MODEL_PROVIDER_GROUPS: ModelProviderGroup[] = buildModelProviderGroups(
  MODEL_REGISTRY.filter(
    (model) =>
      SESSION_START_MODEL_ID_SET_ANY_BACKEND.has(model.id) &&
      (model.visibility !== "internal_probe" || model.requiresCodexSubscriptionAuth === true),
  ),
);
