import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverRemoteMcpTools } from "../../apps/control-plane-worker/src/integrations/mcp-validation";
import type { Env } from "../../apps/control-plane-worker/src/types";
import type { McpServerRecord } from "../../shared/types/mcp";

function makeServer(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "mcp_1",
    businessId: "biz-1",
    name: "Docs",
    description: null,
    transport: "http",
    command: null,
    url: "https://mcp.example.com",
    args: [],
    headers: { Authorization: { secretRef: "DOCS_MCP_TOKEN" } },
    secretRefs: ["DOCS_MCP_TOKEN"],
    scope: { type: "business" },
    enabled: true,
    validationStatus: "validating",
    validationError: null,
    discoveredTools: [],
    lastValidatedAt: null,
    createdByUserId: 42,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeEnv(domains: string[] = ["mcp.example.com"]): Env {
  return {
    DOCS_MCP_TOKEN: "secret-token",
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ egress_allowlist_json: JSON.stringify({ domains }) }),
        }),
      }),
    } as unknown as D1Database,
  } as Env;
}

describe("MCP validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers remote tools without forwarding secret-backed headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ jsonrpc: "2.0", id: "initialize", result: {} }, { headers: { "mcp-session-id": "session-1" } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: "tools-list",
          result: {
            tools: [
              {
                name: "search_docs",
                description: "Search docs",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              },
            ],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tools = await discoverRemoteMcpTools(makeServer(), makeEnv());

    expect(tools).toEqual([
      {
        name: "search_docs",
        description: "Search docs",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    const notificationHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(notificationHeaders.get("Authorization")).toBeNull();
    expect(notificationHeaders.get("mcp-session-id")).toBe("session-1");
  });

  it("fails closed unless the remote host is business-egress allowlisted", async () => {
    await expect(discoverRemoteMcpTools(makeServer(), makeEnv(["other.example.com"]))).rejects.toThrow(
      "remote MCP validation requires the server host in the business egress allowlist",
    );
  });

  it("does not validate stdio servers in the control plane worker", async () => {
    await expect(
      discoverRemoteMcpTools(
        makeServer({
          transport: "stdio",
          command: "npx",
          url: null,
        }),
        makeEnv(),
      ),
    ).rejects.toThrow("stdio MCP validation requires sandbox runtime discovery");
  });

  it("discovers tools from streamable HTTP event-stream responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":"initialize","result":{}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
            'event: message\ndata: {"jsonrpc":"2.0","id":"tools-list","result":{"tools":[\n' +
            'data: {"name":"search_cloudflare_documentation"}]}}\n\n',
          { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tools = await discoverRemoteMcpTools(
      makeServer({
        headers: {},
        secretRefs: [],
      }),
      makeEnv(),
    );

    expect(tools).toEqual([{ name: "search_cloudflare_documentation" }]);
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
  });

  it("rejects malformed tools/list results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: "initialize", result: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: "tools-list", result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverRemoteMcpTools(makeServer({ headers: {}, secretRefs: [] }), makeEnv())).rejects.toThrow(
      "MCP tools/list result must include a tools array",
    );
  });

  it("rejects JSON-RPC responses with unexpected ids", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: "wrong-id", result: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverRemoteMcpTools(makeServer({ headers: {}, secretRefs: [] }), makeEnv())).rejects.toThrow(
      "MCP server returned a JSON-RPC response with an unexpected id",
    );
  });
});
