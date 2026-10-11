// @ts-nocheck — sandbox-bridge is excluded from root tsconfig
import { describe, expect, it, vi } from "vitest";

import { ToolPartTracker } from "../../apps/sandbox-bridge/src/trackers/tool-part-tracker.js";

/**
 * Builds a fake Braintrust prompt span whose `startSpan` returns child spans
 * that record their `log`/`end` calls, so we can assert span lifecycle without
 * touching the real Braintrust logger.
 */
function makeFakeBtParent() {
  const children: Array<{ name: string; logs: Record<string, unknown>[]; ended: boolean }> = [];
  const parent = {
    id: "prompt-span",
    log: vi.fn(),
    end: vi.fn(),
    startSpan(opts: { name: string }) {
      const child = { name: opts.name, logs: [] as Record<string, unknown>[], ended: false };
      children.push(child);
      return {
        id: opts.name,
        startSpan: () => parent,
        log: (data: Record<string, unknown>) => child.logs.push(data),
        end: () => {
          child.ended = true;
        },
      };
    },
  };
  return { parent, children };
}

function makeTracker(parent: ReturnType<typeof makeFakeBtParent>["parent"]) {
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const tracker = new ToolPartTracker({
    getActiveBtPromptSpan: () => parent,
    getSessionId: () => "sess-1",
    getSandboxId: () => "sbx-1",
    getPromptId: () => "prompt-1",
    getAgentSessionId: () => "codex-1",
    log: log as never,
  });
  return { tracker, log };
}

describe("ToolPartTracker", () => {
  it("starts a child span and ends it with output + metrics", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.startSpan("call-1", "bash", { command: "ls" });
    expect(tracker.activeSpanCount).toBe(1);
    expect(children).toHaveLength(1);
    expect(children[0].name).toBe("tool:bash");

    tracker.endSpan("call-1", "completed", 42, 7);
    expect(tracker.activeSpanCount).toBe(0);
    expect(children[0].ended).toBe(true);
    // No output supplied -> status is used as the span output (unchanged behavior), and status
    // is also recorded in metadata.
    expect(children[0].logs).toEqual([
      { output: "completed", metadata: { status: "completed" }, metrics: { durationMs: 42, outputEstimatedTokens: 7 } },
    ]);
  });

  it("logs the complete tool output as the span output, keeping status in metadata", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.startSpan("call-1", "datadog.search_datadog_logs", { query: "status:error" });
    const output = "found 3 matching log entries: err-a, err-b, err-c";
    tracker.endSpan("call-1", "completed", 12, 20, output);

    // The span now carries the real tool result (previously it was only "completed").
    expect(children[0].logs).toHaveLength(1);
    const logged = children[0].logs[0];
    expect(logged.output).toContain("found 3 matching log entries");
    expect(logged.metadata).toEqual({ status: "completed" });
    expect(logged.metrics).toEqual({ durationMs: 12, outputEstimatedTokens: 20 });
  });

  it("redacts secrets in the tool output but keeps the surrounding content", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.startSpan("call-1", "bash", { command: "env | grep TOKEN" });
    const output = "build ok\nGITHUB_TOKEN=ghp_abcdefghij0123456789ABCD\nfinished in 3s";
    tracker.endSpan("call-1", "completed", 8, 12, output);

    const logged = String(children[0].logs[0].output);
    // real content survives...
    expect(logged).toContain("build ok");
    expect(logged).toContain("finished in 3s");
    // ...but the secret is masked and never emitted verbatim.
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("ghp_abcdefghij0123456789ABCD");
  });

  it("bounds a very large tool output (truncated, not dropped)", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.startSpan("call-1", "bash", { command: "rg pattern ." });
    const huge = "x".repeat(200_000);
    tracker.endSpan("call-1", "completed", 5, 50_000, huge);

    const logged = String(children[0].logs[0].output);
    // Non-empty real content (vs the old status-only "completed"), and bounded well under the raw size.
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.length).toBeLessThan(huge.length);
  });

  it("omits undefined metrics when ending a span", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.startSpan("call-1", "apply_patch", {});
    tracker.endSpan("call-1", "aborted");
    expect(children[0].logs).toEqual([{ output: "aborted", metadata: { status: "aborted" }, metrics: {} }]);
  });

  it("endSpan is a no-op for an unknown callId", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.endSpan("missing", "completed");
    expect(children).toHaveLength(0);
    expect(tracker.activeSpanCount).toBe(0);
  });

  it("force-ends and clears every active span on an aborted prompt", () => {
    const { parent, children } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    tracker.startSpan("call-1", "bash", { command: "a" });
    tracker.startSpan("call-2", "apply_patch", {});
    tracker.startSpan("call-3", "agent", {});
    expect(tracker.activeSpanCount).toBe(3);

    const leaked = tracker.forceEndAll();

    expect(leaked).toBe(3);
    expect(tracker.activeSpanCount).toBe(0);
    expect(children.every((child) => child.ended)).toBe(true);
    expect(children.map((child) => child.logs[0]?.output)).toEqual(["aborted", "aborted", "aborted"]);
  });

  it("force-ends nothing (count 0) when there are no active spans", () => {
    const { parent } = makeFakeBtParent();
    const { tracker } = makeTracker(parent);

    expect(tracker.forceEndAll()).toBe(0);
  });

  it("degrades (logs, does not throw) when span start fails", () => {
    const throwingParent = {
      id: "prompt-span",
      log: vi.fn(),
      end: vi.fn(),
      startSpan: () => {
        throw new Error("bt down");
      },
    };
    const { tracker, log } = makeTracker(throwingParent as never);

    expect(() => tracker.startSpan("call-1", "bash", { command: "ls" })).not.toThrow();
    expect(tracker.activeSpanCount).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "bt.tool_span_start_failed", btSpanDegraded: true }),
      expect.any(String),
    );
    // A later endSpan for the never-started call is a harmless no-op.
    expect(() => tracker.endSpan("call-1", "completed")).not.toThrow();
  });
});
