// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it } from "vitest";

import { TimelineEmitter } from "../../apps/sandbox-bridge/src/services/timeline-emitter.js";
import type { BridgeEvent as SandboxEvent } from "../../shared/events/bridge.js";

function makeEmitter() {
  const events: SandboxEvent[] = [];
  const emitter = new TimelineEmitter({
    sendEvent: (event) => events.push(event),
    sandboxId: "sbx-1",
    now: () => 1000,
  });
  return { emitter, events };
}

describe("TimelineEmitter.sendAgentTimelineEvent", () => {
  it("redacts and truncates the summary and stamps the clock", () => {
    const { emitter, events } = makeEmitter();
    const entry = emitter.sendAgentTimelineEvent({
      eventType: "tools.run",
      promptId: "p1",
      status: "completed",
      summary: "  did a thing  ",
    });
    expect(entry.source).toBe("observed");
    expect(entry.observer).toBe("sandbox_bridge");
    expect(entry.summary).toBe("did a thing");
    expect(entry.timestampMs).toBe(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_timeline",
      messageId: "p1",
      sandboxId: "sbx-1",
      timestamp: 1000,
    });
  });
});

describe("TimelineEmitter.emitCommandTimeline", () => {
  it("returns undefined and emits nothing for no commands", () => {
    const { emitter, events } = makeEmitter();
    expect(emitter.emitCommandTimeline("p1", [])).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it("summarizes a plain command count when no checks completed", () => {
    const { emitter } = makeEmitter();
    const entry = emitter.emitCommandTimeline("p1", [
      { status: "failed", check: "typecheck" },
      { status: "running", check: "test" },
    ]);
    expect(entry?.summary).toBe("Observed 2 command(s).");
    expect(entry?.eventType).toBe("commands.run");
  });

  it("lists completed checks sorted, excluding 'other'", () => {
    const { emitter } = makeEmitter();
    const entry = emitter.emitCommandTimeline("p1", [
      { status: "completed", check: "typecheck" },
      { status: "completed", check: "lint" },
      { status: "completed" }, // defaults to "other", excluded
      { status: "failed", check: "test" }, // not completed, excluded
    ]);
    expect(entry?.summary).toBe("Observed 4 command(s), including completed lint, typecheck checks.");
  });
});

describe("TimelineEmitter.emitVerificationTimeline", () => {
  const cases: Array<{
    name: string;
    verification: Record<string, unknown>;
    outcome?: "success" | "error";
    status: string;
    summary: string;
  }> = [
    {
      name: "reports passing checks when verification ran and was clean",
      verification: { status: "completed", verdict: "CONFIRMED" },
      status: "completed",
      summary: "QA verification result recorded.",
    },
    {
      name: "records failed QA result on error outcome",
      verification: { status: "completed", verdict: "CONFIRMED" },
      outcome: "error",
      status: "failed",
      summary: "QA verification result failed.",
    },
    {
      name: "records failed QA result on verification.status failed",
      verification: { status: "failed", verdict: "CONFIRMED" },
      status: "failed",
      summary: "QA verification result failed.",
    },
    {
      name: "records failed QA result on REFUTED verdict",
      verification: { status: "completed", verdict: "REFUTED" },
      status: "failed",
      summary: "QA verification result failed.",
    },
    {
      name: "reports inconclusive verdict",
      verification: { status: "completed", verdict: "INCONCLUSIVE" },
      status: "failed",
      summary: "QA verification result was inconclusive.",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const { emitter } = makeEmitter();
      const entry = emitter.emitVerificationTimeline("p1", c.verification, c.outcome);
      expect(entry.status).toBe(c.status);
      expect(entry.summary).toBe(c.summary);
      expect(entry.eventType).toBe("verification.result");
    });
  }

  it("records a QA result when verification is undefined and not blocked", () => {
    const { emitter } = makeEmitter();
    const entry = emitter.emitVerificationTimeline("p1", undefined, undefined);
    expect(entry.status).toBe("completed");
    expect(entry.summary).toBe("QA verification result recorded.");
  });
});

describe("TimelineEmitter.emitPublishGateTimeline", () => {
  it("emits publish gate events separately from verifier results", () => {
    const { emitter } = makeEmitter();
    const entry = emitter.emitPublishGateTimeline("p1", "completed", "Configured pre-publish gate passed.", {
      gate: "tests",
    });
    expect(entry.eventType).toBe("publish_gate.result");
    expect(entry.summary).toBe("Configured pre-publish gate passed.");
    expect(entry.metadata?.gate).toBe("tests");
  });
});

describe("TimelineEmitter.emitPromptObservationTimeline", () => {
  it("emits tool and file entries only when counts are non-zero", () => {
    const { emitter, events } = makeEmitter();
    const entries = emitter.emitPromptObservationTimeline("p1", {
      toolCallCount: 3,
      toolCounts: new Map([["bash", 2]]),
      modifiedFiles: new Set(["a.ts", "b.ts"]),
    });
    expect(entries).toHaveLength(2);
    expect(events.map((e) => e.eventType)).toEqual(["tools.run", "files.edited"]);
    expect(events[0].summary).toBe("Observed 3 tool call(s) across 1 tool type(s).");
    expect(events[0].metadata).toMatchObject({
      tool_call_count: 3,
      tool_type_count: 1,
      tool_type_attribution_complete: true,
    });
    expect(events[1].summary).toBe("Edited 2 file(s).");
  });

  it("does not report a misleading zero tool-type count when attribution is unavailable", () => {
    const { emitter, events } = makeEmitter();
    emitter.emitPromptObservationTimeline("p1", {
      toolCallCount: 3,
      toolCounts: new Map(),
      modifiedFiles: new Set(),
    });
    expect(events[0].summary).toBe("Observed 3 tool call(s); tool type attribution was unavailable.");
    expect(events[0].metadata).toMatchObject({
      tool_call_count: 3,
      tool_type_count: 0,
      tool_type_attribution_complete: false,
    });
  });

  it("emits nothing when there is no observed activity", () => {
    const { emitter, events } = makeEmitter();
    const entries = emitter.emitPromptObservationTimeline("p1", {
      toolCallCount: 0,
      toolCounts: new Map(),
      modifiedFiles: new Set(),
    });
    expect(entries).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
