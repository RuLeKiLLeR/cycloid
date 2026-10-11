import { describe, expect, it } from "vitest";

import { flattenSessionEvents } from "../../shared/transcript/projector.js";

describe("flattenSessionEvents — token fields", () => {
  it("passes inputEstimatedTokens through on tool_call events", () => {
    const raw = [
      { type: "tool_call", data: { id: "tc1", tool: "read", summary: "Reading /foo.ts", inputEstimatedTokens: 15 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("tool_call");
    expect((result[0] as { inputEstimatedTokens?: number }).inputEstimatedTokens).toBe(15);
  });

  it("patches outputEstimatedTokens and outputChars from tool_update onto matching tool_call", () => {
    const raw = [
      { type: "tool_call", data: { id: "tc1", tool: "read", summary: "Reading /foo.ts", inputEstimatedTokens: 15 } },
      { type: "tool_update", data: { id: "tc1", status: "completed", outputEstimatedTokens: 200, outputChars: 800 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    const tc = result[0] as {
      inputEstimatedTokens?: number;
      outputEstimatedTokens?: number;
      outputChars?: number;
      toolStatus?: string;
    };
    expect(tc.inputEstimatedTokens).toBe(15);
    expect(tc.outputEstimatedTokens).toBe(200);
    expect(tc.outputChars).toBe(800);
    expect(tc.toolStatus).toBe("completed");
  });

  it("patches correct tool_call when interleaved: A, B, update-A", () => {
    const raw = [
      { type: "tool_call", data: { id: "tc-a", tool: "read", summary: "A", inputEstimatedTokens: 10 } },
      { type: "tool_call", data: { id: "tc-b", tool: "grep", summary: "B", inputEstimatedTokens: 20 } },
      { type: "tool_update", data: { id: "tc-a", status: "completed", outputEstimatedTokens: 50, outputChars: 200 } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(2);

    const a = result[0] as { id: string; outputEstimatedTokens?: number; outputChars?: number; toolStatus?: string };
    expect(a.id).toBe("tc-a");
    expect(a.outputEstimatedTokens).toBe(50);
    expect(a.outputChars).toBe(200);
    expect(a.toolStatus).toBe("completed");

    const b = result[1] as { id: string; outputEstimatedTokens?: number };
    expect(b.id).toBe("tc-b");
    expect(b.outputEstimatedTokens).toBeUndefined();
  });

  it("does not add token fields when tool_update has none", () => {
    const raw = [
      { type: "tool_call", data: { id: "tc1", tool: "bash", summary: "ls" } },
      { type: "tool_update", data: { id: "tc1", status: "completed" } },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    const tc = result[0] as { outputEstimatedTokens?: number; outputChars?: number };
    expect(tc.outputEstimatedTokens).toBeUndefined();
    expect(tc.outputChars).toBeUndefined();
  });

  it("patches structured redacted failure metadata from tool_update onto matching tool_call", () => {
    const raw = [
      { type: "tool_call", data: { id: "tc1", tool: "bash", summary: "npm test" } },
      {
        type: "tool_update",
        data: {
          id: "tc1",
          status: "error",
          failure: {
            category: "auth",
            phase: "auth",
            diagnosticsRedacted: true,
            safeSummary: "Authentication failed for token [REDACTED]",
          },
        },
      },
    ];
    const result = flattenSessionEvents(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "tool_call",
      id: "tc1",
      toolStatus: "error",
      failure: {
        category: "auth",
        phase: "auth",
        diagnosticsRedacted: true,
        safeSummary: "Authentication failed for token [REDACTED]",
      },
    });
    expect(JSON.stringify(result[0])).not.toContain("ghp_");
  });
});
