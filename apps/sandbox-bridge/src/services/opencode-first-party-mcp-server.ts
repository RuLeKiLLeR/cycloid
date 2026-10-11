import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { jsonSchemaPropertiesToZodShape } from "./dynamic-tool-zod.js";
import {
  appendOpencodeMemoryTelemetry,
  buildOpencodeFirstPartyDynamicToolSpecs,
  executeOpencodeFirstPartyDynamicTool,
  loadOpencodeAgentProfile,
  loadOpencodeMemoryContext,
  toOpencodeFirstPartyDynamicToolName,
} from "./opencode-first-party-dynamic-tools.js";
import {
  buildOpencodeMcpContentItemsForDynamicToolResult,
  defaultOpencodeImageFeedbackCapability,
  resolveOpencodeImageFeedbackModelId,
} from "./opencode-image-feedback.js";

// Runs as a stdio MCP subprocess that opencode spawns. It is reached by
// re-invoking the bundled bridge entrypoint (`node bundle.js --first-party-mcp-server`),
// NOT a loose `.ts` file via tsx - the E2B image ships only `bundle.js`, so the
// previous `tsx/cli` launch crashed with MODULE_NOT_FOUND at every prompt.
export async function runOpencodeFirstPartyMcpServer(): Promise<void> {
  const server = new McpServer({ name: "cycloid_first_party_dynamic_tools", version: "1.0.0" });

  for (const spec of buildOpencodeFirstPartyDynamicToolSpecs(process.env)) {
    server.registerTool(
      toOpencodeFirstPartyDynamicToolName(spec.namespace, spec.name),
      {
        description: `${spec.description}\n\nCanonical first-party dynamic tool name: \`${spec.namespace}.${spec.name}\`.`,
        inputSchema: jsonSchemaPropertiesToZodShape(spec.inputSchema),
      },
      async (args, extra) => {
        const maybeSignal = extra.signal;
        const agentProfile = loadOpencodeAgentProfile(process.env);
        const memoryContext = loadOpencodeMemoryContext(process.env);
        const result = await executeOpencodeFirstPartyDynamicTool(spec.namespace, spec.name, args, {
          env: process.env,
          cwd: process.cwd(),
          ...(agentProfile ? { agentProfile } : {}),
          ...memoryContext,
          recordTelemetry: (event, fields) => appendOpencodeMemoryTelemetry(process.env, event, fields),
          ...(maybeSignal instanceof AbortSignal ? { signal: maybeSignal } : {}),
        });
        const modelId = resolveOpencodeImageFeedbackModelId(process.env);
        const capability = defaultOpencodeImageFeedbackCapability(modelId);
        const imageFeedback = await buildOpencodeMcpContentItemsForDynamicToolResult({
          result,
          capability,
        });
        if (imageFeedback.unsupportedReason) {
          process.stderr.write(
            `${JSON.stringify({
              event: "desktop.model_image_feedback_unsupported",
              backend: "opencode",
              modelId,
              reason: imageFeedback.unsupportedReason,
              registrationBlocked: false,
            })}\n`,
          );
        }
        return {
          isError: !result.success,
          content: imageFeedback.content,
        };
      },
    );
  }

  await server.connect(new StdioServerTransport());
}
