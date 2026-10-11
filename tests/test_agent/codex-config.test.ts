import { describe, expect, it } from "vitest";

import { buildCodexConfig } from "../../apps/sandbox-bridge/src/agent/codex-config.js";

describe("buildCodexConfig", () => {
  it("disables web search when no selected model is provided", () => {
    expect(buildCodexConfig()).toEqual({ web_search: "disabled" });
  });

  it("passes through the selected model without provider prefix", () => {
    expect(buildCodexConfig({ selectedModel: "openai/gpt-5.4" })).toEqual({
      web_search: "disabled",
      model: "gpt-5.4",
    });
  });

  it("passes through Codex native project-doc config", () => {
    expect(
      buildCodexConfig({
        selectedModel: "openai/gpt-5.4",
        projectDocFallbackFilenames: ["CLAUDE.md", "agents.md"],
        projectRootMarkers: [".git"],
        projectDocMaxBytes: 32768,
      }),
    ).toEqual({
      web_search: "disabled",
      model: "gpt-5.4",
      project_doc_fallback_filenames: ["CLAUDE.md", "agents.md"],
      project_root_markers: [".git"],
      project_doc_max_bytes: 32768,
    });
  });

  it("omits an invalid project_doc_max_bytes", () => {
    expect(buildCodexConfig({ projectDocMaxBytes: -1 })).toEqual({ web_search: "disabled" });
    expect(buildCodexConfig({ projectDocMaxBytes: 1.5 })).toEqual({ web_search: "disabled" });
    // Zero would disable project-doc injection entirely; treat it as invalid.
    expect(buildCodexConfig({ projectDocMaxBytes: 0 })).toEqual({ web_search: "disabled" });
  });

  it("includes managed MCP servers from session config", () => {
    expect(
      buildCodexConfig({
        managedMcpServers: [
          {
            name: "cycloid-mcp_1",
            transport: "http",
            url: "https://mcp.example.com",
            headers: { Authorization: { envVar: "DOCS_MCP_TOKEN" } },
            envVars: ["DOCS_MCP_TOKEN"],
          },
        ],
      }),
    ).toEqual({
      web_search: "disabled",
      mcp: {
        "cycloid-mcp_1": {
          type: "remote",
          url: "https://mcp.example.com",
          env_http_headers: { Authorization: "DOCS_MCP_TOKEN" },
        },
      },
      managed_mcp_env_names: ["DOCS_MCP_TOKEN"],
    });
  });

  it("skips managed SSE MCP servers because Codex remote config does not preserve SSE transport", () => {
    expect(
      buildCodexConfig({
        managedMcpServers: [
          {
            name: "cycloid-sse",
            transport: "sse",
            url: "https://mcp.example.com/sse",
            headers: { Authorization: { envVar: "SSE_MCP_TOKEN" } },
            envVars: ["SSE_MCP_TOKEN"],
          },
        ],
      }),
    ).toEqual({ web_search: "disabled" });
  });
});
