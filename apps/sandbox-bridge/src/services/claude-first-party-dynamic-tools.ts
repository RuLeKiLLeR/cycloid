import { createSdkMcpServer, type Options, tool } from "@anthropic-ai/claude-agent-sdk";

import type { AgentRole } from "../../../../shared/agent/schema.js";
import { buildDynamicToolsBehavioralGuidance } from "../constants/bridge.js";
import {
  buildClaudeMcpContentItemsForDynamicToolResult,
  type ClaudeImageFeedbackCapability,
  type ClaudeMcpToolResultContentItem,
  defaultClaudeImageFeedbackCapability,
  filterClaudeDesktopDynamicToolSpecsForImageFeedback,
} from "./claude-image-feedback.js";
import { jsonSchemaPropertiesToZodShape } from "./dynamic-tool-zod.js";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
  type FirstPartyDynamicToolExecuteContext,
  type FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const CLAUDE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME = "cycloid_first_party_dynamic_tools";

export type ClaudeFirstPartyDynamicToolsProjection = {
  mcpServer: NonNullable<Options["mcpServers"]>[string];
  toolNames: ReadonlySet<string>;
  guidance: string;
  executeTool: (
    toolName: string,
    args: unknown,
    extra?: { signal?: unknown },
  ) => Promise<{ isError: boolean; content: ClaudeMcpToolResultContentItem[] }>;
};

type ClaudeFirstPartyDynamicToolExecuteContext = FirstPartyDynamicToolExecuteContext & {
  getRepoMemories?: () => NonNullable<FirstPartyDynamicToolExecuteContext["repoMemories"]>;
  getMemoryRefById?: () => NonNullable<FirstPartyDynamicToolExecuteContext["memoryRefById"]>;
};

function canonicalToolKey(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

export function toClaudeFirstPartyDynamicToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

export function parseClaudeFirstPartyDynamicToolName(toolName: string): { namespace: string; name: string } | null {
  const prefix = `mcp__${CLAUDE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME}__`;
  if (!toolName.startsWith(prefix)) return null;
  const encodedName = toolName.slice(prefix.length);
  const separator = encodedName.indexOf("__");
  if (separator <= 0 || separator === encodedName.length - 2) return null;
  return {
    namespace: encodedName.slice(0, separator),
    name: encodedName.slice(separator + 2),
  };
}

async function executeProjectedTool(
  spec: FirstPartyDynamicToolSpec,
  context: ClaudeFirstPartyDynamicToolExecuteContext,
  args: unknown,
  extra: { signal?: unknown } | undefined,
  imageFeedbackCapability: ClaudeImageFeedbackCapability,
  modelId: string | null,
): Promise<{ isError: boolean; content: ClaudeMcpToolResultContentItem[] }> {
  const { getRepoMemories, getMemoryRefById, ...baseContext } = context;
  const maybeSignal = extra?.signal;
  const result = await executeFirstPartyDynamicToolCall(spec.namespace, spec.name, args, {
    ...baseContext,
    ...(getRepoMemories ? { repoMemories: getRepoMemories() } : {}),
    ...(getMemoryRefById ? { memoryRefById: getMemoryRefById() } : {}),
    ...(maybeSignal instanceof AbortSignal ? { signal: maybeSignal } : {}),
  });
  const imageFeedback = await buildClaudeMcpContentItemsForDynamicToolResult({
    result,
    capability: imageFeedbackCapability,
    promptLog: context.promptLog ?? null,
  });
  if (imageFeedback.unsupportedReason) {
    context.promptLog?.warn(
      {
        event: "desktop.model_image_feedback_unsupported",
        backend: "claude_code",
        modelId,
        reason: imageFeedback.unsupportedReason,
        registrationBlocked: false,
      },
      "Claude Code desktop image feedback is unavailable",
    );
  }
  return {
    isError: !result.success,
    content: imageFeedback.content,
  };
}

function dynamicToolToMcpTool(
  spec: FirstPartyDynamicToolSpec,
  context: ClaudeFirstPartyDynamicToolExecuteContext,
  imageFeedbackCapability: ClaudeImageFeedbackCapability,
  modelId: string | null,
) {
  return tool(
    toClaudeFirstPartyDynamicToolName(spec.namespace, spec.name),
    `${spec.description}\n\nCanonical first-party dynamic tool name: \`${canonicalToolKey(spec.namespace, spec.name)}\`.`,
    jsonSchemaPropertiesToZodShape(spec.inputSchema),
    (args, extra) =>
      executeProjectedTool(
        spec,
        context,
        args,
        extra as { signal?: unknown } | undefined,
        imageFeedbackCapability,
        modelId,
      ),
    { alwaysLoad: true },
  );
}

export function buildClaudeFirstPartyDynamicToolsProjection(
  env: NodeJS.ProcessEnv | Record<string, string>,
  context: ClaudeFirstPartyDynamicToolExecuteContext,
  options: {
    agentRole?: AgentRole;
    imageFeedbackCapability?: ClaudeImageFeedbackCapability;
    modelId?: string | null;
  } = {},
): ClaudeFirstPartyDynamicToolsProjection | null {
  const imageFeedbackCapability = options.imageFeedbackCapability ?? defaultClaudeImageFeedbackCapability();
  const modelId = options.modelId ?? null;
  const specs = filterClaudeDesktopDynamicToolSpecsForImageFeedback({
    specs: buildAllDynamicToolSpecs(env, options),
    capability: imageFeedbackCapability,
    modelId,
    emitUnsupported: (fields) => {
      context.promptLog?.warn(fields, "Claude Code desktop image feedback is unavailable");
    },
  });
  if (specs.length === 0) return null;
  const executionContext: ClaudeFirstPartyDynamicToolExecuteContext = {
    ...context,
    ...(options.agentRole ? { agentRole: options.agentRole } : {}),
  };
  const toolNames = new Set(specs.map((spec) => canonicalToolKey(spec.namespace, spec.name)));
  const guidance = buildDynamicToolsBehavioralGuidance(toolNames);
  if (!guidance) return null;
  const specByClaudeToolName = new Map(
    specs.map((spec) => [toClaudeFirstPartyDynamicToolName(spec.namespace, spec.name), spec]),
  );

  return {
    toolNames,
    guidance,
    executeTool: (toolName, args, extra) => {
      const spec = specByClaudeToolName.get(toolName);
      if (!spec) throw new Error(`Unknown Claude first-party dynamic tool '${toolName}'`);
      return executeProjectedTool(spec, executionContext, args, extra, imageFeedbackCapability, modelId);
    },
    mcpServer: createSdkMcpServer({
      name: CLAUDE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME,
      version: "1.0.0",
      instructions: `${guidance}\n\nClaude Code exposes these tools through MCP names of the form \`mcp__${CLAUDE_FIRST_PARTY_DYNAMIC_TOOLS_MCP_SERVER_NAME}__<namespace>__<tool>\`; each tool description includes its canonical \`<namespace>.<tool>\` name.`,
      tools: specs.map((spec) => dynamicToolToMcpTool(spec, executionContext, imageFeedbackCapability, modelId)),
      alwaysLoad: true,
    }),
  };
}
