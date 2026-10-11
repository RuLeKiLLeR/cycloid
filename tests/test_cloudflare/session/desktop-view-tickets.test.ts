import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY,
  LIFECYCLE_SANDBOX_STATE_STORAGE_KEY,
} from "../../../apps/control-plane-worker/src/constants/sessions";
import { createFakeState, mockCloudflareWorkers, mockSentryCloudflare, seedSandboxState, seedSession } from "./helpers";

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

const SESSION_ID = "session-desktop-view-ticket";
const USER_ID = "viewer-1";
const BASE_NOW_MS = Date.parse("2026-07-07T00:00:00.000Z");

function authHeaders(userId = USER_ID, canAccessAll = false): HeadersInit {
  return {
    "x-auth-user-id": userId,
    "x-auth-can-access-all": canAccessAll ? "true" : "false",
    "content-type": "application/json",
  };
}

async function createTicket(instance: { fetch(request: Request): Promise<Response> }) {
  const response = await instance.fetch(
    new Request("https://internal/session/desktop/view-ticket", {
      method: "POST",
      headers: authHeaders(),
    }),
  );
  const body = (await response.json()) as {
    ok: true;
    ticket: {
      ticketId: string;
      expiresAtMs: number;
      hardExpiresAtMs: number;
      heartbeatIntervalMs: number;
      viewOnly: boolean;
    };
  };
  return { response, body };
}

async function postTicket(
  instance: { fetch(request: Request): Promise<Response> },
  path: "heartbeat" | "revoke" | "status" | "connect" | "close",
  body: Record<string, unknown>,
  userId = USER_ID,
  canAccessAll = false,
) {
  const response = await instance.fetch(
    new Request(`https://internal/session/desktop/view-ticket/${path}`, {
      method: "POST",
      headers: authHeaders(userId, canAccessAll),
      body: JSON.stringify(body),
    }),
  );
  return {
    response,
    body: response.ok ? ((await response.json()) as Record<string, unknown>) : null,
  };
}

