/**
 * Tests for SessionDO event durability ordering.
 *
 * Verifies that:
 * 1. non-critical streaming events are persisted through durable fanout
 * 2. critical events fan out only after they are durable
 * 3. text/reasoning deltas are buffered for batch persistence
 * 4. structured events flush the text buffer before persisting
 * 5. completion events (session_idle) flush buffer and complete the prompt
 * 6. enqueuePersistence serializes tasks and handles errors
 *
 * The lifecycle `rich_status` projection ordering rule (await before
 * broadcast) is documented in `apps/control-plane-worker/README.md` under
 * "Projection write ownership"; contract-level coverage for the
 * `persistAndBroadcastSessionStatus` path lives in
 * `tests/test_cloudflare/session/lifecycle-projection-blocking.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAutoCloseGraceMs,
  LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_PHASE_STORAGE_KEY,
  LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
  LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY,
  LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY,
  LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
  MIN_ALARM_DELAY_MS,
  PROMPT_MAX_DURATION_MS,
  PROMPT_STOPPED_BY_STORAGE_KEY,
  SANDBOX_HEARTBEAT_LIVENESS_MS,
  SANDBOX_LOSS_RECOVERY_BUDGET_MS,
  SANDBOX_RECONNECT_GRACE_MS,
  SPAWN_CONNECT_TIMEOUT_COLD_MS,
  STALE_PROMPT_TIMEOUT_MS,
} from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { computeSha256Hex } from "../../../apps/control-plane-worker/src/utils.ts";
import { translateBridgeEventToCycloidEvent } from "../../../apps/sandbox-bridge/src/events/translate.ts";
import {
  getRawSessionEventData,
  getRawSessionEventKind,
  type RawSessionEvent,
} from "../../../shared/transcript/projector.js";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  queryEvents,
  queryPrompts,
  querySandboxState,
  querySessionEvents,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  default: {
    fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  };
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
  };
};

/** Type-safe interface for accessing private DO members in tests. */
interface DOTestHandle {
  completeActivePrompt(
    sessionId: string,
    completion: { success: boolean; error?: string; errorCode?: string },
    expectedPromptId?: string,
    completionSource?: "session_idle" | "execution_complete" | "post_execution_preclose",
  ): Promise<void>;
  armPlatformLlmPostExecutionWindow(
    sessionId: string,
    promptId: string,
  ): Promise<"held" | "terminalize" | "already_terminal">;
  processSandboxMessage(data: string | ArrayBuffer, session: Record<string, unknown>): Promise<void>;
  startSpawnAttempt(sessionId: string, operation: string): Promise<string>;
  spawnSandbox(sessionId: string, spawnAttemptId: string, operation: string): Promise<void>;
  scheduleSpawnConnectAlarm(): Promise<void>;
  alarm(): Promise<void>;
  enqueuePersistence(task: () => Promise<void>): void;
  flushTextDeltaBuffer(): Promise<void>;
  rescheduleSessionAlarm(): Promise<void>;
  persistenceQueue: Promise<void>;
  cachedSandboxConnectionGen?: number | null;
  sandboxWs?: WebSocket | null;
  probeE2BRuntimeLiveness(...args: unknown[]): Promise<"alive" | "dead" | "unknown">;
  crossCheckRuntimeForDiagnosis(...args: unknown[]): Promise<void>;
  textDeltaBuffer: Array<{ type: string; timestamp: string; data: Record<string, unknown> }>;
  textDeltaBufferMeta: { sessionId: string; promptId?: string } | null;
}

type CapturedD1Run = {
  query: string;
  values: unknown[];
};

class CapturingD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly d1: CapturingD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    this.d1.runs.push({ query: this.query, values: this.values });
    return { success: true, meta: { last_row_id: 0 } };
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("FROM users WHERE id") && this.query.includes("business_id")) {
      return { business_id: "biz-1" };
    }
    return null;
  }
}

class CapturingD1 {
  runs: CapturedD1Run[] = [];

  prepare(query: string): CapturingD1Statement {
    return new CapturingD1Statement(this, query);
  }
}

class BlockingD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly d1: BlockingD1,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    this.d1.runs.push({ query: this.query, values: this.values });
    await this.d1.waitForQuery(this.query);
    return { success: true, meta: { last_row_id: 0 } };
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }

  async first(): Promise<Record<string, unknown> | null> {
    if (this.query.includes("FROM users WHERE id") && this.query.includes("business_id")) {
      return { business_id: "biz-1" };
    }
    return null;
  }
}

class BlockingD1 {
  runs: CapturedD1Run[] = [];
  private releaseQuery: ((value: void | PromiseLike<void>) => void) | null = null;
  private readonly blockedQuery: string;
  private readonly blockedPromise: Promise<void>;

  constructor(blockedQuery: string) {
    this.blockedQuery = blockedQuery;
    this.blockedPromise = new Promise<void>((resolve) => {
      this.releaseQuery = resolve;
    });
  }

  prepare(query: string): BlockingD1Statement {
    return new BlockingD1Statement(this, query);
  }

  async batch(statements: unknown[]): Promise<unknown[]> {
    const shouldBlock = statements.some(
      (statement) => statement instanceof BlockingD1Statement && statement.query.includes(this.blockedQuery),
    );
    if (shouldBlock) {
      await this.blockedPromise;
    }
    return [];
  }

  async waitForQuery(query: string): Promise<void> {
    if (query.includes(this.blockedQuery)) {
      await this.blockedPromise;
    }
  }

  release(): void {
    this.releaseQuery?.();
    this.releaseQuery = null;
  }
}

/**
 * Helper to create a SessionDO instance with pre-populated state.
 * Returns the DO instance cast to `any` for private member access,
 * the fake storage, and a mock client socket for broadcast assertions.
 */
async function createDOWithSession(workerModule: WorkerModule, envOverrides: Record<string, unknown> = {}) {
  const env = { ...createTestEnv(), ...envOverrides };
  const fakeState = createFakeState();

  // Pre-populate minimal session state
  const sessionId = "test-session-1";
  const session = {
    sessionId,
    ownerUserId: "user-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    lastEventId: null,
    title: null,
  };
  await fakeState.storage.put("session", session);
  await fakeState.storage.put("activePromptId", "prompt-1");
  await fakeState.storage.put("prompts", [
    makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
  ]);
  await fakeState.storage.put("replay", {
    sessionId,
    lastEventSequence: 0,
    lastEventTimestamp: null,
    updatedAt: null,
  });
  await fakeState.storage.put("events", []);

  const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

  // Initialize the cached activePromptId as if sandbox connected

  // Add a mock client socket for broadcast assertions
  const mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  fakeState.acceptWebSocket(mockSocket, ["client", "wsid:test-client"]);
  const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "gen:1", "sid:sbx-1"]);

  return { instance, fakeState, mockSocket, sandboxSocket, session, sessionId };
}

async function armConfirmedRuntimeLoss(
  instance: DOTestHandle,
  fakeState: Awaited<ReturnType<typeof createDOWithSession>>["fakeState"],
  sessionId: string,
): Promise<void> {
  fakeState.storage.sql.exec(
    `UPDATE sandbox_state
        SET runtime_provider = ?,
            runtime_backend = ?,
            runtime_state = ?,
            runtime_sandbox_id = COALESCE(runtime_sandbox_id, ?)
      WHERE session_id = ?`,
    "e2b",
    "e2b_cloud",
    "running",
    "e2b-runtime-1",
    sessionId,
  );
  const lifecycleSandbox =
    (await fakeState.storage.get<Record<string, unknown>>(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY)) ?? {};
  await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
    ...lifecycleSandbox,
    lastHeartbeatAt: Date.now() - SANDBOX_LOSS_RECOVERY_BUDGET_MS - 1,
  });
  vi.spyOn(instance, "probeE2BRuntimeLiveness").mockResolvedValue("dead");
  vi.spyOn(instance, "crossCheckRuntimeForDiagnosis").mockResolvedValue();
}

function makeStoredPrompt(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    promptId: "prompt-1",
    prompt: "Fix the post-execution flow",
    actorUserId: "user-1",
    status: "completed",
    createdAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    result: null,
    error: null,
    ...overrides,
  };
}

/**
 * Create a mock MessageEvent from a sandbox bridge event payload.
 */
function mockMessageEvent(payload: Record<string, unknown>): string {
  return JSON.stringify({
    ...payload,
    ...translateBridgeEventToCycloidEvent("test-session-1", {
      messageId: "prompt-1",
      sandboxId: "sbx-1",
      timestamp: Date.now(),
      ...payload,
    } as never),
  });
}

