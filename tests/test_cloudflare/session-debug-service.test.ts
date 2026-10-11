import { describe, expect, it } from "vitest";

import { derivePromptDebugSummary } from "../../apps/control-plane-worker/src/services/session-debug";

describe("session debug service", () => {
  it("derives workspace-setup bottlenecks from prompt timeline events", () => {
    const summary = derivePromptDebugSummary(
      {
        id: "p-1",
        status: "completed",
        createdAt: "2026-05-12T18:21:25.506Z",
        startedAt: "2026-05-12T18:21:25.506Z",
        completedAt: "2026-05-12T18:23:37.642Z",
      },
      [
        { type: "prompt_enqueued", timestamp: "2026-05-12T18:21:25.506Z", data: { promptId: "p-1" } },
        { type: "prompt_processing", timestamp: "2026-05-12T18:21:25.506Z", data: { promptId: "p-1" } },
        { type: "sandbox_runtime_info", timestamp: "2026-05-12T18:21:41.100Z", data: { promptId: "p-1" } },
        {
          type: "prompt_activity",
          timestamp: "2026-05-12T18:21:41.983Z",
          data: { promptId: "p-1", detail: "workspace_setup" },
        },
        {
          type: "prompt_activity",
          timestamp: "2026-05-12T18:23:18.030Z",
          data: { promptId: "p-1", detail: "workspace_setup_complete" },
        },
        {
          type: "prompt_activity",
          timestamp: "2026-05-12T18:23:19.975Z",
          data: { promptId: "p-1", phase: "prompt_dispatching" },
        },
        {
          type: "agent_progress",
          timestamp: "2026-05-12T18:23:19.977Z",
          data: { promptId: "p-1", step: "waiting_for_model" },
        },
        { type: "text", timestamp: "2026-05-12T18:23:22.150Z", data: { promptId: "p-1", text: "I" } },
      ],
      {
        prompt_id: "p-1",
        outcome: "completed",
        error_code: null,
        error_details_json: null,
        dd_trace_id: "dd-trace",
        bt_span_id: "bt-span",
      },
    );

    expect(summary.timings.workspaceSetupMs).toBe(96047);
    expect(summary.timings.contextPrepMs).toBe(1945);
    expect(summary.timings.modelWaitMs).toBe(2173);
    expect(summary.timings.firstTokenMs).toBe(116644);
    expect(summary.diagnosis.bottleneckPhase).toBe("workspace_setup");
    expect(summary.traces.ddTraceId).toBe("dd-trace");
    expect(summary.traces.btSpanId).toBe("bt-span");
  });

  it("summarizes tool calls and failed tool updates", () => {
    const summary = derivePromptDebugSummary(
      {
        id: "p-2",
        status: "completed",
        createdAt: "2026-05-12T00:00:00.000Z",
        startedAt: "2026-05-12T00:00:00.000Z",
        completedAt: "2026-05-12T00:00:10.000Z",
      },
      [
        { type: "prompt_enqueued", timestamp: "2026-05-12T00:00:00.000Z", data: { promptId: "p-2" } },
        { type: "prompt_processing", timestamp: "2026-05-12T00:00:00.000Z", data: { promptId: "p-2" } },
        {
          type: "tool_call",
          timestamp: "2026-05-12T00:00:02.000Z",
          data: { promptId: "p-2", id: "call-1", tool: "linear.get_issue" },
        },
        {
          type: "tool_update",
          timestamp: "2026-05-12T00:00:03.000Z",
          data: { promptId: "p-2", id: "call-1", status: "error" },
        },
        {
          type: "tool_update",
          timestamp: "2026-05-12T00:00:03.500Z",
          data: { promptId: "p-2", id: "call-1", status: "error" },
        },
        {
          type: "tool_call",
          timestamp: "2026-05-12T00:00:04.000Z",
          data: { promptId: "p-2", id: "call-2", tool: "linear.get_issue" },
        },
        {
          type: "tool_call",
          timestamp: "2026-05-12T00:00:05.000Z",
          data: { promptId: "p-2", id: "call-3", tool: "linear.list_issue_statuses" },
        },
        {
          type: "tool_call",
          timestamp: "2026-05-12T00:00:05.500Z",
          data: { promptId: "p-2", id: "call-3", tool: "linear.list_issue_statuses" },
        },
      ],
      {
        prompt_id: "p-2",
        outcome: "completed",
        error_code: null,
        error_details_json: null,
        dd_trace_id: null,
        bt_span_id: null,
      },
    );

    expect(summary.firstToolCallAt).toBe("2026-05-12T00:00:02.000Z");
    expect(summary.toolSummary.totalCalls).toBe(3);
    expect(summary.toolSummary.failedCalls).toBe(1);
    expect(summary.toolSummary.byTool).toEqual({
      "linear.get_issue": 2,
      "linear.list_issue_statuses": 1,
    });
    expect(summary.diagnosis.notes).toContain("Observed 1 failed tool call update(s) during the prompt.");
  });

  it("redacts unsafe error details and explains missing Braintrust spans for pre-bridge failures", () => {
    const summary = derivePromptDebugSummary(
      {
        id: "p-3",
        status: "failed",
        createdAt: "2026-05-12T00:00:00.000Z",
        startedAt: null,
        completedAt: "2026-05-12T00:00:01.000Z",
      },
      [],
      {
        prompt_id: "p-3",
        outcome: "failed",
        error_code: "spawn_deadline_no_bridge",
        error_details_json: JSON.stringify({
          message: "Failed path=/workspace/repo/apps/control-plane-worker/src/session.ts:12",
          name: "Error",
          code: "spawn_deadline_no_bridge",
          errno: -2,
          stack: "Error: boom\n    at /workspace/repo/apps/control-plane-worker/src/session.ts:12:3",
          raw: "Authorization: Bearer secret-token",
          responseBodyPreview: "Provider response with customer repo text",
          cause: {
            message: "config:/workspace/repo/.env",
            code: "SQLITE_CONSTRAINT",
          },
        }),
        dd_trace_id: null,
        bt_span_id: null,
      },
    );

    expect(summary.traces.btSpanMissingReason).toBe("pre_bridge_failure");
    expect(summary.errorDetails).toEqual({
      message: "[redacted]",
      name: "Error",
      code: "spawn_deadline_no_bridge",
      errno: "-2",
      cause: {
        message: "[redacted]",
        code: "SQLITE_CONSTRAINT",
        redacted: true,
      },
      redacted: true,
    });
    expect(JSON.stringify(summary)).not.toContain("/workspace/repo");
    expect(JSON.stringify(summary)).not.toContain("Bearer secret-token");
    expect(JSON.stringify(summary)).not.toContain("Provider response");
    expect(JSON.stringify(summary)).not.toContain("stack");
  });
});
