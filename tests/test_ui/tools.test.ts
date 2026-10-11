import { describe, expect, it } from "vitest";

import { buildIntegrationToolEntries as getIntegrationToolEntries } from "../../shared/constants/integration-helpers";

describe("getIntegrationToolEntries", () => {
  it("returns empty array when no integrations are available", () => {
    expect(getIntegrationToolEntries([])).toEqual([]);
  });

  it("returns matching integrations with their tools", () => {
    const result = getIntegrationToolEntries(["linear", "sentry"]);
    expect(result).toHaveLength(2);
    expect(result.map((integration) => integration.key)).toEqual(["linear", "sentry"]);
    expect(result[0].tools.length).toBeGreaterThan(0);
    expect(result[1].tools.length).toBeGreaterThan(0);
  });

  it("filters out integrations without session tools", () => {
    const result = getIntegrationToolEntries(["linear", "github", "openai", "sentry"]);
    expect(result).toHaveLength(2);
    expect(result.map((integration) => integration.key)).toEqual(["linear", "sentry"]);
  });

  it("filters out unknown integration names", () => {
    const result = getIntegrationToolEntries(["linear", "unknown_integration", "sentry", "nonexistent"]);
    expect(result).toHaveLength(2);
    expect(result.map((integration) => integration.key)).toEqual(["linear", "sentry"]);
  });

  it("preserves order from input array", () => {
    const result = getIntegrationToolEntries(["github", "sentry", "linear", "openai"]);
    expect(result.map((i) => i.key)).toEqual(["sentry", "linear"]);
  });

  it("returns all integrations with session tools", () => {
    const result = getIntegrationToolEntries(["github", "linear", "openai", "sentry"]);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.key)).toEqual(["linear", "sentry"]);
  });

  it("each integration has displayName, description, and non-empty tools", () => {
    const result = getIntegrationToolEntries(["linear", "sentry"]);
    for (const integration of result) {
      expect(integration.displayName).toBeTruthy();
      expect(integration.description).toBeTruthy();
      expect(integration.tools.length).toBeGreaterThan(0);
      for (const tool of integration.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
      }
    }
  });
});
