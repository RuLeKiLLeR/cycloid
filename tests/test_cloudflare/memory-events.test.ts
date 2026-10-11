import { describe, expect, it, vi } from "vitest";

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

import { projectCycloidEventToDurableEntry } from "../../apps/control-plane-worker/src/session/cycloid-event-store";

function translateBridgeEvent(event: Record<string, unknown>, ts: string) {
  const projected = projectCycloidEventToDurableEntry(
    translateBridgeEventToCycloidEvent("session-1", {
      messageId: "prompt-1",
      sandboxId: "sbx-1",
      timestamp: Date.parse(ts),
      ...event,
    } as never),
  );
  return projected ? [{ type: projected.type, timestamp: ts, data: projected.data }] : [];
}

describe("projectCycloidEventToDurableEntry memory_usage", () => {
  it("translates memory_usage into a durable event with activeMemoryIds", () => {
    const ts = new Date().toISOString();
    const result = translateBridgeEvent(
      {
        type: "memory_usage",
        messageId: "p-1",
        sandboxId: "sb-1",
        timestamp: Date.now(),
        activeMemoryIds: ["mem-1", "mem-2"],
      },
      ts,
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("memory_usage");
    expect(result[0].timestamp).toBe(ts);
    expect(result[0].data).toEqual({ activeMemoryIds: ["mem-1", "mem-2"] });
  });

  it("preserves activeMemories metadata when present", () => {
    const ts = new Date().toISOString();
    const activeMemories = [
      { id: "mem-1", path: ".cycloid/memory/engineering/gotchas/one.md", title: "One" },
      { id: "mem-2", path: ".cycloid/memory/engineering/gotchas/two.md", title: "Two" },
    ];
    const result = translateBridgeEvent(
      {
        type: "memory_usage",
        messageId: "p-1",
        sandboxId: "sb-1",
        timestamp: Date.parse(ts),
        activeMemoryIds: ["mem-1", "mem-2"],
        activeMemories,
      },
      ts,
    );
    expect(result).toHaveLength(1);
    expect(result[0].data).toEqual({ activeMemoryIds: ["mem-1", "mem-2"], activeMemories });
  });

  it("still translates other event types normally", () => {
    const result = translateBridgeEvent(
      { type: "patch", messageId: "p-1", sandboxId: "sb-1", timestamp: Date.now(), files: ["src/app.ts"] },
      new Date().toISOString(),
    );
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("patch");
  });

  it("translates memory_recall_usage into a telemetry durable event", () => {
    const ts = new Date().toISOString();
    const result = translateBridgeEvent(
      {
        type: "memory_recall_usage",
        messageId: "p-1",
        sandboxId: "sb-1",
        timestamp: Date.parse(ts),
        eventName: "memory_recall.returned",
        requestedMemoryIds: ["mem-a", "mem-b"],
        returnedMemoryIds: ["mem-b"],
        intent: "Patch auth route",
        files: ["apps/control-plane-worker/src/auth/routes.ts"],
        symbols: ["verifyUserRepoAccess"],
        tool: "apply_patch",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        codexItemId: "item-1",
        retrievalTrace: {
          retrievalConfigVersion: "repo-memory-denoise-v1-explicit-recall",
          candidateCount: 2,
          selectedCount: 1,
          returnedEmpty: false,
        },
      },
      ts,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "memory_recall_usage",
      timestamp: ts,
      data: {
        type: "memory_recall_usage",
        messageId: "p-1",
        sandboxId: "sb-1",
        eventName: "memory_recall.returned",
        requestedMemoryIds: ["mem-a", "mem-b"],
        returnedMemoryIds: ["mem-b"],
        intent: "Patch auth route",
        files: ["apps/control-plane-worker/src/auth/routes.ts"],
        symbols: ["verifyUserRepoAccess"],
        tool: "apply_patch",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        codexItemId: "item-1",
      },
    });
    // Internal retrieval/selector traces must not be persisted into durable
    // session events (they are replayed to session viewers).
    expect(result[0].data).not.toHaveProperty("retrievalTrace");
    expect(result[0].data).not.toHaveProperty("decisionTrace");
  });

  it("preserves requested/returned memory metadata when present", () => {
    const ts = new Date().toISOString();
    const requestedMemories = [
      { id: "mem-a", path: ".cycloid/memory/engineering/gotchas/a.md", title: "A" },
      { id: "mem-b", path: ".cycloid/memory/engineering/gotchas/b.md", title: "B" },
    ];
    const returnedMemories = [requestedMemories[1]];
    const result = translateBridgeEvent(
      {
        type: "memory_recall_usage",
        messageId: "p-1",
        sandboxId: "sb-1",
        timestamp: Date.parse(ts),
        eventName: "memory_recall.returned",
        requestedMemoryIds: ["mem-a", "mem-b"],
        returnedMemoryIds: ["mem-b"],
        requestedMemories,
        returnedMemories,
      },
      ts,
    );
    expect(result[0].data).toMatchObject({
      requestedMemories,
      returnedMemories,
    });
  });
});
