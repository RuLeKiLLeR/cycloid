import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/observability/events-exporter")
  >("../../../apps/control-plane-worker/src/observability/events-exporter");
  return {
    ...actual,
    postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
  };
});

import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
  };
};

const SESSION_ID = "lifecycle-export-session";

let workerModule: WorkerModule;

/**
 * ARC-1196: lifecycle transitions must be direct-posted to Datadog. The
 * console-only `lifecycle_event` log was unqueryable during the zombie-socket
 * investigation (Workers Logs empty, logpush disabled); the direct post is
 * the guardrail.
 */
describe("lifecycle_event Datadog direct post", () => {
  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as unknown as WorkerModule;
  });

  beforeEach(() => {
    mockPostStructuredEventToDd.mockClear();
  });

  it("direct-posts lifecycle_event metadata when a lifecycle transition is processed", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: null,
      promptCounter: 0,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        body: JSON.stringify({ reason: "user_closed" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    await fakeState.flushWaitUntil();

    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: "lifecycle_event",
        sessionId: SESSION_ID,
        eventType: expect.any(String),
        decisionCount: expect.any(Number),
      }),
    );
  });

  it("does not direct-post high-frequency heartbeat and running-activity events", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: null,
      promptCounter: 0,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const lifecycle = instance as unknown as {
      processLifecycleEvent(sessionId: string, event: Record<string, unknown>): Promise<unknown>;
    };
    await lifecycle.processLifecycleEvent(SESSION_ID, { type: "sandbox.heartbeat_received", sandboxId: "sb-1" });
    await lifecycle.processLifecycleEvent(SESSION_ID, {
      type: "prompt.running_activity",
      promptId: "p-1",
      sandboxId: "sb-1",
    });
    await fakeState.flushWaitUntil();

    expect(mockPostStructuredEventToDd).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: "lifecycle_event" }),
    );
  });
});
