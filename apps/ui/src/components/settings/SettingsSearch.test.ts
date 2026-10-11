import { describe, expect, it } from "vitest";

import { SETTINGS_SEARCH_INDEX } from "../../constants/settings-search";
import { SETTINGS_GROUPS } from "../../pages/SettingsPage";
import { matchSettingsSearch } from "./SettingsSearch";

describe("matchSettingsSearch", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(matchSettingsSearch("")).toEqual([]);
    expect(matchSettingsSearch("   ")).toEqual([]);
  });

  it("matches by tab label, case-insensitively", () => {
    const results = matchSettingsSearch("CLI");
    expect(results.map((r) => r.entry.to)).toContain("/settings/cli-tokens");
    expect(matchSettingsSearch("cli").map((r) => r.entry.to)).toContain("/settings/cli-tokens");
  });

  it("matches by keyword synonyms that are not rendered on the page", () => {
    expect(matchSettingsSearch("cron")).toEqual([]);
    expect(matchSettingsSearch("byok").map((r) => r.entry.to)).toEqual(["/settings/api-keys"]);
  });

  it("matches by setting row label and reports which items matched", () => {
    const results = matchSettingsSearch("draft");
    const preferences = results.find((r) => r.entry.to === "/settings/preferences");
    expect(preferences).toBeDefined();
    expect(preferences?.matchedItems).toContain("Open pull requests as drafts");
  });

  it("requires every token to match somewhere in the entry", () => {
    expect(matchSettingsSearch("default model").map((r) => r.entry.to)).toContain("/settings/preferences");
    expect(matchSettingsSearch("default zebra")).toEqual([]);
  });

  it("returns no results for a query that matches nothing", () => {
    expect(matchSettingsSearch("qqqqxyz")).toEqual([]);
  });
});

describe("SETTINGS_SEARCH_INDEX", () => {
  const navTabsByRoute = new Map(
    SETTINGS_GROUPS.flatMap((group) => group.tabs.map((tab) => [tab.to, { tab, group: group.label }] as const)),
  );

  it("covers every nav tab and nothing else (index and nav stay in sync)", () => {
    const indexRoutes = SETTINGS_SEARCH_INDEX.map((entry) => entry.to).sort();
    const navRoutes = [...navTabsByRoute.keys()].sort();
    expect(indexRoutes).toEqual(navRoutes);
  });

  it("mirrors the nav label and group for every entry", () => {
    for (const entry of SETTINGS_SEARCH_INDEX) {
      const nav = navTabsByRoute.get(entry.to);
      expect(nav, `index entry ${entry.to} has no nav tab`).toBeDefined();
      expect(entry.label).toBe(nav?.tab.label);
      expect(entry.group).toBe(nav?.group);
    }
  });

  it("has no duplicate routes", () => {
    const routes = SETTINGS_SEARCH_INDEX.map((entry) => entry.to);
    expect(new Set(routes).size).toBe(routes.length);
  });
});
