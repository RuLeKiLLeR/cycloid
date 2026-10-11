/**
 * Tests for the SessionDO `sandbox_undersized` native-event branch: it must fire
 * the internal undersize notifier (with the repo identified via getSessionExtended
 * — the base session row omits repo owner/name) and must NOT broadcast, persist,
 * or project the alert into the customer's session timeline.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../../../apps/control-plane-worker/src/sandbox/undersize-notify.ts", () => ({
  notifySandboxUndersized: notifyMock,
}));

import * as doDb from "../../../apps/control-plane-worker/src/session/do-db.ts";
import { translateBridgeEventToCycloidEvent } from "../../../apps/sandbox-bridge/src/events/translate.ts";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySessionEvents,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = { SessionDO: new (state: unknown, env: unknown) => unknown };

interface DOTestHandle {
  processSandboxMessage(data: string, session: Record<string, unknown>): Promise<void>;
  persistenceQueue: Promise<void>;
}

function makeStoredPrompt() {
  const now = new Date().toISOString();
  return {
    promptId: "prompt-1",
    prompt: "Onboard the repo",
    actorUserId: "user-1",
    status: "processing",
    createdAt: now,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    result: null,
    error: null,
  };
}

async function createDOWithSession(workerModule: WorkerModule) {
  const env = createTestEnv();
  const fakeState = createFakeState();
  const sessionId = "test-session-1";
  const session = {
    sessionId,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    lastEventId: null,
    title: null,
  };
  await fakeState.storage.put("session", session);
  await fakeState.storage.put("activePromptId", "prompt-1");
  await fakeState.storage.put("prompts", [makeStoredPrompt()]);
  await fakeState.storage.put("replay", { sessionId, lastEventSequence: 0, lastEventTimestamp: null, updatedAt: null });
  await fakeState.storage.put("events", []);

  const instance = new workerModule.SessionDO(fakeState, env) as unknown as DOTestHandle;
  const mockSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  fakeState.acceptWebSocket(mockSocket, ["client", "wsid:test-client"]);
  const sandboxSocket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  fakeState.acceptWebSocket(sandboxSocket, ["sandbox", "gen:1", "sid:sbx-1"]);

  return { instance, fakeState, mockSocket, session, sessionId };
}

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

describe("SessionDO sandbox_undersized branch", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });
  beforeEach(() => notifyMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("fires the notifier with repo from getSessionExtended and does not project to the timeline", async () => {
    const getExtended = vi
      .spyOn(doDb, "getSessionExtended")
      .mockReturnValue({ repoOwner: "acme", repoName: "widget" } as never);
    const getSandbox = vi.spyOn(doDb, "getSandboxState").mockReturnValue({
      runtimeSandboxId: "e2b-runtime-1",
      runtimeBackend: "e2b_cloud",
    } as never);
    const { instance, fakeState, mockSocket, session, sessionId } = await createDOWithSession(workerModule);

    await instance.processSandboxMessage(mockMessageEvent({ type: "sandbox_undersized", oomKills: 3 }), session);
    await instance.persistenceQueue;

    expect(getExtended).toHaveBeenCalled();
    expect(getSandbox).toHaveBeenCalledWith(expect.anything(), sessionId);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1]).toMatchObject({
      sessionId,
      sandboxId: "e2b-runtime-1",
      runtimeBackend: "e2b_cloud",
      repoOwner: "acme",
      repoName: "widget",
      businessId: "biz-1",
      oomKills: 3,
    });

    // The internal alert must not leak into the customer's session timeline.
    const broadcasts = mockSocket.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(broadcasts.some((b) => b?.event?.type === "sandbox_undersized")).toBe(false);
    const persisted = querySessionEvents(fakeState.storage, sessionId) as Array<{ type?: string }>;
    expect(persisted.some((e) => String(e.type ?? "").includes("undersized"))).toBe(false);
  });

  it("omits the runtime sandbox id when sandbox state has not recorded one", async () => {
    vi.spyOn(doDb, "getSessionExtended").mockReturnValue({ repoOwner: "acme", repoName: "widget" } as never);
    vi.spyOn(doDb, "getSandboxState").mockReturnValue({ runtimeSandboxId: null, runtimeBackend: "e2b_cloud" } as never);
    const { instance, session } = await createDOWithSession(workerModule);

    await instance.processSandboxMessage(mockMessageEvent({ type: "sandbox_undersized", oomKills: 1 }), session);
    await instance.persistenceQueue;

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][1]).toMatchObject({ sandboxId: null, runtimeBackend: "e2b_cloud" });
    expect(notifyMock.mock.calls[0][1]).not.toHaveProperty("sandboxId", "sbx-1");
  });

  it("does not fire for unrelated sandbox events", async () => {
    vi.spyOn(doDb, "getSessionExtended").mockReturnValue({ repoOwner: "acme", repoName: "widget" } as never);
    const { instance, session } = await createDOWithSession(workerModule);

    await instance.processSandboxMessage(mockMessageEvent({ type: "heartbeat", status: "ready" }), session);
    await instance.persistenceQueue;

    expect(notifyMock).not.toHaveBeenCalled();
  });
});
