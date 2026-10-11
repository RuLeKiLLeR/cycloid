import {
  buildToolCatalog,
  type LoadedTool,
  loadTools,
  type ToolCatalogEntry,
  validateToolInput,
} from "../../../../shared/tools-runtime/index.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolRegistration,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";
import { EMBEDDED_FIRST_PARTY_TOOLS } from "./loaded-tools-index.js";

const LOADED_TOOLS = loadTools(EMBEDDED_FIRST_PARTY_TOOLS);

export function getLoadedFirstPartyToolKeys(): ReadonlySet<string> {
  return new Set(flattenLoadedToolEntries().map((entry) => `${entry.namespace}.${entry.name}`));
}

export function buildLoadedFirstPartyDynamicToolRegistrations(): FirstPartyDynamicToolRegistration[] {
  return LOADED_TOOLS.flatMap((tool) =>
    buildToolCatalog([tool], allSecretsPresentEnv(tool)).map((entry) => ({
      namespace: entry.namespace,
      name: entry.name,
      planMode: entry.planMode,
      buildSpecs: (env) => {
        if (!isLoadedEntryAvailable(tool, entry, env)) return [];
        return [toFirstPartySpec(entry)];
      },
      execute: (args, context) =>
        entry.method.execute(args, toToolExecutionContext(context)) as Promise<FirstPartyDynamicToolCallResult>,
      validateInput: (args) => validateToolInput(entry, args),
      redactPersistedInput: (args) => normalizeRedactedInput(entry.method.redactPersistedInput?.(args)),
    })),
  );
}

function flattenLoadedToolEntries(): ToolCatalogEntry[] {
  return LOADED_TOOLS.flatMap((tool) => buildToolCatalog([tool], allSecretsPresentEnv(tool)));
}

function allSecretsPresentEnv(tool: LoadedTool): Record<string, string> {
  return Object.fromEntries(tool.manifest.secrets.map((secret) => [secret.name, "present"]));
}

function isLoadedEntryAvailable(
  tool: LoadedTool,
  entry: ToolCatalogEntry,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  if (!tool.manifest.secrets.every((secret) => Boolean(env[secret.name]))) return false;
  return entry.method.isAvailable?.(env) ?? true;
}

function toFirstPartySpec(entry: ToolCatalogEntry): FirstPartyDynamicToolSpec {
  return {
    namespace: entry.namespace,
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema as Record<string, unknown>,
  };
}

function toToolExecutionContext(context: FirstPartyDynamicToolExecuteContext): FirstPartyDynamicToolExecuteContext & {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
} {
  return {
    ...context,
    fetchImpl: context.fetchImpl ?? fetch,
    signal: context.signal ?? new AbortController().signal,
  };
}

function normalizeRedactedInput(value: unknown): Record<string, unknown> | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
