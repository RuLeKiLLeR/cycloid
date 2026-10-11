import { beforeEach, describe, expect, it, vi } from "vitest";

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

interface ReplayState {
  sessionId: string;
  lastEventSequence: number;
  lastEventTimestamp: string | null;
  updatedAt: string | null;
}

type ReplayWindow = {
  afterSequence: number;
  events: SessionEvent[];
  truncated: boolean;
  droppedCount: number;
};

type EventsModule = {
  appendDurableEvents: (
    state: unknown,
    sessionId: string,
    entries: Array<{ type: string; timestamp?: string; data?: Record<string, unknown> }>,
    promptId?: string,
  ) => Promise<{ replay: ReplayState; events: SessionEvent[] }>;
  selectReplayWindow: (events: SessionEvent[], afterSequenceRaw: unknown, maxEvents?: number) => ReplayWindow;
  filterEventsForPrompt: (allEvents: SessionEvent[], promptId: string) => SessionEvent[];
};

let mod: EventsModule;

function fakeState() {
  const state = createFakeState();
  seedSession(state.storage, { sessionId: "s-1", ownerUserId: "u-1" });
  return state;
}

describe("event ordering through DO pipeline", () => {
  beforeEach(async () => {
    const modulePath: string = "../../apps/control-plane-worker/src/session/events";
    mod = (await import(modulePath)) as unknown as EventsModule;
  });

  it("preserves insertion order across multiple appendDurableEvents calls", async () => {
    const state = fakeState();
    await mod.appendDurableEvents(state, "s-1", [
      { type: "text", data: { id: "p1", text: "a" } },
      { type: "tool_call", data: { id: "t1", tool: "bash" } },
      { type: "tool_update", data: { id: "t1", status: "completed" } },
    ]);
    const result = await mod.appendDurableEvents(state, "s-1", [
      { type: "text", data: { id: "p2", text: "b" } },
      { type: "agent_progress", data: { label: "working" } },
      { type: "retry_status", data: { attempt: 1 } },
    ]);

    expect(result.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.events.map((e) => e.type)).toEqual([
      "text",
      "tool_call",
      "tool_update",
      "text",
      "agent_progress",
      "retry_status",
    ]);
  });

  it("does not compact or merge interleaved text events on canonical writes", async () => {
    const state = fakeState();
    const result = await mod.appendDurableEvents(state, "s-1", [
      { type: "text", data: { id: "partA", text: "hello " } },
      { type: "tool_call", data: { id: "t1", tool: "bash" } },
      { type: "text", data: { id: "partA", text: "world " } },
      { type: "tool_update", data: { id: "t1", status: "completed" } },
      { type: "text", data: { id: "partA", text: "!" } },
    ]);

    expect(result.events).toHaveLength(5);
    expect(result.events.map((e) => e.type)).toEqual(["text", "tool_call", "text", "tool_update", "text"]);
  });

  it("legacy prompt-boundary filtering still preserves cross-prompt ordering", async () => {
    const state = fakeState();
    const { events } = await mod.appendDurableEvents(state, "s-1", [
      { type: "prompt_processing", data: { promptId: "p1" } },
      { type: "text", data: { id: "t1", text: "hello" } },
      { type: "tool_call", data: { id: "tc1", tool: "bash" } },
      { type: "prompt_completed", data: { promptId: "p1" } },
      { type: "prompt_processing", data: { promptId: "p2" } },
      { type: "text", data: { id: "t2", text: "world" } },
      { type: "tool_call", data: { id: "tc2", tool: "read" } },
    ]);

    const p1Events = mod.filterEventsForPrompt(events, "p1");
    expect(p1Events).toHaveLength(4);
    expect(p1Events[0].sequence).toBe(1);
    expect(p1Events[p1Events.length - 1].sequence).toBe(4);

    const p2Events = mod.filterEventsForPrompt(events, "p2");
    expect(p2Events).toHaveLength(3);
    expect(p2Events[0].sequence).toBe(5);
    expect(p2Events[p2Events.length - 1].sequence).toBe(7);
  });

  it("replay window returns events in sequence order after cursor", async () => {
    const state = fakeState();
    const entries = Array.from({ length: 10 }, (_, i) => ({
      type: "tool_call",
      data: { id: `tc-${i}`, tool: "bash" },
    }));
    const { events } = await mod.appendDurableEvents(state, "s-1", entries);

    const window = mod.selectReplayWindow(events, 5);
    expect(window.events).toHaveLength(5);
    expect(window.events.map((e) => e.sequence)).toEqual([6, 7, 8, 9, 10]);
  });

  it("preserves tool call and update order", async () => {
    const state = fakeState();
    const result = await mod.appendDurableEvents(state, "s-1", [
      { type: "tool_call", data: { id: "tc1", tool: "bash" } },
      { type: "tool_update", data: { id: "tc1", status: "completed" } },
    ]);

    expect(result.events.map((e) => e.type)).toEqual(["tool_call", "tool_update"]);
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i].sequence).toBe(result.events[i - 1].sequence + 1);
    }
  });
});
