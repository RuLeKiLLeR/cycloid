import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SANDBOX_TEMPLATE = resolve("apps/sandbox-e2b/template.ts");
const BRIDGE = resolve("apps/sandbox-bridge/src/bridge.ts");

describe("Braintrust MCP setup", () => {
  it("does not install the Braintrust MCP server in the active sandbox template", () => {
    const source = readFileSync(SANDBOX_TEMPLATE, "utf-8");
    expect(source).not.toContain("@braintrust/mcp-server");
    expect(source).not.toContain("braintrust-mcp-server --help");
  });

  it("does not enable a Braintrust MCP server in the bridge", () => {
    const source = readFileSync(BRIDGE, "utf-8");
    expect(source).not.toContain('mcp["braintrust"]');
    expect(source).not.toContain('command: ["braintrust-mcp-server"]');
  });
});
