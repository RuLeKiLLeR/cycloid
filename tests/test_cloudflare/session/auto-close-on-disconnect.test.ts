/**
 * Tests for auto-close on sandbox disconnect.
 *
 * Verifies that:
 * 1. handleSandboxClose schedules an alarm when idle (no active prompt)
 * 2. handleSandboxClose immediately fails the active prompt on disconnect
 * 2b. handleSandboxClose drains queue and spawns new sandbox after failing active prompt
 * 3. Alarm fires and closes idle session with D1 sync
 * 4. Alarm fires but sandbox reconnected -- session stays open
 * 5. Alarm fires but new prompt is active -- session stays open
 * 6. Stale socket close callback (mismatched sandboxId) returns early
 * 7. Sandbox reconnect rejected when session is closed
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  PROMPT_MAX_DURATION_MS,
  SANDBOX_LOSS_RECOVERY_BUDGET_MS,
  SANDBOX_RECONNECT_GRACE_MS,
} from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import { computeSha256Hex } from "../../../apps/control-plane-worker/src/utils.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  queryActiveProcessingPromptId,
  queryPrompts,
  querySandboxState,
  querySession,
  querySessionEvents,
  seedPrompt,
  seedSandboxState,
  seedSession,
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
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  webSocketError(ws: WebSocket, error: unknown): Promise<void>;
  sendPendingPromptToSandbox(sessionId: string): Promise<boolean>;
  startSpawnAttempt(sessionId: string, operation: string): Promise<string>;
  persistenceQueue: Promise<void>;
  cachedSandboxConnectionGen: number | null;
  sandboxWs: unknown | null;
  handledSandboxDisconnectGenerations: Set<number>;
  probeE2BRuntimeLiveness(...args: unknown[]): Promise<"alive" | "dead" | "unknown">;
  crossCheckRuntimeForDiagnosis(...args: unknown[]): Promise<void>;
  alarm(): Promise<void>;
}

const SESSION_ID = "test-session-1";

interface RecordingD1Run {
  query: string;
  boundValues: unknown[];
}

class RecordingD1Statement {
  boundValues: unknown[] = [];

  constructor(
    private readonly db: RecordingD1,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    this.db.runs.push({ query: this.query, boundValues: [...this.boundValues] });
    return { success: true, meta: { last_row_id: 0 } };
  }

  async all(): Promise<{ results: Array<Record<string, unknown>> }> {
    return { results: [] };
  }

  async first(): Promise<Record<string, unknown> | null> {
    return null;
  }
}

class RecordingD1 {
  readonly runs: RecordingD1Run[] = [];

  prepare(query: string): RecordingD1Statement {
    return new RecordingD1Statement(this, query);
  }

  async batch(statements: RecordingD1Statement[]): Promise<unknown[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function splitTopLevelCsv(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(input.slice(start).trim());
  return parts;
}

function placeholderCount(expression: string): number {
  return expression.split("?").length - 1;
}

function boundSessionIndexValue(run: RecordingD1Run, columnName: string): unknown {
  if (columnName === "updated_at") {
    return run.boundValues[5];
  }

  const updateMatch = run.query.match(/UPDATE session_index\s+SET\s+([\s\S]+?)\s+WHERE session_id = \?/);
  if (updateMatch) {
    const assignments = splitTopLevelCsv(updateMatch[1]);
    const columnIndex = assignments.findIndex((assignment) => assignment.startsWith(`${columnName} = `));
    if (columnIndex === -1) {
      throw new Error(`Expected session_index UPDATE to include ${columnName}`);
    }

    const targetExpression = assignments[columnIndex].slice(assignments[columnIndex].indexOf("=") + 1).trim();
    if (placeholderCount(targetExpression) !== 1) {
      throw new Error(`Expected session_index.${columnName} update to bind exactly one value`);
    }

    const bindIndex = assignments
      .slice(0, columnIndex)
      .reduce((total, assignment) => total + placeholderCount(assignment.slice(assignment.indexOf("=") + 1).trim()), 0);
    if (bindIndex >= run.boundValues.length) {
      throw new Error(`Expected a bound value for session_index.${columnName}`);
    }

    return run.boundValues[bindIndex];
  }

  const insertMatch = run.query.match(
    /INSERT INTO session_index \(([\s\S]+?)\)\s+VALUES\s+\(([\s\S]+?)\)\s+ON CONFLICT/,
  );
  if (!insertMatch) {
    throw new Error("Expected a session_index INSERT with explicit columns and values");
  }

  const columns = splitTopLevelCsv(insertMatch[1]);
  const values = splitTopLevelCsv(insertMatch[2]);
  if (columns.length !== values.length) {
    throw new Error("Expected session_index INSERT columns and values to match");
  }

  const columnIndex = columns.indexOf(columnName);
  if (columnIndex === -1) {
    throw new Error(`Expected session_index INSERT to include ${columnName}`);
  }

  const targetExpression = values[columnIndex];
  if (placeholderCount(targetExpression) !== 1) {
    throw new Error(`Expected session_index.${columnName} to bind exactly one value`);
  }

  const bindIndex = values.slice(0, columnIndex).reduce((total, expression) => total + placeholderCount(expression), 0);
  if (bindIndex >= run.boundValues.length) {
    throw new Error(`Expected a bound value for session_index.${columnName}`);
  }

  return run.boundValues[bindIndex];
}

function connectSandbox(
  fakeState: ReturnType<typeof createFakeState>,
  instance: DOTestHandle,
  generation = 1,
  sandboxId = "sandbox-1",
) {
  const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
  fakeState.acceptWebSocket(sandboxSocket, ["sandbox", `sid:${sandboxId}`, `gen:${generation}`]);
  fakeState.storage.sql.exec("UPDATE sandbox_state SET sandbox_id = ? WHERE session_id = ?", sandboxId, SESSION_ID);
  instance.cachedSandboxConnectionGen = generation;
  instance.sandboxWs = sandboxSocket;
  return sandboxSocket;
}

async function createIdleDO(workerModule: WorkerModule) {
  const env = createTestEnv();
  const fakeState = createFakeState();

  // DO constructor runs initSchema via blockConcurrencyWhile
  const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

  // Seed SQL state AFTER construction (tables now exist)
  seedSession(fakeState.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
  });
  seedSandboxState(fakeState.storage, { sessionId: SESSION_ID });

  await fakeState.storage.put("events", []);
  await fakeState.storage.put("replay", {
    sessionId: SESSION_ID,
    lastEventSequence: 0,
    lastEventTimestamp: null,
    updatedAt: null,
  });

  const mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  fakeState.acceptWebSocket(mockSocket, ["client", "wsid:test-client"]);

  const session = { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" };
  return { instance, fakeState, mockSocket, session, env };
}

async function createActiveDO(workerModule: WorkerModule, envOverrides: Record<string, unknown> = {}) {
  const env = { ...createTestEnv(), ...envOverrides };
  const fakeState = createFakeState();

  const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

  seedSession(fakeState.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    status: "active",
    activePromptId: "prompt-1",
    promptCounter: 1,
  });
  seedSandboxState(fakeState.storage, { sessionId: SESSION_ID });
  seedPrompt(fakeState.storage, {
    promptId: "prompt-1",
    sessionId: SESSION_ID,
    promptText: "test",
    actorUserId: "user-1",
    agent: "code",
    status: "processing",
    startedAt: Date.now(),
  });

  await fakeState.storage.put("events", []);
  await fakeState.storage.put("replay", {
    sessionId: SESSION_ID,
    lastEventSequence: 0,
    lastEventTimestamp: null,
    updatedAt: null,
  });

  const mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  fakeState.acceptWebSocket(mockSocket, ["client", "wsid:test-client"]);

  const session = { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" };
  return { instance, fakeState, mockSocket, session, env };
}

async function armConfirmedRuntimeLoss(
  instance: DOTestHandle,
  fakeState: Awaited<ReturnType<typeof createActiveDO>>["fakeState"],
  lastHeartbeatAt = Date.now() - SANDBOX_LOSS_RECOVERY_BUDGET_MS - 1,
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
    SESSION_ID,
  );
  const lifecycleSandbox =
    (await fakeState.storage.get<Record<string, unknown>>(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY)) ?? {};
  await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
    ...lifecycleSandbox,
    lastHeartbeatAt,
  });
  vi.spyOn(instance, "probeE2BRuntimeLiveness").mockResolvedValue("dead");
  vi.spyOn(instance, "crossCheckRuntimeForDiagnosis").mockResolvedValue();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionDO auto-close on disconnect", () => {
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
  // 1. Sandbox close with no active prompt schedules alarm
  // -----------------------------------------------------------------------

  it("schedules auto-close alarm when sandbox disconnects and session is idle", async () => {
    const { instance, fakeState } = await createIdleDO(workerModule);

    const sandboxSocket = connectSandbox(fakeState, instance);
    await instance.webSocketClose(sandboxSocket, 1000, "closed", true);
    await instance.persistenceQueue;

    // auto_close_scheduled_at should be written in sandbox_state
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.auto_close_scheduled_at).toBeDefined();
    expect(typeof sb?.auto_close_scheduled_at).toBe("number");

    // An alarm should be set ~24 hours from now
    const alarm = await fakeState.storage.getAlarm();
    expect(alarm).toBeDefined();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + ONE_DAY_MS - 1000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + ONE_DAY_MS + 1000);
  });

  it("bypasses reconnect grace and auto-close when the sandbox closes after an intentional idle pause", async () => {
    const { instance, fakeState } = await createIdleDO(workerModule);

    const sandboxSocket = connectSandbox(fakeState, instance);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET status = ?, intentional_pause_reason = ? WHERE session_id = ?",
      "stopped",
      "idle_auto_pause",
      SESSION_ID,
    );

    await instance.webSocketClose(sandboxSocket, 1000, "paused", true);
    await instance.persistenceQueue;

    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("stopped");
    expect(sb?.stop_reason).toBeNull();
    expect(sb?.disconnect_started_at).toBeNull();
    expect(sb?.auto_close_scheduled_at).toBeNull();
    expect(sb?.intentional_pause_reason).toBeNull();
    await expect(fakeState.storage.getAlarm()).resolves.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 2. Sandbox close WITH active prompt enters reconnect grace
  // -----------------------------------------------------------------------

  it("enters reconnect grace on clean sandbox close without failing the active prompt", async () => {
    const { instance, fakeState, mockSocket } = await createActiveDO(workerModule, { LOG_LEVEL: "info" });
    // Set has_pending_question on the prompt and last_push_succeeded on session
    fakeState.storage.sql.exec("UPDATE prompts SET has_pending_question = 1 WHERE prompt_id = ?", "prompt-1");
    fakeState.storage.sql.exec("UPDATE session SET last_push_succeeded = 1 WHERE session_id = ?", SESSION_ID);
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state
          SET prompt_last_activity_at = ?,
              runtime_provider = ?,
              runtime_backend = ?,
              runtime_state = ?
        WHERE session_id = ?`,
      Date.now() - 1234,
      "e2b",
      "e2b_cloud",
      "running",
      SESSION_ID,
    );
    const consoleSpy = vi.spyOn(console, "log");

    const sandboxSocket = connectSandbox(fakeState, instance);
    await instance.webSocketClose(sandboxSocket, 1000, "closed", true);
    await instance.persistenceQueue;

    // No auto-close alarm should be scheduled (prompt was active, not idle)
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.auto_close_scheduled_at).toBeNull();
    expect(sb?.status).toBe("reconnecting");
    expect(sb?.disconnect_started_at).toBeDefined();

    // Prompt should remain processing during reconnect grace.
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    const activePrompt = prompts.find((p) => p.prompt_id === "prompt-1");
    expect(activePrompt?.status).toBe("processing");
    expect(activePrompt?.error).toBeNull();

    // activePromptId and prompt/session state should stay intact until grace expiry.
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("prompt-1");
    expect(activePrompt?.has_pending_question).toBe(1);
    expect(sess?.last_push_succeeded).toBe(1);

    // Client should have received broadcast
    expect(mockSocket.send).toHaveBeenCalled();
    const messages = mockSocket.send.mock.calls.map(
      ([payload]) =>
        JSON.parse(payload as string) as {
          type: string;
          event?: Record<string, unknown>;
          sandboxSubstate?: string;
        },
    );
    expect(
      messages.some((message) => message.type === "session_status" && message.sandboxSubstate === "reconnecting"),
    ).toBe(true);

    const closeLog = consoleSpy.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .find((entry) => entry.event === "sandbox_ws_closed");
    expect(closeLog).toMatchObject({
      sessionId: SESSION_ID,
      code: 1000,
      reason: "closed",
      wasClean: true,
      connectionGeneration: 1,
      currentGeneration: 1,
      sandboxId: "sandbox-1",
      runtimeProvider: "e2b",
      runtimeBackend: "e2b_cloud",
      runtimeState: "running",
      activePromptId: "prompt-1",
      activePromptInFlight: true,
      promptLastActivityAgeMs: 1234,
      closeDecision: "active_prompt_reconnect_grace",
    });
  });

  it("logs rejected sandbox websocket messages with provider context", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule, { LOG_LEVEL: "warn" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state
          SET sandbox_id = ?,
              runtime_provider = ?,
              runtime_backend = ?,
              runtime_state = ?
        WHERE session_id = ?`,
      "sandbox-1",
      "e2b",
      "e2b_cloud",
      "running",
      SESSION_ID,
    );
    const sandboxSocket = connectSandbox(fakeState, instance);
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await instance.webSocketMessage(sandboxSocket, JSON.stringify({ type: "heartbeat" }));

    const rejectLog = consoleSpy.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .find((entry) => entry.event === "sandbox_ws_message_rejected");
    expect(rejectLog).toMatchObject({
      sessionId: SESSION_ID,
      reason: "missing_auth",
      sandboxId: "sandbox-1",
      runtimeProvider: "e2b",
      runtimeBackend: "e2b_cloud",
      runtimeState: "running",
    });
    consoleSpy.mockRestore();
  });

  it("does not attach sandbox connection telemetry to client websocket errors", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule, { LOG_LEVEL: "warn" });
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state
          SET sandbox_id = ?,
              runtime_provider = ?,
              runtime_backend = ?,
              runtime_state = ?
        WHERE session_id = ?`,
      "sandbox-1",
      "e2b",
      "e2b_cloud",
      "running",
      SESSION_ID,
    );
    const clientSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(clientSocket, ["client", "wsid:test-client"]);
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await instance.webSocketError(clientSocket, new Error("client socket failed"));

    const errorLog = consoleSpy.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .find((entry) => entry.msg === "WebSocket error");
    expect(errorLog).toMatchObject({
      sessionId: SESSION_ID,
      kind: "client",
      error: "Error: client socket failed",
    });
    expect(errorLog).not.toHaveProperty("event");
    expect(errorLog).not.toHaveProperty("runtimeProvider");
    expect(errorLog).not.toHaveProperty("runtimeBackend");
    expect(errorLog).not.toHaveProperty("runtimeState");
    consoleSpy.mockRestore();
  });

  it("enters reconnect grace on abnormal sandbox close without failing the active prompt", async () => {
    const { instance, fakeState, mockSocket } = await createActiveDO(workerModule);
    const sandboxSocket = { close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "sid:sandbox-1", "gen:1"]);
    fakeState.storage.sql.exec("UPDATE sandbox_state SET sandbox_id = ? WHERE session_id = ?", "sandbox-1", SESSION_ID);
    instance.cachedSandboxConnectionGen = 1;
    instance.sandboxWs = sandboxSocket;

    await instance.webSocketClose(sandboxSocket, 1006, "abnormal", false);

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")?.status).toBe("processing");
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("prompt-1");
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("reconnecting");

    expect(sb?.disconnect_started_at).toBeDefined();

    const alarm = await fakeState.storage.getAlarm();
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + SANDBOX_RECONNECT_GRACE_MS - 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + SANDBOX_RECONNECT_GRACE_MS + 1_000);

    const messages = mockSocket.send.mock.calls.map(
      ([payload]) =>
        JSON.parse(payload as string) as {
          type: string;
          event?: Record<string, unknown>;
          sandboxSubstate?: string;
        },
    );
    expect(
      messages.some((message) => message.type === "session_status" && message.sandboxSubstate === "reconnecting"),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.type === "sandbox_event" &&
          message.event?.type === "heartbeat" &&
          message.event?.status === "reconnecting",
      ),
    ).toBe(true);
  });

  it("lifecycle terminalizes reconnect expiry at the retry cap with sandbox_disconnected_exhausted", async () => {
    const db = new RecordingD1();
    const { instance, fakeState } = await createActiveDO(workerModule, { DB: db });
    const sandboxSocket = connectSandbox(fakeState, instance);
    fakeState.storage.sql.exec(
      `UPDATE sandbox_state
          SET runtime_provider = ?,
              runtime_backend = ?,
              runtime_state = ?,
              runtime_sandbox_id = ?,
              runtime_template_id = ?,
              runtime_live_lease_expires_at = ?
        WHERE session_id = ?`,
      "e2b",
      "e2b_cloud",
      "running",
      "e2b-running-1",
      "cycloid-sandbox-test",
      Date.now() + 60_000,
      SESSION_ID,
    );
    // Pin the active prompt at the disconnect-retry cap so grace expiry
    // terminalizes (the lifecycle behavior under test here). Under-cap
    // recovery (re-run on a fresh sandbox) is covered separately below.
    fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");

    await armConfirmedRuntimeLoss(instance, fakeState, Date.now());

    await instance.webSocketClose(sandboxSocket, 1006, "abnormal", false);

    const deadline = await fakeState.storage.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY);
    expect(deadline).toBeGreaterThanOrEqual(Date.now() + SANDBOX_RECONNECT_GRACE_MS - 1_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + SANDBOX_RECONNECT_GRACE_MS + 1_000);

    vi.setSystemTime(Date.now() + SANDBOX_RECONNECT_GRACE_MS + 1);
    await instance.alarm();
    await fakeState.flushWaitUntil();

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    const failedPrompt = prompts.find((prompt) => prompt.prompt_id === "prompt-1");
    expect(failedPrompt).toMatchObject({
      status: "failed",
      error: "Sandbox kept disconnecting after 3 attempts",
    });
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBeNull();
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("stopped");
    expect(sb?.stop_reason).toBe("reaped");
    expect(sb?.disconnect_started_at).toBeNull();
    expect(sb?.runtime_state).toBe("killed");
    expect(sb?.runtime_live_lease_expires_at).toBeNull();

    const failedEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "prompt_failed",
    );
    expect(failedEvent?.data).toMatchObject({
      promptId: "prompt-1",
      errorCode: "sandbox_disconnected_exhausted",
    });

    const richStatusWrites = db.runs.filter((run) => run.query.includes("UPDATE session_index SET rich_status"));
    const richStatusWrite = richStatusWrites[richStatusWrites.length - 1];
    if (!richStatusWrite) {
      throw new Error("Expected a session_index rich_status write");
    }
    expect(richStatusWrite.boundValues[0]).toBe("stopped");

    const runtimeProjectionWrite = db.runs.find(
      (run) => run.query.includes("UPDATE session_index") && run.query.includes("runtime_provider"),
    );
    if (!runtimeProjectionWrite) {
      throw new Error("Expected a session_index runtime projection write");
    }
    expect(boundSessionIndexValue(runtimeProjectionWrite, "runtime_provider")).toBe("e2b");
    expect(boundSessionIndexValue(runtimeProjectionWrite, "runtime_backend")).toBe("e2b_cloud");
    expect(boundSessionIndexValue(runtimeProjectionWrite, "runtime_state")).toBe("killed");
    expect(boundSessionIndexValue(runtimeProjectionWrite, "runtime_sandbox_id")).toBe("e2b-running-1");
    expect(boundSessionIndexValue(runtimeProjectionWrite, "runtime_template_id")).toBe("cycloid-sandbox-test");
    expect(boundSessionIndexValue(runtimeProjectionWrite, "runtime_live_lease_expires_at")).toBeNull();
  });

  it("recovers from reconnect grace when the sandbox is back before expiry", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ?, status = ?, prompt_last_activity_at = ? WHERE session_id = ?",
      Date.now() - 1_000,
      "reconnecting",
      Date.now() - 5_000,
      SESSION_ID,
    );
    instance.sandboxWs = { close: vi.fn(), readyState: 1 } as unknown;

    await instance.alarm();

    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("ready");
    expect(sb?.disconnect_started_at).toBeNull();
    expect(sb?.auto_close_scheduled_at).toBeNull();

    const alarm = await fakeState.storage.getAlarm();
    expect(alarm).toBeGreaterThanOrEqual(Date.now() + PROMPT_MAX_DURATION_MS - 1_000);
    expect(alarm).toBeLessThanOrEqual(Date.now() + PROMPT_MAX_DURATION_MS + 1_000);
  });

  it("does not expire reconnect grace when the sandbox socket is live and disconnect marker is clear", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    vi.setSystemTime(new Date("2026-04-15T00:00:00.000Z"));
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET sandbox_id = ?, status = ?, disconnect_started_at = NULL WHERE session_id = ?",
      "sandbox-1",
      "ready",
      SESSION_ID,
    );
    await fakeState.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, Date.now() - 1);
    instance.sandboxWs = { close: vi.fn(), readyState: 1 } as unknown;

    await instance.alarm();

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
      status: "processing",
      error: null,
    });
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("prompt-1");
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("ready");
    expect(sb?.disconnect_started_at).toBeNull();
    await expect(
      fakeState.storage.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY),
    ).resolves.toBeUndefined();

    const failedEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "prompt_failed",
    );
    expect(failedEvent).toBeUndefined();
  });

  it("fails the active prompt when reconnect grace expires", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ?, status = ? WHERE session_id = ?",
      Date.now() - SANDBOX_RECONNECT_GRACE_MS - 1_000,
      "reconnecting",
      SESSION_ID,
    );
    fakeState.storage.sql.exec("UPDATE prompts SET has_pending_question = 1 WHERE prompt_id = ?", "prompt-1");
    fakeState.storage.sql.exec("UPDATE session SET last_push_succeeded = 1 WHERE session_id = ?", SESSION_ID);
    // Cap reached: grace expiry terminalizes rather than re-running.
    fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");
    await armConfirmedRuntimeLoss(instance, fakeState);

    await instance.alarm();

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")?.status).toBe("failed");
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBeNull();
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("stopped");
    expect(sb?.disconnect_started_at).toBeNull();
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")?.has_pending_question).toBe(0);
    // ARC-876: last_push_succeeded is no longer reset on prompt failure;
    // push outcome is bundled on the post_execution event.
  });

  it("clears reconnect state when grace expires after the session row is gone", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ?, status = ?, auto_close_scheduled_at = ? WHERE session_id = ?",
      Date.now() - SANDBOX_RECONNECT_GRACE_MS - 1_000,
      "reconnecting",
      Date.now() + 60_000,
      SESSION_ID,
    );
    (instance as DOTestHandle & { _sessionId: string | null })._sessionId = SESSION_ID;
    fakeState.storage.sql.exec("DELETE FROM session WHERE session_id = ?", SESSION_ID);

    await instance.alarm();

    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("stopped");
    expect(sb?.stop_reason).toBe("reaped");
    expect(sb?.disconnect_started_at).toBeNull();
    expect(sb?.auto_close_scheduled_at).toBeNull();
  });

  it("re-runs the active prompt on a fresh sandbox when grace expires under the disconnect-retry cap", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    const startSpawnAttempt = vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("spawn-attempt-1");
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ?, status = ? WHERE session_id = ?",
      Date.now() - SANDBOX_RECONNECT_GRACE_MS - 1_000,
      "reconnecting",
      SESSION_ID,
    );
    await armConfirmedRuntimeLoss(instance, fakeState);

    await instance.alarm();

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    // The dropped run is finalized and a fresh clone (id derived from
    // prompt_counter) takes over as the active prompt.
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")?.status).toBe("failed");
    const clone = prompts.find((prompt) => prompt.prompt_id === "p-2");
    expect(clone?.status).toBe("processing");
    expect(clone?.disconnect_retry_count).toBe(1);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("p-2");
    expect(startSpawnAttempt).toHaveBeenCalledWith(SESSION_ID, "spawnSandbox.sandboxDisconnect");

    // Soft recovery: a prompt_retrying event, not a hard prompt_failed.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.some((event) => event.type === "prompt_retrying")).toBe(true);
    expect(events.some((event) => event.type === "prompt_failed")).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 2c. Silent VM death (sandbox liveness lease lapses, no clean WS close)
  // routes through the SAME bounded disconnect recovery as reconnect grace.
  // -----------------------------------------------------------------------

  // Arm a past-due sandbox-liveness deadline with no disconnect marker: this is
  // the silent-death shape (the event stream just goes quiet, so there is no
  // clean close and no reconnect-grace deadline).
  async function armSilentLivenessExpiry(
    instance: DOTestHandle,
    fakeState: Awaited<ReturnType<typeof createActiveDO>>["fakeState"],
  ) {
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET sandbox_id = ?, status = ?, disconnect_started_at = NULL WHERE session_id = ?",
      "sandbox-1",
      "ready",
      SESSION_ID,
    );
    await fakeState.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, Date.now() - 1);
    await armConfirmedRuntimeLoss(instance, fakeState);
  }

  it("re-runs the active prompt on a fresh sandbox when sandbox liveness expires under the cap", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    const startSpawnAttempt = vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("spawn-attempt-1");
    await armSilentLivenessExpiry(instance, fakeState);

    await instance.alarm();

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    // Same recovery shape as reconnect-grace: the dropped run is finalized and a
    // fresh clone takes over, instead of a lone terminal failure.
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")?.status).toBe("failed");
    const clone = prompts.find((prompt) => prompt.prompt_id === "p-2");
    expect(clone?.status).toBe("processing");
    expect(clone?.disconnect_retry_count).toBe(1);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("p-2");
    expect(startSpawnAttempt).toHaveBeenCalledWith(SESSION_ID, "spawnSandbox.sandboxDisconnect");

    // Soft recovery surfaces prompt_retrying (the user-visible "interrupted,
    // re-running on a fresh sandbox" signal), not a hard prompt_failed.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.some((event) => event.type === "prompt_retrying")).toBe(true);
    expect(events.some((event) => event.type === "prompt_failed")).toBe(false);
  });

  it("terminalizes with sandbox_disconnected_exhausted when liveness expires at the retry cap", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    await armSilentLivenessExpiry(instance, fakeState);
    fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");

    await instance.alarm();

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
      status: "failed",
      error: "Sandbox kept disconnecting after 3 attempts",
    });
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBeNull();
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("stopped");

    const failedEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "prompt_failed",
    );
    expect(failedEvent?.data).toMatchObject({
      promptId: "prompt-1",
      errorCode: "sandbox_disconnected_exhausted",
    });
  });

  it("does not finalize the prompt when a prompt deadline shares the alarm batch with liveness expiry", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("spawn-attempt-1");
    await armSilentLivenessExpiry(instance, fakeState);
    // A running-inactivity deadline is also past-due in the same batch. It sorts
    // ahead of liveness, so without guard-ordering it would terminalize the
    // prompt first and defeat the re-enqueue. The disconnect path must win.
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET prompt_last_activity_at = ? WHERE session_id = ?",
      Date.now() - PROMPT_MAX_DURATION_MS - 1_000,
      SESSION_ID,
    );

    await instance.alarm();

    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    // Re-enqueue (prompt_retrying), not a terminal max-duration prompt_failed.
    expect(events.some((event) => event.type === "prompt_retrying")).toBe(true);
    expect(events.some((event) => event.type === "prompt_failed")).toBe(false);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("p-2");
  });

  it("keeps the next queued prompt dispatchable after grace expiry", async () => {
    const { instance, fakeState, session } = await createActiveDO(workerModule);
    const startSpawnAttempt = vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("spawn-attempt-1");
    // Add a second queued prompt
    seedPrompt(fakeState.storage, {
      promptId: "prompt-2",
      sessionId: SESSION_ID,
      promptText: "second",
      actorUserId: "user-1",
      agent: "code",
      status: "queued",
      createdAt: Date.now() + 1,
    });
    fakeState.storage.sql.exec("UPDATE session SET prompt_counter = 2 WHERE session_id = ?", SESSION_ID);
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ?, status = ? WHERE session_id = ?",
      Date.now() - SANDBOX_RECONNECT_GRACE_MS - 1_000,
      "reconnecting",
      SESSION_ID,
    );
    // Cap reached: the dropped prompt terminalizes and the queued prompt-2 is
    // promoted (under-cap would instead re-run prompt-1 itself).
    fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");
    await armConfirmedRuntimeLoss(instance, fakeState);

    await instance.alarm();

    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("prompt-2");
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.pending_prompt_dispatch).toBe(1);
    expect(startSpawnAttempt).toHaveBeenCalledWith(SESSION_ID, "spawnSandbox.sandboxDisconnect");

    const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    instance.sandboxWs = sandboxSocket;

    expect(await instance.sendPendingPromptToSandbox(session.sessionId)).toBe(true);
    expect(sandboxSocket.send).toHaveBeenCalledTimes(1);
    const sbAfter = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sbAfter?.pending_prompt_dispatch).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2b. Sandbox disconnect with queued prompts spawns new sandbox
  // -----------------------------------------------------------------------

  it("drains queue and spawns new sandbox after reconnect grace expires", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();

    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: "prompt-1",
      promptCounter: 2,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID });
    seedPrompt(fakeState.storage, {
      promptId: "prompt-1",
      sessionId: SESSION_ID,
      promptText: "first",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt: Date.now(),
    });
    seedPrompt(fakeState.storage, {
      promptId: "prompt-2",
      sessionId: SESSION_ID,
      promptText: "second",
      actorUserId: "user-1",
      agent: "code",
      status: "queued",
      createdAt: Date.now() + 1,
    });
    // Cap reached: the dropped prompt terminalizes and the queue drains onto a
    // fresh sandbox (under-cap would re-run prompt-1 instead).
    fakeState.storage.sql.exec("UPDATE prompts SET disconnect_retry_count = 2 WHERE prompt_id = ?", "prompt-1");
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const startSpawnAttempt = vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("spawn-attempt-1");

    const mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    fakeState.acceptWebSocket(mockSocket, ["client", "wsid:test-client"]);

    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET disconnect_started_at = ?, status = ? WHERE session_id = ?",
      Date.now() - SANDBOX_RECONNECT_GRACE_MS - 1_000,
      "reconnecting",
      SESSION_ID,
    );
    await armConfirmedRuntimeLoss(instance, fakeState);

    await instance.alarm();

    // prompt-1 should be failed
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((p) => p.prompt_id === "prompt-1")?.status).toBe("failed");

    // prompt-2 should now be processing
    expect(prompts.find((p) => p.prompt_id === "prompt-2")?.status).toBe("processing");

    // activePromptId should be prompt-2
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBe("prompt-2");
    expect(startSpawnAttempt).toHaveBeenCalledWith(SESSION_ID, "spawnSandbox.sandboxDisconnect");

    // Events should include prompt_processing for the next prompt in canonical SQL rows.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    const processingEvent = events?.find((e) => e.type === "prompt_processing");
    expect(processingEvent).toBeDefined();
    expect(processingEvent?.data?.promptId).toBe("prompt-2");
  });

  // -----------------------------------------------------------------------
  // 3. Alarm fires and stops idle session
  // -----------------------------------------------------------------------

  it("auto-stops session when alarm fires and session is idle with no sandbox", async () => {
    const { instance, fakeState } = await createIdleDO(workerModule);

    // Set up the auto-close marker as handleSandboxClose would
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET auto_close_scheduled_at = ? WHERE session_id = ?",
      Date.now(),
      SESSION_ID,
    );

    // No sandbox connected
    instance.sandboxWs = null;

    await instance.alarm();

    // Session should stay active but become stopped
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(sess?.status).toBe("active");
    expect(sess?.closed_at).toBeNull();

    // auto_close_scheduled_at should be cleaned up
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.status).toBe("stopped");
    expect(sb?.auto_close_scheduled_at).toBeNull();
  });

  it("does not promote the sidebar ordering timestamp when an idle auto-stop fires", async () => {
    const originalUpdatedAt = Date.parse("2026-04-12T09:30:00.000Z");
    const autoStopAt = Date.parse("2026-04-15T12:00:00.000Z");
    vi.setSystemTime(autoStopAt);

    const db = new RecordingD1();
    const env = { ...createTestEnv(), DB: db };
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      businessId: "biz-1",
      status: "active",
      createdAt: originalUpdatedAt - 1_000,
      updatedAt: originalUpdatedAt,
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      autoCloseScheduledAt: autoStopAt,
    });
    await fakeState.storage.put("replay", {
      sessionId: SESSION_ID,
      lastEventSequence: 0,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    instance.sandboxWs = null;

    await instance.alarm();

    const sessionIndexWrite = db.runs.find((run) => run.query.includes("INSERT INTO session_index"));
    if (!sessionIndexWrite) {
      throw new Error("Expected a session_index projection write");
    }
    expect(boundSessionIndexValue(sessionIndexWrite, "updated_at")).toBe("2026-04-15T12:00:00.000Z");

    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(sess?.updated_at).toBe(autoStopAt);
  });

  // -----------------------------------------------------------------------
  // 4. Alarm fires but sandbox reconnected -- session stays open
  // -----------------------------------------------------------------------

  it("skips auto-close when sandbox has reconnected during grace period", async () => {
    const { instance, fakeState } = await createIdleDO(workerModule);

    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET auto_close_scheduled_at = ? WHERE session_id = ?",
      Date.now(),
      SESSION_ID,
    );

    // Sandbox reconnected during grace period
    instance.sandboxWs = { close: vi.fn(), readyState: 1 } as unknown;

    await instance.alarm();

    // Session should still be active
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(sess?.status).toBe("active");
  });

  // -----------------------------------------------------------------------
  // 5. Alarm fires but new prompt is active -- session stays open
  // -----------------------------------------------------------------------

  it("skips auto-close when a new prompt became active during grace period", async () => {
    const { instance, fakeState } = await createIdleDO(workerModule);

    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET auto_close_scheduled_at = ? WHERE session_id = ?",
      Date.now(),
      SESSION_ID,
    );
    // A new prompt started during the grace period
    seedPrompt(fakeState.storage, {
      promptId: "prompt-2",
      sessionId: SESSION_ID,
      promptText: "new",
      status: "processing",
      startedAt: Date.now(),
    });

    instance.sandboxWs = null;

    await instance.alarm();

    // Session should still be active
    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(sess?.status).toBe("active");
  });

  // -----------------------------------------------------------------------
  // 6. Stale socket close callback (mismatched sandboxId) returns early
  // -----------------------------------------------------------------------

  it("returns early on stale close callback with mismatched sandbox generation", async () => {
    const { instance, fakeState } = await createIdleDO(workerModule);

    // Current sandbox generation is 2, but callback is from generation 1 (stale)
    instance.cachedSandboxConnectionGen = 2;
    instance.sandboxWs = { close: vi.fn(), readyState: 1 } as unknown;
    const staleSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(staleSocket, ["sandbox", "sid:sandbox-1", "gen:1"]);

    await instance.webSocketClose(staleSocket, 1000, "closed", true);

    // No alarm should be scheduled (returned early)
    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.auto_close_scheduled_at).toBeNull();

    // Current sandbox reference should still be set (not cleared)
    expect(instance.sandboxWs).not.toBeNull();
    expect(instance.cachedSandboxConnectionGen).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 7. Sandbox reconnect rejected when session is closed
  // -----------------------------------------------------------------------

  it("rejects sandbox WebSocket when session is closed", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const sandboxAuthToken = "test-token";
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;

    const doInstance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "archived",
      closedAt: Date.now(),
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      sandboxId: "sandbox-1",
      sandboxAuthTokenHash: await computeSha256Hex(sandboxAuthToken),
    });
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      // Build a request that would trigger handleSandboxWebSocket
      const request = new Request(
        `https://internal/session/ws?type=sandbox&sessionId=${SESSION_ID}&sandboxId=sandbox-1`,
        {
          headers: {
            upgrade: "websocket",
            authorization: `Bearer ${sandboxAuthToken}`,
            "x-sandbox-id": "sandbox-1",
          },
        },
      );

      const response = await doInstance.fetch(request);
      expect(response.status).toBe(409);

      const body = (await response.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("Session is archived");
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }
  });

  // -----------------------------------------------------------------------
  // 8. Session already closed -- no alarm scheduled
  // -----------------------------------------------------------------------

  it("does NOT schedule alarm when session is already closed", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();

    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "archived" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID });

    const sandboxSocket = connectSandbox(fakeState, instance);
    await instance.webSocketClose(sandboxSocket, 1000, "closed", true);
    await instance.persistenceQueue;

    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.auto_close_scheduled_at).toBeNull();
  });

  it("fails an active prompt even when the session is already archived", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    fakeState.storage.sql.exec(
      "UPDATE session SET status = ?, closed_at = ? WHERE session_id = ?",
      "archived",
      Date.now(),
      SESSION_ID,
    );

    const sandboxSocket = connectSandbox(fakeState, instance);
    await instance.webSocketClose(sandboxSocket, 1000, "closed", true);
    await instance.persistenceQueue;

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({
      status: "failed",
      error: "Sandbox disconnected while processing",
    });

    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(sess?.status).toBe("archived");
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBeNull();

    const sb = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sb?.auto_close_scheduled_at).toBeNull();
    expect(sb?.status).toBe("stopped");

    const failedEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "prompt_failed",
    );
    expect(failedEvent?.data).toMatchObject({
      promptId: "prompt-1",
      errorCode: "sandbox_disconnected",
    });
  });

  it("does not promote queued prompts when an archived session disconnects", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    const startSpawnAttempt = vi.spyOn(instance, "startSpawnAttempt").mockResolvedValue("spawn-attempt-1");
    seedPrompt(fakeState.storage, {
      promptId: "prompt-2",
      sessionId: SESSION_ID,
      promptText: "second",
      actorUserId: "user-1",
      agent: "code",
      status: "queued",
      createdAt: Date.now() + 1,
    });
    fakeState.storage.sql.exec("UPDATE session SET prompt_counter = 2 WHERE session_id = ?", SESSION_ID);
    fakeState.storage.sql.exec(
      "UPDATE session SET status = ?, closed_at = ? WHERE session_id = ?",
      "archived",
      Date.now(),
      SESSION_ID,
    );

    const sandboxSocket = connectSandbox(fakeState, instance);
    await instance.webSocketClose(sandboxSocket, 1000, "closed", true);
    await instance.persistenceQueue;

    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-1")).toMatchObject({ status: "failed" });
    expect(prompts.find((prompt) => prompt.prompt_id === "prompt-2")).toMatchObject({ status: "queued" });

    const sess = querySession(fakeState.storage, SESSION_ID);
    expect(sess?.status).toBe("archived");
    expect(queryActiveProcessingPromptId(fakeState.storage, SESSION_ID)).toBeNull();

    const processingEvent = querySessionEvents(fakeState.storage, SESSION_ID).find(
      (event) => event.type === "prompt_processing" && event.data?.promptId === "prompt-2",
    );
    expect(processingEvent).toBeUndefined();
    expect(startSpawnAttempt).not.toHaveBeenCalled();
  });

  // The two reconnect-grace-after-archive cleanup tests that used to live
  // here were removed: the alarm handler now early-returns on archived
  // sessions (durable-object.ts, search "alarm.noop_terminal_session"), and
  // `closeSessionAtDurabilityBoundary` finalizes any in-flight prompt
  // synchronously before flipping session.status, so the corrupt state
  // those tests staged (archived + processing prompt + reconnecting
  // sandbox) is no longer reachable. Coverage for the alarm-on-archived
  // invariant lives in tests/test_cloudflare/session/archive-active-prompt-leak.test.ts.

  // -----------------------------------------------------------------------
  // 9. Stale close callback after alarm() intentional disconnect is a no-op
  // -----------------------------------------------------------------------

  it("skips disconnect-fail when socket was already cleaned up by alarm", async () => {
    const { instance, fakeState } = await createActiveDO(workerModule);
    const sandboxSocket = { close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "sid:sandbox-1", "gen:1"]);
    instance.cachedSandboxConnectionGen = 1;
    instance.handledSandboxDisconnectGenerations.add(1);

    await instance.webSocketClose(sandboxSocket, 1000, "closed", true);
    await instance.persistenceQueue;

    // Prompt should still be processing (not double-failed)
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    const prompt = prompts.find((p) => p.prompt_id === "prompt-1");
    expect(prompt?.status).toBe("processing");

    // No session_error events should have been appended (events still in KV)
    const events = await fakeState.storage.get<Array<{ type: string }>>("events");
    const errorEvents = events?.filter((e) => e.type === "session_error") ?? [];
    expect(errorEvents).toHaveLength(0);
  });
});