/** Drain the persistence queue by awaiting it. */
async function drainPersistence(instance: DOTestHandle): Promise<void> {
  await instance.persistenceQueue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionDO durability ordering", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. Critical events wait for durable fanout while streaming events are buffered
  // -----------------------------------------------------------------------

  describe("critical events wait for durable fanout", () => {
    it("buffers token events without raw sandbox_event fanout", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      const tokenEvent = mockMessageEvent({
        type: "token",
        content: "hello",
        partId: "part-1",
        messageId: "prompt-1",
      });

      // Call processSandboxMessage synchronously
      instance.processSandboxMessage(tokenEvent, session);

      expect(mockSocket.send).not.toHaveBeenCalled();

      // Storage should NOT have the event yet (text is buffered)
      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events).toEqual([]);
    });

    it("persists and ACKs final_answer through the critical durable path", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);
      const originalUpdatedAt = fakeState.storage.sql
        .exec("SELECT updated_at FROM session WHERE session_id = ?", sessionId)
        .toArray()[0]?.updated_at;

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "final_answer",
          content: "All set.",
          partId: "prompt-1:final_answer",
          ackId: "prompt-1:final_answer:1:hash",
          messageId: "prompt-1",
        }),
        session,
      );

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events).toEqual([
        expect.objectContaining({
          id: "ack:test-session-1:prompt-1:final_answer:1:hash",
          type: "text",
          data: expect.objectContaining({
            id: "prompt-1:final_answer",
            text: "All set.",
            finalAnswer: true,
          }),
        }),
      ]);

      expect(mockSocket.send).toHaveBeenCalledTimes(1);
      const broadcasted = JSON.parse(mockSocket.send.mock.calls[0][0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(getRawSessionEventKind(broadcasted.event as RawSessionEvent)).toBe("text");
      expect(getRawSessionEventData(broadcasted.event as RawSessionEvent)?.text).toBe("All set.");

      expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:final_answer:1:hash",
      });
      expect(
        fakeState.storage.sql.exec("SELECT updated_at FROM session WHERE session_id = ?", sessionId).toArray()[0]
          ?.updated_at,
      ).toBe(originalUpdatedAt);
      expect(instance.textDeltaBuffer).toEqual([]);
    });

    it("persists and broadcasts prompt activity through durable fanout", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "waiting_for_agent_event",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      const broadcasted = mockSocket.send.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .find((message) => message.type === "session_event");
      expect(broadcasted).toMatchObject({
        type: "session_event",
        event: {
          phase: "prompt.dispatch",
          promptId: "prompt-1",
          payload: expect.objectContaining({
            bridgeData: expect.objectContaining({
              phase: "waiting_for_agent_event",
            }),
          }),
        },
      });

      expect(querySessionEvents(fakeState.storage, sessionId)).toEqual([
        expect.objectContaining({
          type: "prompt_activity",
          data: expect.objectContaining({
            type: "prompt_activity",
            promptId: "prompt-1",
            phase: "waiting_for_agent_event",
            sandboxId: "sbx-1",
          }),
        }),
      ]);
    });

    it("does not let plain model-wait prompt activity extend running inactivity", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        lastRunningActivityAt: Date.now() - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, 123_456);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "waiting_for_agent_event",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      await expect(fakeState.storage.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY)).resolves.toBe(
        123_456,
      );
    });

    it("lets waiting prompt activity extend inactivity while a tool call is open before persistence drains", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        lastRunningActivityAt: Date.now() - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, 123_456);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_call",
          tool: "bash",
          args: { command: "npm test" },
          callId: "call-1",
          status: "running",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "waiting_for_agent_event",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      const deadline = await fakeState.storage.get<number>(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY);
      expect(deadline).toBeGreaterThan(Date.now() + STALE_PROMPT_TIMEOUT_MS - 5_000);
    });

    it("keeps waiting prompt activity exempt after a non-terminal tool update", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        lastRunningActivityAt: Date.now() - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, 123_456);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_call",
          tool: "bash",
          args: { command: "npm test" },
          callId: "call-1",
          status: "running",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_update",
          tool: "bash",
          callId: "call-1",
          status: "running",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, 123_456);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "waiting_for_agent_event",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      const deadline = await fakeState.storage.get<number>(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY);
      expect(deadline).toBeGreaterThan(Date.now() + STALE_PROMPT_TIMEOUT_MS - 5_000);
    });

    it("stops exempting waiting prompt activity after a terminal tool update", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        lastRunningActivityAt: Date.now() - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, 123_456);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_call",
          tool: "bash",
          args: { command: "npm test" },
          callId: "call-1",
          status: "running",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_update",
          tool: "bash",
          callId: "call-1",
          status: "completed",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, 123_456);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "waiting_for_agent_event",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      await expect(fakeState.storage.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY)).resolves.toBe(
        123_456,
      );
    });

    it("broadcasts heartbeat liveness without persisting it into replay storage", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "heartbeat",
          sandboxId: "sbx-1",
          status: "running",
          timestamp: Date.now(),
        }),
        session,
      );

      const broadcasted = mockSocket.send.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .find((message) => message.type === "sandbox_event");
      expect(broadcasted).toMatchObject({
        type: "sandbox_event",
        event: {
          type: "heartbeat",
          sandboxId: "sbx-1",
          status: "running",
        },
      });

      expect(queryEvents(fakeState.storage, sessionId)).toEqual([]);
    });

    it("ignores prompt activity for non-active prompts", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-2",
          phase: "waiting_for_agent_event",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(querySessionEvents(fakeState.storage, sessionId)).toEqual([]);
    });

    it("drops removed legacy subagent events before broadcast or persistence", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        JSON.stringify({
          type: "subagent_text",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          delta: "removed",
          timestamp: Date.now(),
        }),
        session,
      );
      await drainPersistence(instance);

      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(querySessionEvents(fakeState.storage, sessionId)).toEqual([]);
    });

    it("acks removed ACK-required step events before dropping them", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        JSON.stringify({
          type: "step_start",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
          ackId: "prompt-1:step_start:1:hash",
        }),
        session,
      );
      await drainPersistence(instance);

      expect(sandboxSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "ack", ackId: "prompt-1:step_start:1:hash" }),
      );
      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(querySessionEvents(fakeState.storage, sessionId)).toEqual([]);
    });

    it("drops removed Cycloid subagent events rejected by schema validation", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        JSON.stringify({
          phase: "bridge.event",
          timestampMs: Date.now(),
          sessionId,
          promptId: "prompt-1",
          sandboxId: "sbx-1",
          payload: {
            bridgeEventType: "subagent_text",
            bridgeData: { delta: "removed" },
          },
        }),
        session,
      );
      await drainPersistence(instance);

      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(querySessionEvents(fakeState.storage, sessionId)).toEqual([]);
    });

    it("only applies dispatching lifecycle progress for the active prompt", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-old",
          phase: "prompt_dispatching",
          sandboxId: "sbx-1",
          startupAttemptId: "start-1",
          timestamp: Date.now(),
        }),
        session,
      );

      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY)).toBeUndefined();

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "prompt_dispatching",
          sandboxId: "sbx-1",
          startupAttemptId: "start-1",
          timestamp: Date.now(),
        }),
        session,
      );

      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY)).toMatchObject({
        phase: "dispatching",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        startupAttemptId: "start-1",
      });
    });

    it("waits to fan out tool_call until after the durable write completes", async () => {
      const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

      const toolCallEvent = mockMessageEvent({
        type: "tool_call",
        tool: "read",
        callId: "call-1",
        args: { filePath: "/src/index.ts" },
        messageId: "prompt-1",
      });

      instance.processSandboxMessage(toolCallEvent, session);

      // Critical events no longer go out over the pre-commit sandbox_event channel.
      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(querySessionEvents(fakeState.storage, sessionId)).toEqual([]);

      // After draining persistence, storage should have the event
      await drainPersistence(instance);
      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.type).toBe("tool_call");

      expect(mockSocket.send).toHaveBeenCalledTimes(1);
      const broadcasted = JSON.parse(mockSocket.send.mock.calls[0][0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(broadcasted.event.type).toBe("tool_call");
    });

    it("persists and ACKs ACK-required tool_result deliveries as tool updates", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_result",
          tool: "bash",
          callId: "call-1",
          result: "passed",
          ackId: "prompt-1:tool_result:1",
          messageId: "prompt-1",
        }),
        session,
      );

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events).toEqual([
        expect.objectContaining({
          id: "ack:test-session-1:prompt-1:tool_result:1",
          type: "tool_update",
          data: expect.objectContaining({
            id: "call-1",
            status: "completed",
            output: "passed",
          }),
        }),
      ]);

      expect(mockSocket.send).toHaveBeenCalledTimes(1);
      const broadcasted = JSON.parse(mockSocket.send.mock.calls[0][0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(getRawSessionEventKind(broadcasted.event as RawSessionEvent)).toBe("tool_update");

      expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:tool_result:1",
      });
    });

    it("persists question before broadcasting it", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      const questionEvent = mockMessageEvent({
        type: "question",
        ackId: "prompt-1:question:1",
        questionId: "q-1",
        question: "Which file?",
        options: ["a.ts", "b.ts"],
        messageId: "prompt-1",
      });

      await instance.processSandboxMessage(questionEvent, session);

      expect(await fakeState.storage.get("has_pending_question")).toBe(true);
      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.map((event) => event.type)).toContain("question");
      const persistedQuestion = events.find((event) => event.type === "question") as
        { data?: { id?: string; options?: unknown } } | undefined;
      expect(persistedQuestion).toBeDefined();
      expect(persistedQuestion?.data?.id).toBe("q-1");
      expect(persistedQuestion?.data?.options).toEqual(["a.ts", "b.ts"]);

      // Question event is broadcast first (durable + replay-visible), then the
      // session_status broadcast flips the UI to `waiting_for_input`.
      expect(mockSocket.send).toHaveBeenCalledTimes(2);
      const broadcasted = JSON.parse(mockSocket.send.mock.calls[0][0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(getRawSessionEventKind(broadcasted.event as RawSessionEvent)).toBe("question");
      expect(getRawSessionEventData(broadcasted.event as RawSessionEvent)?.question).toBe("Which file?");
      const statusBroadcast = JSON.parse(mockSocket.send.mock.calls[1][0] as string);
      expect(statusBroadcast).toMatchObject({ type: "session_status", phase: "waiting_for_input" });
      // The frame carries lastBranch so a push re-entering a non-terminal phase
      // surfaces the new branch (and the Create-PR CTA) without the ~30s poll.
      expect(statusBroadcast).toHaveProperty("lastBranch");

      expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:question:1",
      });
    });

    it("drops envelope events whose sessionId does not match the receiving session", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      const misroutedQuestion = JSON.stringify({
        type: "question",
        ackId: "prompt-1:question:misrouted",
        questionId: "q-misrouted",
        question: "Which file?",
        messageId: "prompt-1",
        sandboxId: "sbx-1",
        timestamp: Date.now(),
        sessionId: "session-other",
        timestampMs: Date.now(),
        phase: "user_question",
        payload: {
          bridgeEventType: "question",
          questionId: "q-misrouted",
          question: "Which file?",
        },
      });

      await instance.processSandboxMessage(misroutedQuestion, session);

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.map((event) => event.type)).not.toContain("question");
      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(sandboxSocket.send).not.toHaveBeenCalled();
    });

    it("drops envelope events with mismatched sessionId even when payload validation fails", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      // payload: {} fails validateCycloidEvent for phase "user_question",
      // forcing the catch-path. The sessionId guard must still drop the event.
      const misroutedWithBadPayload = JSON.stringify({
        type: "question",
        ackId: "prompt-1:question:misrouted-catch",
        questionId: "q-misrouted-catch",
        question: "Which file?",
        messageId: "prompt-1",
        sandboxId: "sbx-1",
        timestamp: Date.now(),
        sessionId: "session-other",
        timestampMs: Date.now(),
        phase: "user_question",
        payload: {},
      });

      await instance.processSandboxMessage(misroutedWithBadPayload, session);

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.map((event) => event.type)).not.toContain("question");
      expect(mockSocket.send).not.toHaveBeenCalled();
      expect(sandboxSocket.send).not.toHaveBeenCalled();
    });

    it("ACKs duplicate question deliveries without duplicating the durable event", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      const questionEvent = mockMessageEvent({
        type: "question",
        ackId: "prompt-1:question:1",
        questionId: "q-1",
        question: "Which file?",
        messageId: "prompt-1",
      });

      await instance.processSandboxMessage(questionEvent, session);
      await instance.processSandboxMessage(questionEvent, session);

      const questions = querySessionEvents(fakeState.storage, sessionId).filter((event) => event.type === "question");
      expect(questions).toHaveLength(1);

      // First delivery emits the question event + waiting_for_input status broadcast.
      // The duplicate delivery is deduped before persistence so it must not emit
      // an extra status broadcast.
      expect(mockSocket.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockSocket.send.mock.calls[1][0] as string)).toMatchObject({
        type: "session_status",
        phase: "waiting_for_input",
      });
      expect(sandboxSocket.send).toHaveBeenCalledTimes(2);
      expect(JSON.parse(sandboxSocket.send.mock.calls[1][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:question:1",
      });
    });

    it("re-ACKs duplicate question deliveries on the latest sandbox socket after reconnect", async () => {
      const { instance, fakeState, mockSocket, sandboxSocket, session, sessionId } =
        await createDOWithSession(workerModule);

      const questionEvent = mockMessageEvent({
        type: "question",
        ackId: "prompt-1:question:1",
        questionId: "q-1",
        question: "Which file?",
        messageId: "prompt-1",
      });

      await instance.processSandboxMessage(questionEvent, session);

      const reconnectedSandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      fakeState.acceptWebSocket(reconnectedSandboxSocket, ["sandbox", "gen:2", "sid:sbx-2"]);
      instance.sandboxWs = null;
      instance.cachedSandboxConnectionGen = 2;

      await instance.processSandboxMessage(questionEvent, session);

      const questions = querySessionEvents(fakeState.storage, sessionId).filter((event) => event.type === "question");
      expect(questions).toHaveLength(1);

      // First delivery emits question + waiting_for_input. Duplicate delivery is
      // deduped so no extra status broadcast.
      expect(mockSocket.send).toHaveBeenCalledTimes(2);
      expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(reconnectedSandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(reconnectedSandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:question:1",
      });
    });

    it("does not ACK a question when durable persistence fails", async () => {
      const { instance, sandboxSocket, session } = await createDOWithSession(workerModule);
      const failingInstance = instance as DOTestHandle & {
        appendAndBroadcastEvents: ReturnType<typeof vi.fn>;
      };
      failingInstance.appendAndBroadcastEvents = vi.fn().mockRejectedValue(new Error("write failed"));

      await expect(
        instance.processSandboxMessage(
          mockMessageEvent({
            type: "question",
            ackId: "prompt-1:question:1",
            questionId: "q-1",
            question: "Which file?",
            messageId: "prompt-1",
          }),
          session,
        ),
      ).rejects.toThrow("write failed");

      expect(sandboxSocket.send).not.toHaveBeenCalled();
    });

    it("includes the updated prompt payload when execution_complete fails a prompt", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule, { DB: d1 });
      await fakeState.storage.put("prompts", [makeStoredPrompt({ status: "processing", result: null, error: null })]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: false,
          error: "Follow-up prompt did not start during empty-completion retry",
          errorCode: "followup_not_started",
          errorDetails: {
            message: "fetch failed",
            name: "TypeError",
            stack: "TypeError: fetch failed\n    at sandbox",
            responseBodyPreview: '{"error":"secret"}',
            raw: '{"secret":"value"}',
            cause: {
              message: "connect ECONNREFUSED 127.0.0.1:12345",
              code: "ECONNREFUSED",
              syscall: "connect",
              address: "127.0.0.1",
              port: 12345,
            },
          },
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "failed",
        error: "Follow-up prompt did not start during empty-completion retry",
      });

      const events = querySessionEvents(fakeState.storage, sessionId);
      const failedEvent = events?.find((event) => event.type === "prompt_failed");
      expect(failedEvent?.data?.error).toBe("Follow-up prompt did not start during empty-completion retry");
      expect(failedEvent?.data?.errorDetails).toMatchObject({
        message: "fetch failed",
        name: "TypeError",
        cause: {
          code: "ECONNREFUSED",
          port: 12345,
        },
      });
      expect(failedEvent?.data?.errorDetails).not.toHaveProperty("stack");
      expect(failedEvent?.data?.errorDetails).not.toHaveProperty("responseBodyPreview");
      expect(failedEvent?.data?.errorDetails).not.toHaveProperty("raw");
      expect(failedEvent?.data?.prompt).toMatchObject({
        promptId: "prompt-1",
        status: "failed",
        error: "Follow-up prompt did not start during empty-completion retry",
        errorDetails: {
          message: "fetch failed",
          name: "TypeError",
        },
      });
      expect(failedEvent?.data?.prompt?.errorDetails).not.toHaveProperty("stack");
      expect(failedEvent?.data?.prompt?.errorDetails).not.toHaveProperty("responseBodyPreview");
      expect(failedEvent?.data?.prompt?.errorDetails).not.toHaveProperty("raw");
      const insertRun = d1.runs.find((run) => run.query.includes("INSERT INTO prompt_runs"));
      expect(insertRun).toBeDefined();
      expect(insertRun!.values[22]).toBe(
        JSON.stringify({
          message: "fetch failed",
          name: "TypeError",
          stack: "TypeError: fetch failed\n    at sandbox",
          responseBodyPreview: '{"error":"secret"}',
          raw: '{"secret":"value"}',
          cause: {
            message: "connect ECONNREFUSED 127.0.0.1:12345",
            code: "ECONNREFUSED",
            syscall: "connect",
            address: "127.0.0.1",
            port: 12345,
          },
        }),
      );
    });

    it("normalizes contradictory execution_complete telemetry across prompt state, replay, and prompt_runs", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule, { DB: d1 });
      const errorDetails = { message: "Tool 'tool_search' is not supported", name: "CodexStreamError" };

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          errorDetails,
          idleObserved: true,
          sessionEditCount: 0,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const prompts = await fakeState.storage.get<Array<{ promptId: string; status: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({ status: "failed" });

      const durableTerminal = querySessionEvents(fakeState.storage, sessionId).find(
        (event) => event.type === "sandbox_execution_complete",
      );
      expect(durableTerminal?.data).toMatchObject({
        success: false,
        error: errorDetails.message,
        errorCode: "unknown",
      });

      const insertRun = d1.runs.find((run) => run.query.includes("INSERT INTO prompt_runs"));
      expect(insertRun?.values[11]).toBe("failed");
      expect(insertRun?.values[12]).toBe("unknown");
      expect(insertRun?.values[22]).toBe(JSON.stringify(errorDetails));
    });

    it("atomically repairs a session_idle-first completed prompt_runs row and is replay-idempotent", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1 });

      await instance.completeActivePrompt("test-session-1", { success: true }, "prompt-1", "session_idle");
      const contradictoryTerminal = mockMessageEvent({
        type: "execution_complete",
        messageId: "prompt-1",
        success: true,
        errorCode: "api_error",
        errorDetails: { message: "Provider rejected the request" },
        idleObserved: true,
      });

      await instance.processSandboxMessage(contradictoryTerminal, session);
      await instance.processSandboxMessage(contradictoryTerminal, session);
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const backfills = d1.runs.filter(
        (run) => run.query.includes("UPDATE prompt_runs SET") && run.query.includes("outcome = CASE"),
      );
      expect(backfills.length).toBeGreaterThanOrEqual(2);
      for (const backfill of backfills) {
        expect(backfill.query).toContain("THEN 'failed'");
        expect(backfill.values[0]).toBe("api_error");
        expect(backfill.values[1]).toBe(JSON.stringify({ message: "Provider rejected the request" }));
      }
    });

    it("waits for prompt running-activity bookkeeping before returning a first execution event", async () => {
      const { instance, session } = await createDOWithSession(workerModule);
      const handle = instance as DOTestHandle & {
        processLifecycleEvent: ReturnType<typeof vi.fn>;
      };
      const lifecycleCalls: string[] = [];
      let releaseRunningActivity: (() => void) | null = null;
      const runningActivityGate = new Promise<void>((resolve) => {
        releaseRunningActivity = resolve;
      });

      handle.processLifecycleEvent = vi.fn(async (_sessionId: string, event: { type: string }) => {
        lifecycleCalls.push(event.type);
        if (event.type === "prompt.running_activity") {
          await runningActivityGate;
        }
      });

      let settled = false;
      const tokenPromise = handle
        .processSandboxMessage(
          mockMessageEvent({
            type: "token",
            content: "hello",
            partId: "part-1",
            messageId: "prompt-1",
            sandboxId: "sbx-1",
          }),
          session,
        )
        .then(() => {
          settled = true;
        });

      await Promise.resolve();
      await Promise.resolve();

      expect(lifecycleCalls).toEqual(["prompt.running_activity"]);
      expect(settled).toBe(false);

      releaseRunningActivity?.();
      await tokenPromise;

      expect(settled).toBe(true);
    });

    it("does not start prompt running-activity from agent_prompt_sent", async () => {
      const { instance, session } = await createDOWithSession(workerModule);
      const handle = instance as DOTestHandle & {
        processLifecycleEvent: ReturnType<typeof vi.fn>;
      };
      const lifecycleCalls: string[] = [];

      handle.processLifecycleEvent = vi.fn(async (_sessionId: string, event: { type: string }) => {
        lifecycleCalls.push(event.type);
      });

      await handle.processSandboxMessage(
        mockMessageEvent({
          type: "agent_prompt_sent",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
        }),
        session,
      );

      expect(lifecycleCalls).toEqual(["prompt.agent_prompt_sent"]);
    });

    it("treats memory recall telemetry as prompt running activity", async () => {
      const { instance, session } = await createDOWithSession(workerModule);
      const handle = instance as DOTestHandle & {
        processLifecycleEvent: ReturnType<typeof vi.fn>;
      };
      const lifecycleCalls: string[] = [];

      handle.processLifecycleEvent = vi.fn(async (_sessionId: string, event: { type: string }) => {
        lifecycleCalls.push(event.type);
      });

      await handle.processSandboxMessage(
        mockMessageEvent({
          type: "memory_recall_usage",
          eventName: "memory_recall.returned",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          returnedMemoryIds: ["mem-1"],
        }),
        session,
      );

      expect(lifecycleCalls).toEqual(["prompt.running_activity"]);
    });

    it("finalizes a prompt when the dispatch-to-first-execution watchdog fires", async () => {
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "dispatching",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        codexPromptSentAt: Date.now() - 181_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_DISPATCH_DEADLINE_STORAGE_KEY, Date.now() - 1);

      await instance.alarm();
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
        status: "failed",
        error: "Prompt could not be delivered to the agent runtime",
      });
      const failedEvents = querySessionEvents(fakeState.storage, sessionId).filter(
        (event) => event.type === "prompt_failed",
      );
      const failedEvent = failedEvents.at(-1);
      expect(failedEvent?.data).toMatchObject({
        promptId: "prompt-1",
        errorCode: "codex_prompt_dispatch_timeout",
      });

      await instance.alarm();
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();
      expect(
        querySessionEvents(fakeState.storage, sessionId).filter((event) => event.type === "prompt_failed"),
      ).toHaveLength(failedEvents.length);
    });

    it("recovers a stale prompt when execution_complete arrives late without progress metadata", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule, {
        DB: d1,
      });
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        startupAttemptId: "start-1",
        lastRunningActivityAt: Date.now() - STALE_PROMPT_TIMEOUT_MS - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() - 1);

      await instance.alarm();
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const telemetryAfterFailure = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, sessionId);
      expect(telemetryAfterFailure["prompt-1"]).toMatchObject({
        errorCode: "stale_prompt",
      });

      await fakeState.storage.put("activePromptId", null);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.some((event) => event.type === "prompt_recovered")).toBe(true);
      const completedEvent = events.findLast((event) => event.type === "prompt_completed");
      expect(completedEvent?.data).toMatchObject({
        recoveredFrom: "stale_prompt",
        staleReason: "stale_prompt",
      });

      const recoveryUpdate = d1.runs.find((run) =>
        run.query.includes("WHERE id = ? AND outcome = 'failed' AND error_code = 'stale_prompt'"),
      );
      expect(recoveryUpdate).toBeDefined();
      expect(recoveryUpdate?.values[0]).toBe("completed");
      expect(recoveryUpdate?.values[1]).toBeNull();
    });

    it("recovers a stale prompt when session_idle arrives late", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule, {
        DB: d1,
      });
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        startupAttemptId: "start-1",
        lastRunningActivityAt: Date.now() - STALE_PROMPT_TIMEOUT_MS - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() - 1);

      await instance.alarm();
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const telemetryAfterFailure = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, sessionId);
      expect(telemetryAfterFailure["prompt-1"]).toMatchObject({
        errorCode: "stale_prompt",
      });

      await fakeState.storage.put("activePromptId", null);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.some((event) => event.type === "prompt_recovered")).toBe(true);
      const completedEvent = events.findLast((event) => event.type === "prompt_completed");
      expect(completedEvent?.data).toMatchObject({
        recoveredFrom: "stale_prompt",
        staleReason: "stale_prompt",
      });

      const recoveryUpdate = d1.runs.find((run) =>
        run.query.includes("WHERE id = ? AND outcome = 'failed' AND error_code = 'stale_prompt'"),
      );
      expect(recoveryUpdate).toBeDefined();
      expect(recoveryUpdate?.values[0]).toBe("completed");
      expect(recoveryUpdate?.values[1]).toBeNull();
    });

    it("does not recover a failed non-stale prompt when execution_complete arrives late", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule, {
        DB: d1,
      });

      await fakeState.storage.put("activePromptId", null);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({
          status: "failed",
          error: "Prompt exceeded maximum duration",
          startedAt: "2026-04-13T09:58:00.000Z",
          completedAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:00:00.000Z",
        }),
      ]);
      doDb.upsertPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, "prompt-1", {
        errorCode: "max_duration_exceeded",
        toolCallCount: 0,
      });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
          sessionEditCount: 2,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
        status: "failed",
        error: "Prompt exceeded maximum duration",
      });
      expect(querySessionEvents(fakeState.storage, sessionId).some((event) => event.type === "prompt_recovered")).toBe(
        false,
      );
      expect(
        d1.runs.some((run) =>
          run.query.includes("WHERE id = ? AND outcome = 'failed' AND error_code = 'stale_prompt'"),
        ),
      ).toBe(false);
    });

    it("drains queued prompts from successful execution_complete without waiting for session_idle", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Run the queued follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-2")).toMatchObject({
        status: "processing",
      });
      expect(await fakeState.storage.get("activePromptId")).toBe("prompt-2");

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events?.some((event) => event.type === "prompt_completed")).toBe(true);
      expect(events?.some((event) => event.type === "prompt_processing")).toBe(true);
    });

    it("closes execution_complete before slow terminal side effects finish", async () => {
      const d1 = new BlockingD1("INSERT INTO prompt_runs");
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1 });
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Run the queued follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts = await fakeState.storage.get<Array<{ promptId: string; status: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({ status: "completed" });
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-2")).toMatchObject({ status: "processing" });
      expect(await fakeState.storage.get("activePromptId")).toBe("prompt-2");
      expect(d1.runs.some((run) => run.query.includes("INSERT INTO prompt_runs"))).toBe(true);

      d1.release();
      await fakeState.flushWaitUntil();
    });

    it("does not let slow memory usage telemetry block a later execution_complete", async () => {
      const d1 = new BlockingD1("session_memory_usage");
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1 });
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Run the queued follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "memory_usage",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
          activeMemoryIds: ["mem-1"],
        }),
        session,
      );

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts = await fakeState.storage.get<Array<{ promptId: string; status: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({ status: "completed" });
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-2")).toMatchObject({ status: "processing" });
      expect(await fakeState.storage.get("activePromptId")).toBe("prompt-2");

      d1.release();
      await fakeState.flushWaitUntil();
    });

    it("persists memory usage before a later execution_complete", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule, {
        DB: new BlockingD1("query-that-will-not-block"),
      });
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "memory_usage",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
          activeMemoryIds: ["mem-1"],
        }),
        session,
      );

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
          sessionEditCount: 0,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);

      const events = querySessionEvents(fakeState.storage, sessionId);
      const memoryUsageIndex = events.findIndex((event) => event.type === "memory_usage");
      const promptCompletedIndex = events.findIndex((event) => event.type === "prompt_completed");

      expect(memoryUsageIndex).toBeGreaterThanOrEqual(0);
      expect(promptCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(memoryUsageIndex).toBeLessThan(promptCompletedIndex);
      expect(events[memoryUsageIndex]?.data).toMatchObject({
        activeMemoryIds: ["mem-1"],
      });
    });

    it("completes successful execution_complete even when sessions finish with zero session edits", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events?.some((event) => event.type === "prompt_completed")).toBe(true);
      expect(events?.some((event) => event.type === "prompt_failed")).toBe(false);
    });

    it("ACKs replayed execution_complete deliveries without duplicating terminal replay", async () => {
      const { instance, fakeState, sandboxSocket, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
      ]);
      const completionEvent = mockMessageEvent({
        type: "execution_complete",
        ackId: "prompt-1:execution_complete:1",
        messageId: "prompt-1",
        success: true,
        idleObserved: true,
        sessionEditCount: 0,
        sessionPromptCount: 2,
      });

      await instance.processSandboxMessage(completionEvent, session);
      await drainPersistence(instance);

      const replayInstance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
      const replaySandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      fakeState.acceptWebSocket(replaySandboxSocket, ["sandbox", "gen:2", "sid:sbx-1"]);
      replayInstance.sandboxWs = null;
      replayInstance.cachedSandboxConnectionGen = 2;

      await replayInstance.processSandboxMessage(completionEvent, session);
      await drainPersistence(replayInstance);

      const rawAckRows = queryEvents(fakeState.storage, sessionId).filter(
        (event) => event.event_id === "ack:test-session-1:prompt-1:execution_complete:1",
      );
      expect(rawAckRows).toHaveLength(1);

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.filter((event) => event.type === "prompt_completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "prompt_failed")).toHaveLength(0);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });

      expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:execution_complete:1",
      });
      expect(replaySandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(replaySandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:execution_complete:1",
      });
    });

    it("waits for session_idle when successful execution_complete lacks progress metadata", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
        }),
        session,
      );
      await drainPersistence(instance);

      let prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "processing",
        error: null,
      });
      let events = querySessionEvents(fakeState.storage, sessionId);
      expect(events?.some((event) => event.type === "prompt_completed" || event.type === "prompt_failed")).toBe(false);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });
      events = querySessionEvents(fakeState.storage, sessionId);
      expect(events?.some((event) => event.type === "prompt_completed")).toBe(true);
      expect(events?.some((event) => event.type === "prompt_failed")).toBe(false);
      expect(doDb.getPlatformLlmPromptStatus(fakeState.storage.sql as unknown as SqlStorage, "prompt-1")).toMatchObject(
        {
          sessionId,
          status: "post_execution_pending",
          startedAt: expect.any(Number),
        },
      );
    });

    it("treats duplicate post-execution window arming as a successful no-op", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      const sql = fakeState.storage.sql as unknown as SqlStorage;
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);
      const firstStartedAt = doDb.getPlatformLlmPromptStatus(sql, "prompt-1")?.startedAt;

      await expect(instance.armPlatformLlmPostExecutionWindow(sessionId, "prompt-1")).resolves.toBe("held");

      expect(doDb.getPlatformLlmPromptStatus(sql, "prompt-1")).toMatchObject({
        sessionId,
        status: "post_execution_pending",
        startedAt: firstStartedAt,
      });
    });

    it("terminalizes plan prompts without arming the post-execution window", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      const sql = fakeState.storage.sql as unknown as SqlStorage;
      const planSession = { ...session, planMode: true };
      await fakeState.storage.put("session", planSession);
      await fakeState.storage.put("activePromptId", "p-1");
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ promptId: "p-1", status: "processing", result: null, error: null, completedAt: null }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "p-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        planSession,
      );
      await drainPersistence(instance);

      expect(doDb.getPlatformLlmPromptStatus(sql, "p-1")).toMatchObject({
        sessionId,
        status: "terminal",
        startedAt: null,
      });
    });

    it("uses execution_complete fallback when idle was not observed and progress metadata is absent", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Run the queued follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-2")).toMatchObject({
        status: "processing",
      });
    });

    it("ignores late session_idle for a prompt already completed by execution_complete", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Run the queued follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-2")).toMatchObject({
        status: "processing",
      });
      expect(await fakeState.storage.get("activePromptId")).toBe("prompt-2");

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events?.filter((event) => event.type === "prompt_completed")).toHaveLength(1);
      expect(events?.filter((event) => event.type === "prompt_processing")).toHaveLength(1);
    });

    it("does not let stale-recovery ignore the still-active prompt after user stop", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(PROMPT_STOPPED_BY_STORAGE_KEY, { "prompt-1": "user" });
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Run the queued follow-up",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string | null }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-2")).toMatchObject({
        status: "processing",
      });
      expect(await fakeState.storage.get("activePromptId")).toBe("prompt-2");
      expect(await fakeState.storage.get(PROMPT_STOPPED_BY_STORAGE_KEY)).toBeUndefined();
    });

    it("completes multi-prompt sessions that go idle with zero session edits", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [makeStoredPrompt({ status: "processing", result: null, error: null })]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });

      const events = querySessionEvents(fakeState.storage, sessionId);
      const completedEvent = events?.find((entry) => entry.type === "prompt_completed");
      expect(completedEvent?.data?.prompt).toMatchObject({
        promptId: "prompt-1",
        status: "completed",
        error: null,
      });
      expect(events?.some((event) => event.type === "prompt_failed")).toBe(false);
    });

    it("keeps investigate idle sessions successful even when no edits were made", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [makeStoredPrompt({ status: "processing", result: null, error: null })]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; status: string; error?: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "completed",
        error: null,
      });

      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events?.some((entry) => entry.type === "prompt_completed")).toBe(true);
    });

    it("broadcasts session_status finalizing when prompt completes with no queued follow-up", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
          sessionEditCount: 0,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);

      const broadcasts = mockSocket.send.mock.calls.map(
        ([payload]) => JSON.parse(payload as string) as { type: string; status?: string },
      );
      // The explicit post-execution projection owns this transition; clearing
      // an already-false pending-question flag does not emit its own status
      // broadcast.
      const statusBroadcasts = broadcasts.filter((msg) => msg.type === "session_status");
      expect(statusBroadcasts.length).toBeGreaterThan(0);
      expect(statusBroadcasts[statusBroadcasts.length - 1].phase).toBe("finalizing");
    });

    it("broadcasts session_status running (not idle) when queued prompt drains after completion", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "processing", result: null, error: null, completedAt: null }),
        makeStoredPrompt({
          promptId: "prompt-2",
          prompt: "Follow-up work",
          status: "queued",
          startedAt: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: true,
          sessionEditCount: 0,
          sessionPromptCount: 2,
        }),
        session,
      );
      await drainPersistence(instance);

      const broadcasts = mockSocket.send.mock.calls.map(
        ([payload]) => JSON.parse(payload as string) as { type: string; status?: string },
      );
      const statusBroadcast = broadcasts.find((msg) => msg.type === "session_status");
      expect(statusBroadcast).toBeDefined();
      expect(statusBroadcast!.phase).toBe("running");
    });

    it("ignores post_execution updates for prompts already failed by the idle no-progress gate", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({ status: "failed", result: null, error: "No code changes made" }),
      ]);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "post_execution",
          messageId: "prompt-1",
          hasChanges: false,
          noChangeReason: "no_diff",
        }),
        session,
      );
      await drainPersistence(instance);

      const prompts =
        await fakeState.storage.get<Array<{ promptId: string; result: unknown; status: string }>>("prompts");
      expect(prompts?.find((prompt) => prompt.promptId === "prompt-1")).toMatchObject({
        status: "failed",
        result: null,
      });

      const outboundMessages = mockSocket.send.mock.calls.map(
        ([payload]) => JSON.parse(payload as string) as { type: string },
      );
      expect(outboundMessages.some((message) => message.type === "prompt_updated")).toBe(false);
    });
  });

  describe("prompt telemetry start", () => {
    it("persists runtime_info, backfills Modal object id, and exposes observability readiness", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "runtime_info",
          runtime: {
            modalEnvironment: "local-test",
            modalSandboxId: "sb-runtime-1",
            reportedAt: 123,
          },
          observabilityReadiness: {
            traceExport: false,
            collector: false,
            ddLogs: false,
            tracingState: "disabled",
          },
        }),
        session,
      );
      await drainPersistence(instance);

      const response = await (instance as unknown as { fetch(request: Request): Promise<Response> }).fetch(
        new Request("https://internal/session/state"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        session: { observabilityReadiness: Record<string, unknown> | null };
      };
      expect(body.ok).toBe(true);
      expect(body.session.observabilityReadiness).toEqual({
        traceExport: false,
        collector: false,
        ddLogs: false,
        tracingState: "disabled",
      });
      expect(querySandboxState(fakeState.storage, session.sessionId)?.modal_object_id).toBe("sb-runtime-1");

      const outboundMessages = mockSocket.send.mock.calls.map(
        ([payload]) =>
          JSON.parse(payload as string) as { type: string; observabilityReadiness?: Record<string, unknown> },
      );
      expect(outboundMessages.some((message) => message.type === "observability_readiness_updated")).toBe(true);
    });

    it("does not register a Modal object id from a mismatched sandbox", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);

      doDb.ensureSandboxState(fakeState.storage.sql, session.sessionId);
      doDb.updateSandboxState(fakeState.storage.sql, session.sessionId, { sandboxId: "current-sandbox" });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "runtime_info",
          sandboxId: "stale-sandbox",
          runtime: {
            modalSandboxId: "stale-modal-object",
            reportedAt: 123,
          },
        }),
        session,
      );
      await drainPersistence(instance);

      expect(querySandboxState(fakeState.storage, session.sessionId)?.modal_object_id).toBeNull();

      const outboundMessages = mockSocket.send.mock.calls.map(
        ([payload]) => JSON.parse(payload as string) as { type: string; runtimeProvenance?: Record<string, unknown> },
      );
      const runtimeUpdate = outboundMessages.find((message) => message.type === "runtime_provenance_updated");
      expect(runtimeUpdate?.runtimeProvenance?.modalObjectId).toBeNull();
    });

    it("uses prompt-start telemetry when finalizing from session_idle", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1 });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_telemetry_start",
          promptId: "prompt-1",
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const insertRun = d1.runs.find((run) => run.query.includes("INSERT INTO prompt_runs"));
      expect(insertRun).toBeDefined();
      // dd_trace_id is no longer emitted by the bridge; only bt_span_id persists.
      expect(insertRun!.values[18]).toBeNull();
      expect(insertRun!.values[19]).toBe("bt-span-1");
    });

    it("updates only DO prompt telemetry when prompt-start arrives after finalization", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1 });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "session_idle",
          messageId: "prompt-1",
          sessionEditCount: 0,
          sessionPromptCount: 1,
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();
      const d1RunCountAfterFinalize = d1.runs.length;

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_telemetry_start",
          promptId: "prompt-1",
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const telemetry = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, "test-session-1");
      expect(telemetry["prompt-1"]).toMatchObject({
        btSpanId: "bt-span-1",
      });
      expect(d1.runs).toHaveLength(d1RunCountAfterFinalize);
    });

    it("coalesces duplicate prompt-start telemetry without rewriting the existing btSpanId", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_telemetry_start",
          promptId: "prompt-1",
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_telemetry_start",
          promptId: "prompt-1",
          btSpanId: "bt-span-2",
        }),
        session,
      );
      await drainPersistence(instance);

      const telemetry = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, "test-session-1");
      expect(telemetry["prompt-1"]).toMatchObject({
        btSpanId: "bt-span-1",
      });
    });

    it("backfills btSpanId from execution_complete into prompt_runs", async () => {
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1 });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const telemetry = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, "test-session-1");
      expect(telemetry["prompt-1"]).toMatchObject({
        btSpanId: "bt-span-1",
      });
      const updateRun = d1.runs.find((run) => run.query.includes("UPDATE prompt_runs SET"));
      expect(updateRun).toBeDefined();
      // Outcome guard binds precede trace telemetry in the backfill UPDATE.
      expect(updateRun!.values[2]).toBe("bt-span-1");
    });

    it("logs prompt telemetry completeness after execution_complete backfill", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1, LOG_LEVEL: "info" });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const finalizationLog = consoleLog.mock.calls
        .map(([payload]) => String(payload))
        .filter((entry) => entry.includes('"event":"prompt.trace.finalized"'))
        .at(-1);
      expect(finalizationLog).toBeDefined();
      expect(JSON.parse(finalizationLog!)).toMatchObject({
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        source: "execution_complete",
        trace_expected: true,
        telemetry_complete: true,
        dd_trace_id_present: false,
        bt_span_id_present: true,
      });
    });

    it("direct-posts prompt trace finalization without skipping the existing console log path", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, {
        DB: d1,
        DD_API_KEY: "dd-api-key",
        DD_SITE: "datadoghq.com",
        LOG_LEVEL: "info",
      });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const finalizationLog = consoleLog.mock.calls
        .map(([payload]) => String(payload))
        .filter((entry) => entry.includes('"event":"prompt.trace.finalized"'))
        .at(-1);
      expect(finalizationLog).toBeDefined();
      expect(JSON.parse(finalizationLog!)).toMatchObject({
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        source: "execution_complete",
        trace_expected: true,
        telemetry_complete: true,
        dd_trace_id_present: false,
        bt_span_id_present: true,
      });

      // Find the trace finalization direct-POST by body content. Other
      // lifecycle Datadog POSTs (phase transition metric/event) can fire in
      // the same flushWaitUntil pass; .at(-1) is order-fragile.
      const tracePostCall = fetchSpy.mock.calls.find((call) => {
        const body = String((call[1] as RequestInit | undefined)?.body ?? "");
        return body.includes('"_direct_post":true') && body.includes('"prompt.trace.finalized"');
      });
      expect(tracePostCall, "expected a trace finalization direct POST").toBeDefined();
      const directPostBody = JSON.parse(String((tracePostCall![1] as RequestInit).body));
      expect(directPostBody).toHaveLength(1);
      expect(directPostBody[0]).toMatchObject({
        service: "cycloid-control-plane",
        _direct_post: true,
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        source: "execution_complete",
        trace_expected: true,
        telemetry_complete: true,
        dd_trace_id_present: false,
        bt_span_id_present: true,
        bt_span_id: "bt-span-1",
        "dd.trace_id": expect.any(String),
        "dd.span_id": expect.any(String),
      });
    });

    it("emits only bounded structured error fields, never free-form ones (CWE-532)", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1, LOG_LEVEL: "info" });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: false,
          error: "fetch failed",
          errorCode: "api_error",
          errorDetails: {
            message: "fetch failed",
            name: "TypeError",
            stack: "TypeError: fetch failed\n    at sandbox",
            responseBodyPreview: '{"error":"secret"}',
            raw: '{"secret":"value"}',
            cause: {
              message: "connect ECONNREFUSED 127.0.0.1:12345",
              code: "ECONNREFUSED",
              syscall: "connect",
              address: "127.0.0.1",
              port: 12345,
            },
          },
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const finalizationLog = consoleLog.mock.calls
        .map(([payload]) => String(payload))
        .filter((entry) => entry.includes('"event":"prompt.trace.finalized"'))
        .at(-1);
      expect(finalizationLog).toBeDefined();
      const parsed = JSON.parse(finalizationLog!);
      // Bounded, structured fields are kept for triage.
      expect(parsed).toMatchObject({
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        error_details_present: true,
        error_name: "TypeError",
        error_cause_code: "ECONNREFUSED",
      });
      // Free-form fields must never reach Datadog (they stay in D1/S3 only).
      expect(parsed).not.toHaveProperty("error_details_json");
      expect(parsed).not.toHaveProperty("error_message");
      expect(parsed).not.toHaveProperty("error_hostname");
      expect(parsed).not.toHaveProperty("error_cause_message");
      // And no secret-bearing free-form text leaks into the event payload.
      expect(finalizationLog).not.toContain("secret");
      expect(finalizationLog).not.toContain("at sandbox");
    });

    it("logs incomplete prompt trace finalization when execution_complete has no trace IDs", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const d1 = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: d1, LOG_LEVEL: "info" });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "execution_complete",
          messageId: "prompt-1",
          success: true,
          idleObserved: false,
        }),
        session,
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const finalizationLog = consoleLog.mock.calls
        .map(([payload]) => String(payload))
        .filter((entry) => entry.includes('"event":"prompt.trace.finalized"'))
        .at(-1);
      expect(finalizationLog).toBeDefined();
      expect(JSON.parse(finalizationLog!)).toMatchObject({
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        source: "execution_complete",
        trace_expected: true,
        telemetry_complete: false,
        dd_trace_id_present: false,
        bt_span_id_present: false,
      });
    });

    it("marks denied Codex terminals as trace-expected after the prompt was dispatched to Codex", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const d1 = new CapturingD1();
      const { instance, fakeState } = await createDOWithSession(workerModule, { DB: d1, LOG_LEVEL: "info" });
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "dispatching",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        codexPromptSentAt: Date.now() - 1_000,
      });

      await instance.completeActivePrompt(
        "test-session-1",
        {
          success: false,
          error: "Codex app-server is closed",
          errorCode: "codex_transport_closed",
        },
        "prompt-1",
        "execution_complete",
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const finalizationLog = consoleLog.mock.calls
        .map(([payload]) => String(payload))
        .filter((entry) => entry.includes('"event":"prompt.trace.finalized"'))
        .at(-1);
      expect(finalizationLog).toBeDefined();
      expect(JSON.parse(finalizationLog!)).toMatchObject({
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        error_code: "codex_transport_closed",
        trace_expected: true,
        telemetry_complete: false,
        bt_span_id_present: false,
      });
    });

    it("keeps denied Codex terminals trace-unexpected before the prompt was dispatched to Codex", async () => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const d1 = new CapturingD1();
      const { instance, fakeState } = await createDOWithSession(workerModule, { DB: d1, LOG_LEVEL: "info" });
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "dispatching",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        codexPromptSentAt: null,
      });

      await instance.completeActivePrompt(
        "test-session-1",
        {
          success: false,
          error: "Codex app-server is closed",
          errorCode: "codex_transport_closed",
        },
        "prompt-1",
        "execution_complete",
      );
      await drainPersistence(instance);
      await fakeState.flushWaitUntil();

      const finalizationLog = consoleLog.mock.calls
        .map(([payload]) => String(payload))
        .filter((entry) => entry.includes('"event":"prompt.trace.finalized"'))
        .at(-1);
      expect(finalizationLog).toBeDefined();
      expect(JSON.parse(finalizationLog!)).toMatchObject({
        event: "prompt.trace.finalized",
        prompt_id: "prompt-1",
        error_code: "codex_transport_closed",
        trace_expected: false,
        telemetry_complete: false,
        bt_span_id_present: false,
      });
    });

    it("rejects an all-zero btSpanId from prompt-start telemetry", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_telemetry_start",
          promptId: "prompt-1",
          btSpanId: "0000000000000000",
        }),
        session,
      );
      await drainPersistence(instance);

      const telemetry = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, "test-session-1");
      expect(telemetry["prompt-1"]).toBeUndefined();
    });

    it("persists btSpanId from prompt-start telemetry", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_telemetry_start",
          promptId: "prompt-1",
          btSpanId: "bt-span-1",
        }),
        session,
      );
      await drainPersistence(instance);

      const telemetry = doDb.getPromptTelemetry(fakeState.storage.sql as unknown as SqlStorage, "test-session-1");
      expect(telemetry["prompt-1"]).toMatchObject({
        btSpanId: "bt-span-1",
      });
      expect(telemetry["prompt-1"].ddTraceId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Text delta buffering
  // -----------------------------------------------------------------------

  describe("text delta buffering", () => {
    it("buffers text events instead of persisting immediately", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "hello ", partId: "p1", messageId: "prompt-1" }),
        session,
      );
      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "world", partId: "p1", messageId: "prompt-1" }),
        session,
      );

      // Both tokens should be in the buffer
      const buffer = instance.textDeltaBuffer as unknown[];
      expect(buffer.length).toBe(2);

      // Storage should still have no events
      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events).toEqual([]);
    });

    it("flushes buffered text deltas after TEXT_DELTA_FLUSH_MS timeout", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "hello", partId: "p1", messageId: "prompt-1" }),
        session,
      );

      // Advance timer past the flush interval
      vi.advanceTimersByTime(60);

      // Drain the persistence queue (flush enqueues a task)
      await drainPersistence(instance);

      // Buffer should be empty now
      expect((instance.textDeltaBuffer as unknown[]).length).toBe(0);

      // Events should be persisted
      const events = querySessionEvents(fakeState.storage, sessionId);
      expect(events.length).toBeGreaterThan(0);
    });

    it("buffers reasoning events alongside text events", async () => {
      const { instance, session } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({ type: "reasoning", content: "thinking...", partId: "r1", messageId: "prompt-1" }),
        session,
      );

      const buffer = instance.textDeltaBuffer as unknown[];
      expect(buffer.length).toBe(1);
      expect((buffer[0] as Record<string, unknown>).type).toBe("reasoning");
    });
  });

  // -----------------------------------------------------------------------
  // 3. Structured events flush the text buffer
  // -----------------------------------------------------------------------

  describe("structured event flush", () => {
    it("flushes buffered text and structured events without a session activity timestamp write", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      const sql = fakeState.storage.sql;
      const originalExec = sql.exec.bind(sql);
      let sessionActivityUpdates = 0;
      sql.exec = ((query: string, ...params: unknown[]) => {
        if (query.includes("UPDATE session SET") && query.includes("updated_at")) {
          sessionActivityUpdates += 1;
        }
        return originalExec(query, ...params);
      }) as typeof sql.exec;

      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "thinking...", partId: "p1", messageId: "prompt-1" }),
        session,
      );
      instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_call",
          tool: "bash",
          callId: "c1",
          args: { command: "ls" },
          messageId: "prompt-1",
        }),
        session,
      );
      await drainPersistence(instance);

      expect(sessionActivityUpdates).toBe(0);
    });

    it("flushes buffered text when a tool_call event arrives", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);

      // Buffer some text
      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "thinking...", partId: "p1", messageId: "prompt-1" }),
        session,
      );
      expect((instance.textDeltaBuffer as unknown[]).length).toBe(1);

      // Send a structured event (tool_call)
      instance.processSandboxMessage(
        mockMessageEvent({
          type: "tool_call",
          tool: "bash",
          callId: "c1",
          args: { command: "ls" },
          messageId: "prompt-1",
        }),
        session,
      );

      // Drain persistence queue
      await drainPersistence(instance);

      // Buffer should be empty (flushed by the structured event)
      expect((instance.textDeltaBuffer as unknown[]).length).toBe(0);

      // Storage should have both text and tool_call events
      const events = querySessionEvents(fakeState.storage, sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("text");
      expect(types).toContain("tool_call");
    });

    it("flushes buffered text when a usage event arrives", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);

      // Buffer some text
      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "output", partId: "p1", messageId: "prompt-1" }),
        session,
      );

      // Send usage event
      instance.processSandboxMessage(
        mockMessageEvent({
          type: "usage",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalCostUsd: 0.001,
          model: "gpt-5.4-mini",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const events = querySessionEvents(fakeState.storage, sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("text");
      expect(types).toContain("usage");
    });

    it("normalizes new-format usage events into /session/usage aggregates", async () => {
      const { instance, session } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "usage",
          inputTokens: 200,
          outputTokens: 50,
          cacheReadTokens: 100,
          cacheWriteTokens: 25,
          totalCostUsd: 0.001,
          model: "gpt-5.4-mini",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const response = await instance.fetch(new Request("https://internal/session/usage"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; usage: Record<string, unknown> | null };
      expect(body.ok).toBe(true);
      expect(body.usage).toMatchObject({
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 25,
        totalTokens: 250,
        totalBilledTokens: 375,
      });
    });

    it("derives normalized usage from legacy cumulative cache fields", async () => {
      const { instance, session } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "usage",
          inputTokens: 300,
          outputTokens: 50,
          cumulativeCacheRead: 100,
          cumulativeCacheWrite: 25,
          totalCostUsd: 0.001,
          model: "gpt-5.4-mini",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const response = await instance.fetch(new Request("https://internal/session/usage"));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; usage: Record<string, unknown> | null };
      expect(body.ok).toBe(true);
      expect(body.usage).toMatchObject({
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheWriteTokens: 25,
        totalTokens: 250,
        totalBilledTokens: 375,
      });
    });

    it("flushes buffered text before persisting a question event", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);

      // Buffer a token
      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "here is my answer: ", partId: "p1", messageId: "prompt-1" }),
        session,
      );
      expect((instance.textDeltaBuffer as unknown[]).length).toBe(1);

      // Send question event (critical path -- awaited)
      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "question",
          ackId: "prompt-1:question:2",
          questionId: "q-2",
          question: "Which approach?",
          messageId: "prompt-1",
        }),
        session,
      );

      // Buffer must be empty: question handler flushed it
      expect((instance.textDeltaBuffer as unknown[]).length).toBe(0);

      const events = querySessionEvents(fakeState.storage, sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("text");
      expect(types).toContain("question");
    });

    it("text event precedes question event in storage sequence when question arrives within buffer window", async () => {
      const { instance, fakeState, session, sessionId } = await createDOWithSession(workerModule);

      // Buffer a token (text delta)
      instance.processSandboxMessage(
        mockMessageEvent({ type: "token", content: "thinking...", partId: "p1", messageId: "prompt-1" }),
        session,
      );

      // Question arrives before the 50ms timer fires -- must flush text first
      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "question",
          ackId: "prompt-1:question:3",
          questionId: "q-3",
          question: "Continue?",
          messageId: "prompt-1",
        }),
        session,
      );

      const events = querySessionEvents(fakeState.storage, sessionId);
      const textIdx = events.findIndex((e) => e.type === "text");
      const questionIdx = events.findIndex((e) => e.type === "question");

      expect(textIdx).toBeGreaterThanOrEqual(0);
      expect(questionIdx).toBeGreaterThan(textIdx);
    });
  });

  // -----------------------------------------------------------------------
  // 4. enqueuePersistence serialization and error handling
  // -----------------------------------------------------------------------

  describe("enqueuePersistence", () => {
    it("runs tasks in order", async () => {
      const { instance } = await createDOWithSession(workerModule);
      const order: number[] = [];

      instance.enqueuePersistence(async () => {
        order.push(1);
      });
      instance.enqueuePersistence(async () => {
        order.push(2);
      });
      instance.enqueuePersistence(async () => {
        order.push(3);
      });

      await drainPersistence(instance);
      expect(order).toEqual([1, 2, 3]);
    });

    it("continues processing after a task throws", async () => {
      const { instance } = await createDOWithSession(workerModule);
      const order: number[] = [];

      instance.enqueuePersistence(async () => {
        order.push(1);
      });
      instance.enqueuePersistence(async () => {
        throw new Error("boom");
      });
      instance.enqueuePersistence(async () => {
        order.push(3);
      });

      await drainPersistence(instance);
      expect(order).toEqual([1, 3]);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Native sandbox events use the durable path when critical
  // -----------------------------------------------------------------------

  describe("native sandbox events", () => {
    it("waits to fan out push_complete until after persistence", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "push_complete",
          branchName: "feature/test",
          messageId: "prompt-1",
        }),
        session,
      );

      expect(mockSocket.send).not.toHaveBeenCalled();

      await drainPersistence(instance);
      // ARC-876: push_complete no longer sets last_push_succeeded; outcome is
      // now bundled on the post_execution event itself. The durability
      // ordering invariant here (broadcast after persist) still holds via the
      // event broadcast check below.
      expect(mockSocket.send).toHaveBeenCalledTimes(1);
      const broadcasted = JSON.parse(mockSocket.send.mock.calls[0][0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(getRawSessionEventKind(broadcasted.event as RawSessionEvent)).toBe("push_complete");
    });

    it("invalidates the current snapshot when push_complete changes the workspace branch", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      fakeState.storage.sql.exec(
        "UPDATE session SET base_branch = ?, last_branch = ? WHERE session_id = ?",
        "main",
        "feature/old",
        session.sessionId,
      );
      fakeState.storage.sql.exec(
        "UPDATE sandbox_state SET snapshot_image_id = ?, snapshot_branch = ? WHERE session_id = ?",
        "img-session-1",
        "feature/old",
        session.sessionId,
      );

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "push_complete",
          branchName: "feature/new",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const sandbox = querySandboxState(fakeState.storage, session.sessionId);
      expect(sandbox?.snapshot_image_id).toBeNull();
      expect(String(sandbox?.last_snapshot_error)).toContain("workspace branch changed");
      expect(String(sandbox?.last_snapshot_error)).toContain("feature/new");
    });

    it("does not persist a forged unsafe branch name from push_complete", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      fakeState.storage.sql.exec(
        "UPDATE session SET base_branch = ?, last_branch = ? WHERE session_id = ?",
        "main",
        "feature/old",
        session.sessionId,
      );
      fakeState.storage.sql.exec(
        "UPDATE sandbox_state SET snapshot_image_id = ?, snapshot_branch = ? WHERE session_id = ?",
        "img-session-1",
        "feature/old",
        session.sessionId,
      );

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "push_complete",
          branchName: "--upload-pack=touch /tmp/pwned",
          commitSha: "deadbeef",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const rows = fakeState.storage.sql
        .exec("SELECT last_branch, last_commit_sha FROM session WHERE session_id = ?", session.sessionId)
        .toArray() as Array<{ last_branch: string | null; last_commit_sha: string | null }>;
      expect(rows[0]?.last_branch).toBe("feature/old");
      expect(rows[0]?.last_commit_sha).toBeNull();
      // Snapshot must not be invalidated off a rejected branch name.
      const sandbox = querySandboxState(fakeState.storage, session.sessionId);
      expect(sandbox?.snapshot_image_id).toBe("img-session-1");
    });

    it("still persists a valid branch name from push_complete", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "push_complete",
          branchName: "feature/safe-branch",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const rows = fakeState.storage.sql
        .exec("SELECT last_branch FROM session WHERE session_id = ?", session.sessionId)
        .toArray() as Array<{ last_branch: string | null }>;
      expect(rows[0]?.last_branch).toBe("feature/safe-branch");
    });

    it("broadcasts prompt_updated with stripped attachment content for post_execution", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({
          uploadedFiles: [{ name: "spec.txt", content: "top-secret" }],
          uploadedImages: [{ name: "diagram.png", mediaType: "image/png", data: "base64-image" }],
        }),
      ]);

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "post_execution",
          hasChanges: false,
          noChangeReason: "no_diff",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const storedPrompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
      expect(storedPrompts?.[0].uploadedFiles).toEqual([{ name: "spec.txt", content: "top-secret" }]);
      expect(storedPrompts?.[0].uploadedImages).toEqual([
        { name: "diagram.png", mediaType: "image/png", data: "base64-image" },
      ]);

      const promptUpdated = mockSocket.send.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { type: string; prompt?: Record<string, unknown> })
        .find((message) => message.type === "prompt_updated");
      expect(promptUpdated).toBeDefined();
      expect(promptUpdated?.prompt?.uploadedFiles).toEqual([{ name: "spec.txt" }]);
      expect(promptUpdated?.prompt?.uploadedImages).toEqual([{ name: "diagram.png", mediaType: "image/png" }]);
    });

    it("treats branchless post_execution with hasChanges=true as a changed result", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [makeStoredPrompt()]);

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "post_execution",
          hasChanges: true,
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);

      const storedPrompts = await fakeState.storage.get<Array<Record<string, unknown>>>("prompts");
      expect(storedPrompts?.[0].result).toEqual({ diffSummary: "Changes detected" });

      const promptUpdated = mockSocket.send.mock.calls
        .map(([payload]) => JSON.parse(payload as string) as { type: string; prompt?: Record<string, unknown> })
        .find((message) => message.type === "prompt_updated");
      expect(promptUpdated?.prompt?.result).toEqual({ diffSummary: "Changes detected" });
    });

    it("keeps post-execution LLM capabilities alive until pending PR polish finishes", async () => {
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put("prompts", [makeStoredPrompt()]);
      const sql = fakeState.storage.sql as unknown as SqlStorage;
      const now = Date.now();

      doDb.insertPlatformLlmCapability(sql, {
        idHash: await computeSha256Hex("pr-template-token"),
        sessionId: session.sessionId as string,
        sandboxId: "sbx-1",
        promptId: "prompt-1",
        callType: "pr_template_fill",
        phase: "post_execution",
        expiresAt: now + 60_000,
        createdAt: now,
      });
      doDb.upsertPlatformLlmPromptStatus(sql, {
        promptId: "prompt-1",
        sessionId: session.sessionId as string,
        status: "post_execution_pending",
        updatedAt: now,
      });

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "post_execution",
          messageId: "prompt-1",
          hasChanges: true,
          branch: "cycloid/test",
          diffSummary: "src/app.ts | 1 +",
        }),
        session,
      );
      await drainPersistence(instance);

      expect(doDb.getPlatformLlmPromptStatus(sql, "prompt-1")).toMatchObject({
        status: "terminal",
      });
      const afterPostExecutionTerminal = sql
        .exec("SELECT call_type, used_at FROM platform_llm_capabilities WHERE prompt_id = ?", "prompt-1")
        .toArray();
      expect(afterPostExecutionTerminal.every((row) => typeof row.used_at === "number")).toBe(true);
    });

    it("projects completed rich status after post-execution clears the pending prompt", async () => {
      const db = new CapturingD1();
      const { instance, fakeState, session } = await createDOWithSession(workerModule, { DB: db });
      await fakeState.storage.put("prompts", [makeStoredPrompt()]);
      const sql = fakeState.storage.sql as unknown as SqlStorage;
      const now = Date.now();

      doDb.upsertPlatformLlmPromptStatus(sql, {
        promptId: "prompt-1",
        sessionId: session.sessionId as string,
        status: "post_execution_pending",
        updatedAt: now,
      });

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "post_execution",
          messageId: "prompt-1",
          hasChanges: false,
          noChangeReason: "no_diff",
        }),
        session,
      );
      await drainPersistence(instance);

      expect(doDb.getPlatformLlmPromptStatus(sql, "prompt-1")).toMatchObject({
        status: "terminal",
      });
      expect(
        db.runs.some(
          (run) =>
            run.query.includes("UPDATE session_index") &&
            run.query.includes("rich_status") &&
            run.values.includes("completed"),
        ),
      ).toBe(true);
    });

    it("push_error goes through the durable translated path without a raw sandbox_event", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);
      doDb.updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, session.sessionId, {
        lastPushSucceeded: true,
      });

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "push_error",
          error: "permission denied",
          messageId: "prompt-1",
        }),
        session,
      );

      await drainPersistence(instance);
      expect(
        doDb.getSandboxState(fakeState.storage.sql as unknown as SqlStorage, session.sessionId)?.stopReason,
      ).toBeNull();
      const sessionEventCall = mockSocket.send.mock.calls.find((call) => {
        const payload = JSON.parse(call[0] as string);
        return payload.type === "session_event";
      });
      expect(sessionEventCall).toBeDefined();
      const broadcasted = JSON.parse(sessionEventCall![0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(getRawSessionEventKind(broadcasted.event as RawSessionEvent)).toBe("push_error");
      expect(getRawSessionEventData(broadcasted.event as RawSessionEvent)?.error).toBe("permission denied");
    });

    it("ACKs push_error after the translated durable event is committed", async () => {
      const { instance, mockSocket, sandboxSocket, session } = await createDOWithSession(workerModule);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "push_error",
          ackId: "prompt-1:push_error:1:error-hash",
          error: "permission denied",
          messageId: "prompt-1",
        }),
        session,
      );

      const sessionEventCall = mockSocket.send.mock.calls.find((call) => {
        const payload = JSON.parse(call[0] as string);
        return payload.type === "session_event";
      });
      expect(sessionEventCall).toBeDefined();
      const broadcasted = JSON.parse(sessionEventCall![0] as string);
      expect(broadcasted.type).toBe("session_event");
      expect(getRawSessionEventKind(broadcasted.event as RawSessionEvent)).toBe("push_error");

      expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sandboxSocket.send.mock.calls[0][0] as string)).toEqual({
        type: "ack",
        ackId: "prompt-1:push_error:1:error-hash",
      });
    });
  });

  // -----------------------------------------------------------------------
  // 6. Stale prompt alarm is fire-and-forget
  // -----------------------------------------------------------------------

  describe("stale prompt alarm", () => {
    it("tracks sandbox liveness separately from prompt running activity", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
        lastHeartbeatAt: Date.now() - 60_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        startupAttemptId: "start-1",
        lastRunningActivityAt: Date.now() - 60_000,
      });

      await instance.processSandboxMessage(
        mockMessageEvent({ type: "heartbeat", sandboxId: "sbx-1", status: "running", timestamp: Date.now() }),
        session,
      );

      expect(await fakeState.storage.get(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY)).toMatchObject({
        lastHeartbeatAt: Date.now(),
      });
      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY)).toMatchObject({
        lastRunningActivityAt: Date.now() - 60_000,
      });
      expect(await fakeState.storage.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY)).toBe(
        Date.now() + SANDBOX_HEARTBEAT_LIVENESS_MS,
      );

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "token",
          content: "x",
          partId: "p1",
          messageId: "prompt-1",
          sandboxId: "sbx-1",
          startupAttemptId: "start-1",
        }),
        session,
      );

      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY)).toMatchObject({
        lastRunningActivityAt: Date.now(),
      });
      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY)).toBe(
        Date.now() + STALE_PROMPT_TIMEOUT_MS,
      );
    });

    it("ignores legacy watchdog deadlines when choosing the next lifecycle alarm", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState } = await createDOWithSession(workerModule);

      await fakeState.storage.put({
        agent_inactivity_deadline: Date.now() - 1_000,
        sandbox_dead_deadline: Date.now() - 1_000,
        llm_response_waiting_deadline: Date.now() - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() + 120_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + 120_000);
    });

    it("reschedules the soonest future deadline when all candidates are in the future", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() + 120_000);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, Date.now() + 240_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + 120_000);
    });

    it("clears orphaned lifecycle deadlines before rearming the session alarm", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState } = await createDOWithSession(workerModule);
      await fakeState.storage.put("activePromptId", null);
      await fakeState.storage.setAlarm(Date.now() + 10_000);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "terminal",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "stopped",
        sandboxId: "sbx-1",
        spawnInProgress: false,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() - 5_000);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, Date.now() - 5_000);
      await fakeState.storage.put(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, Date.now() - 5_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBeNull();
      await expect(
        fakeState.storage.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY),
      ).resolves.toBeUndefined();
      await expect(fakeState.storage.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
      await expect(fakeState.storage.get(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY)).resolves.toBeUndefined();
    });

    it("deletes the alarm and logs source diagnostics when only past deadlines remain", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState } = await createDOWithSession(workerModule, { LOG_LEVEL: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await fakeState.storage.put("activePromptId", null);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "spawning",
        sandboxId: "sbx-1",
        spawnInProgress: true,
      });
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, "test-session-1", {
        status: "spawning",
      });
      await fakeState.storage.setAlarm(Date.now() + 10_000);
      await fakeState.storage.put(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, Date.now() - 5_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBeNull();
      const diagnostic = warnSpy.mock.calls
        .map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>)
        .find((entry) => entry.event === "alarm_circuit_breaker");
      expect(diagnostic).toMatchObject({
        sessionId: "test-session-1",
        deadlineSource: "spawnTimeout",
        deadlineAt: Date.now() - 5_000,
        nowAt: Date.now(),
        deltaMs: 5_000,
      });
      warnSpy.mockRestore();
    });

    it("prunes invalid past lifecycle deadlines without emitting the past-deadline diagnostic", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState } = await createDOWithSession(workerModule, { LOG_LEVEL: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await fakeState.storage.put("activePromptId", null);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "terminal",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() - 5_000);

      await instance.rescheduleSessionAlarm();

      await expect(
        fakeState.storage.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY),
      ).resolves.toBeUndefined();
      expect(
        warnSpy.mock.calls
          .map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>)
          .some((entry) => entry.event === "alarm_circuit_breaker"),
      ).toBe(false);
      warnSpy.mockRestore();
    });

    it("logs stale past lifecycle deadlines when a future candidate still exists", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule, { LOG_LEVEL: "warn" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await fakeState.storage.put("activePromptId", null);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "spawning",
        sandboxId: "sbx-1",
        spawnInProgress: true,
      });
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, sessionId, {
        status: "spawning",
        autoCloseScheduledAt: Date.now(),
      });
      await fakeState.storage.put(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, Date.now() - 5_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + getAutoCloseGraceMs({}));
      expect(
        warnSpy.mock.calls
          .map(([payload]) => JSON.parse(String(payload)) as Record<string, unknown>)
          .some((entry) => entry.event === "alarm_circuit_breaker" && entry.deadlineSource === "spawnTimeout"),
      ).toBe(true);
      warnSpy.mockRestore();
    });

    it("rearms immediately for overdue sandbox liveness even when a future prompt deadline exists", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
      });
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, sessionId, {
        status: "ready",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, Date.now() - 5_000);
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() + 120_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + MIN_ALARM_DELAY_MS);
    });

    it("rearms immediately for an overdue reconnect deadline from the last bridge heartbeat", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "reconnecting",
        sandboxId: "sbx-1",
        lastHeartbeatAt: Date.now() - 120_000,
      });
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, sessionId, {
        status: "reconnecting",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, Date.now() - 60_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + MIN_ALARM_DELAY_MS);
    });

    it("rearms immediately for overdue disconnect catch-up work even without future candidates", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, sessionId, {
        disconnectStartedAt: Date.now() - SANDBOX_RECONNECT_GRACE_MS - 5_000,
      });

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + MIN_ALARM_DELAY_MS);
    });

    it("rearms immediately for overdue catch-up work even when a future candidate exists", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, sessionId, {
        disconnectStartedAt: Date.now() - SANDBOX_RECONNECT_GRACE_MS - 5_000,
      });
      await fakeState.storage.put(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, Date.now() + 120_000);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + MIN_ALARM_DELAY_MS);
    });

    it("floors near-future alarm deadlines to the minimum delay", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const { instance, fakeState } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() + 100);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(Date.now() + MIN_ALARM_DELAY_MS);
    });

    // PR 49 (DE-3): the precise FSM state-deadline alarm arm. `fsmStateDeadline` is reprojected
    // directly from `pr_coordination.deadline_at` for a review-listening session; only a FUTURE
    // deadline in REVIEW/VERIFYING is armed (a past-due one is left to the opportunistic
    // `shadowFireDueDeadline` fire, so it can never tight-loop as an immediate catch-up).
    function fsmRowDb(row: { state: string; deadlineAt: number }) {
      return {
        prepare(query: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (!query.includes("FROM pr_coordination")) return null;
              return {
                session_id: "test-session-1",
                version: 7,
                state: row.state,
                pr_url: "https://github.com/acme/repo/pull/42",
                head_sha: "h1",
                verdict: null,
                verdict_head_sha: null,
                verification_run_head: null,
                verification_run_id: 0,
                verification_child_id: null,
                verification_run_count: 0,
                ci_fix_rounds: 0,
                in_flight_epoch_id: null,
                code_changed_since_verification: 0,
                prompt_intends_change: null,
                merge_ready_reopen_count: 0,
                blocked_reason: null,
                failure_reason: null,
                stop_mode: null,
                pre_stop_state: null,
                update_branch_queued_at: null,
                deadline_at: row.deadlineAt,
                state_entered_at: Date.now() - 1_000,
              };
            },
          };
        },
      };
    }

    it("projects a committed REVIEW/VERIFYING FSM deadline into the shared DO alarm", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const fsmDeadline = Date.now() + 90_000;
      const { instance, fakeState } = await createDOWithSession(workerModule, {
        DB: fsmRowDb({ state: "REVIEW", deadlineAt: fsmDeadline }),
        FSM_MODE: "live",
      });
      doDb.updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, "test-session-1", {
        reviewListeningActive: true,
      });
      await fakeState.storage.put("activePromptId", null);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBe(fsmDeadline);
    });

    it("does NOT project a PAST-DUE FSM state deadline (no immediate catch-up tight loop)", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const pastDeadline = Date.now() - 90_000;
      const { instance, fakeState } = await createDOWithSession(workerModule, {
        DB: fsmRowDb({ state: "REVIEW", deadlineAt: pastDeadline }),
        FSM_MODE: "live",
      });
      doDb.updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, "test-session-1", {
        reviewListeningActive: true,
      });
      await fakeState.storage.put("activePromptId", null);

      await instance.rescheduleSessionAlarm();

      // No future candidate => the alarm is cleared, NOT rescheduled to a near-now catch-up tick.
      expect(await fakeState.storage.getAlarm()).toBeNull();
    });

    it("does NOT project an FSM deadline for a terminal (non-REVIEW/VERIFYING) state", async () => {
      vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
      const fsmDeadline = Date.now() + 90_000;
      const { instance, fakeState } = await createDOWithSession(workerModule, {
        DB: fsmRowDb({ state: "NEEDS_YOU", deadlineAt: fsmDeadline }),
        FSM_MODE: "live",
      });
      doDb.updateSessionFields(fakeState.storage.sql as unknown as SqlStorage, "test-session-1", {
        reviewListeningActive: true,
      });
      await fakeState.storage.put("activePromptId", null);

      await instance.rescheduleSessionAlarm();

      expect(await fakeState.storage.getAlarm()).toBeNull();
    });

    for (const testCase of [
      {
        name: "sandbox reconnect grace",
        key: LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
        setup: async (fakeState: Awaited<ReturnType<typeof createDOWithSession>>["fakeState"]) => {
          await fakeState.storage.put("activePromptId", null);
          await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
            state: "reconnecting",
            sandboxId: "sbx-1",
          });
        },
      },
      {
        name: "sandbox liveness",
        key: LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
        setup: async (fakeState: Awaited<ReturnType<typeof createDOWithSession>>["fakeState"]) => {
          await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
            state: "ready",
            sandboxId: "sbx-1",
          });
          await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
            phase: "running",
            promptId: "prompt-1",
            sandboxId: "sbx-1",
          });
        },
      },
      {
        name: "prompt startup",
        key: LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY,
        setup: async (fakeState: Awaited<ReturnType<typeof createDOWithSession>>["fakeState"]) => {
          await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
            phase: "dispatching",
            promptId: "prompt-1",
            sandboxId: "sbx-1",
          });
        },
      },
      {
        name: "prompt running inactivity",
        key: LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY,
        setup: async (fakeState: Awaited<ReturnType<typeof createDOWithSession>>["fakeState"]) => {
          await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
            phase: "running",
            promptId: "prompt-1",
            sandboxId: "sbx-1",
          });
        },
      },
      {
        name: "spawn timeout",
        key: LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY,
        setup: async (fakeState: Awaited<ReturnType<typeof createDOWithSession>>["fakeState"]) => {
          await fakeState.storage.put("activePromptId", null);
          await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
            state: "spawning",
            startupAttemptId: "start-1",
          });
        },
      },
    ] as const) {
      it(`clears the ${testCase.name} lifecycle deadline after alarm dispatch`, async () => {
        vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
        const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
        await testCase.setup(fakeState);
        if (testCase.name === "sandbox liveness") {
          await armConfirmedRuntimeLoss(instance, fakeState, sessionId);
        }
        await fakeState.storage.put(testCase.key, Date.now() - 1);

        await instance.alarm();

        await expect(fakeState.storage.get(testCase.key)).resolves.toBeUndefined();
      });
    }
    it("rearms lifecycle spawn timeout after cold-start classification", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      doDb.updateSandboxState(fakeState.storage.sql as unknown as SqlStorage, sessionId, {
        status: "spawning",
        spawnStartedAt: Date.now(),
      });
      await fakeState.storage.put("spawn_cold_start", true);
      await fakeState.storage.put(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY, Date.now() + 180_000);

      await instance.scheduleSpawnConnectAlarm();

      const expectedDeadline = Date.now() + SPAWN_CONNECT_TIMEOUT_COLD_MS;
      expect(await fakeState.storage.get(LIFECYCLE_SPAWN_TIMEOUT_DEADLINE_STORAGE_KEY)).toBe(expectedDeadline);
      expect(await fakeState.storage.getAlarm()).toBe(expectedDeadline);
    });

    it("does not let Codex wait pulses clear the lifecycle startup deadline", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, session } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "dispatching",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        startupAttemptId: "start-1",
        bridgeAcceptedAt: Date.now() - 1_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY, Date.now() + 120_000);

      await instance.processSandboxMessage(
        mockMessageEvent({
          type: "prompt_activity",
          promptId: "prompt-1",
          phase: "waiting_for_agent_event",
          startupAttemptId: "start-1",
          sandboxId: "sbx-1",
          timestamp: Date.now(),
        }),
        session,
      );

      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY)).toMatchObject({
        phase: "dispatching",
        bridgeAcceptedAt: Date.now() - 1_000,
      });
      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY)).toBe(Date.now() + 120_000);
      expect(await fakeState.storage.get(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY)).toBeUndefined();
      expect(await fakeState.storage.get("agent_inactivity_deadline")).toBeUndefined();
      expect(await fakeState.storage.get("sandbox_dead_deadline")).toBeUndefined();
    });

    it("dispatches lifecycle startup alarms to typed Codex failures", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "dispatching",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        bridgeAcceptedAt: Date.now() - 181_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_STARTUP_DEADLINE_STORAGE_KEY, Date.now() - 1);

      await instance.alarm();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts[0]).toMatchObject({
        status: "failed",
        error: "Prompt could not be delivered to the agent runtime",
      });
      const failedEvent = querySessionEvents(fakeState.storage, sessionId).find(
        (event) => event.type === "prompt_failed",
      );
      expect(failedEvent?.data).toMatchObject({
        promptId: "prompt-1",
        errorCode: "codex_prompt_dispatch_timeout",
      });
    });

    it("dispatches lifecycle sandbox liveness alarms to typed sandbox failures", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
        state: "ready",
        sandboxId: "sbx-1",
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_PHASE_STORAGE_KEY, {
        phase: "running",
        promptId: "prompt-1",
        sandboxId: "sbx-1",
        startupAttemptId: "start-1",
        lastRunningActivityAt: Date.now() - 60_000,
      });
      await fakeState.storage.put(LIFECYCLE_PROMPT_RUNNING_INACTIVITY_DEADLINE_STORAGE_KEY, Date.now() + 120_000);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, Date.now() - 1);
      // Pin at the disconnect-retry cap so liveness expiry terminalizes here (the
      // typed-dispatch behavior under test). Under-cap liveness now re-runs on a
      // fresh sandbox; that recovery path is covered in auto-close-on-disconnect.
      fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");
      await armConfirmedRuntimeLoss(instance, fakeState, sessionId);

      await instance.alarm();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts[0]).toMatchObject({
        status: "failed",
        error: "Sandbox kept disconnecting after 3 attempts",
      });
      expect(await fakeState.storage.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY)).toBeUndefined();
      const failedEvent = querySessionEvents(fakeState.storage, sessionId).find(
        (event) => event.type === "prompt_failed",
      );
      expect(failedEvent?.data).toMatchObject({
        promptId: "prompt-1",
        errorCode: "sandbox_disconnected_exhausted",
      });
    });

    it("honors the lifecycle spawn circuit before launching a sandbox", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      instance.spawnSandbox = vi.fn(async () => undefined);
      await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, { state: "failed" });
      await fakeState.storage.put(LIFECYCLE_SPAWN_FAILURE_COUNT_STORAGE_KEY, 3);
      await fakeState.storage.put(LIFECYCLE_SPAWN_LAST_FAILURE_AT_STORAGE_KEY, Date.now());

      await instance.startSpawnAttempt(sessionId, "test");

      expect(instance.spawnSandbox).not.toHaveBeenCalled();
      expect(await fakeState.storage.get("spawnAttemptId")).toBeUndefined();
      expect(querySandboxState(fakeState.storage, sessionId)?.status).not.toBe("spawning");
      expect(queryPrompts(fakeState.storage, sessionId)[0]).toMatchObject({
        status: "failed",
        error: "Sandbox failed before connecting",
      });
      const failedEvent = querySessionEvents(fakeState.storage, sessionId).find(
        (event) => event.type === "prompt_failed",
      );
      expect(failedEvent?.data).toMatchObject({
        promptId: "prompt-1",
        errorCode: "spawn_preconnect",
      });
    });

    it("fails prompts that exceed the maximum duration ceiling", async () => {
      const now = new Date("2026-04-13T10:00:00.000Z");
      vi.setSystemTime(now);
      const { instance, fakeState, sessionId } = await createDOWithSession(workerModule);
      const startedAt = new Date(Date.now() - PROMPT_MAX_DURATION_MS - 5_000).toISOString();
      await fakeState.storage.put("prompts", [
        makeStoredPrompt({
          status: "processing",
          startedAt,
          completedAt: null,
          updatedAt: startedAt,
          result: null,
          error: null,
        }),
      ]);
      // The sandbox socket is live (createDOWithSession), so this is a genuine
      // long turn and stays max_duration_exceeded rather than the no-socket
      // sandbox_never_started phantom.

      await instance.alarm();

      const prompts = queryPrompts(fakeState.storage, sessionId);
      expect(prompts[0]).toMatchObject({
        status: "failed",
        error: "Prompt exceeded maximum duration",
      });
      const failedEvent = querySessionEvents(fakeState.storage, sessionId).find(
        (event) => event.type === "prompt_failed",
      );
      expect(failedEvent?.data?.error).toBe("Prompt exceeded maximum duration");
    });
  });

  // -----------------------------------------------------------------------
  // The "cachedActivePromptId" describe block (with a "falls back to bridge
  // messageId when cache is null" test) was removed alongside the cache
  // itself in PR2 (session.active_prompt_id drop). processSandboxMessage now
  // derives the active prompt id via doDb.getActiveProcessingPromptId and
  // falls back to parsed.messageId when no prompt is processing -- same
  // outcome, no cache to test.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // 8. agent_session_created and codex_event
  // -----------------------------------------------------------------------

  describe("non-broadcast events", () => {
    it("does not broadcast agent_session_created", async () => {
      const { instance, fakeState, mockSocket, session } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(
        mockMessageEvent({
          type: "agent_session_created",
          agentSessionId: "opc-123",
          agent: "code",
        }),
        session,
      );

      expect(mockSocket.send).not.toHaveBeenCalled();

      // But it does persist the session ID
      await drainPersistence(instance);
      const opcId = await fakeState.storage.get<string>("agent_session_id");
      expect(opcId).toBe("opc-123");
    });

    it("skips codex_event entirely", async () => {
      const { instance, mockSocket, session } = await createDOWithSession(workerModule);

      instance.processSandboxMessage(mockMessageEvent({ type: "codex_event", data: {} }), session);

      expect(mockSocket.send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // 9. flushTextDeltaBuffer is idempotent
  // -----------------------------------------------------------------------

  describe("flushTextDeltaBuffer", () => {
    it("is safe to call when buffer is empty", async () => {
      const { instance } = await createDOWithSession(workerModule);

      // Should not throw
      await instance.flushTextDeltaBuffer();
      expect((instance.textDeltaBuffer as unknown[]).length).toBe(0);
    });
  });
});
