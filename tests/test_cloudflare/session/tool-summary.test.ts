import { describe, expect, it } from "vitest";

import { generateToolSummary } from "../../../apps/control-plane-worker/src/session/tool-summary.ts";

describe("generateToolSummary", () => {
  it("ignores malformed batch entries instead of throwing", () => {
    expect(
      generateToolSummary("batch", {
        tool_calls: [null, { tool: "read", parameters: { filePath: "/tmp/demo.ts" } }, 1],
      }),
    ).toBe("Reading /tmp/demo.ts");
  });

  it("ignores malformed todo entries and keeps valid labels", () => {
    expect(
      generateToolSummary("todowrite", {
        todos: [null, { content: "Ship fix" }, { title: "Follow up" }, false],
      }),
    ).toBe("Ship fix, Follow up");
  });
});
