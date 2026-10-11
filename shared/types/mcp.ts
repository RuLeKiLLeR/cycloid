export const MCP_TRANSPORTS = ["stdio", "http", "sse"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_VALIDATION_STATUSES = ["untested", "validating", "valid", "invalid"] as const;
export type McpValidationStatus = (typeof MCP_VALIDATION_STATUSES)[number];

export interface McpHeaderConfig {
  secretRef?: string;
}

export interface McpRepoScope {
  owner: string;
  name: string;
}

export type McpServerScope = { type: "business" } | { type: "repositories"; repositories: McpRepoScope[] };

export interface McpDiscoveredTool {
  name: string;
  description?: string | null;
  inputSchema?: unknown;
}

export interface McpServerRecord {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  command: string | null;
  url: string | null;
  args: string[];
  headers: Record<string, McpHeaderConfig>;
  secretRefs: string[];
  scope: McpServerScope;
  enabled: boolean;
  validationStatus: McpValidationStatus;
  validationError: string | null;
  discoveredTools: McpDiscoveredTool[];
  lastValidatedAt: number | null;
  createdByUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  description?: string | null;
  transport: McpTransport;
  command?: string | null;
  url?: string | null;
  args?: string[];
  headers?: Record<string, McpHeaderConfig>;
  secretRefs?: string[];
  scope?: McpServerScope;
  enabled?: boolean;
}

export interface ManagedMcpRuntimeHeader {
  value?: string;
  envVar?: string;
}

export interface ManagedMcpRuntimeServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, ManagedMcpRuntimeHeader>;
  envVars?: string[];
}
