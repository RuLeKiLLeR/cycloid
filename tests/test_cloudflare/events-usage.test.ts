import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate";

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

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

type DurableEntry = { type: string; timestamp: string; data: Record<string, unknown> };
type EventsModule = {
  projectCycloidEventToDurableEntry: (
    event: ReturnType<typeof translateBridgeEventToCycloidEvent>,
  ) => DurableEntry | null;
};

let projectCycloidEventToDurableEntry: EventsModule["projectCycloidEventToDurableEntry"];

function translateBridgeEvent(event: Record<string, unknown>, _ts: string): DurableEntry[] {
  const enrichedEvent = {
    messageId: "prompt-1",
    sandboxId: "sbx-1",
    timestamp: Date.parse(_ts),
    ...event,
  };
  const projected = projectCycloidEventToDurableEntry(
    translateBridgeEventToCycloidEvent("session-1", enrichedEvent as never),
  );
  return projected ? [{ type: projected.type, timestamp: _ts, data: projected.data }] : [];
}

beforeEach(async () => {
  vi.resetModules();
  const mod = (await import("../../apps/control-plane-worker/src/session/events.js")) as unknown as EventsModule;
  projectCycloidEventToDurableEntry = mod.projectCycloidEventToDurableEntry;
});

describe("translateBridgeEvent — token fields", () => {
  const ts = "2026-01-01T00:00:00Z";

  it("passes inputEstimatedTokens through on tool_call", () => {
    const entries = translateBridgeEvent(
      {
        type: "tool_call",
        tool: "read",
        args: { filePath: "/foo.ts" },
        callId: "tc1",
        inputEstimatedTokens: 42,
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data.inputEstimatedTokens).toBe(42);
  });

  it("omits inputEstimatedTokens when not present on tool_call", () => {
    const entries = translateBridgeEvent(
      {
        type: "tool_call",
        tool: "read",
        args: { filePath: "/foo.ts" },
        callId: "tc1",
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data).not.toHaveProperty("inputEstimatedTokens");
  });

  it("passes outputEstimatedTokens and outputChars through on tool_update", () => {
    const entries = translateBridgeEvent(
      {
        type: "tool_update",
        callId: "tc1",
        tool: "read",
        status: "completed",
        outputEstimatedTokens: 100,
        outputChars: 400,
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data.outputEstimatedTokens).toBe(100);
    expect(entries[0].data.outputChars).toBe(400);
  });

  it("passes structured redacted failure through on tool_update without raw diagnostics", () => {
    const entries = translateBridgeEvent(
      {
        type: "tool_update",
        callId: "tc1",
        tool: "bash",
        status: "error",
        failure: {
          category: "auth",
          phase: "auth",
          diagnosticsRedacted: true,
          safeSummary: "Authentication failed for token [REDACTED]",
          upstream: { runId: "123", logUrl: "https://github.com/trycycloid/cycloid/actions/runs/123" },
        },
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toEqual({
      id: "tc1",
      status: "error",
      failure: {
        category: "auth",
        phase: "auth",
        diagnosticsRedacted: true,
        safeSummary: "Authentication failed for token [REDACTED]",
        upstream: { runId: "123", logUrl: "https://github.com/trycycloid/cycloid/actions/runs/123" },
      },
    });
    expect(JSON.stringify(entries[0].data)).not.toContain("ghp_");
  });

  it("omits outputEstimatedTokens when not present on tool_update", () => {
    const entries = translateBridgeEvent(
      {
        type: "tool_update",
        callId: "tc1",
        tool: "read",
        status: "completed",
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data).not.toHaveProperty("outputEstimatedTokens");
    expect(entries[0].data).not.toHaveProperty("outputChars");
  });

  it("passes all scoped usage fields through", () => {
    const entries = translateBridgeEvent(
      {
        type: "usage",
        inputTokens: 1000,
        outputTokens: 500,
        contextTokens: 8000,
        peakContextTokens: 15000,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        totalCostUsd: 0.05,
        model: "gpt-5.4-mini",
        contextCacheRead: 6000,
        contextCacheWrite: 500,
        contextUncachedInput: 1500,
        cumulativeCacheRead: 12000,
        cumulativeCacheWrite: 800,
        instructionFilesEst: 3000,
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    const d = entries[0].data;
    expect(d.inputTokens).toBe(1000);
    expect(d.outputTokens).toBe(500);
    expect(d.peakContextTokens).toBe(15000);
    expect(d.contextCacheRead).toBe(6000);
    expect(d.contextCacheWrite).toBe(500);
    expect(d.contextUncachedInput).toBe(1500);
    expect(d.cumulativeCacheRead).toBe(12000);
    expect(d.cumulativeCacheWrite).toBe(800);
    expect(d.instructionFilesEst).toBe(3000);
  });

  it("omits scoped usage fields when not present", () => {
    const entries = translateBridgeEvent(
      {
        type: "usage",
        inputTokens: 1000,
        outputTokens: 500,
        contextTokens: 8000,
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    const d = entries[0].data;
    expect(d).not.toHaveProperty("peakContextTokens");
    expect(d).not.toHaveProperty("contextCacheRead");
    expect(d).not.toHaveProperty("cumulativeCacheRead");
    expect(d).not.toHaveProperty("instructionFilesEst");
    expect(d).not.toHaveProperty("contextWindow");
  });

  it("passes contextWindow through on usage event", () => {
    const entries = translateBridgeEvent(
      {
        type: "usage",
        inputTokens: 1000,
        outputTokens: 500,
        contextTokens: 8000,
        contextWindow: 1_000_000,
        model: "gpt-5.4",
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data.contextWindow).toBe(1_000_000);
  });

  it("omits contextWindow when not present on usage event", () => {
    const entries = translateBridgeEvent(
      {
        type: "usage",
        inputTokens: 1000,
        outputTokens: 500,
        contextTokens: 8000,
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].data).not.toHaveProperty("contextWindow");
  });
});

describe("translateBridgeEvent — memory_recall_usage trace stripping", () => {
  const ts = "2026-01-01T00:00:00Z";

  it("strips retrievalTrace and decisionTrace from durable data but keeps bounded fields", () => {
    const entries = translateBridgeEvent(
      {
        type: "memory_recall_usage",
        eventName: "memory_context.returned",
        requestedMemoryIds: ["mem-1"],
        returnedMemoryIds: ["mem-1"],
        returnedMemories: [{ id: "mem-1", title: "Routes call services.", selectionRank: 1 }],
        usageSource: "recall",
        intent: "fix the sink",
        retrievalTrace: { candidates: [{ id: "mem-rejected", claim: "internal claim excerpt" }] },
        decisionTrace: { selector: { rejected: [{ id: "mem-rejected" }] } },
      },
      ts,
    );
    expect(entries).toHaveLength(1);
    // Session events are replayed to viewers: internal selector/retrieval traces
    // (which include non-injected candidates) must never be persisted here.
    expect(entries[0].data).not.toHaveProperty("retrievalTrace");
    expect(entries[0].data).not.toHaveProperty("decisionTrace");
    expect(entries[0].data.returnedMemoryIds).toEqual(["mem-1"]);
    expect(entries[0].data.usageSource).toBe("recall");
    expect(entries[0].data.intent).toBe("fix the sink");
    expect(entries[0].data.returnedMemories).toEqual([
      { id: "mem-1", title: "Routes call services.", selectionRank: 1 },
    ]);
  });
});
