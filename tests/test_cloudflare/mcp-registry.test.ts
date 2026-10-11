import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import {
  buildManagedMcpRuntimeConfig,
  createMcpServer,
  McpRegistryValidationError,
  normalizeMcpServerInput,
  updateMcpServer,
} from "../../apps/control-plane-worker/src/integrations/mcp-registry";
import type { McpServerRecord } from "../../shared/types/mcp";

describe("MCP registry validation", () => {
  it("normalizes remote MCP server config and collects header secret refs", () => {
    const input = normalizeMcpServerInput({
      name: "Docs",
      description: "Documentation MCP",
      transport: "http",
      url: "https://mcp.example.com/sse",
      headers: {
        authorization: { secretRef: "DOCS_MCP_TOKEN" },
      },
      secretRefs: ["EXTRA_SECRET"],
      enabled: true,
    });

    expect(input).toMatchObject({
      name: "Docs",
      transport: "http",
      url: "https://mcp.example.com/sse",
      enabled: true,
      scope: { type: "business" },
    });
    expect(input.secretRefs).toEqual(["DOCS_MCP_TOKEN", "EXTRA_SECRET"]);
    expect(input.headers).toEqual({ authorization: { secretRef: "DOCS_MCP_TOKEN" } });
  });

  it("caps combined header and explicit secret refs", () => {
    expect(() =>
      normalizeMcpServerInput({
        name: "Docs",
        transport: "http",
        url: "https://mcp.example.com/sse",
        headers: Object.fromEntries(
          Array.from({ length: 50 }, (_, index) => [`x-secret-${index}`, { secretRef: `HEADER_SECRET_${index}` }]),
        ),
        secretRefs: Array.from({ length: 50 }, (_, index) => `EXTRA_SECRET_${index}`),
      }),
    ).toThrow(new McpRegistryValidationError("secretRefs has too many entries"));
  });

  it("requires HTTPS for remote MCP servers", () => {
    expect(() =>
      normalizeMcpServerInput({
        name: "Local",
        transport: "http",
        url: "http://mcp.example.com",
      }),
    ).toThrow(new McpRegistryValidationError("remote MCP server URL must use HTTPS"));
  });

  it("requires stdio MCP servers to use command instead of URL", () => {
    expect(() =>
      normalizeMcpServerInput({
        name: "Local",
        transport: "stdio",
        command: "node",
        url: "https://mcp.example.com",
      }),
    ).toThrow(new McpRegistryValidationError("url is not allowed for stdio MCP servers"));

    expect(() =>
      normalizeMcpServerInput({
        name: "Local",
        transport: "stdio",
      }),
    ).toThrow(new McpRegistryValidationError("command is required for stdio MCP servers"));
  });

  it("rejects plaintext header values", () => {
    expect(() =>
      normalizeMcpServerInput({
        name: "Docs",
        transport: "http",
        url: "https://mcp.example.com",
        headers: {
          authorization: { value: "Bearer token" },
        },
      }),
    ).toThrow(new McpRegistryValidationError("headers.authorization must set secretRef"));
  });

  it("rejects duplicate header names regardless of case", () => {
    expect(() =>
      normalizeMcpServerInput({
        name: "Docs",
        transport: "http",
        url: "https://mcp.example.com",
        headers: {
          Authorization: { secretRef: "DOCS_MCP_TOKEN" },
          authorization: { secretRef: "OTHER_TOKEN" },
        },
      }),
    ).toThrow(new McpRegistryValidationError("Duplicate header name: authorization"));
  });

  it("caps and deduplicates repository scope", () => {
    const input = normalizeMcpServerInput({
      name: "Docs",
      transport: "http",
      url: "https://mcp.example.com",
      scope: {
        type: "repositories",
        repositories: [
          { owner: "Acme", name: "Repo" },
          { owner: "acme", name: "repo" },
        ],
      },
    });

    expect(input.scope).toEqual({ type: "repositories", repositories: [{ owner: "acme", name: "repo" }] });

    expect(() =>
      normalizeMcpServerInput({
        name: "Docs",
        transport: "http",
        url: "https://mcp.example.com",
        scope: {
          type: "repositories",
          repositories: Array.from({ length: 101 }, (_, index) => ({ owner: "acme", name: `repo-${index}` })),
        },
      }),
    ).toThrow(new McpRegistryValidationError("scope.repositories has too many entries"));
  });

  it("maps duplicate active names to registry validation errors", async () => {
    const uniqueError = new Error("D1_ERROR: UNIQUE constraint failed: idx_mcp_servers_business_name_active");
    let callCount = 0;
    const db = {
      prepare() {
        return {
          bind() {
            return {
              run() {
                callCount += 1;
                if (callCount === 1) return { success: true, meta: { changes: 0 } };
                throw uniqueError;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const body = { name: "Docs", transport: "http", url: "https://mcp.example.com" };

    await expect(createMcpServer(db, "biz-1", 1, body)).rejects.toThrow(
      new McpRegistryValidationError("MCP server name already exists"),
    );
    await expect(updateMcpServer(db, "biz-1", "mcp-1", body)).rejects.toThrow(
      new McpRegistryValidationError("MCP server name already exists"),
    );
  });

  it("builds runtime config without embedding secret values in server config", () => {
    const server: McpServerRecord = {
      id: "mcp_1",
      businessId: "biz-1",
      name: "Docs",
      description: null,
      transport: "http",
      command: null,
      url: "https://mcp.example.com",
      args: [],
      headers: { authorization: { secretRef: "DOCS_MCP_TOKEN" } },
      secretRefs: ["DOCS_MCP_TOKEN"],
      scope: { type: "business" },
      enabled: true,
      validationStatus: "untested",
      validationError: null,
      discoveredTools: [],
      lastValidatedAt: null,
      createdByUserId: 42,
      createdAt: 1,
      updatedAt: 1,
    };

    const runtime = buildManagedMcpRuntimeConfig([server], { DOCS_MCP_TOKEN: "secret-token" });

    expect(runtime.envVars).toEqual({ DOCS_MCP_TOKEN: "secret-token" });
    expect(runtime.servers).toEqual([
      {
        name: "cycloid-mcp_1",
        transport: "http",
        url: "https://mcp.example.com",
        headers: { authorization: { envVar: "DOCS_MCP_TOKEN" } },
        envVars: ["DOCS_MCP_TOKEN"],
      },
    ]);
  });

  it("skips runtime MCP servers with missing secret refs", () => {
    const server = {
      id: "mcp_1",
      businessId: "biz-1",
      name: "Docs",
      description: null,
      transport: "stdio",
      command: "npx",
      url: null,
      args: ["-y", "@example/mcp"],
      headers: {},
      secretRefs: ["DOCS_MCP_TOKEN"],
      scope: { type: "business" },
      enabled: true,
      validationStatus: "untested",
      validationError: null,
      discoveredTools: [],
      lastValidatedAt: null,
      createdByUserId: 42,
      createdAt: 1,
      updatedAt: 1,
    } satisfies McpServerRecord;

    const runtime = buildManagedMcpRuntimeConfig([server], {});

    expect(runtime.servers).toEqual([]);
    expect(runtime.envVars).toEqual({});
    expect(runtime.warnings).toEqual(["MCP server 'Docs' skipped because secret refs are missing: DOCS_MCP_TOKEN"]);
  });

  it("enforces usage event tenant matches in the migration schema", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.exec(readFileSync("apps/control-plane-worker/migrations/0176_mcp_servers.sql", "utf8"));
    db.exec(`
      INSERT INTO businesses (id, name, created_at, updated_at)
      VALUES ('biz-1', 'One', 1, 1), ('biz-2', 'Two', 1, 1);

      INSERT INTO mcp_servers (
        id, business_id, name, transport, args_json, headers_json, secret_refs_json, scope_json,
        enabled, validation_status, discovered_tools_json, created_at, updated_at
      )
      VALUES ('mcp-1', 'biz-1', 'Docs', 'http', '[]', '{}', '[]', '{"type":"business"}', 1, 'untested', '[]', 1, 1);
    `);

    expect(() =>
      db
        .prepare(
          `INSERT INTO mcp_tool_usage_events (id, business_id, mcp_server_id, tool_name, status, created_at)
           VALUES ('usage-1', 'biz-2', 'mcp-1', 'search', 'started', 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