function connectionId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("SessionDO desktop view tickets", () => {
  let workerModule: WorkerModule;
  let nowMs = BASE_NOW_MS;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    nowMs = BASE_NOW_MS;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createInstance() {
    const state = createFakeState();
    seedSession(state.storage, {
      sessionId: SESSION_ID,
      ownerUserId: USER_ID,
      businessId: "biz-1",
      repoOwner: "trycycloid",
      repoName: "cycloid",
    });
    const instance = new workerModule.SessionDO(state, { WORKER_ENV: "test" });
    return { state, instance };
  }

  it("creates, heartbeats, revokes, and rejects stale or cross-user tickets", async () => {
    const { instance } = createInstance();
    const created = await createTicket(instance);
    expect(created.response.status).toBe(200);
    expect(created.body.ticket.ticketId).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(created.body.ticket).sort()).toEqual([
      "expiresAtMs",
      "hardExpiresAtMs",
      "heartbeatIntervalMs",
      "ticketId",
      "viewOnly",
    ]);

    nowMs = Date.parse("2026-07-07T00:00:30.000Z");
    const heartbeat = await postTicket(instance, "heartbeat", { ticketId: created.body.ticket.ticketId });
    expect(heartbeat.response.status).toBe(200);
    expect((heartbeat.body?.ticket as { expiresAtMs: number }).expiresAtMs).toBeGreaterThan(
      created.body.ticket.expiresAtMs,
    );
    expect((heartbeat.body?.ticket as { hardExpiresAtMs: number }).hardExpiresAtMs).toBe(
      created.body.ticket.hardExpiresAtMs,
    );

    const crossUser = await postTicket(
      instance,
      "heartbeat",
      { ticketId: created.body.ticket.ticketId },
      "other-user",
      true,
    );
    expect(crossUser.response.status).toBe(403);

    const revoke = await postTicket(instance, "revoke", { ticketId: created.body.ticket.ticketId });
    expect(revoke.response.status).toBe(200);
    expect(revoke.body).toEqual({ ok: true, revoked: true });

    const revokedHeartbeat = await postTicket(instance, "heartbeat", { ticketId: created.body.ticket.ticketId });
    expect(revokedHeartbeat.response.status).toBe(410);

    const stale = await createTicket(instance);
    nowMs = stale.body.ticket.hardExpiresAtMs + 1;
    const staleConnect = await postTicket(instance, "connect", {
      ticketId: stale.body.ticket.ticketId,
      connectionId: connectionId(99),
    });
    expect(staleConnect.response.status).toBe(410);
  });

  it("does not treat desktop viewer heartbeats as bridge liveness", async () => {
    const { state, instance } = createInstance();
    const staleBridgeHeartbeatAt = BASE_NOW_MS - 120_000;
    const staleLivenessDeadline = BASE_NOW_MS - 60_000;
    await state.storage.put(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY, {
      state: "ready",
      sandboxId: "sandbox-bridge-1",
      lastHeartbeatAt: staleBridgeHeartbeatAt,
    });
    await state.storage.put(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY, staleLivenessDeadline);

    const created = await createTicket(instance);
    nowMs = BASE_NOW_MS + 30_000;
    const heartbeat = await postTicket(instance, "heartbeat", { ticketId: created.body.ticket.ticketId });

    expect(heartbeat.response.status).toBe(200);
    expect(await state.storage.get(LIFECYCLE_SANDBOX_STATE_STORAGE_KEY)).toMatchObject({
      lastHeartbeatAt: staleBridgeHeartbeatAt,
    });
    expect(await state.storage.get(LIFECYCLE_SANDBOX_LIVENESS_DEADLINE_STORAGE_KEY)).toBe(staleLivenessDeadline);
  });

  it("rejects desktop ticket creation after terminal sandbox failure", async () => {
    const { state, instance } = createInstance();
    seedSandboxState(state.storage, {
      sessionId: SESSION_ID,
      status: "stopped",
      sandboxId: "sandbox-dead",
    });
    state.storage.sql.exec(
      "UPDATE sandbox_state SET runtime_provider = ?, runtime_backend = ?, runtime_state = ?, runtime_sandbox_id = ?, stop_reason = ? WHERE session_id = ?",
      "e2b",
      "e2b_cloud",
      "paused",
      "runtime-dead",
      "reaped",
      SESSION_ID,
    );

    const response = await instance.fetch(
      new Request("https://internal/session/desktop/view-ticket", {
        method: "POST",
        headers: authHeaders(),
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      code: "desktop_view_unavailable",
      reason: "sandbox_stopped",
      errorDetails: {
        desktopViewRetryable: false,
        desktopViewReason: "sandbox_stopped",
      },
    });
  });

  it("enforces the connected-viewer cap and releases capacity on close", async () => {
    const { instance } = createInstance();
    const tickets: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const created = await createTicket(instance);
      tickets.push(created.body.ticket.ticketId);
      const connected = await postTicket(instance, "connect", {
        ticketId: created.body.ticket.ticketId,
        connectionId: connectionId(index),
      });
      expect(connected.response.status).toBe(200);
    }

    const sixth = await createTicket(instance);
    const blocked = await postTicket(instance, "connect", {
      ticketId: sixth.body.ticket.ticketId,
      connectionId: connectionId(6),
    });
    expect(blocked.response.status).toBe(409);

    const closed = await postTicket(instance, "close", {
      ticketId: tickets[0],
      connectionId: connectionId(0),
      reason: "client_closed",
      detail: "upstream_closed_after_ready",
      diagnostics: {
        phase: "ready",
        reason: "upstream_closed_after_ready",
        durationMs: 123,
        statusCode: 200,
        retryable: false,
        runtimeState: "running",
        supervisorExitCode: 0,
        supervisorHealthDisplay: ":99",
        supervisorHealthWidth: 1280,
        supervisorHealthHeight: 720,
        supervisorHealthScreenshotOk: true,
        supervisorHealthScreenshotNonBlackPixelRatio: 0.9,
        supervisorHealthScreenshotEntropy: 2.5,
        supervisorHealthScreenshotUniform: false,
        providerErrorCode: "rate_limit",
        providerErrorStatus: 429,
        providerErrorRetryAfterMs: 1500,
        providerErrorRequestSent: true,
        websocketCloseSource: "upstream",
        websocketCloseCode: 1006,
        websocketCloseReason: "upstream reset",
        websocketCloseWasClean: false,
      },
    });
    expect(closed.response.status).toBe(200);
    expect(closed.body).toEqual({ ok: true, closed: true });
    const status = await postTicket(instance, "status", { ticketId: tickets[0] });
    expect(status.response.status).toBe(200);
    expect(status.body).toMatchObject({
      ok: true,
      connectionId: connectionId(0),
      closeReason: "client_closed",
      closeDetail: "upstream_closed_after_ready",
      closeDiagnostics: {
        phase: "ready",
        reason: "upstream_closed_after_ready",
        durationMs: 123,
        statusCode: 200,
        retryable: false,
        runtimeState: "running",
        supervisorExitCode: 0,
        supervisorHealthDisplay: ":99",
        supervisorHealthWidth: 1280,
        supervisorHealthHeight: 720,
        supervisorHealthScreenshotOk: true,
        supervisorHealthScreenshotNonBlackPixelRatio: 0.9,
        supervisorHealthScreenshotEntropy: 2.5,
        supervisorHealthScreenshotUniform: false,
        providerErrorCode: "rate_limit",
        providerErrorStatus: 429,
        providerErrorRetryAfterMs: 1500,
        providerErrorRequestSent: true,
        websocketCloseSource: "upstream",
        websocketCloseCode: 1006,
        websocketCloseReason: "upstream reset",
        websocketCloseWasClean: false,
      },
      revoked: false,
      expired: false,
    });

    const reconnectedClosedTicket = await postTicket(instance, "connect", {
      ticketId: tickets[0],
      connectionId: connectionId(50),
    });
    expect(reconnectedClosedTicket.response.status).toBe(409);

    const connectedAfterClose = await postTicket(instance, "connect", {
      ticketId: sixth.body.ticket.ticketId,
      connectionId: connectionId(6),
    });
    expect(connectedAfterClose.response.status).toBe(200);
  });

  it("chunks indexed ticket reads and cleanup deletes over 128 storage keys", async () => {
    const { state, instance } = createInstance();
    const storage = state.storage as {
      get(keyOrKeys: string | string[]): Promise<unknown>;
      delete(keyOrKeys: string | string[]): Promise<boolean>;
    };
    const getBatchSizes: number[] = [];
    const deleteBatchSizes: number[] = [];
    const originalGet = storage.get.bind(storage);
    const originalDelete = storage.delete.bind(storage);
    vi.spyOn(storage, "get").mockImplementation(async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        getBatchSizes.push(keyOrKeys.length);
        if (keyOrKeys.length > 128) throw new Error(`oversized get: ${keyOrKeys.length}`);
      }
      return originalGet(keyOrKeys);
    });
    vi.spyOn(storage, "delete").mockImplementation(async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        deleteBatchSizes.push(keyOrKeys.length);
        if (keyOrKeys.length > 128) throw new Error(`oversized delete: ${keyOrKeys.length}`);
      }
      return originalDelete(keyOrKeys);
    });

    let lastCreated: Awaited<ReturnType<typeof createTicket>> | null = null;
    for (let index = 0; index < 130; index += 1) {
      lastCreated = await createTicket(instance);
      expect(lastCreated.response.status).toBe(200);
    }
    expect(lastCreated).not.toBeNull();
    if (!lastCreated) throw new Error("expected at least one desktop view ticket");

    nowMs = lastCreated.body.ticket.hardExpiresAtMs + 60 * 60_000 + 1;
    const cleanupTicket = await createTicket(instance);
    expect(cleanupTicket.response.status).toBe(200);

    expect(getBatchSizes.some((size) => size === 128)).toBe(true);
    expect(deleteBatchSizes).toEqual([128, 2]);
    expect([...getBatchSizes, ...deleteBatchSizes].every((size) => size <= 128)).toBe(true);
  });
});
