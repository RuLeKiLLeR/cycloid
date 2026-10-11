import { describe, expect, it } from "vitest";

import {
  type ActivityEvent,
  filterEventsForPrompt,
  flattenSessionEvents,
  getRawSessionEventData,
  getRawSessionEventPromptId,
  getRawSessionEventTimestamp,
  type RawSessionEvent,
  resolveAuthoritativePromptEvents,
  resolveAuthoritativePromptEventsWithDiagnostics,
} from "../../shared/transcript/projector.js";

describe("shared transcript projector prompt windows", () => {
  it("filters a prompt window even when replay starts after prompt_processing", () => {
    const events: RawSessionEvent[] = [
      { type: "text", data: { promptId: "p-1", id: "t-1", text: "live delta" } },
      { type: "tool_call", data: { promptId: "p-1", id: "tool-1", tool: "read", summary: "read file" } },
      { type: "prompt_processing", data: { promptId: "p-2" } },
      { type: "text", data: { promptId: "p-2", id: "t-2", text: "other prompt" } },
    ];

    expect(filterEventsForPrompt(events, "p-1")).toEqual(events.slice(0, 2));
    expect(filterEventsForPrompt(events, "p-2")).toEqual(events.slice(2));
  });
});

describe("resolveAuthoritativePromptEvents", () => {
  it("prefers embedded terminal history when present", () => {
    const raw: RawSessionEvent[] = [
      { type: "text", data: { id: "t-ignored", text: "partial" } },
      {
        type: "prompt_completed",
        data: {
          history: [{ type: "text", data: { id: "t-final", text: "authoritative" } }],
        },
      },
    ];

    expect(resolveAuthoritativePromptEvents(raw)).toEqual([
      { type: "text", data: { id: "t-final", text: "authoritative" } },
    ]);
  });

  it("preserves durable prompt activity missing from embedded terminal history", () => {
    const setupActivity: RawSessionEvent = {
      type: "prompt_activity",
      data: { promptId: "p-1", phase: "prompt_preparing", detail: "workspace_setup" },
    };
    const raw: RawSessionEvent[] = [
      setupActivity,
      { type: "text", data: { promptId: "p-1", id: "t-ignored", text: "partial" } },
      {
        type: "prompt_completed",
        data: {
          promptId: "p-1",
          history: [{ type: "text", data: { promptId: "p-1", id: "t-final", text: "authoritative" } }],
        },
      },
    ];

    const result = resolveAuthoritativePromptEventsWithDiagnostics(raw);

    expect(result.events).toEqual([
      setupActivity,
      { type: "text", data: { promptId: "p-1", id: "t-final", text: "authoritative" } },
    ]);
    expect(result.diagnostics).toMatchObject({
      embeddedHistoryPresent: true,
      durablePromptActivityCount: 1,
      embeddedPromptActivityCount: 0,
      mergedDurablePromptActivityCount: 1,
      duplicateDurablePromptActivityCount: 0,
    });
  });

  it("preserves durable agent progress missing from embedded terminal history", () => {
    const progress: RawSessionEvent = {
      type: "agent_progress",
      data: { promptId: "p-1", step: "preparing_context", label: "Preparing context" },
    };
    const raw: RawSessionEvent[] = [
      progress,
      { type: "text", data: { promptId: "p-1", id: "t-ignored", text: "partial" } },
      {
        type: "prompt_completed",
        data: {
          promptId: "p-1",
          history: [{ type: "text", data: { promptId: "p-1", id: "t-final", text: "authoritative" } }],
        },
      },
    ];

    const result = resolveAuthoritativePromptEventsWithDiagnostics(raw);

    expect(result.events).toEqual([
      progress,
      { type: "text", data: { promptId: "p-1", id: "t-final", text: "authoritative" } },
    ]);
    expect(result.diagnostics).toMatchObject({
      embeddedHistoryPresent: true,
      durableAgentProgressCount: 1,
      embeddedAgentProgressCount: 0,
      mergedDurableAgentProgressCount: 1,
      duplicateDurableAgentProgressCount: 0,
    });
  });

  it("does not duplicate prompt activity already present in embedded terminal history", () => {
    const setupActivity: RawSessionEvent = {
      type: "prompt_activity",
      data: { promptId: "p-1", phase: "prompt_preparing", detail: "workspace_setup" },
    };
    const duplicateSetupActivity: RawSessionEvent = {
      type: "prompt_activity",
      data: { promptId: "p-1", phase: "prompt_preparing", detail: "workspace_setup" },
    };
    const raw: RawSessionEvent[] = [
      setupActivity,
      {
        type: "prompt_completed",
        data: {
          promptId: "p-1",
          history: [
            setupActivity,
            duplicateSetupActivity,
            { type: "text", data: { promptId: "p-1", id: "t-final", text: "authoritative" } },
          ],
        },
      },
    ];

    const result = resolveAuthoritativePromptEventsWithDiagnostics(raw);

    expect(result.events).toEqual([
      setupActivity,
      duplicateSetupActivity,
      { type: "text", data: { promptId: "p-1", id: "t-final", text: "authoritative" } },
    ]);
    expect(result.diagnostics).toMatchObject({
      embeddedHistoryPresent: true,
      durablePromptActivityCount: 1,
      embeddedPromptActivityCount: 2,
      mergedDurablePromptActivityCount: 0,
      duplicateDurablePromptActivityCount: 1,
    });
  });

  it("merges canonical durable prompt activity with canonical embedded terminal history", () => {
    const promptActivity: RawSessionEvent = {
      phase: "bridge.event",
      sessionId: "s-1",
      promptId: "p-1",
      sequence: 1,
      timestampMs: 100,
      payload: {
        bridgeEventType: "prompt_activity",
        bridgeData: {
          phase: "prompt_preparing",
          detail: "workspace_setup",
        },
      },
    };
    const raw: RawSessionEvent[] = [
      promptActivity,
      {
        phase: "prompt.complete",
        sessionId: "s-1",
        promptId: "p-1",
        sequence: 2,
        timestampMs: 200,
        payload: {
          success: true,
          bridgeData: {
            history: [
              {
                phase: "text.delta",
                sessionId: "s-1",
                promptId: "p-1",
                sequence: 3,
                timestampMs: 300,
                payload: {
                  partId: "t-final",
                  text: "authoritative",
                  channel: "output",
                },
              },
            ],
          },
        },
      },
    ];

    const result = resolveAuthoritativePromptEventsWithDiagnostics(raw);

    expect(result.events).toEqual([
      promptActivity,
      {
        phase: "text.delta",
        sessionId: "s-1",
        promptId: "p-1",
        sequence: 3,
        timestampMs: 300,
        payload: {
          partId: "t-final",
          text: "authoritative",
          channel: "output",
        },
      },
    ]);
    expect(result.diagnostics).toMatchObject({
      embeddedHistoryPresent: true,
      durablePromptActivityCount: 1,
      embeddedPromptActivityCount: 0,
      mergedDurablePromptActivityCount: 1,
      duplicateDurablePromptActivityCount: 0,
    });
  });
});

