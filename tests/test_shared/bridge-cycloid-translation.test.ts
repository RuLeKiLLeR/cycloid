import { describe, expect, it } from "vitest";

import { projectCycloidEventToDurableEntry } from "../../apps/control-plane-worker/src/session/cycloid-event-store.js";
import { translateBridgeEventToCycloidEvent } from "../../apps/sandbox-bridge/src/events/translate.js";
import type { BridgeEvent } from "../../shared/events/bridge.js";
import { decodeCycloidEvent } from "../../shared/events/schema.js";

describe("bridge CycloidEvent transport projection", () => {
  it("projects token events into durable text entries", () => {
    const event: BridgeEvent = {
      type: "token",
      content: "hello",
      partId: "part-1",
      messageId: "prompt-1",
      sandboxId: "sandbox-1",
      timestamp: 100,
    };

    const translated = translateBridgeEventToCycloidEvent("session-1", event);

    expect(translated.phase).toBe("text.delta");
    expect(translated.promptId).toBe("prompt-1");
    expect(decodeCycloidEvent(JSON.stringify(translated))).toEqual(translated);
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "text",
      data: { id: "part-1", text: "hello" },
    });
  });

  it("drops token events that do not carry a stable partId", () => {
    const event: BridgeEvent = {
      type: "token",
      content: "hello",
      messageId: "prompt-1",
      sandboxId: "sandbox-1",
      timestamp: 150,
    };

    const translated = translateBridgeEventToCycloidEvent("session-1", event);

    expect(projectCycloidEventToDurableEntry(translated)).toBeNull();
  });

  it("preserves prompt activity in bridge-event compat payloads", () => {
    const event: BridgeEvent = {
      type: "prompt_activity",
      promptId: "prompt-2",
      phase: "prompt_dispatching",
      startupAttemptId: "attempt-1",
      detail: "waiting for model",
      sandboxId: "sandbox-2",
      timestamp: 200,
    };

    const translated = translateBridgeEventToCycloidEvent("session-2", event);

    expect(translated.phase).toBe("prompt.dispatch");
    expect(translated.promptId).toBe("prompt-2");
    expect((translated.payload as Record<string, unknown>).bridgeEventType).toBe("prompt_activity");
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "prompt_activity",
      data: {
        type: "prompt_activity",
        promptId: "prompt-2",
        phase: "prompt_dispatching",
        startupAttemptId: "attempt-1",
        detail: "waiting for model",
        sandboxId: "sandbox-2",
      },
    });
  });

  it("projects agent progress as customer-facing prompt dispatch events", () => {
    const event: BridgeEvent = {
      type: "agent_progress",
      promptId: "prompt-2",
      step: "preparing_context",
      label: "Preparing context",
      sandboxId: "sandbox-2",
      timestamp: 250,
    };

    const translated = translateBridgeEventToCycloidEvent("session-2", event);

    expect(translated.phase).toBe("prompt.dispatch");
    expect(translated.promptId).toBe("prompt-2");
    expect((translated.payload as Record<string, unknown>).bridgeEventType).toBe("agent_progress");
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "agent_progress",
      data: {
        type: "agent_progress",
        promptId: "prompt-2",
        step: "preparing_context",
        label: "Preparing context",
        sandboxId: "sandbox-2",
      },
    });
  });

  it("projects acked execution_complete events into sandbox durable entries", () => {
    const event: BridgeEvent = {
      type: "execution_complete",
      ackId: "ack-1",
      messageId: "prompt-3",
      success: false,
      error: "sandbox disconnected",
      errorCode: "sandbox_disconnected",
      sandboxId: "sandbox-3",
      timestamp: 300,
    };

    const translated = translateBridgeEventToCycloidEvent("session-3", event);

    expect(translated.phase).toBe("prompt.complete");
    expect(translated.ackId).toBe("ack-1");
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "sandbox_execution_complete",
      data: {
        type: "execution_complete",
        messageId: "prompt-3",
        success: false,
        error: "sandbox disconnected",
        errorCode: "sandbox_disconnected",
      },
    });
  });

  it.each([
    [
      "execution_complete",
      {
        type: "execution_complete",
        messageId: "prompt-ack",
        success: true,
        timestamp: 301,
      },
    ],
    [
      "push_complete with branch",
      {
        type: "push_complete",
        messageId: "prompt-ack",
        branchName: "feature",
        timestamp: 302,
      },
    ],
    [
      "push_complete fallback",
      {
        type: "push_complete",
        messageId: "prompt-ack",
        timestamp: 303,
      },
    ],
    [
      "push_error with branch",
      {
        type: "push_error",
        messageId: "prompt-ack",
        branchName: "feature",
        error: "push failed",
        timestamp: 304,
      },
    ],
    [
      "push_error fallback",
      {
        type: "push_error",
        messageId: "prompt-ack",
        error: "push failed",
        timestamp: 305,
      },
    ],
    [
      "question",
      {
        type: "question",
        messageId: "prompt-ack",
        questionId: "question-1",
        question: "Continue?",
        options: ["yes", "no"],
        timestamp: 306,
      },
    ],
  ])("preserves optional ackId for %s translation", (_name, eventWithoutAck) => {
    const withoutAck = translateBridgeEventToCycloidEvent("session-ack", eventWithoutAck as BridgeEvent);
    const withAck = translateBridgeEventToCycloidEvent("session-ack", {
      ...eventWithoutAck,
      ackId: "ack-table",
    } as BridgeEvent);

    expect(withoutAck).not.toHaveProperty("ackId");
    expect(withAck).toMatchObject({
      ...withoutAck,
      ackId: "ack-table",
    });
  });

  it("sanitizes session_error details before projecting durable entries", () => {
    const event: BridgeEvent = {
      type: "error",
      error: "API error",
      code: "api_error",
      errorDetails: {
        message: "fetch failed",
        stack: "Error: fetch failed\n    at sandbox",
        responseBodyPreview: '{"error":"invalid_api_key"}',
        raw: '{"secret":"value"}',
        statusCode: 401,
        cause: {
          message: "connect ECONNREFUSED 127.0.0.1:12345",
          code: "ECONNREFUSED",
          stack: "Error: connect ECONNREFUSED",
          port: 12345,
        },
      },
      messageId: "prompt-3",
      sandboxId: "sandbox-3",
      timestamp: 325,
    };

    const translated = translateBridgeEventToCycloidEvent("session-3", event);
    const projected = projectCycloidEventToDurableEntry(translated);

    expect(projected).toMatchObject({
      type: "session_error",
      data: {
        error: "API error",
        code: "api_error",
        errorDetails: {
          message: "fetch failed",
          statusCode: 401,
          cause: {
            message: "connect ECONNREFUSED 127.0.0.1:12345",
            code: "ECONNREFUSED",
            port: 12345,
          },
        },
      },
    });
    expect(projected?.data.errorDetails).not.toHaveProperty("stack");
    expect(projected?.data.errorDetails).not.toHaveProperty("responseBodyPreview");
    expect(projected?.data.errorDetails).not.toHaveProperty("raw");
    expect(projected?.data.errorDetails).not.toHaveProperty("cause.stack");
  });

  it("uses bridge.event for non-canonical bridge payloads and projects them", () => {
    const event: BridgeEvent = {
      type: "memory_usage",
      messageId: "prompt-4",
      sandboxId: "sandbox-4",
      timestamp: 400,
      activeMemoryIds: ["mem-1"],
    };

    const translated = translateBridgeEventToCycloidEvent("session-4", event);

    expect(translated.phase).toBe("bridge.event");
    expect((translated.payload as Record<string, unknown>).bridgeEventType).toBe("memory_usage");
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "memory_usage",
      data: { activeMemoryIds: ["mem-1"] },
    });
  });

  it("projects memory recall usage telemetry with requested and returned ids", () => {
    const event: BridgeEvent = {
      type: "memory_recall_usage",
      messageId: "prompt-4",
      sandboxId: "sandbox-4",
      timestamp: 425,
      eventName: "memory_recall.returned",
      requestedMemoryIds: ["mem-1", "mem-2"],
      returnedMemoryIds: ["mem-2"],
      intent: "Patch auth route",
      files: ["apps/control-plane-worker/src/auth/routes.ts"],
      symbols: ["verifyUserRepoAccess"],
      tool: "apply_patch",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      codexItemId: "item-1",
    };

    const translated = translateBridgeEventToCycloidEvent("session-4", event);

    expect(translated.phase).toBe("bridge.event");
    expect((translated.payload as Record<string, unknown>).bridgeEventType).toBe("memory_recall_usage");
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "memory_recall_usage",
      data: {
        type: "memory_recall_usage",
        messageId: "prompt-4",
        eventName: "memory_recall.returned",
        requestedMemoryIds: ["mem-1", "mem-2"],
        returnedMemoryIds: ["mem-2"],
        intent: "Patch auth route",
        files: ["apps/control-plane-worker/src/auth/routes.ts"],
        symbols: ["verifyUserRepoAccess"],
        tool: "apply_patch",
        repoOwner: "trycycloid",
        repoName: "cycloid",
        codexItemId: "item-1",
      },
    });
  });

  it("projects observed agent timeline events into durable entries", () => {
    const event: BridgeEvent = {
      type: "agent_timeline",
      messageId: "prompt-4",
      sandboxId: "sandbox-4",
      timestamp: 450,
      eventType: "tools.run",
      source: "observed",
      observer: "sandbox_bridge",
      summary: "Observed 3 tool calls across 2 tool types.",
      status: "completed",
      metadata: {
        toolCallCount: 3,
        toolCounts: {
          bash: 2,
          apply_patch: 1,
        },
      },
    };

    const translated = translateBridgeEventToCycloidEvent("session-4", event);

    expect(translated.phase).toBe("timeline");
    expect(translated.promptId).toBe("prompt-4");
    expect(decodeCycloidEvent(JSON.stringify(translated))).toEqual(translated);
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "agent_timeline",
      data: {
        eventType: "tools.run",
        source: "observed",
        observer: "sandbox_bridge",
        summary: "Observed 3 tool calls across 2 tool types.",
        status: "completed",
        metadata: {
          toolCallCount: 3,
          toolCounts: {
            bash: 2,
            apply_patch: 1,
          },
        },
      },
    });
  });

  it("projects question events into durable question entries", () => {
    const event: BridgeEvent = {
      type: "question",
      questionId: "q-1",
      question: "Continue?",
      options: ["Yes", "No"],
      messageId: "prompt-5",
      sandboxId: "sandbox-5",
      timestamp: 500,
    };

    const translated = translateBridgeEventToCycloidEvent("session-5", event);

    expect(translated.phase).toBe("user_question");
    expect(projectCycloidEventToDurableEntry(translated)).toMatchObject({
      type: "question",
      data: {
        id: "q-1",
        question: "Continue?",
        options: ["Yes", "No"],
      },
    });
  });
});
