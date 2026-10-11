import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "../../types";
import {
  deriveContextUsage,
  deriveRuntimeActions,
  deriveRuntimeLogTail,
  deriveSandboxConnection,
  deriveSandboxMeta,
  deriveSandboxState,
  formatContextReadout,
  formatTokenCount,
  formatUsd,
} from "./runtime";

describe("deriveSandboxState", () => {
  it("uses the canonical phase projection", () => {
    expect(deriveSandboxState({ phase: "running" })).toEqual({ label: "Active", live: true });
    expect(deriveSandboxState({ phase: "archived" })).toEqual({ label: "Archived", live: false });
    expect(deriveSandboxState({ phase: "failed" })).toEqual({ label: "Idle", live: false });
  });

  it("refines a working sandbox with the substate", () => {
    expect(deriveSandboxState({ phase: "running", sandboxSubstate: "creating" })).toEqual({
      label: "Starting",
      live: true,
    });
    // Never-connected boot: creating wins over the connected flag — the bridge
    // has not connected yet, so this is "Starting", not a lost connection.
    expect(deriveSandboxState({ phase: "running", sandboxSubstate: "creating", sandboxConnected: false })).toEqual({
      label: "Starting",
      live: true,
    });
    expect(deriveSandboxState({ phase: "running", sandboxSubstate: "reconnecting" })).toEqual({
      label: "Reconnecting",
      live: true,
    });
    expect(deriveSandboxState({ phase: "running", sandboxSubstate: "stopping" })).toEqual({
      label: "Stopping",
      live: false,
    });
  });

  it("treats waiting_for_input as an active but not live sandbox", () => {
    expect(deriveSandboxState({ phase: "waiting_for_input" })).toEqual({ label: "Active", live: false });
  });

  it("lets a disconnected transport override an otherwise active sandbox", () => {
    expect(deriveSandboxState({ phase: "running", sandboxConnected: false })).toEqual({
      label: "Disconnected",
      live: false,
    });
  });
});

describe("deriveSandboxConnection", () => {
  it("renders nothing when the record predates the sandboxConnected field", () => {
    expect(deriveSandboxConnection({ phase: "running" })).toBeNull();
    expect(deriveSandboxConnection({ phase: "running", sandboxConnected: null })).toBeNull();
  });

  it("maps connected/disconnected for live sessions", () => {
    expect(deriveSandboxConnection({ phase: "running", sandboxConnected: true })).toEqual({
      label: "Connected",
      live: true,
    });
    expect(deriveSandboxConnection({ phase: "running", sandboxConnected: false })).toEqual({
      label: "Disconnected",
      live: false,
    });
    expect(deriveSandboxConnection({ phase: "waiting_for_input", sandboxConnected: true })).toEqual({
      label: "Connected",
      live: true,
    });
  });

  it("suppresses the readout for terminal display statuses (no tautological Disconnected)", () => {
    expect(deriveSandboxConnection({ phase: "stopped", sandboxConnected: false })).toBeNull();
    expect(deriveSandboxConnection({ phase: "archived", sandboxConnected: false })).toBeNull();
    expect(deriveSandboxConnection({ phase: "completed", sandboxConnected: true })).toBeNull();
  });
});