describe("canonical replay prompt IDs", () => {
  it("derives timestamps from canonical replay timestampMs and legacy timestamp data", () => {
    expect(
      getRawSessionEventTimestamp({
        phase: "prompt.complete",
        sessionId: "s-1",
        promptId: "p-1",
        sequence: 1,
        timestampMs: 1_713_456_789_000,
        payload: { success: true },
      }),
    ).toBe("2024-04-18T16:13:09.000Z");

    expect(
      getRawSessionEventTimestamp({
        type: "question",
        sequence: 2,
        data: { timestamp: "2024-04-18T12:00:00.000Z", question: "Continue?" },
      }),
    ).toBe("2024-04-18T12:00:00.000Z");

    expect(
      getRawSessionEventTimestamp({
        type: "text",
        sequence: 3,
        data: { timestamp: 1_713_456_789_100 },
      }),
    ).toBe("2024-04-18T16:13:09.100Z");

    expect(
      getRawSessionEventTimestamp({
        type: "text",
        sequence: 4,
        data: { timestamp: "not-a-date" },
      }),
    ).toBeUndefined();

    expect(
      getRawSessionEventTimestamp({
        type: "text",
        sequence: 5,
        data: { timestamp: 9_999_999_999_999_999 },
      }),
    ).toBeUndefined();
  });

  it("prefers data.timestamp over a top-level timestamp, falling back to top-level when data has none", () => {
    // data.timestamp keeps the long-standing precedence other callers rely on.
    expect(
      getRawSessionEventTimestamp({
        type: "text",
        sequence: 1,
        timestamp: "2024-04-18T18:00:00.000Z",
        data: { timestamp: "2024-04-18T12:00:00.000Z" },
      } as unknown as RawSessionEvent),
    ).toBe("2024-04-18T12:00:00.000Z");

    // Events that only carry a top-level timestamp still resolve.
    expect(
      getRawSessionEventTimestamp({
        type: "retry_status",
        sequence: 2,
        timestamp: "2024-04-18T18:00:00.000Z",
      } as unknown as RawSessionEvent),
    ).toBe("2024-04-18T18:00:00.000Z");

    // An unparseable data.timestamp falls through to a valid top-level one.
    expect(
      getRawSessionEventTimestamp({
        type: "text",
        sequence: 3,
        timestamp: "2024-04-18T18:00:00.000Z",
        data: { timestamp: "not-a-date" },
      } as unknown as RawSessionEvent),
    ).toBe("2024-04-18T18:00:00.000Z");
  });

  it("falls back to compat bridge identifiers when top-level promptId is absent", () => {
    const event: RawSessionEvent = {
      phase: "prompt.dispatch",
      sessionId: "s-1",
      sequence: 1,
      timestampMs: 1_713_456_789_000,
      payload: {
        startupAttemptId: null,
        bridgeData: {
          messageId: "p-1",
        },
      },
    };

    expect(getRawSessionEventPromptId(event)).toBe("p-1");
    expect(getRawSessionEventData(event)).toMatchObject({ promptId: "p-1" });
  });

  it("aliases bridge.event tool_update callId to id for raw consumers", () => {
    const event: RawSessionEvent = {
      phase: "bridge.event",
      sessionId: "s-1",
      promptId: "p-1",
      sequence: 2,
      timestampMs: 1_713_456_789_100,
      payload: {
        bridgeEventType: "tool_update",
        bridgeData: {
          id: null,
          callId: "tool-1",
          status: "completed",
          outputEstimatedTokens: 12,
        },
      },
    };

    expect(getRawSessionEventData(event)).toMatchObject({
      promptId: "p-1",
      callId: "tool-1",
      id: "tool-1",
      status: "completed",
      outputEstimatedTokens: 12,
    });
  });
});

