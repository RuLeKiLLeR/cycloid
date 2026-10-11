import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../apps/ui/src/types.js";
import {
  type AgentProgressGroup,
  type AgentTimelineEvent,
  batchCallSummary,
  formatProviderLabel,
  groupConsecutiveToolCalls,
  type PostExecutionPanelItem,
  toolRunCurrentActionSummary,
  type ToolRunGroup,
  trailingItemSelfAnimates,
  type TranscriptRenderItem,
} from "../../apps/ui/src/utils/transcript.js";

function agentProgress(id: string, step: string, label: string): ActivityEvent & { type: "agent_progress" } {
  return {
    type: "agent_progress",
    id,
    step,
    label,
    terminal: false,
    promptId: "p-1",
  };
}

function promptActivity(id: string): ActivityEvent & { type: "prompt_activity" } {
  return {
    type: "prompt_activity",
    id,
    phase: "waiting_for_agent_event",
    detail: "draining",
    promptId: "p-1",
  };
}

function toolCall(id: string, tool = "Read"): ActivityEvent & { type: "tool_call" } {
  return {
    type: "tool_call",
    id,
    tool,
    summary: "",
    toolStatus: "completed",
  } as ActivityEvent & { type: "tool_call" };
}

function textEvent(id: string, text: string): ActivityEvent & { type: "text" } {
  return {
    type: "text",
    id,
    text,
    promptId: "p-1",
  };
}

function toolRunGroup(trailing: boolean): ToolRunGroup {
  return {
    type: "tool_run_group",
    events: [toolCall("tool-1")],
    groupId: "group-tool-1",
    activityCount: 1,
    tally: {
      reads: 1,
      searches: 0,
      edits: 0,
      commands: 0,
      other: 0,
    },
    hasError: false,
    trailing,
    tokenTotals: {
      inputEstimatedTokens: 0,
      outputEstimatedTokens: 0,
    },
  };
}

function agentProgressGroup(terminal: boolean): AgentProgressGroup {
  const event = { ...agentProgress("ap-group-1", "waiting_for_model", "Waiting for model"), terminal };
  return {
    type: "agent_progress_group",
    id: "agent-progress-group-ap-group-1",
    events: [event],
    latest: event,
    trailing: true,
  };
}

function postExecutionPanel(): PostExecutionPanelItem {
  const event: AgentTimelineEvent = {
    type: "agent_timeline",
    id: "atl-1",
    eventType: "pr.open",
    source: "control-plane",
    observer: "session",
    summary: "PR opened",
    promptId: "p-1",
  };
  return {
    type: "post_execution_panel",
    id: "post-exec-atl-1",
    events: [event],
  };
}

const activePredicateOpts = {
  isActive: true,
  promptCompleted: false,
  planTextEventId: "plan-1",
};

