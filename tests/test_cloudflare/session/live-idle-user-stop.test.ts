/**
 * Live-idle user stop (resume-stopped-session).
 *
 * A manual user stop of a NON-verifier session must keep the sandbox live-idle:
 * no pause, no finalize-to-stopped, no socket close. The session shows "Stopped"
 * (phase stays idle) via the userStopped flag on the live session_status frame,
 * so the next prompt dispatches straight to the live agent. Verifier sessions
 * keep pausing (decision #8) so verification dedup is unaffected.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  STOPPED_KEPT_ALIVE_AT_STORAGE_KEY,
} from "../../../apps/control-plane-worker/src/constants/sessions.ts";
import { updateSessionPlanStatus, upsertSessionPlan } from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
  seedPrompt,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => { fetch(request: Request): Promise<Response> };
};

interface DOTestHandle {
  fetch(request: Request): Promise<Response>;
  cachedSandboxConnectionGen: number | null;
  sandboxWs: unknown | null;
}

const SESSION_ID = "live-idle-stop-session";

/** Attach a live+fresh sandbox transport so handleStopRequest reaches the stop branches. */
function attachLiveSandbox(fakeState: ReturnType<typeof createFakeState>, instance: DOTestHandle) {
  const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket;
  fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "sid:sandbox-1", "gen:1"]);
  fakeState.storage.sql.exec("UPDATE sandbox_state SET sandbox_id = ? WHERE session_id = ?", "sandbox-1", SESSION_ID);
  instance.cachedSandboxConnectionGen = 1;
  instance.sandboxWs = sandboxSocket;
  return sandboxSocket;
}

/** Capture broadcast frames sent to connected clients. */
function attachClient(fakeState: ReturnType<typeof createFakeState>) {
  const clientSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
  fakeState.acceptWebSocket(clientSocket, ["client", "wsid:test-client"]);
  return clientSocket;
}

