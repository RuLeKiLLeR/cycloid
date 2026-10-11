import type { McpDiscoveredTool, McpServerRecord } from "../../../../shared/types/mcp.js";
import { getBusinessEgressPolicy } from "../business/db";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { completeMcpServerValidation, getMcpServer, resetMcpServerValidation } from "./mcp-registry";

type McpJsonRpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};

type McpJsonRpcResult = {
  body: McpJsonRpcResponse;
  sessionId: string | null;
};

export type McpToolDiscovery = (server: McpServerRecord, env: Env) => Promise<McpDiscoveredTool[]>;

function resolveValidationHeaders(): Headers {
  return new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
}

function parseSseJson(text: string, expectedId: string): McpJsonRpcResponse {
  let eventData: string[] = [];
  const flush = (): McpJsonRpcResponse | null => {
    if (eventData.length === 0) return null;
    const payload = eventData.join("\n").trim();
    eventData = [];
    if (!payload || payload === "[DONE]") return null;
    const parsed = JSON.parse(payload) as McpJsonRpcResponse;
    if (parsed.id === expectedId && ("result" in parsed || "error" in parsed)) return parsed;
    return null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      const parsed = flush();
      if (parsed) return parsed;
      continue;
    }
    if (line.startsWith("data:")) eventData.push(line.slice("data:".length).trimStart());
  }
  const parsed = flush();
  if (parsed) return parsed;
  throw new Error("MCP server returned an event stream without a matching JSON-RPC response");
}

function assertJsonRpcResponse(response: McpJsonRpcResponse, expectedId: string): void {
  if (response.id !== expectedId) {
    throw new Error("MCP server returned a JSON-RPC response with an unexpected id");
  }
  if (!("result" in response) && !("error" in response)) {
    throw new Error("MCP server returned a JSON-RPC response without result or error");
  }
}

async function postJsonRpc(url: string, headers: Headers, body: Record<string, unknown>): Promise<McpJsonRpcResult> {
  const expectedId = String(body.id ?? "");
  const response = await tracedFetch(
    url,
    {
      method: "POST",
      headers,
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    },
    "mcp.validation.json_rpc",
  );
  if (!response.ok) {
    throw new Error(`MCP server returned HTTP ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const parsed = contentType.includes("text/event-stream")
    ? parseSseJson(await response.text(), expectedId)
    : ((await response.json()) as McpJsonRpcResponse);
  assertJsonRpcResponse(parsed, expectedId);
  if (parsed.error) {
    throw new Error(typeof parsed.error.message === "string" ? parsed.error.message : "MCP JSON-RPC error");
  }
  return { body: parsed, sessionId: response.headers.get("mcp-session-id") };
}

async function postJsonRpcNotification(url: string, headers: Headers, body: Record<string, unknown>): Promise<void> {
  const response = await tracedFetch(
    url,
    {
      method: "POST",
      headers,
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    },
    "mcp.validation.notification",
  );
  if (!response.ok) {
    throw new Error(`MCP server returned HTTP ${response.status}`);
  }
}

function normalizeTools(result: unknown): McpDiscoveredTool[] {
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) {
    throw new Error("MCP tools/list result must include a tools array");
  }
  return (result as { tools: unknown[] }).tools.map((tool, index): McpDiscoveredTool => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error(`MCP tools[${index}] must be an object`);
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new Error(`MCP tools[${index}].name must be a non-empty string`);
    }
    return {
      name: record.name,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(record.inputSchema !== undefined ? { inputSchema: record.inputSchema } : {}),
    };
  });
}

export async function discoverRemoteMcpTools(server: McpServerRecord, env: Env): Promise<McpDiscoveredTool[]> {
  if (server.transport === "stdio") {
    throw new Error("stdio MCP validation requires sandbox runtime discovery");
  }
  if (server.transport === "sse") {
    throw new Error("sse MCP validation requires sandbox runtime discovery");
  }
  if (!server.url) throw new Error("remote MCP server URL is missing");
  await assertRemoteValidationAllowed(env, server);
  const headers = resolveValidationHeaders();
  const initialized = await postJsonRpc(server.url, headers, {
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "cycloid-mcp-validator", version: "1" },
    },
  });
  if (initialized.sessionId) headers.set("mcp-session-id", initialized.sessionId);
  await postJsonRpcNotification(server.url, headers, { method: "notifications/initialized", params: {} });
  const tools = await postJsonRpc(server.url, headers, { id: "tools-list", method: "tools/list", params: {} });
  return normalizeTools(tools.body.result);
}

async function assertRemoteValidationAllowed(env: Env, server: McpServerRecord): Promise<void> {
  if (!server.url) throw new Error("remote MCP server URL is missing");
  const hostname = new URL(server.url).hostname.toLowerCase();
  const policy = await getBusinessEgressPolicy(env.DB, server.businessId);
  if (!policy?.domains.includes(hostname)) {
    throw new Error("remote MCP validation requires the server host in the business egress allowlist");
  }
}

function validationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

export async function validateMcpServerTools(
  env: Env,
  businessId: string,
  mcpServerId: string,
  validationJobId: string,
  discover: McpToolDiscovery = discoverRemoteMcpTools,
): Promise<void> {
  const server = await getMcpServer(env.DB, businessId, mcpServerId);
  if (!server) return;
  try {
    const tools = await discover(server, env);
    await completeMcpServerValidation(env.DB, businessId, mcpServerId, { status: "valid", tools }, validationJobId);
  } catch (error) {
    const message = validationErrorMessage(error);
    if (server.transport === "stdio" && message === "stdio MCP validation requires sandbox runtime discovery") {
      await resetMcpServerValidation(env.DB, businessId, mcpServerId, message, validationJobId);
      return;
    }
    if (server.transport === "sse" && message === "sse MCP validation requires sandbox runtime discovery") {
      await resetMcpServerValidation(env.DB, businessId, mcpServerId, message, validationJobId);
      return;
    }
    await completeMcpServerValidation(
      env.DB,
      businessId,
      mcpServerId,
      {
        status: "invalid",
        error: message,
      },
      validationJobId,
    );
  }
}
