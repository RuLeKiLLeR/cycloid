import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../apps/ui/src/types.js";
import { groupConsecutiveToolCalls } from "../../apps/ui/src/utils/transcript.js";
import type { ToolFailureCategory, ToolFailureReport } from "../../shared/tool-failure.js";

function patch(id: string, files: string[]): ActivityEvent & { type: "patch" } {
  return { type: "patch", id, files };
}

function text(id: string, txt: string): ActivityEvent & { type: "text" } {
  return { type: "text", id, text: txt };
}

function toolCall(id: string, tool: string, input?: Record<string, unknown>): ActivityEvent & { type: "tool_call" } {
  return {
    type: "tool_call",
    id,
    tool,
    summary: "",
    toolStatus: "completed",
    ...(input ? { input } : {}),
  } as ActivityEvent & { type: "tool_call" };
}

function failure(category: ToolFailureCategory): ToolFailureReport {
  return {
    category,
    phase: category === "unknown" ? "command" : category,
    safeSummary: "Tool failed",
    diagnosticsRedacted: true,
  };
}

function erroredToolCall(id: string, tool: string): ActivityEvent & { type: "tool_call" } {
  return {
    ...toolCall(id, tool),
    toolStatus: "error",
  };
}

function classifiedErroredToolCall(
  id: string,
  tool: string,
  category: ToolFailureCategory,
): ActivityEvent & { type: "tool_call" } {
  return {
    ...erroredToolCall(id, tool),
    failure: failure(category),
  };
}

function readCall(id: string, filePath: string): ActivityEvent & { type: "tool_call" } {
  return toolCall(id, "Read", { file_path: filePath });
}

function customerActivity(
  id: string,
  details: Array<{ tool: string; content: string }>,
  status?: "running" | "completed" | "error",
): ActivityEvent & { type: "customer_activity" } {
  return {
    type: "customer_activity",
    id,
    category: "inspect",
    title: "Inspected files",
    summary: "Inspected files",
    count: details.length,
    details,
    ...(status ? { status } : {}),
  };
}

function toolRunGroup(result: ReturnType<typeof groupConsecutiveToolCalls>[number]) {
  expect(result.type).toBe("tool_run_group");
  return result as Extract<ReturnType<typeof groupConsecutiveToolCalls>[number], { type: "tool_run_group" }>;
}