describe("batchCallSummary", () => {
  it("returns file_path for Edit tool", () => {
    expect(batchCallSummary({ tool: "Edit", parameters: { file_path: "/src/index.ts" } })).toBe("/src/index.ts");
  });

  it("returns file_path for Read tool", () => {
    expect(batchCallSummary({ tool: "Read", parameters: { file_path: "/README.md" } })).toBe("/README.md");
  });

  it("returns file_path for Write tool", () => {
    expect(batchCallSummary({ tool: "Write", parameters: { file_path: "/new-file.ts" } })).toBe("/new-file.ts");
  });

  it("prefers file_path over filePath and path", () => {
    expect(
      batchCallSummary({
        tool: "Read",
        parameters: { file_path: "/a.ts", filePath: "/b.ts", path: "/c.ts" },
      }),
    ).toBe("/a.ts");
  });

  it("falls back to filePath then path for file tools", () => {
    expect(batchCallSummary({ tool: "Read", parameters: { filePath: "/b.ts" } })).toBe("/b.ts");
    expect(batchCallSummary({ tool: "Read", parameters: { path: "/c.ts" } })).toBe("/c.ts");
  });

  it("returns empty string for file tools with no path", () => {
    expect(batchCallSummary({ tool: "Edit", parameters: {} })).toBe("");
  });

  it("returns command for Bash tool", () => {
    expect(batchCallSummary({ tool: "Bash", parameters: { command: "ls -la" } })).toBe("ls -la");
  });

  it("truncates long Bash commands at 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = batchCallSummary({ tool: "Bash", parameters: { command: longCmd } });
    expect(result).toHaveLength(81); // 80 chars + ellipsis
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("returns empty string for Bash with no command", () => {
    expect(batchCallSummary({ tool: "Bash", parameters: {} })).toBe("");
  });

  it("returns pattern for Glob tool", () => {
    expect(batchCallSummary({ tool: "Glob", parameters: { pattern: "**/*.ts" } })).toBe("**/*.ts");
  });

  it("returns pattern for Grep tool", () => {
    expect(batchCallSummary({ tool: "Grep", parameters: { pattern: "TODO" } })).toBe("TODO");
  });

  it("returns empty string for Glob/Grep with no pattern", () => {
    expect(batchCallSummary({ tool: "Glob", parameters: {} })).toBe("");
    expect(batchCallSummary({ tool: "Grep", parameters: {} })).toBe("");
  });

  it("returns tool name when no parameters", () => {
    expect(batchCallSummary({ tool: "UnknownTool" })).toBe("UnknownTool");
  });

  it("returns first short string value for unknown tools", () => {
    expect(
      batchCallSummary({
        tool: "CustomTool",
        parameters: { query: "search term" },
      }),
    ).toBe("search term");
  });

  it("returns empty string for unknown tools when all values are too long", () => {
    expect(
      batchCallSummary({
        tool: "CustomTool",
        parameters: { data: "x".repeat(100) },
      }),
    ).toBe("");
  });

  it("returns empty string for unknown tools with non-string values only", () => {
    expect(
      batchCallSummary({
        tool: "CustomTool",
        parameters: { count: 42 as unknown as string },
      }),
    ).toBe("");
  });

  it("is case-insensitive on tool names", () => {
    expect(batchCallSummary({ tool: "EDIT", parameters: { file_path: "/foo.ts" } })).toBe("/foo.ts");
    expect(batchCallSummary({ tool: "bash", parameters: { command: "echo hi" } })).toBe("echo hi");
  });
});

describe("formatProviderLabel", () => {
  it("uses shared provider display names", () => {
    expect(formatProviderLabel("openai")).toBe("OpenAI");
    expect(formatProviderLabel("baseten")).toBe("Baseten");
    expect(formatProviderLabel("unknown-provider")).toBe("unknown-provider");
  });
});

describe("trailingItemSelfAnimates", () => {
  it("returns true for a trailing active tool group", () => {
    expect(trailingItemSelfAnimates([toolRunGroup(true)], activePredicateOpts)).toBe(true);
  });

  it("returns false for an inactive or non-trailing tool group", () => {
    expect(trailingItemSelfAnimates([toolRunGroup(true)], { ...activePredicateOpts, isActive: false })).toBe(false);
    expect(trailingItemSelfAnimates([toolRunGroup(false)], activePredicateOpts)).toBe(false);
  });

  it("returns true for a trailing active non-terminal agent progress group", () => {
    expect(trailingItemSelfAnimates([agentProgressGroup(false)], activePredicateOpts)).toBe(true);
  });

  it("returns false for a terminal agent progress group", () => {
    expect(trailingItemSelfAnimates([agentProgressGroup(true)], activePredicateOpts)).toBe(false);
  });

  it("returns true for a streaming plan text event", () => {
    expect(trailingItemSelfAnimates([textEvent("plan-1", "# Plan\n\n- Do it")], activePredicateOpts)).toBe(true);
  });

  it("returns false for a completed or inactive plan text event", () => {
    const planEvent = textEvent("plan-1", "# Plan\n\n- Do it");
    expect(trailingItemSelfAnimates([planEvent], { ...activePredicateOpts, promptCompleted: true })).toBe(false);
    expect(trailingItemSelfAnimates([planEvent], { ...activePredicateOpts, isActive: false })).toBe(false);
  });

  it("returns false for trailing plain assistant text and empty input", () => {
    expect(trailingItemSelfAnimates([textEvent("text-1", "Done")], activePredicateOpts)).toBe(false);
    expect(trailingItemSelfAnimates([], activePredicateOpts)).toBe(false);
  });

  it("scans backward past render-null or non-animating trailing items", () => {
    const animatingToolGroup = toolRunGroup(true);
    const animatingPlanCard = textEvent("plan-1", "# Plan\n\n- Do it");
    const tailCases: TranscriptRenderItem[][] = [
      [animatingToolGroup, promptActivity("pa-tail")],
      [animatingPlanCard, textEvent("duplicate-plan", "# Plan\n\n- Do it")],
      [animatingToolGroup, postExecutionPanel()],
      [animatingToolGroup, { type: "window_gap", id: "active-window-gap", hiddenCount: 3 }],
    ];

    for (const items of tailCases) {
      expect(trailingItemSelfAnimates(items, activePredicateOpts)).toBe(true);
    }
  });
});

describe("toolRunCurrentActionSummary", () => {
  it("adapts tool call input through batch summary", () => {
    const event: ActivityEvent = {
      type: "tool_call",
      id: "bash-1",
      tool: "Bash",
      summary: "running bash",
      input: { command: "git status --short" },
    };

    expect(toolRunCurrentActionSummary(event)).toBe("git status --short");
  });

  it("summarizes grouped customer activity", () => {
    const customerActivity: ActivityEvent = {
      type: "customer_activity",
      id: "ca-1",
      category: "inspect",
      title: "Inspected files",
      summary: "Read 2 files",
      count: 2,
      details: [{ tool: "read", content: "src/index.ts" }],
    };

    expect(toolRunCurrentActionSummary(customerActivity)).toBe("Read 2 files");
  });
});

describe("groupConsecutiveToolCalls", () => {
  it("collapses consecutive agent progress events into one stable group", () => {
    const starting = agentProgress("ap-1", "starting_agent", "Starting agent");
    const waiting = agentProgress("ap-2", "waiting_for_model", "Waiting for model");

    const result = groupConsecutiveToolCalls([starting, waiting]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("agent_progress_group");
    const group = result[0] as AgentProgressGroup;
    expect(group.id).toBe("agent-progress-group-ap-1");
    expect(group.events).toEqual([starting, waiting]);
    expect(group.latest).toEqual(waiting);
    expect(group.trailing).toBe(true);
  });

  it("collapses repeated same-step agent progress events", () => {
    const first = agentProgress("ap-1", "preparing_workspace", "Preparing workspace");
    const repeated = agentProgress("ap-2", "preparing_workspace", "Preparing workspace");

    const result = groupConsecutiveToolCalls([first, repeated]);

    expect(result).toHaveLength(1);
    expect((result[0] as AgentProgressGroup).events).toEqual([first, repeated]);
  });

  it("absorbs render-null prompt activity between agent progress events", () => {
    const result = groupConsecutiveToolCalls([
      agentProgress("ap-1", "starting_agent", "Starting agent"),
      promptActivity("pa-1"),
      agentProgress("ap-2", "preparing_context", "Preparing context"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("agent_progress_group");
    expect((result[0] as AgentProgressGroup).latest.label).toBe("Preparing context");
    expect((result[0] as AgentProgressGroup).trailing).toBe(true);
  });

  it("keeps delayed and failed workspace setup progress standalone and splits surrounding groups", () => {
    const delayed = agentProgress("ap-delayed", "workspace_setup_delayed", "Workspace setup delayed");
    const failed = agentProgress("ap-failed", "workspace_setup_failed", "Workspace setup failed");
    const result = groupConsecutiveToolCalls([
      agentProgress("ap-1", "starting_agent", "Starting agent"),
      delayed,
      agentProgress("ap-2", "preparing_context", "Preparing context"),
      failed,
      agentProgress("ap-3", "waiting_for_model", "Waiting for model"),
    ]);

    expect(result.map((item) => item.type)).toEqual([
      "agent_progress_group",
      "agent_progress",
      "agent_progress_group",
      "agent_progress",
      "agent_progress_group",
    ]);
    expect(result[1]).toEqual(delayed);
    expect(result[3]).toEqual(failed);
  });

  it("keeps agent progress runs separate from tool call groups", () => {
    const result = groupConsecutiveToolCalls([
      agentProgress("ap-1", "starting_agent", "Starting agent"),
      toolCall("tool-1"),
      agentProgress("ap-2", "waiting_for_model", "Waiting for model"),
    ]);

    expect(result.map((item) => item.type)).toEqual(["agent_progress_group", "tool_run_group", "agent_progress_group"]);
  });

  it("sets agent progress trailing after ignoring trailing render-null events", () => {
    const result = groupConsecutiveToolCalls([
      agentProgress("ap-1", "starting_agent", "Starting agent"),
      promptActivity("pa-1"),
    ]);

    expect(result).toHaveLength(1);
    expect((result[0] as AgentProgressGroup).trailing).toBe(true);
  });

  it("clears agent progress trailing when later visible content follows", () => {
    const result = groupConsecutiveToolCalls([
      agentProgress("ap-1", "starting_agent", "Starting agent"),
      { type: "text", id: "text-1", text: "Done" },
    ]);

    expect(result).toHaveLength(2);
    expect((result[0] as AgentProgressGroup).trailing).toBe(false);
  });

  it("does not group lifecycle progress after a healed same-part text segment", () => {
    const result = groupConsecutiveToolCalls([
      {
        type: "text",
        id: "msg_09ca8df50cb9d8d5016a47dbc0a03c819bbbe88fbf917a8d14",
        text: "apps/cli/src/index.ts:117), where the flag help text also marks `--cold`",
        promptId: "p-1",
      },
      {
        ...agentProgress("ap-1", "prompt.dispatch", "Implementing plan"),
        promptId: "p-2",
      },
    ]);

    expect(result).toEqual([
      {
        type: "text",
        id: "msg_09ca8df50cb9d8d5016a47dbc0a03c819bbbe88fbf917a8d14",
        text: "apps/cli/src/index.ts:117), where the flag help text also marks `--cold`",
        promptId: "p-1",
      },
      {
        type: "agent_progress_group",
        id: "agent-progress-group-ap-1",
        events: [
          {
            type: "agent_progress",
            id: "ap-1",
            step: "prompt.dispatch",
            label: "Implementing plan",
            terminal: false,
            promptId: "p-2",
          },
        ],
        latest: {
          type: "agent_progress",
          id: "ap-1",
          step: "prompt.dispatch",
          label: "Implementing plan",
          terminal: false,
          promptId: "p-2",
        },
        trailing: true,
      },
    ]);
    expect(result.some((item) => item.type === "tool_run_group")).toBe(false);
  });
});
