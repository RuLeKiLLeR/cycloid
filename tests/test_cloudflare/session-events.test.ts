import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate";
import { REPLAY_WINDOW_SIZE } from "../../shared/constants/session";
import { createFakeState, queryEvents, seedSession } from "./session/helpers";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

// Local type definitions to avoid importing Cloudflare-typed source modules at the type level
interface SessionEvent {
  sequence: number;
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface ReplayState {
  sessionId: string;
  lastEventSequence: number;
  lastEventTimestamp: string | null;
  updatedAt: string | null;
  approximateBytes?: number;
}

type DurableEntry = { type: string; timestamp: string; data: Record<string, unknown> };
type TransportEvent = ReturnType<typeof translateBridgeEventToCycloidEvent>;
type TestDurableEntry = {
  type: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  eventId?: string;
  transportEvent?: TransportEvent;
};

type ReplayWindow = {
  afterSequence: number;
  events: SessionEvent[];
  truncated: boolean;
  droppedCount: number;
};

type AppendDurableEventsOptions = {
  includeEvents?: boolean;
};

type EventsModule = {
  generateToolSummary: (tool: string, input: Record<string, unknown>) => string;
  projectCycloidEventToDurableEntry: (
    event: ReturnType<typeof translateBridgeEventToCycloidEvent>,
  ) => DurableEntry | null;
  resolveReplayCursor: (queryCursorRaw: unknown, headerCursorRaw: unknown) => number;
  selectReplayWindow: (events: SessionEvent[], afterSequenceRaw: unknown, maxEvents?: number) => ReplayWindow;
  buildSseResponse: (phaseFields: { phase: string }, events: SessionEvent[]) => Response;
  filterEventsForPrompt: (allEvents: SessionEvent[], promptId: string) => SessionEvent[];
  binarySearchAfterSequence: (events: SessionEvent[], target: number) => number;
  appendDurableEvents: (
    state: unknown,
    sessionId: string,
    entries: TestDurableEntry[],
    promptId?: string,
    options?: AppendDurableEventsOptions,
  ) => Promise<{ replay: ReplayState; events: SessionEvent[]; newEvents?: SessionEvent[] }>;
};

let mod: EventsModule;

function translateBridgeEvent(event: Record<string, unknown>, _ts: string): DurableEntry[] {
  const enrichedEvent = {
    messageId: "prompt-1",
    sandboxId: "sbx-1",
    timestamp: Date.parse(_ts),
    ...event,
  };
  const projected = mod.projectCycloidEventToDurableEntry(
    translateBridgeEventToCycloidEvent("session-1", enrichedEvent as never),
  );
  return projected ? [{ type: projected.type, timestamp: _ts, data: projected.data }] : [];
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    sequence: 1,
    id: "event-1",
    type: "text",
    timestamp: "2025-01-01T00:00:00Z",
    data: {},
    ...overrides,
  };
}

