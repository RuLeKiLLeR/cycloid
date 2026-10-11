import { extractModelId } from "../../../../shared/constants/models.js";
import type { ManagedMcpRuntimeServer } from "../utils/session-config.js";

export type BuildCodexConfigOptions = {
  selectedModel?: unknown;
  projectDocFallbackFilenames?: string[];
  projectRootMarkers?: string[];
  projectDocMaxBytes?: number;
  managedMcpServers?: ManagedMcpRuntimeServer[];
};

function collectManagedMcpEnvNames(servers: ManagedMcpRuntimeServer[]): string[] {
  const names = new Set<string>();
  for (const server of servers) {
    if (!isCodexManagedMcpServerSupported(server)) continue;
    for (const name of server.envVars ?? []) names.add(name);
    for (const config of Object.values(server.headers ?? {})) {
      if (config.envVar) names.add(config.envVar);
    }
  }
  return [...names].sort();
}

function isCodexManagedMcpServerSupported(server: ManagedMcpRuntimeServer): boolean {
  return server.transport !== "sse";
}

function buildManagedMcpConfig(servers: ManagedMcpRuntimeServer[]): Record<string, unknown> | undefined {
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    if (!isCodexManagedMcpServerSupported(server)) continue;
    if (server.transport === "stdio") {
      if (!server.command) continue;
      mcp[server.name] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        ...(server.envVars?.length
          ? { environment: Object.fromEntries(server.envVars.map((name) => [name, process.env[name] ?? ""])) }
          : {}),
      };
      continue;
    }
    if (!server.url) continue;
    const headers: Record<string, string> = {};
    const envHttpHeaders: Record<string, string> = {};
    for (const [name, config] of Object.entries(server.headers ?? {})) {
      if (config.envVar) {
        envHttpHeaders[name] = config.envVar;
      } else if (config.value !== undefined) {
        headers[name] = config.value;
      }
    }
    mcp[server.name] = {
      type: "remote",
      url: server.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(envHttpHeaders).length > 0 ? { env_http_headers: envHttpHeaders } : {}),
    };
  }
  return Object.keys(mcp).length > 0 ? mcp : undefined;
}

export function buildCodexConfig(options: BuildCodexConfigOptions = {}): Record<string, unknown> {
  const model = extractModelId(options.selectedModel);
  const managedMcpServers = options.managedMcpServers ?? [];
  const mcp = buildManagedMcpConfig(managedMcpServers);
  const managedMcpEnvNames = collectManagedMcpEnvNames(managedMcpServers);
  return {
    web_search: "disabled",
    ...(model ? { model } : {}),
    ...(options.projectDocFallbackFilenames?.length
      ? { project_doc_fallback_filenames: options.projectDocFallbackFilenames }
      : {}),
    ...(options.projectRootMarkers?.length ? { project_root_markers: options.projectRootMarkers } : {}),
    ...(typeof options.projectDocMaxBytes === "number" &&
    Number.isInteger(options.projectDocMaxBytes) &&
    options.projectDocMaxBytes > 0
      ? { project_doc_max_bytes: options.projectDocMaxBytes }
      : {}),
    ...(mcp ? { mcp } : {}),
    ...(managedMcpEnvNames.length > 0 ? { managed_mcp_env_names: managedMcpEnvNames } : {}),
  };
}
