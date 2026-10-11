import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildToolCallObservedEvent,
  emitToolCallRollupMetrics,
} from "../../apps/control-plane-worker/src/observability/tool-call-metrics";
import type { PromptToolRollupRow } from "../../apps/control-plane-worker/src/session/tool-rollup-db";

function row(overrides: Partial<PromptToolRollupRow> = {}): PromptToolRollupRow {
  return {
    sessionId: "s-1",
    promptId: "p-1",
    businessId: "biz-1",
    ownerUserId: 123,
    agent: "codex",
    toolName: "read",
    mcpServer: null,
    okCount: 1,
    errorCount: 0,
    totalDurationMs: 10,
    durationSampleCount: 1,
    createdAt: 1000,
    ...overrides,
  };
}

describe("emitToolCallRollupMetrics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts all tool-call count series in one Datadog request with bounded tags", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }));

    await emitToolCallRollupMetrics({ DD_API_KEY: "key-123", WORKER_ENV: "production" }, [
      row({ mcpServer: "cycloid-mcp_1", okCount: 3, errorCount: 2 }),
      row({ toolName: "mcp__repo__search", mcpServer: "repo", okCount: 4, errorCount: 0 }),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.series).toHaveLength(3);
    expect(body.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "arcanist.tool.calls",
          type: 1,
          points: [expect.objectContaining({ value: 3 })],
          tags: expect.arrayContaining(["agent:codex", "mcp_class:managed", "outcome:ok", "env:production"]),
        }),
        expect.objectContaining({
          metric: "arcanist.tool.calls",
          type: 1,
          points: [expect.objectContaining({ value: 2 })],
          tags: expect.arrayContaining(["agent:codex", "mcp_class:managed", "outcome:error", "env:production"]),
        }),
        expect.objectContaining({
          metric: "arcanist.tool.calls",
          type: 1,
          points: [expect.objectContaining({ value: 4 })],
          tags: expect.arrayContaining(["agent:codex", "mcp_class:repo", "outcome:ok", "env:production"]),
        }),
      ]),
    );
  });

  it("no-ops without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await emitToolCallRollupMetrics({}, [row()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("buildToolCallObservedEvent", () => {
  it("normalizes tool dimensions and rounds duration", () => {
    expect(
      buildToolCallObservedEvent({
        sessionId: "s-1",
        promptId: "p-1",
        businessId: "biz-1",
        ownerUserId: 123,
        agent: null,
        callId: "call-1",
        toolName: "mcp__Acme_Server__Namespace__Fetch",
        status: "completed",
        durationMs: 12.6,
      }),
    ).toEqual({
      event: "tool_call.observed",
      sessionId: "s-1",
      promptId: "p-1",
      businessId: "biz-1",
      ownerUserId: 123,
      agent: "unknown",
      callId: "call-1",
      toolName: "mcp__acme_server__namespace__fetch",
      mcpServer: "acme_server",
      mcpClass: "repo",
      outcome: "ok",
      timedOut: false,
      durationMs: 13,
    });
  });

  it("marks timeout errors and omits missing durations", () => {
    expect(
      buildToolCallObservedEvent({
        sessionId: "s-1",
        promptId: "p-1",
        businessId: "biz-1",
        ownerUserId: 123,
        agent: "codex",
        callId: "call-2",
        toolName: "bash",
        status: "error",
        failure: {
          category: "provider",
          phase: "provider",
          diagnosticsRedacted: true,
          safeSummary: "Command timed out after 30000ms",
        },
      }),
    ).toEqual({
      event: "tool_call.observed",
      sessionId: "s-1",
      promptId: "p-1",
      businessId: "biz-1",
      ownerUserId: 123,
      agent: "codex",
      callId: "call-2",
      toolName: "bash",
      mcpServer: null,
      mcpClass: "builtin",
      outcome: "error",
      timedOut: true,
    });
  });

  it("ignores non-terminal tool updates", () => {
    expect(
      buildToolCallObservedEvent({
        sessionId: "s-1",
        promptId: "p-1",
        businessId: "biz-1",
        ownerUserId: 123,
        agent: "codex",
        callId: "call-3",
        toolName: "read",
        status: "running",
      }),
    ).toBeNull();
  });
});
