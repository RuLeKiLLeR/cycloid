import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listTomlMcpServers, pruneStaleProjectMcpServers, syncCodexConfig } from "../../scripts/sync-codex-config.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
});

function createTempRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "codex-config-sync-"));
  const codexDir = path.join(repoRoot, ".codex");
  tempDirs.push(repoRoot);
  mkdirSync(codexDir, { recursive: true });
  return { repoRoot, codexDir };
}

describe("sync codex config", () => {
  it("lists MCP server names from top-level and nested tables", () => {
    const servers = listTomlMcpServers(
      [
        "[mcp_servers.linear]",
        '["not a match"]',
        "[mcp_servers.linear.env_http_headers]",
        '[mcp_servers."custom-remote"]',
      ].join("\n"),
    );

    expect([...servers]).toEqual(["linear", "custom-remote"]);
  });

  it("prunes stale project-managed servers and keeps custom entries", () => {
    const runtime = [
      "# Project-scoped Codex MCP config.",
      "",
      "[mcp_servers.cycloid]",
      'command = "bash"',
      "",
      "[mcp_servers.linear]",
      'command = "bash"',
      "",
      "[mcp_servers.linear.env_http_headers]",
      'authorization = "LINEAR_TOKEN"',
      "",
      "[mcp_servers.custom]",
      'url = "https://example.com/mcp"',
      "",
    ].join("\n");
    const example = ["# Project-scoped Codex MCP config.", "", "[mcp_servers.linear]", 'command = "bash"', ""].join(
      "\n",
    );

    expect(pruneStaleProjectMcpServers(runtime, example)).toBe(
      [
        "# Project-scoped Codex MCP config.",
        "",
        "[mcp_servers.linear]",
        'command = "bash"',
        "",
        "[mcp_servers.linear.env_http_headers]",
        'authorization = "LINEAR_TOKEN"',
        "",
        "[mcp_servers.custom]",
        'url = "https://example.com/mcp"',
        "",
      ].join("\n"),
    );
  });

  it("seeds missing runtime config from the example", () => {
    const { repoRoot, codexDir } = createTempRepo();
    const examplePath = path.join(codexDir, "config.example.toml");

    writeFileSync(examplePath, "# Example\n");

    expect(syncCodexConfig(repoRoot)).toEqual({
      seeded: true,
      pruned: false,
      runtimePath: path.join(codexDir, "config.toml"),
      skipped: false,
    });
    expect(readFileSync(path.join(codexDir, "config.toml"), "utf8")).toBe("# Example\n");
  });

  it("prunes the removed cycloid server from an existing runtime config", () => {
    const { repoRoot, codexDir } = createTempRepo();
    const examplePath = path.join(codexDir, "config.example.toml");
    const runtimePath = path.join(codexDir, "config.toml");

    writeFileSync(
      examplePath,
      ["# Project-scoped Codex MCP config for repo-local sessions.", "# Mirrors the repo's `.mcp.json`.", ""].join(
        "\n",
      ),
    );
    writeFileSync(
      runtimePath,
      [
        "# Project-scoped Codex MCP config.",
        "",
        "[mcp_servers.cycloid]",
        'command = "bash"',
        'args = ["-lc", "exec npx tsx apps/mcp/server.ts"]',
        "",
        "[mcp_servers.custom]",
        'url = "https://example.com/mcp"',
        "",
      ].join("\n"),
    );

    expect(syncCodexConfig(repoRoot)).toEqual({
      seeded: false,
      pruned: true,
      runtimePath,
      skipped: false,
    });
    expect(readFileSync(runtimePath, "utf8")).toBe(
      ["# Project-scoped Codex MCP config.", "", "[mcp_servers.custom]", 'url = "https://example.com/mcp"', ""].join(
        "\n",
      ),
    );
  });
});
