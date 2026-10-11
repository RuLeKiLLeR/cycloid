import { beforeAll, describe, expect, it, vi } from "vitest";

import { createFakeState, querySessionEvents, seedSession } from "./session/helpers";

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

type EventsModule = {
  appendDurableEvents: (
    state: unknown,
    sessionId: string,
    entries: Array<{ type: string; timestamp?: string; data?: Record<string, unknown> }>,
    promptId?: string,
  ) => Promise<{ replay: ReplayState; events: SessionEvent[]; newEvents?: SessionEvent[] }>;
};

function fakeState() {
  const state = createFakeState();
  seedSession(state.storage, { sessionId: "s-1", ownerUserId: "u-1" });
  return state;
}

let mod: EventsModule;

describe("compaction guard", () => {
  beforeAll(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/session/events";
    mod = (await import(modulePath)) as unknown as EventsModule;
  });

  describe("replay state tracking", () => {
    it("tracks replay state after append without approximateBytes", async () => {
      const state = fakeState();
      const result = await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { id: "t-1", text: "hello" } },
      ]);
      expect(result.replay.sessionId).toBe("s-1");
      expect(result.replay.lastEventSequence).toBe(1);
      expect(result.replay.lastEventTimestamp).toBeDefined();
      expect(result.replay.approximateBytes).toBeUndefined();
    });

    it("continues replay sequence across multiple appends", async () => {
      const state = fakeState();
      await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { id: "t-1", text: "hello" } },
      ]);
      const result2 = await mod.appendDurableEvents(state, "s-1", [
        { type: "text", timestamp: "2025-01-01T00:00:01Z", data: { id: "t-2", text: "world" } },
      ]);
      expect(result2.replay.lastEventSequence).toBe(2);
      expect(result2.replay.approximateBytes).toBeUndefined();
    });
  });

  describe("canonical append semantics", () => {
    it("keeps small canonical event sets unmerged on write", async () => {
      const state = fakeState();
      const entries: Array<{ type: string; timestamp: string; data: Record<string, unknown> }> = [];
      for (let i = 0; i < 5; i++) {
        entries.push({
          type: "text",
          timestamp: "2025-01-01T00:00:00Z",
          data: { id: "p-1", text: `chunk-${i} ` },
        });
      }
      for (let i = 0; i < 5; i++) {
        entries.push({
          type: "agent_progress",
          timestamp: "2025-01-01T00:00:01Z",
          data: { label: "working" },
        });
      }
      const result = await mod.appendDurableEvents(state, "s-1", entries);

      expect(result.events).toHaveLength(10);
      expect(result.events.filter((event) => event.type === "text")).toHaveLength(5);
      expect(querySessionEvents(state.storage, "s-1")).toHaveLength(10);
    });

    it("keeps over-threshold event sets in the canonical log", async () => {
      const state = fakeState();
      const entries = Array.from({ length: 400 }, (_, i) => ({
        type: "tool_call" as const,
        timestamp: "2025-01-01T00:00:00Z",
        data: { id: `tc-${i}`, tool: "bash", output: "x".repeat(10_000) },
      }));
      const result = await mod.appendDurableEvents(state, "s-1", entries);

      expect(result.events).toHaveLength(400);
      expect(result.replay.lastEventSequence).toBe(400);
      expect(querySessionEvents(state.storage, "s-1")).toHaveLength(400);
    });

    it("preserves accumulated canonical rows across multiple appends", async () => {
      const state = fakeState();

      const smallEntries = Array.from({ length: 10 }, (_, i) => ({
        type: "text" as const,
        timestamp: "2025-01-01T00:00:00Z",
        data: { id: `p-${i}`, text: "small" },
      }));
      await mod.appendDurableEvents(state, "s-1", smallEntries);

      const bigEntries = Array.from({ length: 300 }, (_, i) => ({
        type: "tool_call" as const,
        timestamp: "2025-01-01T00:00:01Z",
        data: { id: `tc-${i}`, tool: "bash", output: "y".repeat(15_000) },
      }));
      const result2 = await mod.appendDurableEvents(state, "s-1", bigEntries);

      expect(result2.events).toHaveLength(310);
      expect(result2.replay.lastEventSequence).toBe(310);
      expect(querySessionEvents(state.storage, "s-1")).toHaveLength(310);
    });

    it("preserves canonical event count for very large batches", async () => {
      const state = fakeState();
      const entries = Array.from({ length: 500 }, (_, i) => ({
        type: "tool_call" as const,
        timestamp: "2025-01-01T00:00:00Z",
        data: { id: `tc-${i}`, tool: "bash", output: "x".repeat(100_000) },
      }));
      const result = await mod.appendDurableEvents(state, "s-1", entries);
      expect(result.events).toHaveLength(500);
    });

    it("returns newEvents while keeping canonical rows unmerged", async () => {
      const state = fakeState();
      const entries = [
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { id: "t-1", text: "chunk1" } },
        { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { id: "t-1", text: "chunk2" } },
        { type: "tool_call", timestamp: "2025-01-01T00:00:01Z", data: { id: "tc-1", tool: "bash" } },
      ];
      const result = await mod.appendDurableEvents(state, "s-1", entries);

      // newEvents should have all 3 entries (pre-compaction)
      expect(result.newEvents).toHaveLength(3);
      expect(result.newEvents![0].type).toBe("text");
      expect(result.newEvents![1].type).toBe("text");
      expect(result.newEvents![2].type).toBe("tool_call");

      expect(querySessionEvents(state.storage, "s-1")).toHaveLength(3);
      const textEvents = result.events.filter((e) => e.type === "text");
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0].data.text).toBe("chunk1");
      expect(textEvents[1].data.text).toBe("chunk2");
    });
  });
});