describe("deriveSandboxMeta", () => {
  it("prefers the live sandbox id over the provenance report", () => {
    expect(
      deriveSandboxMeta({
        sandboxId: "sbx_live",
        runtimeProvenance: {
          bootMode: "repo_image",
          runtime: { provider: "e2b", backend: "e2b_cloud", sandboxId: "sbx_provenance", reportedAt: 1 },
          updatedAt: 1,
        },
      }).sandboxId,
    ).toBe("sbx_live");
    // Live state lands before runtime_info; the id renders without provenance.
    expect(deriveSandboxMeta({ sandboxId: "sbx_live" }).sandboxId).toBe("sbx_live");
  });

  it("falls back to the provenance id when live state has none", () => {
    expect(
      deriveSandboxMeta({
        sandboxId: null,
        runtimeProvenance: { runtime: { provider: "e2b", sandboxId: "sbx_provenance", reportedAt: 1 }, updatedAt: 1 },
      }).sandboxId,
    ).toBe("sbx_provenance");
  });

  it("reads sandbox identity from the runtime provenance report", () => {
    expect(
      deriveSandboxMeta({
        runtimeProvenance: {
          bootMode: "repo_image",
          sandboxImageVersion: "v42",
          runtime: { provider: "e2b", backend: "e2b_cloud", sandboxId: "sbx_123", reportedAt: 1 },
          updatedAt: 1,
        },
      }),
    ).toEqual({ sandboxId: "sbx_123", runtime: "e2b_cloud", bootMode: "repo_image", imageVersion: "v42" });
  });

  it("falls back to the provider when no backend was reported", () => {
    expect(
      deriveSandboxMeta({
        runtimeProvenance: { runtime: { provider: "e2b", sandboxId: null, reportedAt: 1 }, updatedAt: 1 },
      }).runtime,
    ).toBe("e2b");
  });

  it("returns all-null meta when provenance never reached the record", () => {
    expect(deriveSandboxMeta({})).toEqual({ sandboxId: null, runtime: null, bootMode: null, imageVersion: null });
    expect(deriveSandboxMeta({ runtimeProvenance: null }).sandboxId).toBeNull();
  });
});

describe("deriveRuntimeActions", () => {
  it("offers stop while a prompt is running or awaiting input", () => {
    expect(deriveRuntimeActions({ phase: "running" })).toEqual(["stop"]);
    expect(deriveRuntimeActions({ phase: "waiting_for_input" })).toEqual(["stop"]);
  });

  it("hides stop while the sandbox transport has no socket yet", () => {
    expect(deriveRuntimeActions({ phase: "running", sandboxSubstate: "creating" })).toEqual([]);
    expect(deriveRuntimeActions({ phase: "running", sandboxSubstate: "reconnecting" })).toEqual([]);
  });

  it("offers wake and archive for quiescent sessions", () => {
    expect(deriveRuntimeActions({ phase: "completed" })).toEqual(["wake", "archive"]);
    expect(deriveRuntimeActions({ phase: "failed" })).toEqual(["wake", "archive"]);
    expect(deriveRuntimeActions({ phase: "stopped" })).toEqual(["wake", "archive"]);
    expect(deriveRuntimeActions({ phase: "idle" })).toEqual(["wake", "archive"]);
  });

  it("offers no actions for archived sessions", () => {
    expect(deriveRuntimeActions({ phase: "archived" })).toEqual([]);
  });

  it("offers nothing mid-publish and archive-only when blocked", () => {
    expect(deriveRuntimeActions({ phase: "finalizing" })).toEqual([]);
    expect(deriveRuntimeActions({ phase: "blocked" })).toEqual(["archive"]);
  });
});

function transcriptsOf(events: ActivityEvent[]): Map<string, ActivityEvent[]> {
  return new Map([["p1", events]]);
}

