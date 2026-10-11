import { existsSync, readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EMBEDDED_FIRST_PARTY_TOOLS } from "../../apps/sandbox-bridge/src/services/loaded-tools-index.js";
import { parseToml } from "../../shared/tools-runtime/index.js";

describe("loaded tools index", () => {
  it("indexes every tool manifest", () => {
    const toolDirs = readdirSync("tools", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `tools/${entry.name}/manifest.toml`)
      .sort();

    for (const manifestPath of toolDirs) {
      expect(existsSync(manifestPath), `${manifestPath} should exist`).toBe(true);
    }
    expect(EMBEDDED_FIRST_PARTY_TOOLS.map((entry) => entry.manifestPath).sort()).toEqual(toolDirs);
  });

  it("keeps the embedded manifest text in sync with the manifest file", () => {
    for (const embeddedTool of EMBEDDED_FIRST_PARTY_TOOLS) {
      const parsedEmbedded = parseToml(embeddedTool.manifestText, embeddedTool.manifestPath);
      const parsedFile = parseToml(readFileSync(embeddedTool.manifestPath, "utf8"), embeddedTool.manifestPath);
      expect(parsedEmbedded).toEqual(parsedFile);
    }
  });
});
