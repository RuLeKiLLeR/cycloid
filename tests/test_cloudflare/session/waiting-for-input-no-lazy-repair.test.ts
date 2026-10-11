/**
 * Regression suite for PR 3 of the lifecycle projection simplification.
 *
 * The DO previously carried a `maybeScheduleWaitingForInputResync` helper that
 * fired on every read (GET /api/sessions/:id, WS subscribe bootstrap,
 * /session/events, /session/export) and re-synced `session_index.rich_status`
 * if the canonical question-event path had failed to project. The helper was a
 * one-shot migration backfill for sessions stuck in `waiting_for_input` before
 * PR #2994 shipped the rich-status split.
 *
 * Removing it requires that the canonical write paths keep
 * `session_index.rich_status` in sync without any read-path repair:
 *
 *   1. Question event arrival -> writes `rich_status='waiting_for_input'`.
 *   2. Read endpoints that observe `waiting_for_input` issue NO additional
 *      `UPDATE session_index SET rich_status` writes (proving the lazy
 *      repair is gone and the canonical path is the only source).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
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
  };
};

interface RecordedQuery {
  query: string;
  binds: unknown[];
}

class RecordingD1Statement {
  private bound: unknown[] = [];
  constructor(
    private readonly query: string,
    private readonly recorded: RecordedQuery[],
  ) {}
  bind(...values: unknown[]): this {
    this.bound = values;
    return this;
  }
  async run(): Promise<{ success: true; meta: { last_row_id: number } }> {
    this.recorded.push({ query: this.query, binds: this.bound });
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

class RecordingD1 {
  readonly recorded: RecordedQuery[] = [];
  prepare(query: string): RecordingD1Statement {
    return new RecordingD1Statement(query, this.recorded);
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    return Promise.all(statements.map((s) => s.run()));
  }
}

function createEnvWithRecordingDb(db: RecordingD1): Record<string, unknown> {
  return {
    DB: db,
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
  };
}

type TraceQueueMessage = {
  spans: Array<{
    name: string;
    status: string;
    attributes: Record<string, unknown>;
  }>;
};

function countRichStatusWrites(db: RecordingD1): number {
  return db.recorded.filter((r) => r.query.includes("UPDATE session_index SET rich_status")).length;
}

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as unknown as WorkerModule;
});

describe("waiting_for_input requires no lazy projection repair on reads", () => {
  it("GET /session/events on a hasPendingQuestion session does NOT issue a rich_status write", async () => {
    const SESSION_ID = "read-no-repair-session";
    const PROMPT_ID = "prompt-pending-q";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: PROMPT_ID,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "prompt awaiting question",
      status: "processing",
      startedAt: Date.now(),
      hasPendingQuestion: 1,
    });

    const beforeReadCount = countRichStatusWrites(db);

    const response = await instance.fetch(new Request(`https://internal/session/events?afterSequence=0&limit=10`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; sessionStatus: string };
    expect(body.ok).toBe(true);
    // The read still derives the correct rich status from live DO state...
    expect(body.sessionStatus).toBe("waiting_for_input");

    await fakeState.flushWaitUntil();

    // ...but it must NOT issue any projection write. Lazy repair is gone;
    // the canonical question-event path is the sole writer.
    expect(countRichStatusWrites(db)).toBe(beforeReadCount);
  });

  it("GET /session/state on a hasPendingQuestion session does NOT issue a rich_status write", async () => {
    const SESSION_ID = "snapshot-no-repair-session";
    const PROMPT_ID = "prompt-pending-q-2";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: PROMPT_ID,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "prompt awaiting question",
      status: "processing",
      startedAt: Date.now(),
      hasPendingQuestion: 1,
    });

    const beforeReadCount = countRichStatusWrites(db);

    const response = await instance.fetch(new Request(`https://internal/session/state`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; session: { phase: string } };
    expect(body.ok).toBe(true);
    expect(body.session.phase).toBe("waiting_for_input");

    await fakeState.flushWaitUntil();

    expect(countRichStatusWrites(db)).toBe(beforeReadCount);
  });

  it("GET /session/export on a hasPendingQuestion session does NOT issue a rich_status write", async () => {
    const SESSION_ID = "export-no-repair-session";
    const PROMPT_ID = "prompt-pending-q-3";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: PROMPT_ID,
    });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "prompt awaiting question",
      status: "processing",
      startedAt: Date.now(),
      hasPendingQuestion: 1,
    });

    const beforeReadCount = countRichStatusWrites(db);

    const response = await instance.fetch(new Request(`https://internal/session/export`));
    expect(response.status).toBe(200);
    await fakeState.flushWaitUntil();

    expect(countRichStatusWrites(db)).toBe(beforeReadCount);
  });

  it("GET /session/export records error details on the DO span and structured log", async () => {
    const SESSION_ID = "export-error-session";
    const PROMPT_ID = "prompt-export-error";
    const fakeState = createFakeState();
    const traceMessages: TraceQueueMessage[] = [];
    const env = {
      ...createEnvWithRecordingDb(new RecordingD1()),
      TRACE_QUEUE: {
        send: vi.fn(async (message: unknown) => {
          traceMessages.push(message as TraceQueueMessage);
        }),
      },
    };
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
      activePromptId: PROMPT_ID,
    });
    seedPrompt(fakeState.storage, {
      promptId: PROMPT_ID,
      sessionId: SESSION_ID,
      promptText: "prompt with broken export",
      status: "completed",
      startedAt: Date.now(),
      completedAt: Date.now(),
    });

    const error = new Error("synthetic export read failed");
    const getPromptsSpy = vi.spyOn(doDb, "getPrompts").mockImplementation(() => {
      throw error;
    });
    const logErrorSpy = vi.spyOn(
      (instance as unknown as { log: { error: (fields: unknown, message: string) => void } }).log,
      "error",
    );

    try {
      await expect(instance.fetch(new Request("https://internal/session/export"))).rejects.toThrow(
        "synthetic export read failed",
      );
      await fakeState.flushWaitUntil();

      expect(logErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          operation: "session.export",
          error: expect.objectContaining({
            message: "synthetic export read failed",
            stack: expect.stringContaining("synthetic export read failed"),
          }),
        }),
        "session export failed",
      );
      expect(traceMessages).toHaveLength(1);
      const span = traceMessages[0].spans.find((candidate) => candidate.name === "do./session/export");
      expect(span).toBeDefined();
      expect(span).toMatchObject({
        status: "error",
        attributes: expect.objectContaining({
          "session.id": SESSION_ID,
          "error.message": "synthetic export read failed",
          "error.stack": expect.stringContaining("synthetic export read failed"),
        }),
      });
      expect(String(span?.attributes["error.stack"]).length).toBeLessThanOrEqual(4_000);
    } finally {
      getPromptsSpy.mockRestore();
      logErrorSpy.mockRestore();
    }
  });
});

// Silence unused-import warning if the harness API changes.
void vi;
