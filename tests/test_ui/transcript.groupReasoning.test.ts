import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../apps/ui/src/types";
import { groupConsecutiveToolCalls, type ToolRunGroup } from "../../apps/ui/src/utils/transcript";

/** Minimal groupable tool call (read/bash/edit are all groupable). */
function toolCall(id: string, tool: string): ActivityEvent {
  return { type: "tool_call", id, tool, summary: `${tool} ${id}` } as ActivityEvent;
}

function reasoning(id: string): ActivityEvent {
  return { type: "reasoning", id, text: `thinking ${id}` } as ActivityEvent;
}

/** A render-null event (renders nothing) that should be skipped, not grouped. */
function promptActivity(id: string): ActivityEvent {
  return { type: "prompt_activity", id } as ActivityEvent;
}

function isGroup(item: unknown): item is ToolRunGroup {
  return Boolean(item) && (item as { type?: string }).type === "tool_run_group";
}

describe("groupConsecutiveToolCalls — reasoning absorption", () => {
  it("coalesces a run of tool calls interleaved with reasoning into one timeline group", () => {
    const events = [
      toolCall("a", "Read"),
      reasoning("r1"),
      toolCall("b", "Bash"),
      reasoning("r2"),
      toolCall("c", "Edit"),
    ];

    const result = groupConsecutiveToolCalls(events);

    expect(result).toHaveLength(1);
    const group = result[0];
    if (!isGroup(group)) throw new Error("expected a tool_run_group");
    // Reasoning is kept inline so the thinking still renders, in order.
    expect(group.events.map((e) => e.id)).toEqual(["a", "r1", "b", "r2", "c"]);
    // Tally reflects only the tool calls; reasoning contributes nothing.
    expect(group.tally.reads).toBe(1);
    expect(group.tally.commands).toBe(1);
    expect(group.tally.edits).toBe(1);
  });

  it("leaves trailing reasoning standalone (no action follows it)", () => {
    const events = [toolCall("a", "Read"), toolCall("b", "Bash"), reasoning("tail")];

    const result = groupConsecutiveToolCalls(events);

    expect(result).toHaveLength(2);
    expect(isGroup(result[0])).toBe(true);
    expect((result[0] as ToolRunGroup).events.map((e) => e.id)).toEqual(["a", "b"]);
    expect((result[1] as ActivityEvent).type).toBe("reasoning");
  });

  it("does not absorb reasoning that sits before a non-groupable (top-level) tool", () => {
    // TodoWrite is structural and renders top-level, not inside a run.
    const events = [toolCall("a", "Read"), reasoning("r1"), toolCall("todo", "TodoWrite")];

    const result = groupConsecutiveToolCalls(events);

    expect(result).toHaveLength(3);
    expect(isGroup(result[0])).toBe(true);
    expect((result[1] as ActivityEvent).type).toBe("reasoning");
    expect((result[2] as ActivityEvent).type).toBe("tool_call");
  });

  it("keeps a standalone reasoning block (no adjacent tool run) at the top level", () => {
    const result = groupConsecutiveToolCalls([reasoning("solo")]);

    expect(result).toHaveLength(1);
    expect((result[0] as ActivityEvent).type).toBe("reasoning");
  });

  it("peers through render-null events when deciding whether to absorb reasoning", () => {
    // A prompt_activity (render-null) sits between the reasoning block and the
    // next tool call. hasGroupableToolRunAhead must skip it and still coalesce,
    // and the render-null itself must not be injected into the group.
    const events = [toolCall("a", "Read"), reasoning("r1"), promptActivity("pa"), toolCall("b", "Bash")];

    const result = groupConsecutiveToolCalls(events);

    expect(result).toHaveLength(1);
    const group = result[0];
    if (!isGroup(group)) throw new Error("expected a tool_run_group");
    expect(group.events.map((e) => e.id)).toEqual(["a", "r1", "b"]);
  });
});
