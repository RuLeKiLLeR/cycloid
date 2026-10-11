import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Config, McpLocalConfig, OpencodeClient } from "@opencode-ai/sdk";

import type { AgentRole } from "../../../../shared/agent/schema.js";
import { buildDynamicToolsBehavioralGuidance } from "../constants/bridge.js";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
  type FirstPartyDynamicToolExecuteContext,
  type FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import {
  defaultOpencodeImageFeedbackCapability,
  type DesktopModelImageFeedbackUnsupportedFields,
  filterOpencodeDesktopDynamicToolSpecsForImageFeedback,
  type OpencodeImageFeedbackCapability,
  resolveOpencodeImageFeedbackModelId,
} from "./opencode-image-feedback.js";

export const OPENCODE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME = "cycloid_first_party_dynamic_tools";
export const OPENCODE_AGENT_PROFILE_FILE_ENV = "ARCANIST_OPENCODE_AGENT_PROFILE_FILE";
export const OPENCODE_MEMORY_CONTEXT_FILE_ENV = "ARCANIST_OPENCODE_MEMORY_CONTEXT_FILE";
export const OPENCODE_MEMORY_TELEMETRY_FILE_ENV = "ARCANIST_OPENCODE_MEMORY_TELEMETRY_FILE";

// CLI flag the bundled bridge entrypoint dispatches on to run as the stdio MCP
// server (see index.ts main()), mirroring the existing `--memory-hook` hook.
export const OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG = "--first-party-mcp-server";

export type OpencodeFirstPartyDynamicToolsProjection = {
  mcpConfig: McpLocalConfig;
  toolNames: ReadonlySet<string>;
  guidance: string;
};

function canonicalToolKey(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

export function toOpencodeFirstPartyDynamicToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

function stringEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

// The E2B image ships only the single bundled `bundle.js` (no `tsx`, no loose
// `.ts` files), so the MCP subprocess re-invokes that same bundle with the
// dispatch flag. Resolve the bundle path from an explicit override, else the
// running bridge's own entrypoint (`process.argv[1]` is `bundle.js`).
function resolveBridgeBundlePath(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return env.ARCANIST_BRIDGE_BUNDLE_PATH || process.argv[1];
}

export function buildOpencodeFirstPartyDynamicToolsProjection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  extraEnv: Record<string, string> = {},
  options: {
    agentRole?: AgentRole;
    imageFeedbackCapability?: OpencodeImageFeedbackCapability;
    modelId?: string | null;
    emitUnsupported?: (fields: DesktopModelImageFeedbackUnsupportedFields) => void;
  } = {},
): OpencodeFirstPartyDynamicToolsProjection | null {
  const childEnv = {
    ...env,
    ...extraEnv,
    ...(options.agentRole ? { ARCANIST_AGENT_ROLE: options.agentRole } : {}),
  };
  const capability =
    options.imageFeedbackCapability ??
    defaultOpencodeImageFeedbackCapability(options.modelId ?? resolveOpencodeImageFeedbackModelId(childEnv));
  const specs = filterOpencodeDesktopDynamicToolSpecsForImageFeedback({
    specs: buildAllDynamicToolSpecs(env as NodeJS.ProcessEnv | Record<string, string>, options),
    capability,
    emitUnsupported: options.emitUnsupported ?? (() => {}),
  });
  if (specs.length === 0) return null;
  const toolNames = new Set(specs.map((spec) => canonicalToolKey(spec.namespace, spec.name)));
  const guidance = buildDynamicToolsBehavioralGuidance(toolNames);
  if (!guidance) return null;
  return {
    toolNames,
    guidance,
    mcpConfig: {
      type: "local",
      command: [process.execPath, resolveBridgeBundlePath(childEnv), OPENCODE_FIRST_PARTY_MCP_SERVER_FLAG],
      environment: stringEnv(childEnv),
      enabled: true,
      timeout: 10_000,
    },
  };
}

export function applyOpencodeFirstPartyDynamicToolsConfig(
  config: Config,
  projection: OpencodeFirstPartyDynamicToolsProjection | null,
): void {
  if (!projection) return;
  config.mcp = {
    ...(config.mcp ?? {}),
    [OPENCODE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME]: projection.mcpConfig,
  };
}

export async function connectOpencodeFirstPartyDynamicTools(opts: {
  client: OpencodeClient;
  projection: OpencodeFirstPartyDynamicToolsProjection | null;
  signal: AbortSignal;
}): Promise<void> {
  if (!opts.projection) return;
  const result = await opts.client.mcp.connect({
    signal: opts.signal,
    path: { name: OPENCODE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME },
  });
  const data = "data" in result ? result.data : result;
  if (data !== true) throw new Error("opencode MCP connect returned false for Cycloid first-party dynamic tools");
}

export function buildOpencodeFirstPartyDynamicToolSpecs(
  env: NodeJS.ProcessEnv | Record<string, string>,
  options: { agentRole?: AgentRole } = {},
): FirstPartyDynamicToolSpec[] {
  return filterOpencodeDesktopDynamicToolSpecsForImageFeedback({
    specs: buildAllDynamicToolSpecs(env, options),
    capability: defaultOpencodeImageFeedbackCapability(resolveOpencodeImageFeedbackModelId(env)),
    emitUnsupported: () => {},
  });
}

export function executeOpencodeFirstPartyDynamicTool(
  namespace: string,
  name: string,
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
) {
  return executeFirstPartyDynamicToolCall(namespace, name, args, context);
}

export function loadOpencodeAgentProfile(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined {
  const file = env[OPENCODE_AGENT_PROFILE_FILE_ENV];
  if (!file || !existsSync(file)) return undefined;
  const value = readFileSync(file, "utf8").trim();
  return value.length > 0 ? value : undefined;
}

type SerializedMemoryContext = {
  repoMemories?: import("./memory-ranking.js").Memory[];
  memoryRefs?: Array<[string, import("../../../../shared/events/bridge.js").MemoryRef]>;
};

export function loadOpencodeMemoryContext(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Pick<FirstPartyDynamicToolExecuteContext, "repoMemories" | "memoryRefById"> {
  const file = env[OPENCODE_MEMORY_CONTEXT_FILE_ENV];
  if (!file || !existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SerializedMemoryContext;
    const repoMemories = Array.isArray(parsed.repoMemories) ? parsed.repoMemories : undefined;
    const memoryRefById = Array.isArray(parsed.memoryRefs) ? new Map(parsed.memoryRefs) : undefined;
    return {
      ...(repoMemories ? { repoMemories } : {}),
      ...(memoryRefById ? { memoryRefById } : {}),
    };
  } catch {
    return {};
  }
}

export function appendOpencodeMemoryTelemetry(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  event: string,
  fields: Record<string, unknown>,
): void {
  const file = env[OPENCODE_MEMORY_TELEMETRY_FILE_ENV];
  if (!file) return;
  try {
    writeFileSync(file, `${JSON.stringify({ eventName: event, ...fields })}\n`, { flag: "a", encoding: "utf8" });
  } catch {
    // Best-effort side channel; tool execution must not depend on telemetry.
  }
}
