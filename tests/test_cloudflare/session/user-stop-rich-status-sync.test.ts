/**
 * User-stop rich_status projection regression test (resume-stopped-session).
 *
 * A manual user stop of an idle NON-verifier session now keeps the sandbox
 * live-idle instead of pausing (`stopSessionKeepAlive`, no boundary): sandbox
 * stays `status="ready"`, the socket is not closed, and the rich_status
 * projected to D1's `session_index` stays the (unchanged) idle phase — never
 * forced to "stopped". The "Stopped" surface is carried by the userStopped flag
 * on the live session_status frame, not by a rich_status flip. This locks the
 * inverted behavior so the sidebar keeps showing the live idle phase and the
 * detail view can resume straight to the live agent.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeState,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
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

interface DOTestHandle {
  fetch(request: Request): Promise<Response>;
  cachedSandboxConnectionGen: number | null;
  sandboxWs: unknown | null;
}

const SESSION_ID = "user-stop-sync-session";

function createEnvWithRecordingDb(db: RecordingD1): Record<string, unknown> {
  return {
    DB: db,
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
  };
}

describe("user-stop syncs rich_status to D1", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  it("keeps the idle session live (rich_status idle, sandbox ready) on a non-verifier user stop", async () => {
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;

    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });

    const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
    fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "sid:sandbox-1", "gen:1"]);
    fakeState.storage.sql.exec("UPDATE sandbox_state SET sandbox_id = ? WHERE session_id = ?", "sandbox-1", SESSION_ID);
    instance.cachedSandboxConnectionGen = 1;
    instance.sandboxWs = sandboxSocket;

    const response = await instance.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    expect(response.status).toBe(200);
    await fakeState.flushWaitUntil();

    // Sandbox stays live — no boundary pause.
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.status).toBe("ready");
    expect(instance.sandboxWs).not.toBeNull();

    // rich_status is projected as the (unchanged) idle phase, never forced to "stopped".
    const richStatusWrites = db.recorded.filter((r) => r.query.includes("UPDATE session_index SET rich_status"));
    expect(richStatusWrites.length).toBeGreaterThan(0);
    expect(richStatusWrites[richStatusWrites.length - 1].binds[0]).toBe("idle");
  });
});