describe("deriveContextUsage", () => {
  it("returns null when no context event has streamed", () => {
    expect(deriveContextUsage(["p1"], transcriptsOf([]))).toBeNull();
    expect(deriveContextUsage([], new Map())).toBeNull();
  });

  it("reads the latest context_fill_warning and lists the history newest first", () => {
    const events = [
      { type: "context_fill_warning", id: "c1", fillPercent: 30, contextTokens: 60_000, contextWindow: 200_000 },
      { type: "context_fill_warning", id: "c2", fillPercent: 45, contextTokens: 90_000, contextWindow: 200_000 },
    ] as unknown as ActivityEvent[];
    expect(deriveContextUsage(["p1"], transcriptsOf(events))).toEqual({
      contextTokens: 90_000,
      contextWindow: 200_000,
      fillPercent: 45,
      events: [
        { id: "p1:c2", kind: "context_fill_warning", label: "fill warning", detail: "45% · 90K / 200K" },
        { id: "p1:c1", kind: "context_fill_warning", label: "fill warning", detail: "30% · 60K / 200K" },
      ],
    });
  });

  it("computes fill percent after compaction using the last known window", () => {
    const events = [
      { type: "context_fill_warning", id: "c1", fillPercent: 80, contextTokens: 160_000, contextWindow: 200_000 },
      { type: "compaction_complete", id: "c2", contextTokensBefore: 160_000, contextTokensAfter: 50_000 },
    ] as unknown as ActivityEvent[];
    expect(deriveContextUsage(["p1"], transcriptsOf(events))).toEqual({
      contextTokens: 50_000,
      contextWindow: 200_000,
      fillPercent: 25,
      events: [
        { id: "p1:c2", kind: "compaction_complete", label: "compacted", detail: "160K → 50K" },
        { id: "p1:c1", kind: "context_fill_warning", label: "fill warning", detail: "80% · 160K / 200K" },
      ],
    });
  });

  it("keeps fill percent null when the window was never reported", () => {
    const events = [{ type: "compaction_start", id: "c1", contextTokens: 120_000 }] as unknown as ActivityEvent[];
    expect(deriveContextUsage(["p1"], transcriptsOf(events))).toEqual({
      contextTokens: 120_000,
      contextWindow: null,
      fillPercent: null,
      events: [{ id: "p1:c1", kind: "compaction_start", label: "compaction", detail: "at 120K" }],
    });
  });

  it("bounds the event history at the constants limit, keeping the newest", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({
      type: "context_fill_warning",
      id: `c${i}`,
      fillPercent: i,
    })) as unknown as ActivityEvent[];
    const usage = deriveContextUsage(["p1"], transcriptsOf(events));
    expect(usage?.events).toHaveLength(6);
    expect(usage?.events[0]?.id).toBe("p1:c8");
    expect(usage?.events[5]?.id).toBe("p1:c3");
  });
});

