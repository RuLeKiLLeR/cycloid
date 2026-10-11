/**
 * Sidebar drift regression suite for the three direct-write paths that
 * survived PR #2602 (which only fixed the user-stop path):
 *
 *   1. closeSessionAtDurabilityBoundary  -- POST /session/close
 *   2. /session/archive-close-pr handler
 *   3. applyLifecycleStatePatch          -- lifecycle decisions that flip
 *                                            sandbox.state to e.g. "stopped"
 *
 * Each path used to write `sandbox_state.status` directly via
 * doDb.updateSandboxState({ status: ... }) without then calling
 * syncCurrentRichStatus, leaving session_index.rich_status frozen at the
 * value it had during the prior "stopping" sync (which computeRichStatus
 * mapped to "idle"). The sidebar's flattenStatus then renders "idle" as
 * "Needs input", while the detail view (which reads live DO state) shows
 * the correct status -- producing the user-reported "click to fix, refresh
 * to drift" symptom.
 *
 * Each test asserts that the LAST `UPDATE session_index SET rich_status`
 * write D1 receives matches the expected terminal projection.
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
    cachedSandboxConnectionGen: number | null;
    sandboxWs: unknown | null;
    processLifecycleEvent?: (sessionId: string, event: unknown) => Promise<unknown>;
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

function createEnvWithRecordingDb(db: RecordingD1): Record<string, unknown> {
  return {
    DB: db,
    WORKER_ENV: "test",
    SANDBOX_CALLBACK_SECRET: "sandbox-callback-secret",
    LOG_LEVEL: "error",
  };
}

function lastRichStatusBinds(db: RecordingD1): unknown[] | null {
  const writes = db.recorded.filter((r) => r.query.includes("UPDATE session_index SET rich_status"));
  if (writes.length === 0) return null;
  return writes[writes.length - 1].binds;
}

let workerModule: WorkerModule;
beforeAll(async () => {
  workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
});

describe("close path syncs rich_status to D1", () => {
  it("writes rich_status='archived' to session_index after POST /session/close", async () => {
    const SESSION_ID = "close-sync-session";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
    });

    const response = await instance.fetch(
      new Request("https://internal/session/close", {
        method: "POST",
        body: JSON.stringify({ reason: "user_closed" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    await fakeState.flushWaitUntil();

    expect(querySandboxState(fakeState.storage, SESSION_ID)?.status).toBe("stopped");

    const last = lastRichStatusBinds(db);
    expect(last).not.toBeNull();
    // computeRichStatus short-circuits on session.status="archived",
    // regardless of the (stopped) sandbox state.
    expect(last?.[0]).toBe("archived");
    expect(last?.[1]).toBe(SESSION_ID);
  });
});

describe("unarchive path is removed", () => {
  it("does not expose /session/unarchive", async () => {
    const SESSION_ID = "unarchive-removed-session";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "archived",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "stopped",
    });

    const response = await instance.fetch(new Request("https://internal/session/unarchive", { method: "POST" }));
    expect(response.status).toBe(404);
    await fakeState.flushWaitUntil();

    expect(lastRichStatusBinds(db)).toBeNull();
  });
});

describe("applyLifecycleStatePatch syncs rich_status to D1 when sandbox.state changes", () => {
  it("re-projects rich_status after a lifecycle decision flips sandbox.state to 'stopped'", async () => {
    const SESSION_ID = "lifecycle-sync-session";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
    });

    // Drive applyLifecycleStatePatch indirectly by invoking the private
    // method via the instance reference. The lifecycle reducer normally
    // produces these patches; here we simulate the terminal outcome of a
    // sandbox.disconnect event: state -> "stopped".
    type Internal = {
      applyLifecycleStatePatch: (sessionId: string, patch: Record<string, unknown>) => Promise<void>;
    };
    const internal = instance as unknown as Internal;
    const initialWriteCount = db.recorded.filter((r) =>
      r.query.includes("UPDATE session_index SET rich_status"),
    ).length;

    await internal.applyLifecycleStatePatch(SESSION_ID, {
      sandbox: { state: "stopped" },
    });
    await fakeState.flushWaitUntil();

    const writes = db.recorded.filter((r) => r.query.includes("UPDATE session_index SET rich_status"));
    // Must produce at least one new rich_status write; before the fix this
    // path skipped the projection entirely.
    expect(writes.length).toBeGreaterThan(initialWriteCount);
    const last = writes[writes.length - 1];
    // sandbox.status="stopped", no stopReason -> stopped_resumable.
    expect(["stopped", "stopped_resumable"]).toContain(last.binds[0]);
    expect(last.binds[1]).toBe(SESSION_ID);
  });

  it("does NOT sync rich_status when the patch leaves sandbox.state unchanged", async () => {
    const SESSION_ID = "lifecycle-no-state-session";
    const fakeState = createFakeState();
    const db = new RecordingD1();
    const env = createEnvWithRecordingDb(db);
    const instance = new workerModule.SessionDO(fakeState, env);

    seedSession(fakeState.storage, {
      sessionId: SESSION_ID,
      ownerUserId: "user-1",
      status: "active",
    });
    seedSandboxState(fakeState.storage, {
      sessionId: SESSION_ID,
      status: "ready",
    });

    type Internal = {
      applyLifecycleStatePatch: (sessionId: string, patch: Record<string, unknown>) => Promise<void>;
    };
    const internal = instance as unknown as Internal;
    const initialCount = db.recorded.filter((r) => r.query.includes("UPDATE session_index SET rich_status")).length;

    // sandboxId-only patch must NOT trigger a redundant rich_status sync,
    // because rich_status doesn't depend on sandboxId.
    await internal.applyLifecycleStatePatch(SESSION_ID, {
      sandbox: { sandboxId: "sb-new" },
    });
    await fakeState.flushWaitUntil();

    const finalCount = db.recorded.filter((r) => r.query.includes("UPDATE session_index SET rich_status")).length;
    expect(finalCount).toBe(initialCount);
  });
});

// Silence unused-import warnings if the harness API changes.
void vi;
