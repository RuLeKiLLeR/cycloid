import { describe, expect, it } from "vitest";

import {
  type CycloidEvent,
  decodeCycloidEvent,
  encodeCycloidEvent,
  isPhase,
  REMOVED_BRIDGE_EVENT_TYPES,
  validateCycloidEvent,
} from "../../shared/events/schema.js";

describe("isPhase", () => {
  it("accepts planned canonical phases", () => {
    expect(isPhase("bridge.event")).toBe(true);
    expect(isPhase("prompt.enqueue")).toBe(true);
    expect(isPhase("tool.result")).toBe(true);
    expect(isPhase("timeline")).toBe(true);
    expect(isPhase("idle")).toBe(true);
  });

  it("rejects unknown or malformed phases", () => {
    expect(isPhase("prompt_enqueued")).toBe(false);
    expect(isPhase("")).toBe(false);
    expect(isPhase(undefined)).toBe(false);
    expect(isPhase(null)).toBe(false);
  });
});

describe("CycloidEvent encoding", () => {
  it("round-trips a representative prompt event", () => {
    const event: CycloidEvent<"prompt.enqueue"> = {
      phase: "prompt.enqueue",
      timestampMs: 1_763_000_000_000,
      sessionId: "session-1",
      promptId: "prompt-1",
      payload: {
        actorUserId: "user-1",
        agent: "primary",
        model: "gpt-5.4-mini",
      },
    };

    expect(decodeCycloidEvent(encodeCycloidEvent(event))).toEqual(event);
  });

  it("round-trips a representative tool event", () => {
    const event: CycloidEvent<"tool.result"> = {
      phase: "tool.result",
      timestampMs: 1_763_000_000_123,
      sessionId: "session-2",
      promptId: "prompt-9",
      sandboxId: "sandbox-1",
      payload: {
        callId: "call-1",
        tool: "bash",
        ok: true,
        result: { stdout: "ok" },
      },
    };

    expect(decodeCycloidEvent(encodeCycloidEvent(event))).toEqual(event);
  });

  it("round-trips a bridge compatibility event", () => {
    const event: CycloidEvent<"bridge.event"> = {
      phase: "bridge.event",
      timestampMs: 1_763_000_000_456,
      sessionId: "session-3",
      promptId: "prompt-3",
      sandboxId: "sandbox-3",
      payload: {
        bridgeEventType: "memory_usage",
        bridgeData: {
          messageId: "prompt-3",
          activeMemoryIds: ["mem-1", "mem-2"],
        },
      },
    };

    expect(decodeCycloidEvent(encodeCycloidEvent(event))).toEqual(event);
  });

  it("round-trips verification phase artifact bridge metadata", () => {
    const event: CycloidEvent<"bridge.event"> = {
      phase: "bridge.event",
      timestampMs: 1_763_000_000_456,
      sessionId: "session-3",
      promptId: "prompt-3",
      sandboxId: "sandbox-3",
      payload: {
        bridgeEventType: "verification_phase_artifact",
        verificationPhase: "verification-operator",
        intermediate: true,
        bridgeData: {
          runId: "run-1",
        },
      },
    };

    expect(decodeCycloidEvent(encodeCycloidEvent(event))).toEqual(event);
  });

  it("round-trips legacy checker phase bridge metadata for persisted event replay", () => {
    const event: CycloidEvent<"bridge.event"> = {
      phase: "bridge.event",
      timestampMs: 1_763_000_000_456,
      sessionId: "session-3",
      promptId: "prompt-3",
      sandboxId: "sandbox-3",
      payload: {
        bridgeEventType: "verification_phase_artifact",
        verificationPhase: "verification-checker",
        intermediate: true,
        bridgeData: {
          runId: "run-1",
        },
      },
    };

    expect(decodeCycloidEvent(encodeCycloidEvent(event))).toEqual(event);
  });

  it("rejects invalid verification phase artifact bridge metadata", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "bridge.event",
          timestampMs: 1,
          sessionId: "session-1",
          payload: {
            bridgeEventType: "verification_phase_artifact",
            verificationPhase: "verification-inspector",
            intermediate: true,
          },
        }),
      ),
    ).toThrow("Invalid payload for phase bridge.event");
  });

  it.each(Array.from(REMOVED_BRIDGE_EVENT_TYPES))("rejects removed bridge event type %s", (bridgeEventType) => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "bridge.event",
          timestampMs: 1,
          sessionId: "session-1",
          payload: {
            bridgeEventType,
            bridgeData: { delta: "removed" },
          },
        }),
      ),
    ).toThrow("Invalid payload for phase bridge.event");

    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "text.delta",
          timestampMs: 1,
          sessionId: "session-1",
          payload: {
            channel: "output",
            text: "hello",
            bridgeEventType,
          },
        }),
      ),
    ).toThrow("Invalid payload for phase text.delta");
  });

  it("round-trips an observed agent timeline event", () => {
    const event: CycloidEvent<"timeline"> = {
      phase: "timeline",
      timestampMs: 1_763_000_000_789,
      sessionId: "session-4",
      promptId: "prompt-4",
      sandboxId: "sandbox-4",
      payload: {
        eventType: "context.selected",
        source: "observed",
        observer: "sandbox_bridge",
        summary: "Selected repo instructions.",
        status: "completed",
        metadata: {
          instructionFileCount: 1,
          instructionFiles: ["AGENTS.md"],
        },
      },
    };

    expect(decodeCycloidEvent(encodeCycloidEvent(event))).toEqual(event);
  });

  it("rejects malformed agent timeline payloads", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "timeline",
          timestampMs: 1,
          sessionId: "session-1",
          payload: {
            eventType: "claimed.magic",
            source: "claimed",
            observer: "sandbox_bridge",
            summary: "Looks plausible.",
          },
        }),
      ),
    ).toThrow("Invalid payload for phase timeline");
  });

  it("rejects timeline payloads with blank summaries", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "timeline",
          timestampMs: 1,
          sessionId: "session-1",
          payload: {
            eventType: "files.inspected",
            source: "observed",
            observer: "sandbox_bridge",
            summary: "   ",
          },
        }),
      ),
    ).toThrow("Invalid payload for phase timeline");
  });

  it("rejects an invalid phase during decode", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "prompt_enqueued",
          timestampMs: 1_763_000_000_000,
          sessionId: "session-1",
          payload: {},
        }),
      ),
    ).toThrow("Invalid phase");
  });

  it("rejects malformed payloads for phases with required fields", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "tool.call",
          timestampMs: 1,
          sessionId: "session-1",
          payload: {},
        }),
      ),
    ).toThrow("Invalid payload for phase tool.call");
  });

  it("rejects non-finite timestampMs", () => {
    expect(() =>
      decodeCycloidEvent('{"phase":"idle","timestampMs":1e309,"sessionId":"session-1","payload":{}}'),
    ).toThrow("Invalid timestampMs");
  });

  it("rejects empty sessionId", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "idle",
          timestampMs: 1,
          sessionId: "",
          payload: {},
        }),
      ),
    ).toThrow("Invalid sessionId");
  });

  it("rejects non-record payloads", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "idle",
          timestampMs: 1,
          sessionId: "session-1",
          payload: null,
        }),
      ),
    ).toThrow("Invalid payload");
  });

  it("rejects removed benchmark session kinds", () => {
    expect(() =>
      decodeCycloidEvent(
        JSON.stringify({
          phase: "session.create",
          timestampMs: 1,
          sessionId: "session-1",
          payload: { source: "api", sessionKind: "terminal_bench" },
        }),
      ),
    ).toThrow("Invalid payload for phase session.create");
  });
});

describe("validateCycloidEvent", () => {
  it("validates a pre-parsed object without re-serializing", () => {
    const event: CycloidEvent<"idle"> = {
      phase: "idle",
      timestampMs: 1_763_000_000_000,
      sessionId: "session-1",
      payload: { sessionEditCount: 0 },
    };

    expect(validateCycloidEvent(event)).toEqual(event);
  });

  it("rejects non-object inputs", () => {
    expect(() => validateCycloidEvent(null)).toThrow("Invalid CycloidEvent");
    expect(() => validateCycloidEvent("not-an-object")).toThrow("Invalid CycloidEvent");
    expect(() => validateCycloidEvent([{ phase: "idle" }])).toThrow("Invalid CycloidEvent");
  });

  it("rejects a pre-parsed object with an invalid phase", () => {
    expect(() =>
      validateCycloidEvent({
        phase: "prompt_enqueued",
        timestampMs: 1,
        sessionId: "session-1",
        payload: {},
      }),
    ).toThrow("Invalid phase");
  });
});
