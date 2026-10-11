/**
 * Tests for the session-archive active-prompt leak fix.
 *
 * Before the fix, archiving a session while a prompt was still `processing`
 * left `session.active_prompt_id` populated and the prompt max-duration DO
 * alarm armed. The alarm later fired and wrote a spurious
 * `max_duration_exceeded` failure into prompt_runs for an already-archived
 * session.
 *
 * This suite verifies three guarantees:
 *
 *   1. POST /session/close on a session with a processing prompt:
 *      - fails the prompt with errorCode "session_archived"
 *      - clears session.active_prompt_id
 *      - emits prompt_failed BEFORE session_closed (replay ordering)
 *      - deletes the DO alarm
 *   2. The alarm handler early-returns on archived sessions:
 *      - emits no `prompt.max_duration_exceeded` Datadog event
 *      - does not call completeActivePrompt (no failed prompt row rewrite)
 *      - deletes the alarm and logs `alarm.noop_terminal_session`
 *   3. The partial unique index `idx_prompts_one_processing` rejects a
 *      second processing prompt on the same session.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockPostStructuredEventToDd = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../apps/control-plane-worker/src/observability/events-exporter", async () => {
  const actual = await vi.importActual<
    typeof import("../../../apps/control-plane-worker/src/observability/events-exporter")
  >("../../../apps/control-plane-worker/src/observability/events-exporter");
  return {
    ...actual,
    postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
  };
});

import { PROMPT_MAX_DURATION_MS } from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  queryPrompts,
  querySession,
  querySessionEvents,
  seedPrompt,
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
    alarm(): Promise<void>;
    cachedSandboxConnectionGen: number | null;
    sandboxWs: unknown | null;
  };
};

const SESSION_ID = "archive-leak-session";
const PROMPT_ID = "prompt-1";

let workerModule: WorkerModule;

describe("session archive active-prompt leak fix", () => {
  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as unknown as WorkerModule;
  });

  beforeEach(() => {
    mockPostStructuredEventToDd.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. POST /session/close finalizes the active prompt
  // -----------------------------------------------------------------------

  it("fails an in-flight processing prompt with session_archived and clears active_prompt_id", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: PROMPT_ID,
      promptCounter: 1,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "do thing",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt: Date.now(),
    });

    // Arm a max-duration alarm the way the prompt queue would.
    await fakeState.storage.setAlarm(Date.now() + PROMPT_MAX_DURATION_MS);
    await expect(fakeState.storage.getAlarm()).resolves.not.toBeNull();

    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        body: JSON.stringify({ reason: "user_closed" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    await fakeState.flushWaitUntil();

    // Session row archived; no processing prompt remains (the active
    // prompt was finalized and the column itself was dropped in DO
    // migration 70 -- the source of truth is now prompts.status).
    const session = querySession(fakeState.storage, SESSION_ID);
    expect(session?.status).toBe("archived");
    expect(session?.active_prompt_id).toBeUndefined();

    // Prompt row marked failed with session_archived error.
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].status).toBe("failed");
    expect(prompts[0].error).toMatch(/Session archived while processing/);
    expect(prompts[0].completed_at).not.toBeNull();

    // Replay ordering: prompt_failed precedes session_closed.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    const types = events.map((event) => event.type);
    const failedIndex = types.indexOf("prompt_failed");
    const closedIndex = types.indexOf("session_closed");
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(closedIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeLessThan(closedIndex);

    const failedEvent = events[failedIndex];
    expect(failedEvent.data.errorCode).toBe("session_archived");
    expect(failedEvent.data.promptId).toBe(PROMPT_ID);

    // Alarm cleared so no stale max-duration fire.
    await expect(fakeState.storage.getAlarm()).resolves.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 2. alarm() early-returns on archived sessions
  // -----------------------------------------------------------------------

  it("alarm fired on an archived session emits no Datadog event and writes no prompt rows", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env);

    // Simulate the pre-fix corrupt state directly: archived session that
    // still has active_prompt_id set and a "processing" prompt. The guard
    // must short-circuit before any side effects fire.
    const startedAt = Date.now() - PROMPT_MAX_DURATION_MS - 1000;
    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "archived",
      closedAt: Date.now(),
      activePromptId: PROMPT_ID,
      promptCounter: 1,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "stopped" });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "do thing",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt,
    });

    // Arm a past-due alarm (pre-fix this would fire the max-duration branch).
    await fakeState.storage.setAlarm(Date.now() - 1000);

    await instance.alarm();
    await fakeState.flushWaitUntil();

    // No Datadog telemetry. (postStructuredEventToDd is the channel used by
    // both prompt.max_duration_exceeded and session.completed; the alarm
    // path on an archived session must emit neither.)
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();

    // Prompt row untouched -- completeActivePrompt would have flipped status
    // to "failed" and written errorCode "max_duration_exceeded".
    const prompts = queryPrompts(fakeState.storage, SESSION_ID);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].status).toBe("processing");

    // No new prompt_failed event appended by the alarm.
    const events = querySessionEvents(fakeState.storage, SESSION_ID);
    expect(events.find((event) => event.type === "prompt_failed")).toBeUndefined();

    // Alarm cleared.
    await expect(fakeState.storage.getAlarm()).resolves.toBeNull();
  });

  // -----------------------------------------------------------------------
  // 3. Partial unique index rejects duplicate processing prompts
  // -----------------------------------------------------------------------

  it("idx_prompts_one_processing rejects a second processing prompt per session", () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });

    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "first",
      status: "processing",
      startedAt: Date.now(),
    });

    expect(() =>
      seedPrompt(fakeState.storage, {
        promptId: "p-2",
        sessionId: SESSION_ID,
        promptText: "second",
        status: "processing",
        startedAt: Date.now(),
      }),
    ).toThrow(/UNIQUE constraint failed|idx_prompts_one_processing/i);
  });

  it("idx_prompts_one_processing allows multiple non-processing prompts per session", () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });

    seedPrompt(fakeState.storage, {
      promptId: "p-1",
      sessionId: SESSION_ID,
      promptText: "first",
      status: "completed",
    });
    seedPrompt(fakeState.storage, {
      promptId: "p-2",
      sessionId: SESSION_ID,
      promptText: "second",
      status: "queued",
    });
    seedPrompt(fakeState.storage, {
      promptId: "p-3",
      sessionId: SESSION_ID,
      promptText: "third",
      status: "processing",
      startedAt: Date.now(),
    });

    expect(queryPrompts(fakeState.storage, SESSION_ID)).toHaveLength(3);
  });

  // -----------------------------------------------------------------------
  // 4. PR3: alarm reducer derives null on archived; emits alarm.reprojected
  // -----------------------------------------------------------------------

  it("rescheduleSessionAlarm derives null and deletes the alarm after the session is archived", async () => {
    const env = createTestEnv();
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as {
      fetch(request: Request): Promise<Response>;
      rescheduleSessionAlarm(): Promise<void>;
    };

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      promptCounter: 1,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "work",
      actorUserId: "user-1",
      agent: "code",
      status: "processing",
      startedAt: Date.now(),
    });

    // Active prompt -> reducer schedules max-duration alarm.
    await instance.rescheduleSessionAlarm();
    const scheduled = await fakeState.storage.getAlarm();
    expect(scheduled).not.toBeNull();
    expect(scheduled).toBeGreaterThan(Date.now());

    // Archive the session (PR1 path: finalizes prompt, deletes alarm).
    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        body: JSON.stringify({ reason: "user_closed" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    await fakeState.flushWaitUntil();

    // After archive, the reducer should derive no deadline: every candidate
    // either fails its validity gate (no processing prompt, sandbox not
    // spawning, no disconnect) or is past with no catch-up classification.
    await instance.rescheduleSessionAlarm();
    await expect(fakeState.storage.getAlarm()).resolves.toBeNull();
  });
});