describe("session/events", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/session/events";
    mod = (await import(modulePath)) as unknown as EventsModule;
  });

  describe("translateBridgeEvent", () => {
    const ts = "2025-01-01T00:00:00Z";

    it("translates token event to text", () => {
      const entries = translateBridgeEvent(
        {
          type: "token",
          content: "hello",
          partId: "part-1",
          messageId: "m-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("text");
      expect(entries[0].data.text).toBe("hello");
      expect(entries[0].data.id).toBe("part-1");
    });

    it("returns empty for token event without content", () => {
      expect(
        translateBridgeEvent({ type: "token", messageId: "m-1", sandboxId: "sbx-1", timestamp: Date.now() }, ts),
      ).toEqual([]);
    });

    it("returns empty for token event without partId", () => {
      expect(
        translateBridgeEvent(
          { type: "token", content: "hello", messageId: "m-1", sandboxId: "sbx-1", timestamp: Date.now() },
          ts,
        ),
      ).toEqual([]);
    });

    it("translates final_answer to a final text snapshot", () => {
      const entries = translateBridgeEvent(
        {
          type: "final_answer",
          content: "All set.",
          partId: "m-1:final_answer",
          messageId: "m-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
          ackId: "m-1:final_answer:1:h",
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("text");
      expect(entries[0].data).toMatchObject({
        id: "m-1:final_answer",
        text: "All set.",
        finalAnswer: true,
      });
    });

    it("translates tool_call event", () => {
      const entries = translateBridgeEvent(
        {
          type: "tool_call",
          tool: "bash",
          callId: "c-1",
          args: { command: "ls" },
          messageId: "m-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("tool_call");
      expect(entries[0].data.tool).toBe("bash");
      expect(entries[0].data.id).toBe("c-1");
      expect(entries[0].data.input).toEqual({ command: "ls" });
    });

    it("uses explicit summary when provided for tool_call", () => {
      const entries = translateBridgeEvent(
        {
          type: "tool_call",
          tool: "agent",
          callId: "c-1",
          args: { prompt: "test" },
          summary: "custom summary",
          messageId: "m-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].data.summary).toBe("custom summary");
    });

    it("derives summary when not provided for tool_call", () => {
      const entries = translateBridgeEvent(
        {
          type: "tool_call",
          tool: "bash",
          callId: "c-1",
          args: { command: "ls" },
          messageId: "m-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].data.summary).toBe("ls");
    });

    it("returns empty for tool_call without tool", () => {
      expect(
        translateBridgeEvent(
          { type: "tool_call", callId: "c-1", args: {}, messageId: "m-1", sandboxId: "sbx-1", timestamp: Date.now() },
          ts,
        ),
      ).toEqual([]);
    });

    it("translates tool_update event", () => {
      const entries = translateBridgeEvent({ type: "tool_update", callId: "c-1", status: "completed" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("tool_update");
      expect(entries[0].data.id).toBe("c-1");
      expect(entries[0].data.status).toBe("completed");
    });

    it("does not treat non-string raw tool_result errors as failures", () => {
      const event = translateBridgeEventToCycloidEvent("session-1", {
        type: "tool_result",
        callId: "c-1",
        result: "passed",
        error: null,
        messageId: "m-1",
        sandboxId: "sbx-1",
        timestamp: Date.parse(ts),
      } as never);
      const rawBridgeData = (event.payload as { bridgeData?: Record<string, unknown> }).bridgeData ?? {};
      const projected = mod.projectCycloidEventToDurableEntry({
        ...event,
        payload: {
          ...event.payload,
          bridgeData: {
            ...rawBridgeData,
            error: null,
          },
        },
      } as never);

      expect(projected).toBeTruthy();
      expect(projected?.type).toBe("tool_update");
      expect(projected?.data).toMatchObject({
        id: "c-1",
        status: "completed",
        output: "passed",
      });
      expect(projected?.data.error).toBeUndefined();
    });

    it("translates question event", () => {
      const entries = translateBridgeEvent({ type: "question", questionId: "q-1", question: "Continue?" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("question");
      expect(entries[0].data.id).toBe("q-1");
      expect(entries[0].data.question).toBe("Continue?");
      expect(entries[0].data.options).toBeUndefined();
    });

    it("translates question event with options", () => {
      const options = [
        { label: "Option A", description: "Do it this way" },
        { label: "Option B", description: "Do it that way" },
      ];
      const entries = translateBridgeEvent({ type: "question", questionId: "q-2", question: "Pick one", options }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].data.options).toEqual(options);
    });

    it("translates question event with string options", () => {
      const options = ["Continue working", "Try a different approach", "Stop the agent"];
      const entries = translateBridgeEvent(
        { type: "question", questionId: "q-3", question: "Intervention", options },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].data.options).toEqual(options);
    });

    it("translates usage event", () => {
      const entries = translateBridgeEvent(
        { type: "usage", inputTokens: 100, outputTokens: 50, contextTokens: 200 },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("usage");
      expect(entries[0].data).toMatchObject({ inputTokens: 100, outputTokens: 50, contextTokens: 200 });
    });

    it("translates session_idle event with optional progress metadata", () => {
      const entries = translateBridgeEvent(
        {
          type: "session_idle",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_idle");
      expect(entries[0].data).toEqual({
        sessionEditCount: 0,
        sessionPromptCount: 2,
      });
    });

    it("keeps session_idle backward compatible when metadata is absent", () => {
      const entries = translateBridgeEvent({ type: "session_idle" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_idle");
      expect(entries[0].data).toEqual({});
    });

    it("translates prompt_result event", () => {
      const entries = translateBridgeEvent({ type: "prompt_result" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("prompt_result");
      expect(entries[0].data).toEqual({});
    });

    it("translates raw_agent_runtime with partType", () => {
      const entries = translateBridgeEvent({ type: "raw_agent_runtime", partType: "reasoning", id: "r-1" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("raw_agent_runtime");
      expect(entries[0].data.partType).toBe("reasoning");
      expect(entries[0].data.id).toBe("r-1");
    });

    it("translates raw_agent_runtime with eventType (legacy bridged events)", () => {
      // The bridge no longer forwards unknown top-level events, but the DO
      // translator should still handle them if they arrive from older bridges.
      const entries = translateBridgeEvent({ type: "raw_agent_runtime", eventType: "vcs.branch.updated" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("raw_agent_runtime");
      expect(entries[0].data.eventType).toBe("vcs.branch.updated");
    });

    it("translates error event to session_error", () => {
      const entries = translateBridgeEvent({ type: "error", error: "Something broke", code: "auth" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_error");
      expect(entries[0].data.error).toBe("Something broke");
      expect(entries[0].data.code).toBe("auth");
    });

    it("sanitizes error details on session_error events", () => {
      const entries = translateBridgeEvent(
        {
          type: "error",
          error: "API error",
          code: "provider",
          errorDetails: {
            message: "fetch failed",
            stack: "Error: fetch failed\n    at sandbox",
            responseBodyPreview: '{"error":"invalid_api_key"}',
            raw: '{"secret":"value"}',
            statusCode: 401,
            cause: {
              message: "connect ECONNREFUSED 127.0.0.1:12345",
              code: "ECONNREFUSED",
              stack: "Error: connect ECONNREFUSED",
              port: 12345,
            },
          },
        },
        ts,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_error");
      expect(entries[0].data.errorDetails).toMatchObject({
        message: "fetch failed",
        statusCode: 401,
        cause: {
          message: "connect ECONNREFUSED 127.0.0.1:12345",
          code: "ECONNREFUSED",
          port: 12345,
        },
      });
      expect(entries[0].data.errorDetails).not.toHaveProperty("stack");
      expect(entries[0].data.errorDetails).not.toHaveProperty("responseBodyPreview");
      expect(entries[0].data.errorDetails).not.toHaveProperty("raw");
      expect(entries[0].data.errorDetails).not.toHaveProperty("cause.stack");
    });

    it("drops malformed error details without a message", () => {
      const entries = translateBridgeEvent(
        {
          type: "error",
          error: "API error",
          code: "provider",
          errorDetails: {
            stack: "Error: fetch failed\n    at sandbox",
            statusCode: 401,
          },
        },
        ts,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_error");
      expect(entries[0].data).not.toHaveProperty("errorDetails");
    });

    it("translates error event with defaults when fields missing", () => {
      const entries = translateBridgeEvent({ type: "error" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].data.error).toBe("Unknown error");
      expect(entries[0].data.code).toBe("unknown");
    });

    it("translates push_error event to session_error", () => {
      const entries = translateBridgeEvent({ type: "push_error", error: "rejected", branchName: "feat/x" }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_error");
      expect(entries[0].data.error).toBe("Push failed (feat/x): rejected");
      expect(entries[0].data.code).toBe("push_error");
    });

    it("translates classified workflow-permission push_error text verbatim", () => {
      const error =
        "updating `.github/workflows/check-db-migration-sql.yaml` requires the `workflows` permission, which the Cycloid GitHub App does not hold for this repo.";
      const entries = translateBridgeEvent({ type: "push_error", error, branchName: "repo-onboarding" }, ts);

      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("session_error");
      expect(entries[0].data.error).toBe(`Push failed (repo-onboarding): ${error}`);
      expect(entries[0].data.code).toBe("push_error");
    });

    it("translates push_error legacy branch field", () => {
      const entries = translateBridgeEvent({ type: "push_error", error: "rejected", branch: "feat/y" }, ts);
      expect(entries[0].data.error).toBe("Push failed (feat/y): rejected");
    });

    it("translates push_error without branch", () => {
      const entries = translateBridgeEvent({ type: "push_error", error: "rejected" }, ts);
      expect(entries[0].data.error).toBe("Push failed: rejected");
    });

    it("translates retry_status with provider metadata", () => {
      const entries = translateBridgeEvent(
        {
          type: "retry_status",
          attempt: 7,
          message: "Provider is overloaded",
          nextRetryAt: "2026-03-31T18:36:00.000Z",
          provider: "openai",
          errorCode: "api_error",
          timestamp: 1711900000000,
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        type: "retry_status",
        timestamp: ts,
        data: {
          timestamp: 1711900000000,
          attempt: 7,
          message: "Provider is overloaded",
          nextRetryAt: "2026-03-31T18:36:00.000Z",
          provider: "openai",
          errorCode: "api_error",
        },
      });
    });

    it("translates compaction_start with contextTokens", () => {
      const entries = translateBridgeEvent({ type: "compaction_start", contextTokens: 892000, timestamp: 1000 }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("sandbox_compaction_start");
      expect(entries[0].data.contextTokens).toBe(892000);
      expect(entries[0].data.timestamp).toBe(1000);
    });

    it("translates compaction_start without contextTokens (backward compat)", () => {
      const entries = translateBridgeEvent({ type: "compaction_start", timestamp: 1000 }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("sandbox_compaction_start");
      expect(entries[0].data.contextTokens).toBeUndefined();
    });

    it("translates compaction_complete with before/after tokens", () => {
      const entries = translateBridgeEvent(
        { type: "compaction_complete", contextTokensBefore: 892000, contextTokensAfter: 245000, timestamp: 1001 },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("sandbox_compaction_complete");
      expect(entries[0].data.contextTokensBefore).toBe(892000);
      expect(entries[0].data.contextTokensAfter).toBe(245000);
    });

    it("translates compaction_complete without token data (backward compat)", () => {
      const entries = translateBridgeEvent({ type: "compaction_complete", timestamp: 1001 }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("sandbox_compaction_complete");
      expect(entries[0].data.contextTokensBefore).toBeUndefined();
    });

    it("translates context_fill_warning with all fields", () => {
      const entries = translateBridgeEvent(
        {
          type: "context_fill_warning",
          fillPercent: 0.834,
          contextTokens: 834000,
          contextWindow: 1000000,
          timestamp: 2000,
        },
        ts,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("sandbox_context_fill_warning");
      expect(entries[0].data.fillPercent).toBe(0.834);
      expect(entries[0].data.contextTokens).toBe(834000);
      expect(entries[0].data.contextWindow).toBe(1000000);
    });

    it("translates context_fill_warning without optional fields", () => {
      const entries = translateBridgeEvent({ type: "context_fill_warning", fillPercent: 0.85, timestamp: 2000 }, ts);
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe("sandbox_context_fill_warning");
      expect(entries[0].data.fillPercent).toBe(0.85);
      expect(entries[0].data.contextTokens).toBeUndefined();
    });

    it("returns empty for unknown event type", () => {
      expect(translateBridgeEvent({ type: "unknown_type" }, ts)).toEqual([]);
    });

    it("preserves the provided timestamp", () => {
      const customTs = "2025-06-01T12:00:00Z";
      const entries = translateBridgeEvent({ type: "session_idle" }, customTs);
      expect(entries[0].timestamp).toBe(customTs);
    });
  });

  describe("generateToolSummary", () => {
    it("generates summary for read tool", () => {
      expect(mod.generateToolSummary("read", { filePath: "/src/foo.ts" })).toBe("Reading /src/foo.ts");
    });

    it("generates summary for write tool", () => {
      expect(mod.generateToolSummary("write", { filePath: "/src/foo.ts" })).toBe("Writing /src/foo.ts");
    });

    it("generates summary for edit tool", () => {
      expect(mod.generateToolSummary("edit", { filePath: "/src/foo.ts" })).toBe("Editing /src/foo.ts");
    });

    it("generates summary for bash tool", () => {
      expect(mod.generateToolSummary("bash", { command: "npm test" })).toBe("npm test");
    });

    it("truncates long bash commands", () => {
      const longCommand = "a".repeat(100);
      const result = mod.generateToolSummary("bash", { command: longCommand });
      expect(result.length).toBeLessThanOrEqual(81); // 80 + ellipsis char
      expect(result).toContain("…");
    });

    it("generates summary for glob tool", () => {
      expect(mod.generateToolSummary("glob", { pattern: "**/*.ts" })).toBe("Finding **/*.ts");
    });

    it("generates summary for grep tool", () => {
      expect(mod.generateToolSummary("grep", { pattern: "TODO" })).toBe("Searching for TODO");
    });

    it("generates summary for agent tool", () => {
      expect(mod.generateToolSummary("agent", { description: "Find tests" })).toBe("Find tests");
    });

    it("generates summary for batch tool", () => {
      const result = mod.generateToolSummary("batch", {
        tool_calls: [
          { tool: "read", parameters: { filePath: "/src/foo.ts" } },
          { tool: "glob", parameters: { pattern: "**/*.ts" } },
          { tool: "grep", parameters: { pattern: "TODO" } },
        ],
      });
      expect(result).toBe("Reading /src/foo.ts, Finding **/*.ts, Searching for TODO");
    });

    it("generates summary for todowrite tool", () => {
      const result = mod.generateToolSummary("todowrite", {
        todos: [{ content: "Fix tests" }, { content: "Update docs" }, { content: "Add types" }],
      });
      expect(result).toBe("Fix tests, Update docs, Add types");
    });

    it("falls back to tool name for unknown tools with no string args", () => {
      expect(mod.generateToolSummary("custom_tool", { count: 42 })).toBe("custom_tool");
    });

    it("uses first short string value for unknown tools", () => {
      expect(mod.generateToolSummary("custom_tool", { path: "/foo/bar" })).toBe("/foo/bar");
    });

    it("falls back to tool name when file_path is missing for read", () => {
      expect(mod.generateToolSummary("read", {})).toBe("read");
    });

    it("falls back to tool name when command is missing for bash", () => {
      expect(mod.generateToolSummary("bash", {})).toBe("bash");
    });

    it("falls back to tool name for empty batch", () => {
      expect(mod.generateToolSummary("batch", { tool_calls: [] })).toBe("batch");
    });

    it("falls back to tool name for empty todowrite", () => {
      expect(mod.generateToolSummary("todowrite", { todos: [] })).toBe("todowrite");
    });
  });

  describe("resolveReplayCursor", () => {
    it("prefers query cursor when valid", () => {
      expect(mod.resolveReplayCursor("5", "3")).toBe(5);
    });

    it("falls back to header cursor when query is invalid", () => {
      expect(mod.resolveReplayCursor(null, "3")).toBe(3);
    });

    it("returns 0 when both are invalid", () => {
      expect(mod.resolveReplayCursor(null, null)).toBe(0);
    });

    it("handles undefined cursors", () => {
      expect(mod.resolveReplayCursor(undefined, undefined)).toBe(0);
    });

    it("handles zero cursor from query", () => {
      expect(mod.resolveReplayCursor("0", "5")).toBe(0);
    });

    it("handles event-N format in query cursor", () => {
      expect(mod.resolveReplayCursor("event-7", null)).toBe(7);
    });
  });

  describe("selectReplayWindow", () => {
    it("returns all events when count is under the default maxEvents", () => {
      const events = [makeEvent({ sequence: 1 }), makeEvent({ sequence: 2 }), makeEvent({ sequence: 3 })];
      const result = mod.selectReplayWindow(events, 0);
      expect(result.events).toHaveLength(3);
      expect(result.truncated).toBe(false);
      expect(result.droppedCount).toBe(0);
    });

    it("filters events after the given sequence", () => {
      const events = [
        makeEvent({ sequence: 1 }),
        makeEvent({ sequence: 2 }),
        makeEvent({ sequence: 3 }),
        makeEvent({ sequence: 4 }),
      ];
      const result = mod.selectReplayWindow(events, 2);
      expect(result.events).toHaveLength(2);
      expect(result.events[0].sequence).toBe(3);
      expect(result.events[1].sequence).toBe(4);
    });

    it("uses the 500-event default replay window boundary", () => {
      const under = Array.from({ length: REPLAY_WINDOW_SIZE - 1 }, (_, i) => makeEvent({ sequence: i + 1 }));
      const at = Array.from({ length: REPLAY_WINDOW_SIZE }, (_, i) => makeEvent({ sequence: i + 1 }));
      const over = Array.from({ length: REPLAY_WINDOW_SIZE + 1 }, (_, i) => makeEvent({ sequence: i + 1 }));

      const underResult = mod.selectReplayWindow(under, 0);
      expect(underResult.truncated).toBe(false);
      expect(underResult.events).toHaveLength(REPLAY_WINDOW_SIZE - 1);

      const atResult = mod.selectReplayWindow(at, 0);
      expect(atResult.truncated).toBe(false);
      expect(atResult.events).toHaveLength(REPLAY_WINDOW_SIZE);

      const overResult = mod.selectReplayWindow(over, 0);
      expect(overResult.truncated).toBe(true);
      expect(overResult.events).toHaveLength(REPLAY_WINDOW_SIZE);
      expect(overResult.droppedCount).toBe(1);
      expect(overResult.events[0]?.sequence).toBe(2);
      expect(overResult.events[overResult.events.length - 1]?.sequence).toBe(REPLAY_WINDOW_SIZE + 1);
    });

    it("truncates and drops oldest events when over maxEvents", () => {
      const events = Array.from({ length: 10 }, (_, i) => makeEvent({ sequence: i + 1 }));
      const result = mod.selectReplayWindow(events, 0, 3);
      expect(result.truncated).toBe(true);
      expect(result.events).toHaveLength(3);
      expect(result.events[0].sequence).toBe(8);
      expect(result.droppedCount).toBe(1);
    });

    it("handles empty events array", () => {
      const result = mod.selectReplayWindow([], 0);
      expect(result.events).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it("returns afterSequence in result", () => {
      const result = mod.selectReplayWindow([], "5" as unknown as number);
      expect(result.afterSequence).toBe(5);
    });
  });

  describe("buildSseResponse", () => {
    it("builds an SSE response with status and events", () => {
      const events = [
        makeEvent({ sequence: 1, type: "text", data: { text: "hello" } }),
        makeEvent({ sequence: 2, type: "tool_call", data: { tool: "bash" } }),
      ];
      const response = mod.buildSseResponse({ phase: "running" }, events);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
    });

    it("includes status event first", async () => {
      const response = mod.buildSseResponse({ phase: "running" }, []);
      const body = await response.text();
      expect(body).toContain('event: status\ndata: {"phase":"running"}');
    });

    it("includes event id and type for each event", async () => {
      const events = [makeEvent({ sequence: 3, type: "text", data: { text: "x" } })];
      const response = mod.buildSseResponse({ phase: "running" }, events);
      const body = await response.text();
      expect(body).toContain("id: 3");
      expect(body).toContain("event: text");
    });
  });

  describe("binarySearchAfterSequence", () => {
    it("returns 0 for empty array", () => {
      expect(mod.binarySearchAfterSequence([], 5)).toBe(0);
    });

    it("returns events.length when all sequences are below target", () => {
      const events = [makeEvent({ sequence: 1 }), makeEvent({ sequence: 2 }), makeEvent({ sequence: 3 })];
      expect(mod.binarySearchAfterSequence(events, 5)).toBe(3);
    });

    it("returns 0 when all sequences are above target", () => {
      const events = [makeEvent({ sequence: 5 }), makeEvent({ sequence: 6 }), makeEvent({ sequence: 7 })];
      expect(mod.binarySearchAfterSequence(events, 2)).toBe(0);
    });

    it("excludes exact match (finds first event with sequence > target)", () => {
      const events = [makeEvent({ sequence: 1 }), makeEvent({ sequence: 2 }), makeEvent({ sequence: 3 })];
      // target=2 means we want first event with seq > 2, which is index 2 (seq 3)
      expect(mod.binarySearchAfterSequence(events, 2)).toBe(2);
    });

    it("handles single-element array below target", () => {
      expect(mod.binarySearchAfterSequence([makeEvent({ sequence: 1 })], 5)).toBe(1);
    });

    it("handles single-element array above target", () => {
      expect(mod.binarySearchAfterSequence([makeEvent({ sequence: 10 })], 5)).toBe(0);
    });

    it("handles non-contiguous sequences", () => {
      const events = [makeEvent({ sequence: 1 }), makeEvent({ sequence: 5 }), makeEvent({ sequence: 10 })];
      // target=3: first event with seq > 3 is at index 1 (seq 5)
      expect(mod.binarySearchAfterSequence(events, 3)).toBe(1);
    });

    it("maintains sorted invariant in test data", () => {
      const events = [
        makeEvent({ sequence: 1 }),
        makeEvent({ sequence: 5 }),
        makeEvent({ sequence: 10 }),
        makeEvent({ sequence: 15 }),
      ];
      expect(events.every((e, i) => i === 0 || e.sequence >= events[i - 1].sequence)).toBe(true);
    });
  });

  describe("filterEventsForPrompt", () => {
    it("returns events between prompt_processing and the next prompt_processing", () => {
      const events: SessionEvent[] = [
        makeEvent({ sequence: 1, type: "prompt_processing", data: { promptId: "p-1" } }),
        makeEvent({ sequence: 2, type: "text", data: { id: "t-1", text: "hello" } }),
        makeEvent({ sequence: 3, type: "tool_call", data: { id: "tc-1", tool: "bash" } }),
        makeEvent({ sequence: 4, type: "prompt_completed", data: { promptId: "p-1" } }),
        makeEvent({ sequence: 5, type: "prompt_processing", data: { promptId: "p-2" } }),
        makeEvent({ sequence: 6, type: "text", data: { id: "t-2", text: "world" } }),
      ];
      const result = mod.filterEventsForPrompt(events, "p-1");
      expect(result).toHaveLength(4); // seq 1-4
      expect(result[0].sequence).toBe(1);
      expect(result[result.length - 1].sequence).toBe(4);
    });

    it("includes all events until end of stream when no next prompt", () => {
      const events: SessionEvent[] = [
        makeEvent({ sequence: 1, type: "prompt_processing", data: { promptId: "p-1" } }),
        makeEvent({ sequence: 2, type: "text", data: { id: "t-1", text: "hello" } }),
        makeEvent({ sequence: 3, type: "prompt_completed", data: { promptId: "p-1" } }),
      ];
      const result = mod.filterEventsForPrompt(events, "p-1");
      expect(result).toHaveLength(3);
    });

    it("returns empty when prompt_processing not found", () => {
      const events: SessionEvent[] = [makeEvent({ sequence: 1, type: "text", data: { id: "t-1", text: "hello" } })];
      expect(mod.filterEventsForPrompt(events, "p-nonexistent")).toEqual([]);
    });

    it("returns empty for empty events array", () => {
      expect(mod.filterEventsForPrompt([], "p-1")).toEqual([]);
    });

    it("filters second prompt correctly in multi-prompt stream", () => {
      const events: SessionEvent[] = [
        makeEvent({ sequence: 1, type: "prompt_processing", data: { promptId: "p-1" } }),
        makeEvent({ sequence: 2, type: "text", data: { id: "t-1", text: "first" } }),
        makeEvent({ sequence: 3, type: "prompt_completed", data: { promptId: "p-1" } }),
        makeEvent({ sequence: 4, type: "prompt_processing", data: { promptId: "p-2" } }),
        makeEvent({ sequence: 5, type: "text", data: { id: "t-2", text: "second" } }),
        makeEvent({ sequence: 6, type: "tool_call", data: { id: "tc-2", tool: "read" } }),
        makeEvent({ sequence: 7, type: "prompt_completed", data: { promptId: "p-2" } }),
      ];
      const result = mod.filterEventsForPrompt(events, "p-2");
      expect(result).toHaveLength(4); // seq 4-7
      expect(result[0].sequence).toBe(4);
      expect(result[result.length - 1].sequence).toBe(7);
    });
  });

  describe("appendDurableEvents", () => {
    function fakeState() {
      const state = createFakeState();
      seedSession(state.storage, { sessionId: "s-1", ownerUserId: "u-1" });
      return state;
    }

    it("returns base replay state for empty entries", async () => {
      const state = fakeState();
      const result = await mod.appendDurableEvents(state, "s-1", []);
      expect(result.replay.sessionId).toBe("s-1");
      expect(result.replay.lastEventSequence).toBe(0);
    });

    it("appends entries and increments sequence", async () => {
      const state = fakeState();
      const result = await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { text: "hello" } },
        { type: "text", timestamp: "2025-01-01T00:00:01Z", data: { text: "world" } },
      ]);
      expect(result.replay.lastEventSequence).toBe(2);
      expect(result.events).toHaveLength(2);
      expect(result.events[0].sequence).toBe(1);
      expect(result.events[1].sequence).toBe(2);
    });

    it("continues sequence from existing replay state", async () => {
      const state = fakeState();
      await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { text: "first" } },
      ]);
      const result = await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:01Z", data: { text: "second" } },
      ]);
      expect(result.replay.lastEventSequence).toBe(2);
      expect(result.events).toHaveLength(2);
    });

    it("keeps the full canonical log instead of compacting on write", async () => {
      const state = fakeState();
      const manyEntries = Array.from({ length: 510 }, (_, i) => ({
        type: "tool_call",
        timestamp: `2025-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        data: { id: `tc-${i}`, tool: "bash", output: "x".repeat(8_000) },
      }));
      const result = await mod.appendDurableEvents(state, "s-1", manyEntries);
      expect(result.events.length).toBe(510);
      expect(result.replay.lastEventSequence).toBe(510);
    });

    it("can skip returning the full event log after append", async () => {
      const state = fakeState();
      await mod.appendDurableEvents(state, "s-1", [{ type: "text", data: { text: "first" } }]);

      const result = await mod.appendDurableEvents(
        state,
        "s-1",
        [{ type: "text", data: { text: "second" } }],
        undefined,
        { includeEvents: false },
      );

      expect(result.replay.lastEventSequence).toBe(2);
      expect(result.events).toEqual([]);
      expect(result.newEvents).toHaveLength(1);
      expect(queryEvents(state.storage, "s-1").map((row) => row.sequence)).toEqual([1, 2]);
    });

    it("assigns event ids in format event-N", async () => {
      const state = fakeState();
      const result = await mod.appendDurableEvents(state, "s-1", [{ type: "text" }]);
      expect(result.events[0].id).toBe("event-1");
    });

    it("dedupes redelivered ACKed tool events by stable event id", async () => {
      const state = fakeState();
      const transportEvent = translateBridgeEventToCycloidEvent("s-1", {
        type: "tool_call",
        tool: "bash",
        args: { command: "npm test" },
        callId: "call-1",
        messageId: "p-1",
        sandboxId: "sbx-1",
        timestamp: Date.parse("2025-01-01T00:00:00Z"),
        ackId: "p-1:tool_call:1",
      });
      const projected = mod.projectCycloidEventToDurableEntry(transportEvent);
      expect(projected).toBeTruthy();
      const entry = { ...projected!, eventId: "ack:s-1:p-1:tool_call:1" };

      const first = await mod.appendDurableEvents(state, "s-1", [entry], "p-1");
      const second = await mod.appendDurableEvents(state, "s-1", [entry], "p-1");

      expect(first.newEvents).toHaveLength(1);
      expect(second.newEvents).toHaveLength(0);
      expect(second.events).toHaveLength(1);
      expect(second.events[0].id).toBe("ack:s-1:p-1:tool_call:1");
      expect(second.events[0].type).toBe("tool_call");
    });

    it("appends final_answer when final text was not durably streamed", async () => {
      const state = fakeState();
      const result = await mod.appendDurableEvents(
        state,
        "s-1",
        [
          {
            type: "text",
            timestamp: "2025-01-01T00:00:00Z",
            data: { id: "p-1:final_answer", text: "Done.", finalAnswer: true },
            eventId: "ack:s-1:p-1:final_answer:1:h",
          },
        ],
        "p-1",
      );

      expect(result.newEvents).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        id: "ack:s-1:p-1:final_answer:1:h",
        type: "text",
        data: { id: "p-1:final_answer", text: "Done.", finalAnswer: true, promptId: "p-1" },
      });
    });

    it("does not let an earlier final_answer suppress a newer missing snapshot", async () => {
      const state = fakeState();
      await mod.appendDurableEvents(
        state,
        "s-1",
        [
          {
            type: "text",
            timestamp: "2025-01-01T00:00:00Z",
            data: { id: "p-1:final_answer", text: "Earlier final.", finalAnswer: true },
            eventId: "ack:s-1:p-1:final_answer:1:old",
          },
        ],
        "p-1",
      );

      const result = await mod.appendDurableEvents(
        state,
        "s-1",
        [
          {
            type: "text",
            timestamp: "2025-01-01T00:00:01Z",
            data: { id: "p-1:final_answer", text: "Corrected final.", finalAnswer: true },
            eventId: "ack:s-1:p-1:final_answer:2:new",
          },
        ],
        "p-1",
      );

      expect(result.newEvents).toHaveLength(1);
      expect(result.events.map((event) => event.data.text)).toEqual(["Earlier final.", "Corrected final."]);
    });

    it("no-ops final_answer when the same final text already streamed", async () => {
      const state = fakeState();
      await mod.appendDurableEvents(
        state,
        "s-1",
        [
          { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { id: "part-1", text: "Done" } },
          { type: "text", timestamp: "2025-01-01T00:00:01Z", data: { id: "part-1", text: "." } },
        ],
        "p-1",
      );

      const result = await mod.appendDurableEvents(
        state,
        "s-1",
        [
          {
            type: "text",
            timestamp: "2025-01-01T00:00:02Z",
            data: { id: "p-1:final_answer", text: "Done.", finalAnswer: true },
            eventId: "ack:s-1:p-1:final_answer:1:h",
          },
        ],
        "p-1",
      );

      expect(result.newEvents).toHaveLength(0);
      expect(result.events).toHaveLength(2);
      expect(result.events.map((event) => event.data.text)).toEqual(["Done", "."]);
    });

    it("replays completed tool state and final_answer once after ACK redelivery", async () => {
      const state = fakeState();
      const entries = [
        {
          type: "tool_call",
          timestamp: "2025-01-01T00:00:00Z",
          data: { id: "call-1", tool: "bash", input: { command: "npm test" } },
          eventId: "ack:s-1:p-1:tool_call:1",
        },
        {
          type: "tool_update",
          timestamp: "2025-01-01T00:00:01Z",
          data: { id: "call-1", status: "completed" },
          eventId: "ack:s-1:p-1:tool_update:2",
        },
        {
          type: "text",
          timestamp: "2025-01-01T00:00:02Z",
          data: { id: "p-1:final_answer", text: "All set.", finalAnswer: true },
          eventId: "ack:s-1:p-1:final_answer:3:h",
        },
      ];

      await mod.appendDurableEvents(state, "s-1", entries, "p-1");
      const replay = await mod.appendDurableEvents(state, "s-1", entries, "p-1");

      expect(replay.events.map((event) => event.type)).toEqual(["tool_call", "tool_update", "text"]);
      expect(replay.events[1].data.status).toBe("completed");
      expect(replay.events[2].data.text).toBe("All set.");
      expect(replay.newEvents).toHaveLength(0);
    });

    it("stores canonical rows in SQL", async () => {
      const state = fakeState();
      const result = await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { text: "hello" } },
        { type: "tool_call", timestamp: "2025-01-01T00:00:01Z", data: { id: "tc-1", tool: "bash" } },
      ]);
      const rows = queryEvents(state.storage, "s-1");
      expect(result.replay.lastEventSequence).toBe(2);
      expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
      expect(rows.map((row) => row.type)).toEqual(["text", "tool_call"]);
    });

    it("derives row-level prompt_id per event from entry data", async () => {
      const state = fakeState();
      await mod.appendDurableEvents(state, "s-1", [
        { type: "prompt_failed", data: { promptId: "p-1", status: "failed" } },
        { type: "prompt_processing", data: { promptId: "p-2", status: "processing" } },
      ]);

      const rows = queryEvents(state.storage, "s-1");
      expect(rows.map((row) => row.prompt_id)).toEqual(["p-1", "p-2"]);
    });
  });
});
