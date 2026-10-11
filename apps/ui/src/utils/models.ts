import { AGENT_RUNTIME_BACKEND_NAMES } from "../../../../shared/agent/agent-runtime-backend";
import type { BootstrapModelOption } from "../../../../shared/types/bootstrap";
import type { ModelSelection, Provider } from "../types";

export const REASONING_PRESET_ORDER = ["max", "xhigh", "high", "medium", "low"] as const;

type ModelOption = {
  id: string;
  label: string;
  providerID: string;
  modelID: string;
  disabled?: boolean;
  disabledReason?: string;
  groupLabel: string;
};

/**
 * Parse a model identifier string into a ModelSelection.
 *
 * Accepts formats:
 *   - "provider:modelId"
 *   - "provider/modelId"
 *   - bare "modelId" (requires providers list to resolve provider)
 *
 * When given a bare model ID, falls back to searching the providers list.
 * If providers is not supplied or the model is not found, providerID defaults to "openai".
 */
export function parseModelSelection(raw: unknown, providers?: Provider[]): ModelSelection | undefined {
  const value = extractModelString(raw);
  if (!value) return undefined;

  // Try "provider:modelId" or "provider/modelId" format
  for (const sep of [":", "/"]) {
    const idx = value.indexOf(sep);
    if (idx <= 0 || idx >= value.length - 1) continue;
    const providerID = value.slice(0, idx);
    const modelID = value.slice(idx + 1);
    if (providers ? providers.some((p) => p.id === providerID) : providerID === "openai") {
      return { providerID, modelID };
    }
  }

  // Bare model ID: resolve provider from the providers list
  if (providers) {
    for (const p of providers) {
      if (p.models.some((m) => m.id === value)) {
        return { providerID: p.id, modelID: value };
      }
    }
  }

  // Fallback: default provider
  return { providerID: "openai", modelID: value };
}

export function findModelOption(
  providers: Provider[],
  selection: ModelSelection | null | undefined,
): BootstrapModelOption | undefined {
  if (!selection) return undefined;
  const provider = providers.find((candidate) => candidate.id === selection.providerID);
  return provider?.models.find((model) => model.id === selection.modelID);
}

export function getReasoningEffortsForModel(
  providers: Provider[],
  selection: ModelSelection | null | undefined,
): string[] {
  const reasoning = findModelOption(providers, selection)?.reasoning;
  if (!reasoning || reasoning.efforts.length === 0) return [];
  const supportedEfforts = new Set(reasoning.efforts);
  return REASONING_PRESET_ORDER.filter((effort) => supportedEfforts.has(effort));
}

export function getDefaultReasoningEffortForModel(
  providers: Provider[],
  selection: ModelSelection | null | undefined,
): string | undefined {
  const model = findModelOption(providers, selection);
  const reasoning = model?.reasoning;
  if (!reasoning || reasoning.efforts.length === 0) return undefined;
  const supportedEfforts = new Set(reasoning.efforts);
  const reasoningEfforts: string[] = REASONING_PRESET_ORDER.filter((effort) => supportedEfforts.has(effort));
  if (reasoningEfforts.length === 0) return undefined;
  if (reasoning.default && reasoningEfforts.includes(reasoning.default)) {
    return reasoning.default;
  }
  if (reasoningEfforts.includes("high")) {
    return "high";
  }
  return reasoningEfforts[0];
}

export function buildModelOptions(providers: Provider[]): ModelOption[] {
  const options = providers.flatMap((provider) =>
    provider.models.map((model) => {
      const disabled = provider.hasApiKey === false;
      const disabledReason = disabled ? "API key required" : undefined;
      return {
        id: buildModelOptionId(provider.id, model.id),
        label: model.name,
        providerID: provider.id,
        modelID: model.id,
        disabled,
        disabledReason,
        groupLabel: getModelGroupLabel(provider, model),
      };
    }),
  );

  // Keep groups in their first-seen (registry) order, but sort models within
  // each group by name using natural/numeric collation so e.g. GPT-5.4 < GPT-5.6
  // < GPT-5.6 Luna instead of raw registry declaration order.
  const groupOrder = new Map<string, number>();
  for (const option of options) {
    if (!groupOrder.has(option.groupLabel)) groupOrder.set(option.groupLabel, groupOrder.size);
  }
  return options.sort((a, b) => {
    const groupDelta = (groupOrder.get(a.groupLabel) ?? 0) - (groupOrder.get(b.groupLabel) ?? 0);
    if (groupDelta !== 0) return groupDelta;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
  });
}

function buildModelOptionId(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`;
}

function getModelGroupLabel(provider: Provider, model: BootstrapModelOption): string {
  const backend = model.backends?.[0];
  if (backend && backend in AGENT_RUNTIME_BACKEND_NAMES) {
    return AGENT_RUNTIME_BACKEND_NAMES[backend as keyof typeof AGENT_RUNTIME_BACKEND_NAMES];
  }
  return provider.name;
}

function extractModelString(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const id = obj.modelID ?? obj.modelId ?? obj.id;
    if (typeof id === "string") {
      const trimmed = id.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}
