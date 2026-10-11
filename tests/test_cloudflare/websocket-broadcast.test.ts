import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate";
import { createFakeState, seedSession } from "./session/helpers";

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

type DurableEntry = { type: string; timestamp?: string; data?: Record<string, unknown> };

type EventsModule = {
  projectCycloidEventToDurableEntry: (
    event: ReturnType<typeof translateBridgeEventToCycloidEvent>,
  ) => DurableEntry | null;
  appendDurableEvents: (
    state: unknown,
    sessionId: string,
    entries: DurableEntry[],
    promptId?: string,
  ) => Promise<{ replay: { lastEventSequence: number }; events: SessionEvent[]; newEvents?: SessionEvent[] }>;
};

let mod: EventsModule;

function translateBridgeEvent(event: Record<string, unknown>, ts: string): DurableEntry[] {
  const projected = mod.projectCycloidEventToDurableEntry(
    translateBridgeEventToCycloidEvent("s-1", {
      messageId: "prompt-1",
      sandboxId: "sbx-1",
      timestamp: Date.parse(ts),
      ...event,
    } as never),
  );
  return projected ? [projected] : [];
}

function fakeState() {
  const state = createFakeState();
  seedSession(state.storage, { sessionId: "s-1", ownerUserId: "u-1" });
  return state;
}

describe("websocket broadcast: newEvents shape", () => {
  beforeEach(async () => {
    const modulePath = "../../apps/control-plane-worker/src/session/events";
    mod = (await import(modulePath)) as unknown as EventsModule;
  });

  it("returns newEvents with correct DurableSessionEvent shape", async () => {
    const state = fakeState();
    const result = await mod.appendDurableEvents(state, "s-1", [
      { type: "text", timestamp: "2025-01-01T00:00:00Z", data: { text: "hello" } },
    ]);

    expect(result.newEvents).toBeDefined();
    expect(result.newEvents).toHaveLength(1);

    const event = result.newEvents![0];
    expect(event).toHaveProperty("type", "text");
    expect(event).toHaveProperty("sequence", 1);
    expect(event).toHaveProperty("data");
    expect(event.data.text).toBe("hello");
  });

  it("returns no newEvents for empty entries", async () => {
    const state = fakeState();
    const result = await mod.appendDurableEvents(state, "s-1", []);
    expect(result.newEvents).toBeUndefined();
  });

  it("produces incrementing sequences across sequential appends", async () => {
    const state = fakeState();

    const r1 = await mod.appendDurableEvents(state, "s-1", [
      { type: "text", data: { text: "first" } },
      { type: "text", data: { text: "second" } },
    ]);
    expect(r1.newEvents).toHaveLength(2);
    expect(r1.newEvents![0].sequence).toBe(1);
    expect(r1.newEvents![1].sequence).toBe(2);

    const r2 = await mod.appendDurableEvents(state, "s-1", [{ type: "tool_call", data: { tool: "bash" } }]);
    expect(r2.newEvents).toHaveLength(1);
    expect(r2.newEvents![0].sequence).toBe(3);
  });

  it("attaches promptId to newEvents data when provided", async () => {
    const state = fakeState();
    const result = await mod.appendDurableEvents(state, "s-1", [{ type: "text", data: { text: "hello" } }], "p-1");

    expect(result.newEvents![0].data.promptId).toBe("p-1");
  });

  it("translateBridgeEvent output round-trips through appendDurableEvents", async () => {
    const state = fakeState();
    const ts = "2025-01-01T00:00:00Z";

    // Translate a bridge token event
    const entries = translateBridgeEvent(
      { type: "token", content: "hello world", messageId: "m-1", partId: "p-1" },
      ts,
    );
    expect(entries.length).toBeGreaterThan(0);

    // Feed translated entries into appendDurableEvents
    const result = await mod.appendDurableEvents(state, "s-1", entries);
    expect(result.newEvents).toHaveLength(entries.length);

    const event = result.newEvents![0];
    expect(event.type).toBe("text");
    expect(event.sequence).toBe(1);
    expect(event.data.text).toBe("hello world");
    // partId takes precedence over messageId for text event id
    expect(event.data.id).toBe("p-1");
  });

  it("translateBridgeEvent tool_call keeps the transport promptId when appending durable events", async () => {
    const state = fakeState();
    const ts = "2025-01-01T00:00:00Z";

    const entries = translateBridgeEvent(
      { type: "tool_call", tool: "bash", callId: "c-1", args: { command: "ls" }, messageId: "m-1" },
      ts,
    );

    const result = await mod.appendDurableEvents(state, "s-1", entries, "prompt-1");
    expect(result.newEvents).toHaveLength(1);

    const event = result.newEvents![0];
    expect(event.type).toBe("tool_call");
    expect(event.data.tool).toBe("bash");
    expect(event.data.id).toBe("c-1");
    expect(event.data.input).toEqual({ command: "ls" });
    expect(event.data.promptId).toBe("m-1");
  });
});
