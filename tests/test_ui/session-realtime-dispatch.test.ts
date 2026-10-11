import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableEventDispatchContext } from "../../apps/ui/src/utils/durable-event-dispatch";
import { dispatchRealtimeDurableEvent } from "../../apps/ui/src/utils/session-realtime-dispatch";

const durableEventDispatchMocks = vi.hoisted(() => ({
  handleDurableEvent: vi.fn(),
}));

vi.mock("../../apps/ui/src/utils/durable-event-dispatch", () => ({
  handleDurableEvent: durableEventDispatchMocks.handleDurableEvent,
}));

function makeContext(): DurableEventDispatchContext {
  return {
    sessionId: "s-1",
    context: "live",
    dispatch: vi.fn(),
    stateRef: { current: { session: null, prompts: [], transcripts: new Map() } },
    syncSessionStatus: vi.fn(),
    refresh: vi.fn(),
    fetchPromptEvents: vi.fn(async () => ({
      ok: true as const,
      result: {
        events: [],
        maxSequence: 0,
      },
      rawEvents: [],
    })),
    terminalPhases: new Set(["archived"]),
  };
}

function makeState() {
  return {
    lastSequenceRef: { current: 0 },
  };
}

describe("dispatchRealtimeDurableEvent", () => {
  beforeEach(() => {
    durableEventDispatchMocks.handleDurableEvent.mockReset();
  });

  it("dispatches newer live events through canonical ingestion and handleDurableEvent", () => {
    const ctx = makeContext();
    const state = makeState();

    const handled = dispatchRealtimeDurableEvent(
      { type: "text", sequence: 4, data: { promptId: "p-1", text: "hello" } },
      "live",
      ctx,
      state,
    );

    expect(handled).toBe(true);
    expect(state.lastSequenceRef.current).toBe(4);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "event/ingest_live_event",
      event: { type: "text", sequence: 4, data: { promptId: "p-1", text: "hello" } },
    });
    expect(durableEventDispatchMocks.handleDurableEvent).toHaveBeenCalledWith(
      "text",
      { promptId: "p-1", text: "hello" },
      expect.objectContaining({ context: "live" }),
      undefined,
    );
  });

  it("ignores duplicate or older events", () => {
    const ctx = makeContext();
    const state = makeState();
    state.lastSequenceRef.current = 6;

    const handled = dispatchRealtimeDurableEvent(
      { type: "text", sequence: 6, data: { promptId: "p-1", text: "stale" } },
      "live",
      ctx,
      state,
    );

    expect(handled).toBe(false);
    expect(state.lastSequenceRef.current).toBe(6);
    expect(durableEventDispatchMocks.handleDurableEvent).not.toHaveBeenCalled();
  });

  it("routes replay events through replay-page ingestion without skip heuristics", () => {
    const ctx = makeContext();
    const state = makeState();

    const handled = dispatchRealtimeDurableEvent(
      { type: "text", sequence: 7, data: { promptId: "p-1", text: "duplicate replay" } },
      "replay",
      ctx,
      state,
    );

    expect(handled).toBe(true);
    expect(state.lastSequenceRef.current).toBe(7);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "event/ingest_replay_page",
      events: [{ type: "text", sequence: 7, data: { promptId: "p-1", text: "duplicate replay" } }],
    });
    expect(durableEventDispatchMocks.handleDurableEvent).toHaveBeenCalledWith(
      "text",
      { promptId: "p-1", text: "duplicate replay" },
      expect.objectContaining({ context: "replay" }),
      undefined,
    );
  });
});
