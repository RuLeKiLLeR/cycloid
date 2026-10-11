import { z } from "zod";

import type { LoadedTool } from "./discovery.js";
import type { ToolExecutionEnv, ToolMethod, ToolPlanMode } from "./methods.js";

export type ToolCatalogEntry = {
  namespace: string;
  name: string;
  description: string;
  inputSchema: unknown;
  planMode: ToolPlanMode;
  method: ToolMethod;
};

export type ToolCatalog = ToolCatalogEntry[];

export function buildToolCatalog(loadedTools: readonly LoadedTool[], env: ToolExecutionEnv): ToolCatalog {
  const entries: ToolCatalogEntry[] = [];
  for (const tool of loadedTools) {
    if (!toolHasRequiredSecrets(tool, env)) continue;
    for (const [name, method] of Object.entries(tool.methods)) {
      if (method.isAvailable && !method.isAvailable(env)) continue;
      entries.push({
        namespace: tool.manifest.name,
        name,
        description: method.description,
        inputSchema: method.inputJsonSchema ?? z.toJSONSchema(method.inputSchema, { io: "input" }),
        planMode: method.planMode,
        method,
      });
    }
  }
  return entries;
}

export function validateToolInput(entry: ToolCatalogEntry, args: unknown): unknown {
  return entry.method.inputSchema.parse(args === undefined ? {} : args);
}

function toolHasRequiredSecrets(tool: LoadedTool, env: ToolExecutionEnv): boolean {
  return tool.manifest.secrets.every((secret) => Boolean(env[secret.name]));
}
