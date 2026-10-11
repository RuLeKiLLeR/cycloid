/** Canonicalize a tool name to lowercase, tolerating nullish input. */
export function normalizeToolName(tool: string | null | undefined): string {
  return tool?.toLowerCase() ?? "";
}

export function parseMcpServerName(toolName: string | null | undefined): string | null {
  const raw = toolName ?? "";
  if (!normalizeToolName(raw).startsWith("mcp__")) return null;
  const [, server] = raw.split("__", 3);
  return normalizeToolName(server) || null;
}

export type McpClass = "first_party" | "managed" | "repo" | "builtin";

export function classifyMcpServer(serverName: string | null | undefined): McpClass {
  if (!serverName) return "builtin";
  const normalized = normalizeToolName(serverName);
  if (normalized === "cycloid_first_party_dynamic_tools") return "first_party";
  if (normalized.startsWith("cycloid_") || normalized.startsWith("cycloid-") || normalized.startsWith("managed_")) {
    return "managed";
  }
  return "repo";
}