describe("stream coalescing", () => {
  it("coalesces same-part text across lifecycle-only interstitial events", () => {
    const partId = "msg_09ca8df50cb9d8d5016a47dbc0a03c819bbbe88fbf917a8d14";
    const events = flattenSessionEvents([
      {
        phase: "text.delta",
        sessionId: "91437ae2-a8e3-416c-b1c4-c69aee661fd1",
        promptId: "p-1",
        sequence: 394,
        timestampMs: 1_713_456_789_000,
        payload: {
          partId,
          text: "apps/cli/src/index.ts:117), where",
          channel: "output",
        },
      },
      {
        phase: "bridge.event",
        sessionId: "91437ae2-a8e3-416c-b1c4-c69aee661fd1",
        promptId: "p-2",
        sequence: 396,
        timestampMs: 1_713_456_789_100,
        payload: {
          bridgeEventType: "agent_progress",
          bridgeData: {
            step: "prompt.dispatch",
            label: "Implementing plan",
          },
        },
      },
      {
        phase: "text.delta",
        sessionId: "91437ae2-a8e3-416c-b1c4-c69aee661fd1",
        promptId: "p-1",
        sequence: 397,
        timestampMs: 1_713_456_789_200,
        payload: {
          partId,
          text: " the flag help text also marks `--cold`",
          channel: "output",
        },
      },
      {
        phase: "text.delta",
        sessionId: "91437ae2-a8e3-416c-b1c4-c69aee661fd1",
        promptId: "p-1",
        sequence: 398,
        timestampMs: 1_713_456_789_300,
        payload: {
          partId,
          text: " as cold-start only.",
          channel: "output",
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "text",
        id: partId,
        text: "apps/cli/src/index.ts:117), where the flag help text also marks `--cold` as cold-start only.",
        promptId: "p-1",
      },
      {
        type: "agent_progress",
        id: "ap-1",
        step: "prompt.dispatch",
        label: "Implementing plan",
        terminal: false,
        promptId: "p-2",
      },
    ]);
  });

  it("keeps same-part text split across real content events", () => {
    const partId = "msg_with_tool_interstitial";
    const events = flattenSessionEvents([
      {
        phase: "text.delta",
        sessionId: "s-1",
        promptId: "p-1",
        sequence: 1,
        timestampMs: 1_713_456_789_000,
        payload: {
          partId,
          text: "Before",
          channel: "output",
        },
      },
      {
        phase: "tool.call",
        sessionId: "s-1",
        promptId: "p-1",
        sequence: 2,
        timestampMs: 1_713_456_789_100,
        payload: {
          callId: "tool-1",
          tool: "bash",
          args: { command: "pwd" },
          summary: "pwd",
        },
      },
      {
        phase: "text.delta",
        sessionId: "s-1",
        promptId: "p-1",
        sequence: 3,
        timestampMs: 1_713_456_789_200,
        payload: {
          partId,
          text: " after",
          channel: "output",
        },
      },
    ]);

    expect(events).toEqual([
      {
        type: "text",
        id: partId,
        text: "Before",
        promptId: "p-1",
      },
      {
        type: "tool_call",
        id: "tool-1",
        tool: "bash",
        input: { command: "pwd" },
        summary: "pwd",
        promptId: "p-1",
      },
      {
        type: "text",
        id: `${partId}#1`,
        streamId: partId,
        text: " after",
        promptId: "p-1",
      },
    ]);
  });
});

describe("memory event projection", () => {
  function findEvent<T extends ActivityEvent["type"]>(
    events: ActivityEvent[],
    type: T,
  ): Extract<ActivityEvent, { type: T }> | undefined {
    return events.find((event): event is Extract<ActivityEvent, { type: T }> => event.type === type);
  }

  it("projects memory_usage with merged rich memory metadata", () => {
    const events = flattenSessionEvents([
      {
        type: "memory_usage",
        data: {
          activeMemoryIds: ["mem-a", "mem-b"],
          activeMemories: [{ id: "mem-a", path: ".cycloid/memory/engineering/gotchas/a.md", title: "A title" }],
          timestamp: 100,
        },
      },
    ]);
    const projected = findEvent(events, "memory_usage");
    expect(projected).toBeDefined();
    expect(projected?.activeMemoryIds).toEqual(["mem-a", "mem-b"]);
    expect(projected?.activeMemories).toEqual([
      { id: "mem-a", path: ".cycloid/memory/engineering/gotchas/a.md", title: "A title" },
      { id: "mem-b" },
    ]);
  });

  it("projects memory_recall_usage with requested and returned memory refs", () => {
    const events = flattenSessionEvents([
      {
        type: "memory_recall_usage",
        data: {
          eventName: "memory_recall.returned",
          requestedMemoryIds: ["mem-a", "mem-b"],
          returnedMemoryIds: ["mem-b"],
          requestedMemories: [
            { id: "mem-a", path: "a.md", title: "A" },
            { id: "mem-b", path: "b.md", title: "B" },
          ],
          returnedMemories: [{ id: "mem-b", path: "b.md", title: "B" }],
          usageSource: "company_recall",
          intent: "Update auth handler",
          tool: "apply_patch",
          timestamp: 200,
        },
      },
    ]);
    const projected = findEvent(events, "memory_recall_usage");
    expect(projected).toBeDefined();
    expect(projected?.requestedMemoryIds).toEqual(["mem-a", "mem-b"]);
    expect(projected?.returnedMemoryIds).toEqual(["mem-b"]);
    expect(projected?.requestedMemories).toEqual([
      { id: "mem-a", path: "a.md", title: "A" },
      { id: "mem-b", path: "b.md", title: "B" },
    ]);
    expect(projected?.returnedMemories).toEqual([{ id: "mem-b", path: "b.md", title: "B" }]);
    expect(projected?.usageSource).toBe("company_recall");
    expect(projected?.intent).toBe("Update auth handler");
    expect(projected?.tool).toBe("apply_patch");
  });
});
