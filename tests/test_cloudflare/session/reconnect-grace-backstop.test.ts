import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
  SANDBOX_HEARTBEAT_LIVENESS_MS,
  SANDBOX_LOSS_RECOVERY_BUDGET_MS,
} from "../../../apps/control-plane-worker/src/constants/sessions";
import { createEmptyLifecycleState } from "../../../apps/control-plane-worker/src/session/lifecycle/types";
import { ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY } from "../../../apps/control-plane-worker/src/session/ws-manager";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  querySandboxState,
  seedSandboxState,
  seedSession,
} from "./helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => { alarm(): Promise<void> };
};

const SESSION_ID = "reconnect-grace-backstop-session";
const NOW = 10_000_000;

describe("reconnect-grace alarm backstop", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function build(socketSandboxId: string | null) {
    const state = createFakeState();
    const instance = new workerModule.SessionDO(state, createTestEnv());
    seedSession(state.storage, { sessionId: SESSION_ID, ownerUserId: "user-1", status: "active" });
    seedSandboxState(state.storage, {
      sessionId: SESSION_ID,
      status: "reconnecting",
      sandboxId: null,
      disconnectStartedAt: NOW - 1_000,
    });
    const lifecycle = createEmptyLifecycleState();
    lifecycle.sandbox.state = "reconnecting";
    lifecycle.deadlines.sandboxReconnectGrace = NOW - 1;
    await state.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, lifecycle.sandbox);
    await state.storage.put(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY, NOW - 1);
    const socketTags = ["sandbox", "gen:2", ...(socketSandboxId ? [`sid:${socketSandboxId}`] : [])];
    state.acceptWebSocket({ readyState: 1, send: vi.fn(), close: vi.fn() }, socketTags);
    await state.storage.put(ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY, {
      acceptedVersionId: null,
      authenticatedRuntimeSandboxId: socketSandboxId,
      connectionGeneration: 2,
      acceptedAtMs: NOW - 500,
    });
    return { state, instance };
  }

  it("recovers the sandbox id from the live socket tag and re-arms liveness", async () => {
    const { state, instance } = await build("sandbox-from-tag");

    await instance.alarm();

    expect(querySandboxState(state.storage, SESSION_ID)).toMatchObject({
      status: "ready",
      sandbox_id: "sandbox-from-tag",
    });
    expect(await state.storage.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY)).toBeUndefined();
    expect(await state.storage.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY)).toBe(
      NOW + SANDBOX_HEARTBEAT_LIVENESS_MS,
    );
  });

  it("re-arms reconnect grace when neither state nor the socket proves a sandbox id", async () => {
    const { state, instance } = await build(null);

    await instance.alarm();

    expect(querySandboxState(state.storage, SESSION_ID)?.status).toBe("reconnecting");
    expect(await state.storage.get(LIFECYCLE_SANDBOX_RECONNECT_GRACE_DEADLINE_STORAGE_KEY)).toBe(
      NOW + SANDBOX_LOSS_RECOVERY_BUDGET_MS,
    );
  });
});