describe("groupConsecutiveToolCalls", () => {
  describe("patch event dedup", () => {
    it("collapses 2 consecutive patch events for the same file", () => {
      const events: ActivityEvent[] = [patch("p1", ["src/foo.ts"]), patch("p2", ["src/foo.ts"])];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(patch("p1", ["src/foo.ts"]));
    });

    it("collapses 5 consecutive patch events for the same file", () => {
      const events: ActivityEvent[] = [
        patch("p1", ["src/foo.ts"]),
        patch("p2", ["src/foo.ts"]),
        patch("p3", ["src/foo.ts"]),
        patch("p4", ["src/foo.ts"]),
        patch("p5", ["src/foo.ts"]),
      ];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(patch("p1", ["src/foo.ts"]));
    });

    it("keeps a single patch event as-is", () => {
      const events: ActivityEvent[] = [patch("p1", ["src/foo.ts"])];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(1);
    });

    it("does not collapse patch events for different files", () => {
      const events: ActivityEvent[] = [patch("p1", ["src/foo.ts"]), patch("p2", ["src/bar.ts"])];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(2);
    });

    it("collapses same-file patches but keeps different-file patches separate", () => {
      const events: ActivityEvent[] = [
        patch("p1", ["src/foo.ts"]),
        patch("p2", ["src/foo.ts"]),
        patch("p3", ["src/bar.ts"]),
        patch("p4", ["src/bar.ts"]),
        patch("p5", ["src/bar.ts"]),
      ];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(2);
      expect((result[0] as ActivityEvent & { type: "patch" }).files).toEqual(["src/foo.ts"]);
      expect((result[1] as ActivityEvent & { type: "patch" }).files).toEqual(["src/bar.ts"]);
    });

    it("does not collapse patches separated by other events", () => {
      const events: ActivityEvent[] = [
        patch("p1", ["src/foo.ts"]),
        text("t1", "some text"),
        patch("p2", ["src/foo.ts"]),
      ];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(3);
    });

    it("matches files regardless of order", () => {
      const events: ActivityEvent[] = [patch("p1", ["a.ts", "b.ts"]), patch("p2", ["b.ts", "a.ts"])];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(1);
    });
  });

  describe("tool call grouping", () => {
    it("groups a sequential tool run before assistant text", () => {
      const events: ActivityEvent[] = [toolCall("t1", "Read"), toolCall("t2", "Edit"), text("x1", "done")];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("tool_run_group");
      expect(result[1]).toEqual(text("x1", "done"));
      expect((result[0] as { type: "tool_run_group"; events: ActivityEvent[]; trailing: boolean }).events).toHaveLength(
        2,
      );
      expect((result[0] as { type: "tool_run_group"; trailing: boolean }).trailing).toBe(false);
    });

    it("tallies a reads-only run", () => {
      const result = groupConsecutiveToolCalls([readCall("r1", "src/a.ts"), readCall("r2", "src/b.ts")]);
      const group = toolRunGroup(result[0]);
      expect(group.tally).toEqual({ reads: 2, searches: 0, edits: 0, commands: 0, other: 0 });
      expect(group.hasError).toBe(false);
    });

    it("tallies mixed tool activity by display category", () => {
      const result = groupConsecutiveToolCalls([
        readCall("r1", "src/a.ts"),
        toolCall("g1", "Grep"),
        toolCall("l1", "LS"),
        toolCall("e1", "Edit"),
        toolCall("w1", "Write"),
        toolCall("b1", "Bash"),
        toolCall("x1", "CustomTool"),
        customerActivity("ca1", [
          { tool: "Read", content: "src/c.ts" },
          { tool: "Glob", content: "**/*.ts" },
          { tool: "patch", content: "src/d.ts" },
          { tool: "bash", content: "npm test" },
        ]),
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.tally).toEqual({ reads: 2, searches: 3, edits: 3, commands: 2, other: 1 });
    });

    it("counts multi-file patch events as edited files when present in a group", () => {
      const result = groupConsecutiveToolCalls([
        customerActivity("ca1", [
          { tool: "patch", content: "src/a.ts" },
          { tool: "patch", content: "src/b.ts" },
          { tool: "Read", content: "src/c.ts" },
        ]),
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.tally.edits).toBe(2);
      expect(group.tally.reads).toBe(1);
    });

    it("adds customer activity overflow to the same tally bucket when visible details are homogeneous", () => {
      const result = groupConsecutiveToolCalls([
        {
          ...customerActivity("ca1", [
            { tool: "Read", content: "src/a.ts" },
            { tool: "Read", content: "src/b.ts" },
            { tool: "Read", content: "src/c.ts" },
            { tool: "Read", content: "src/d.ts" },
            { tool: "Read", content: "src/e.ts" },
          ]),
          count: 7,
          overflow: 2,
        },
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.tally).toEqual({ reads: 7, searches: 0, edits: 0, commands: 0, other: 0 });
    });

    it("uses the customer activity category fallback for mixed overflow", () => {
      const result = groupConsecutiveToolCalls([
        {
          ...customerActivity("ca1", [
            { tool: "Read", content: "src/a.ts" },
            { tool: "Grep", content: "SessionDetail" },
          ]),
          count: 4,
          overflow: 2,
        },
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.tally).toEqual({ reads: 1, searches: 1, edits: 0, commands: 0, other: 2 });
    });

    it("does not mark a classified Bash command failure as a group error", () => {
      const result = groupConsecutiveToolCalls([
        toolCall("r1", "Read"),
        classifiedErroredToolCall("b1", "Bash", "command"),
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.hasError).toBe(false);
    });

    it("marks classified blocking Bash failures on the group", () => {
      for (const category of ["auth", "provider"] as const) {
        const result = groupConsecutiveToolCalls([
          toolCall("r1", "Read"),
          classifiedErroredToolCall(`b-${category}`, "Bash", category),
        ]);
        const group = toolRunGroup(result[0]);
        expect(group.hasError).toBe(true);
      }
    });

    it("marks a classified unknown non-Bash tool failure on the group", () => {
      const result = groupConsecutiveToolCalls([
        toolCall("r1", "Read"),
        classifiedErroredToolCall("mcp-1", "McpTool", "unknown"),
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.hasError).toBe(true);
    });

    it("marks tool-call status errors without a failure report on the group", () => {
      const result = groupConsecutiveToolCalls([toolCall("r1", "Read"), erroredToolCall("b1", "Bash")]);
      const group = toolRunGroup(result[0]);
      expect(group.hasError).toBe(true);
    });

    it("marks non-Bash status errors without a failure report on the group", () => {
      const result = groupConsecutiveToolCalls([toolCall("r1", "Read"), erroredToolCall("mcp-1", "McpTool")]);
      const group = toolRunGroup(result[0]);
      expect(group.hasError).toBe(true);
    });

    it("marks a mixed group when any tool call has a blocking failure", () => {
      const result = groupConsecutiveToolCalls([
        classifiedErroredToolCall("b1", "Bash", "command"),
        classifiedErroredToolCall("b2", "Bash", "auth"),
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.hasError).toBe(true);
    });

    it("marks a customer-activity error on the group", () => {
      const result = groupConsecutiveToolCalls([
        toolCall("r1", "Read"),
        customerActivity("ca1", [{ tool: "bash", content: "npm test" }], "error"),
      ]);
      const group = toolRunGroup(result[0]);
      expect(group.hasError).toBe(true);
    });

    it("groups a single tool call when it precedes assistant text", () => {
      const events: ActivityEvent[] = [toolCall("t1", "Read"), text("x1", "done")];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("tool_run_group");
    });

    it("groups a tool run without a following assistant text block", () => {
      const events: ActivityEvent[] = [toolCall("t1", "Read"), toolCall("t2", "Edit"), toolCall("t3", "Read")];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool_run_group");
      const group = result[0] as { type: "tool_run_group"; events: ActivityEvent[]; trailing: boolean };
      expect(group.events).toHaveLength(3);
      expect(group.trailing).toBe(true);
    });

    it("keeps patches and grouped progress events top-level before assistant text", () => {
      const events: ActivityEvent[] = [
        toolCall("t1", "Edit"),
        patch("p1", ["src/foo.ts"]),
        { type: "agent_progress", id: "ap1", step: "checking", label: "Checking", terminal: false },
        text("x1", "done"),
      ];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(4);
      expect(result[0].type).toBe("tool_run_group");
      expect(result[1]).toEqual(patch("p1", ["src/foo.ts"]));
      expect(result[2].type).toBe("agent_progress_group");
      expect((result[2] as { type: "agent_progress_group"; latest: ActivityEvent }).latest).toEqual({
        type: "agent_progress",
        id: "ap1",
        step: "checking",
        label: "Checking",
        terminal: false,
      });
      const group = result[0] as { type: "tool_run_group"; events: ActivityEvent[]; activityCount: number };
      expect(group.events).toHaveLength(1);
      expect(group.activityCount).toBe(1);
    });

    it("keeps top-level patch events visible instead of grouping them", () => {
      const events: ActivityEvent[] = [patch("p1", ["src/foo.ts"]), text("x1", "done")];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(patch("p1", ["src/foo.ts"]));
      expect(result[1]).toEqual(text("x1", "done"));
    });

    it("keeps all-patch customer activity visible instead of grouping it", () => {
      const patchActivity = customerActivity("ca1", [{ tool: "patch", content: "src/foo.ts" }]);
      const result = groupConsecutiveToolCalls([toolCall("t1", "Read"), patchActivity, toolCall("t2", "Read")]);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("tool_run_group");
      expect(result[1]).toEqual(patchActivity);
      expect(result[2].type).toBe("tool_run_group");
    });

    it("groups empty customer activity instead of treating it as patch activity", () => {
      const emptyActivity = customerActivity("ca1", []);
      const result = groupConsecutiveToolCalls([toolCall("t1", "Read"), emptyActivity]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool_run_group");
      expect((result[0] as { type: "tool_run_group"; events: ActivityEvent[] }).events).toEqual([
        toolCall("t1", "Read"),
        emptyActivity,
      ]);
    });

    it("keeps retry status visible instead of grouping it", () => {
      const retry: ActivityEvent & { type: "retry_status" } = {
        type: "retry_status",
        id: "retry-1",
        attempt: 1,
        message: "Retrying provider",
      };
      const result = groupConsecutiveToolCalls([toolCall("t1", "Read"), retry, toolCall("t2", "Read")]);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("tool_run_group");
      expect(result[1]).toEqual(retry);
      expect(result[2].type).toBe("tool_run_group");
    });

    it("keeps non-groupable structural tool calls visible", () => {
      const todo = toolCall("todo-1", "TodoWrite", { todos: [] });
      const result = groupConsecutiveToolCalls([todo]);
      expect(result).toEqual([todo]);
    });
  });

  describe("mixed events", () => {
    it("splits groups around deduped patch events", () => {
      const events: ActivityEvent[] = [
        toolCall("t1", "Read"),
        patch("p1", ["src/foo.ts"]),
        patch("p2", ["src/foo.ts"]),
        toolCall("t2", "Read"),
      ];
      const result = groupConsecutiveToolCalls(events);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe("tool_run_group");
      expect(result[1]).toEqual(patch("p1", ["src/foo.ts"]));
      expect(result[2].type).toBe("tool_run_group");
      expect((result[0] as { type: "tool_run_group"; trailing: boolean }).trailing).toBe(false);
      expect((result[2] as { type: "tool_run_group"; trailing: boolean }).trailing).toBe(true);
    });

    it("counts mixed tool calls and customer activity", () => {
      const result = groupConsecutiveToolCalls([
        toolCall("t1", "Read"),
        customerActivity("ca1", [{ tool: "bash", content: "git status" }]),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool_run_group");
      expect((result[0] as { type: "tool_run_group"; activityCount: number }).activityCount).toBe(2);
    });

    it("handles empty event list", () => {
      expect(groupConsecutiveToolCalls([])).toEqual([]);
    });
  });
});
