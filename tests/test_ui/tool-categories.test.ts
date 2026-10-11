import { describe, expect, it } from "vitest";

import { getToolCategory, TOOL_CATEGORY_STYLES } from "../../apps/ui/src/constants/tools";

describe("getToolCategory", () => {
  it("classifies read-only tools as readonly", () => {
    expect(getToolCategory("read")).toBe("readonly");
    expect(getToolCategory("grep")).toBe("readonly");
    expect(getToolCategory("glob")).toBe("readonly");
    expect(getToolCategory("ls")).toBe("readonly");
    expect(getToolCategory("web_search")).toBe("readonly");
    expect(getToolCategory("web_fetch")).toBe("readonly");
    expect(getToolCategory("lsp")).toBe("readonly");
  });

  it("classifies mutating tools as mutating", () => {
    expect(getToolCategory("edit")).toBe("mutating");
    expect(getToolCategory("write")).toBe("mutating");
    expect(getToolCategory("bash")).toBe("mutating");
    expect(getToolCategory("notebook_edit")).toBe("mutating");
  });

  it("classifies planning/orchestration tools as planning", () => {
    expect(getToolCategory("todowrite")).toBe("planning");
    expect(getToolCategory("agent")).toBe("planning");
    expect(getToolCategory("task")).toBe("planning");
    expect(getToolCategory("batch")).toBe("planning");
    expect(getToolCategory("ask_user_question")).toBe("planning");
  });

  it("is case-insensitive", () => {
    expect(getToolCategory("Read")).toBe("readonly");
    expect(getToolCategory("EDIT")).toBe("mutating");
    expect(getToolCategory("TodoWrite")).toBe("planning");
    expect(getToolCategory("Bash")).toBe("mutating");
  });

  it("defaults unknown tools to readonly", () => {
    expect(getToolCategory("some_new_tool")).toBe("readonly");
    expect(getToolCategory("unknown")).toBe("readonly");
  });

  it("no categories are empty in TOOL_CATEGORY_STYLES", () => {
    const categories = ["readonly", "mutating", "planning"] as const;
    for (const cat of categories) {
      expect(TOOL_CATEGORY_STYLES[cat]).toBeDefined();
      expect(TOOL_CATEGORY_STYLES[cat].badge).toBeTruthy();
      if (cat === "readonly") {
        expect(TOOL_CATEGORY_STYLES[cat].surface).toBeUndefined();
      } else {
        expect(TOOL_CATEGORY_STYLES[cat].surface).toBeTruthy();
      }
    }
  });
});