function statusFrames(clientSocket: { send: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return clientSocket.send.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((m) => m.type === "session_status");
}

describe("live-idle user stop keeps the sandbox live", () => {
  let workerModule: WorkerModule;
  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  it("(a) idle non-verifier stop: no pause, sandbox stays ready/running/live, userStopped broadcast", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    // Live E2B runtime with an unexpired lease — the state a live-idle session is in.
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider='e2b', runtime_state='running', runtime_sandbox_id='e2b-1', runtime_live_lease_expires_at=? WHERE session_id=?",
      Date.now() + 900_000,
      SESSION_ID,
    );
    const client = attachClient(fakeState) as unknown as { send: ReturnType<typeof vi.fn> };
    attachLiveSandbox(fakeState, instance);

    const res = await instance.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    expect(res.status).toBe(200);
    await fakeState.flushWaitUntil();

    const sandbox = querySandboxState(fakeState.storage, SESSION_ID);
    expect(sandbox?.status).toBe("ready"); // NOT "stopped" — no boundary pause
    expect(sandbox?.runtime_state).toBe("running");
    expect(instance.sandboxWs).not.toBeNull(); // socket not closed

    const stampedAt = await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY);
    expect(typeof stampedAt).toBe("number");

    const frames = statusFrames(client);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1].phase).toBe("idle");
    expect(frames[frames.length - 1].userStopped).toBe(true);
  });

  it("(c) idle stop exits review-listening without finalizing to stopped", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    // Put the session into review_listening via the DO's own lifecycle event so the
    // reducer + session_ext projection agree.
    await (
      instance as unknown as {
        processLifecycleEvent: (id: string, e: unknown) => Promise<unknown>;
      }
    ).processLifecycleEvent(SESSION_ID, {
      type: "review_listening.entered",
      prUrl: "https://github.com/o/r/pull/1",
      currentHeadSha: "abc",
    });
    attachLiveSandbox(fakeState, instance);

    await instance.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    await fakeState.flushWaitUntil();

    const ext = (await import("../../../apps/control-plane-worker/src/session/do-db.ts")).getSessionExtended(
      fakeState.storage.sql as unknown as SqlStorage,
      SESSION_ID,
    );
    expect(ext?.reviewListeningActive ?? false).toBe(false);
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.status).toBe("ready"); // still live
  });

  it("(b) next prompt dispatches to the live socket (send, not spawn) and clears userStopped", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle & {
      spawnSandbox?: (...args: unknown[]) => Promise<void>;
    };
    const operations: string[] = [];
    instance.spawnSandbox = vi.fn(async (_id: string, _attempt: string, op: string) => {
      operations.push(op);
    });
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    // Live-idle after a soft stop: sandbox ready, runtime running, flag stamped.
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider='e2b', runtime_state='running', runtime_sandbox_id='e2b-1', runtime_live_lease_expires_at=? WHERE session_id=?",
      Date.now() + 900_000,
      SESSION_ID,
    );
    await fakeState.storage.put(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY, Date.now());
    // Fresh heartbeat so shouldSendPromptNow (liveSocket && !resume.stopped && socketFresh) holds.
    await fakeState.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
      state: "connected",
      lastHeartbeatAt: Date.now(),
    });
    const sandboxSocket = attachLiveSandbox(fakeState, instance);

    const res = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
        body: JSON.stringify({ prompt: "add the bit I missed", actorUserId: "user-1" }),
      }),
    );
    expect(res.status).toBe(200);
    await fakeState.flushWaitUntil();

    // Dispatched to the live agent, not respawned.
    expect((sandboxSocket as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled();
    expect(operations).not.toContain("spawnSandbox.resume.cold");
    expect(operations).not.toContain("spawnSandbox.resume.live");
    // Flag cleared on admit.
    expect(await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY)).toBeUndefined();
  });

  it("(d) verifier idle stop still pauses to stopped (decision #8, QA path unchanged)", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle;
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    // agent_role='verification' → isVerificationSession() true → keeps the pause boundary.
    fakeState.storage.sql.exec("UPDATE session SET agent_role='verification' WHERE session_id=?", SESSION_ID);
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    attachLiveSandbox(fakeState, instance);

    await instance.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    await fakeState.flushWaitUntil();

    expect(querySandboxState(fakeState.storage, SESSION_ID)?.status).toBe("stopped");
    expect(await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY)).toBeUndefined(); // no soft-stop stamp
  });

  it("(f) resume queued behind an aborting active prompt clears userStopped when the drain promotes it", async () => {
    const fakeState = createFakeState();
    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle & {
      userStopped: boolean;
    };
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider='e2b', runtime_state='running', runtime_sandbox_id='e2b-1', runtime_live_lease_expires_at=? WHERE session_id=?",
      Date.now() + 900_000,
      SESSION_ID,
    );
    // The prompt the user is aborting — mid-run.
    seedPrompt(fakeState.storage, {
      promptId: "p-active",
      sessionId: SESSION_ID,
      promptText: "original task",
      actorUserId: "user-1",
      status: "processing",
      startedAt: Date.now(),
    });
    const client = attachClient(fakeState) as unknown as { send: ReturnType<typeof vi.fn> };
    const sandboxSocket = attachLiveSandbox(fakeState, instance);

    // 1) User soft-stops the ACTIVE prompt: sandbox stays live, flag set + stamped.
    const stopRes = await instance.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    expect(stopRes.status).toBe(200);
    await fakeState.flushWaitUntil();
    expect(instance.userStopped).toBe(true);
    expect(typeof (await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY))).toBe("number");

    // 2) User submits the correction WHILE the aborting prompt is still processing → it queues
    //    behind p-active (enqueue admit does not fire, so the flag stays set).
    const enqRes = await instance.fetch(
      new Request("https://internal/session/prompts/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-user-id": "user-1" },
        body: JSON.stringify({ prompt: "add the bit I missed", actorUserId: "user-1" }),
      }),
    );
    expect(enqRes.status).toBe(200);
    await fakeState.flushWaitUntil();
    expect(instance.userStopped).toBe(true);
    expect(typeof (await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY))).toBe("number");

    // 3) The aborting prompt finalizes → the drain promotes + dispatches the queued resume prompt.
    const cbRes = await instance.fetch(
      new Request("https://internal/session/prompts/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promptId: "p-active", success: false, error: "Stopped by user" }),
      }),
    );
    expect(cbRes.status).toBe(200);
    await fakeState.flushWaitUntil();

    // The resume prompt runs on the live agent and the "Stopped" flag is cleared on promotion.
    expect((sandboxSocket as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalled();
    expect(instance.userStopped).toBe(false);
    expect(await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY)).toBeUndefined();
    // The wire frame the badge reads now carries userStopped:false.
    const frames = statusFrames(client);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1].userStopped).toBe(false);
  });

  it("(e) stop while plan approval is pending reads STOPPED, not waiting_for_input, on frame + snapshot + view", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    fakeState.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider='e2b', runtime_state='running', runtime_sandbox_id='e2b-1', runtime_live_lease_expires_at=? WHERE session_id=?",
      Date.now() + 900_000,
      SESSION_ID,
    );
    // Plan produced and parked awaiting approval — the state the reported bug fired in.
    upsertSessionPlan(fakeState.storage.sql as unknown as SqlStorage, {
      sessionId: SESSION_ID,
      planPromptId: "p-plan-1",
      implementationPromptId: null,
      markdown: "# Plan\n\nDo it",
      excerpt: "Do it",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 1,
      userEdited: false,
      approvedBy: null,
      approvedAt: null,
      source: "generated",
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle & {
      planApprovalPending: boolean;
      buildClientSessionSnapshot(sessionId: string): Promise<{ session: Record<string, unknown> }>;
    };
    await vi.waitFor(() => {
      expect(instance.planApprovalPending).toBe(true);
    });
    const client = attachClient(fakeState) as unknown as { send: ReturnType<typeof vi.fn> };
    attachLiveSandbox(fakeState, instance);

    const res = await instance.fetch(new Request("https://internal/session/stop", { method: "POST" }));
    expect(res.status).toBe(200);
    await fakeState.flushWaitUntil();

    // Sandbox kept live (live-idle stop) and the soft-stop marker stamped.
    expect(querySandboxState(fakeState.storage, SESSION_ID)?.status).toBe("ready");
    expect(typeof (await fakeState.storage.get(STOPPED_KEPT_ALIVE_AT_STORAGE_KEY))).toBe("number");

    // Live frame (WS path): user stop supersedes the plan-approval wait.
    const frame = statusFrames(client).at(-1);
    expect(frame).toMatchObject({
      phase: "idle",
      displayStatus: "stopped",
      userStopped: true,
      // Plan metadata is retained — the stored plan stays pending so
      // approve/discuss remain valid resume affordances.
      planApprovalPending: true,
      planStatus: "pending",
    });

    // Bootstrap snapshot (WS reconnect path) mirrors the frame.
    const bootstrap = await instance.buildClientSessionSnapshot(SESSION_ID);
    expect(bootstrap.session).toMatchObject({
      phase: "idle",
      displayStatus: "stopped",
      userStopped: true,
      planApprovalPending: true,
    });

    // HTTP view fetch (resilience poll / cold load) agrees with the WS paths.
    const stateRes = await instance.fetch(new Request("https://internal/session/state", { method: "GET" }));
    expect(stateRes.status).toBe(200);
    const statePayload = (await stateRes.json()) as { session: Record<string, unknown> };
    expect(statePayload.session).toMatchObject({
      phase: "idle",
      displayStatus: "stopped",
      userStopped: true,
      planApprovalPending: true,
    });
  });

  it("rehydrates authoritative pending-plan state on wake and carries metadata on frames and bootstrap", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(fakeState.storage, { sessionId: SESSION_ID, status: "ready" });
    upsertSessionPlan(fakeState.storage.sql as unknown as SqlStorage, {
      sessionId: SESSION_ID,
      planPromptId: "p-plan-3",
      implementationPromptId: null,
      markdown: "# Plan\n\nTest it",
      excerpt: "Test it",
      artifactId: null,
      valid: true,
      missingReason: null,
      missingHeadings: [],
      status: "pending",
      revision: 3,
      userEdited: false,
      approvedBy: null,
      approvedAt: null,
      source: "generated",
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv()) as unknown as DOTestHandle & {
      planApprovalPending: boolean;
      persistAndBroadcastSessionStatus(sessionId: string): Promise<string>;
      buildClientSessionSnapshot(sessionId: string): Promise<{ session: Record<string, unknown> }>;
    };
    await vi.waitFor(async () => {
      expect(instance.planApprovalPending).toBe(true);
      expect(await fakeState.storage.get("plan_approval_pending")).toBe(1);
    });

    const client = attachClient(fakeState) as unknown as { send: ReturnType<typeof vi.fn> };
    await instance.persistAndBroadcastSessionStatus(SESSION_ID);
    const frame = statusFrames(client).at(-1);
    expect(frame).toMatchObject({
      phase: "waiting_for_input",
      planApprovalPending: true,
      planRevision: 3,
      planStatus: "pending",
    });

    const bootstrap = await instance.buildClientSessionSnapshot(SESSION_ID);
    expect(bootstrap.session).toMatchObject({
      planApprovalPending: true,
      planRevision: 3,
      planStatus: "pending",
    });

    updateSessionPlanStatus(fakeState.storage.sql as unknown as SqlStorage, {
      sessionId: SESSION_ID,
      planPromptId: "p-plan-3",
      status: "approved",
    });
    await instance.persistAndBroadcastSessionStatus(SESSION_ID);
    expect(instance.planApprovalPending).toBe(false);
    expect(await fakeState.storage.get("plan_approval_pending")).toBeUndefined();
    expect(statusFrames(client).at(-1)).toMatchObject({
      phase: "idle",
      planApprovalPending: false,
      planRevision: 3,
      planStatus: "approved",
    });
  });
});