describe("formatTokenCount", () => {
  it("formats small, thousand, and million scales", () => {
    expect(formatTokenCount(812)).toBe("812");
    expect(formatTokenCount(82_400)).toBe("82.4K");
    expect(formatTokenCount(200_000)).toBe("200K");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});

describe("formatUsd", () => {
  it("caps the readout at three decimals and trims a trailing zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.84)).toBe("$0.84");
    expect(formatUsd(0.0123)).toBe("$0.012");
    expect(formatUsd(1.2)).toBe("$1.20");
  });

  it("floors sub-millicent costs instead of faking $0.00", () => {
    expect(formatUsd(0.0004)).toBe("<$0.001");
  });
});

describe("formatContextReadout", () => {
  it("renders the exact tokens / window (percent) readout", () => {
    expect(formatContextReadout({ contextTokens: 91_000, contextWindow: 400_000, fillPercent: 23, events: [] })).toBe(
      "91K / 400K (23%)",
    );
  });

  it("degrades to what is known", () => {
    expect(formatContextReadout({ contextTokens: 91_000, contextWindow: null, fillPercent: 23, events: [] })).toBe(
      "91K (23%)",
    );
    expect(formatContextReadout({ contextTokens: 91_000, contextWindow: null, fillPercent: null, events: [] })).toBe(
      "91K",
    );
    expect(formatContextReadout({ contextTokens: null, contextWindow: null, fillPercent: 23, events: [] })).toBe("23%");
    expect(
      formatContextReadout({ contextTokens: null, contextWindow: null, fillPercent: null, events: [] }),
    ).toBeNull();
  });
});

describe("deriveRuntimeLogTail", () => {
  // Timeline labels are customer-facing copy; raw event ids must not regress into this panel.
  const tool = (id: string, extra: Record<string, unknown> = {}): ActivityEvent =>
    ({
      type: "tool_call",
      id,
      tool: "bash",
      summary: `run ${id}`,
      promptId: "p1",
      ...extra,
    }) as unknown as ActivityEvent;

  it("maps log-like events with categories, newest first, and skips prose events", () => {
    const events = [
      tool("t1", { toolStatus: "completed" }),
      { type: "text", id: "x1", text: "prose" },
      { type: "reasoning", id: "r1", text: "thinking" },
      { type: "patch", id: "pa1", files: ["a.ts", "b.ts"] },
      { type: "session_error", id: "e1", error: "boom" },
    ] as unknown as ActivityEvent[];
    expect(deriveRuntimeLogTail(["p1"], transcriptsOf(events), 10)).toEqual([
      { id: "p1:e1", kind: "error", label: "error", detail: "boom", status: "error" },
      { id: "p1:pa1", kind: "edit", label: "patch", detail: "a.ts, b.ts", status: "completed" },
      { id: "p1:t1", kind: "tool", label: "bash", detail: "run t1", status: "completed" },
    ]);
  });

  it("categorizes file edits, test runs, and retries", () => {
    const events = [
      tool("t1", { tool: "Edit", summary: "src/a.ts" }),
      tool("t2", { summary: "npm test -- --run" }),
      tool("t3", { summary: "npx vitest run apps/ui" }),
      { type: "retry_status", id: "r1", attempt: 2, message: "rate limited" },
    ] as unknown as ActivityEvent[];
    const kinds = deriveRuntimeLogTail(["p1"], transcriptsOf(events), 10).map((entry) => [entry.id, entry.kind]);
    expect(kinds).toEqual([
      ["p1:r1", "retry"],
      ["p1:t3", "test"],
      ["p1:t2", "test"],
      ["p1:t1", "edit"],
    ]);
  });

  it("surfaces publish and verification timeline events and skips duplicate aggregates", () => {
    const events = [
      {
        type: "agent_timeline",
        id: "atl1",
        eventType: "tools.run",
        source: "observed",
        observer: "sb",
        summary: "ran 12 tools",
      },
      {
        type: "agent_timeline",
        id: "atl2",
        eventType: "pr.open",
        source: "observed",
        observer: "cp",
        summary: "Opened PR #12",
        status: "success",
      },
      {
        type: "agent_timeline",
        id: "atl3",
        eventType: "verification.result",
        source: "observed",
        observer: "sb",
        summary: "checks failed",
        status: "failure",
      },
      {
        type: "agent_timeline",
        id: "atl4",
        eventType: "publish_gate.result",
        source: "observed",
        observer: "sb",
        summary: "publish gate passed",
        status: "success",
        metadata: { gate: "fix" },
      },
      {
        type: "agent_timeline",
        id: "atl5",
        eventType: "internal.unknown",
        source: "observed",
        observer: "sb",
        summary: "hidden detail",
      },
      {
        type: "agent_timeline",
        id: "atl6",
        eventType: "publish.completed",
        source: "observed",
        observer: "cp",
        summary: "publish completed",
        status: "completed",
      },
    ] as unknown as ActivityEvent[];
    expect(deriveRuntimeLogTail(["p1"], transcriptsOf(events), 10)).toEqual([
      { id: "p1:atl6", kind: "publish", label: "Publish update", detail: "publish completed", status: "completed" },
      {
        id: "p1:atl4",
        kind: "publish",
        label: "Preparing changes",
        detail: "publish gate passed",
        status: "completed",
      },
      { id: "p1:atl3", kind: "test", label: "Verification finished", detail: "checks failed", status: "error" },
      { id: "p1:atl2", kind: "publish", label: "Opened PR", detail: "Opened PR #12", status: "completed" },
    ]);
  });

  it("surfaces cold resumes as steps", () => {
    const events = [
      { type: "session_resumed_cold", id: "sr1", reason: "snapshot_expired" },
      { type: "agent_progress", id: "ap1", step: "starting_work", label: "Starting work", terminal: false },
    ] as unknown as ActivityEvent[];
    expect(deriveRuntimeLogTail(["p1"], transcriptsOf(events), 10)).toEqual([
      { id: "p1:ap1", kind: "step", label: null, detail: "Starting work", status: "running" },
      { id: "p1:sr1", kind: "step", label: "resume", detail: "snapshot_expired", status: "completed" },
    ]);
  });

  it("keeps only the newest entries up to the limit, newest first", () => {
    const events = [tool("t1"), tool("t2"), tool("t3")] as ActivityEvent[];
    const tail = deriveRuntimeLogTail(["p1"], transcriptsOf(events), 2);
    expect(tail.map((entry) => entry.id)).toEqual(["p1:t3", "p1:t2"]);
  });

  it("returns an empty tail when no events streamed", () => {
    expect(deriveRuntimeLogTail(["p1"], new Map(), 5)).toEqual([]);
  });
});
