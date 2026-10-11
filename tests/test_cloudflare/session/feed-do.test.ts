import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedDelta } from "../../../shared/types/session-feed";
import {
  FakeDurableState,
  FakeSqlStorage,
  mockCloudflareWorkers,
  mockSentryCloudflare,
} from "../helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

// Each new WebSocketPair() yields fresh fake sockets so we can assert per-socket
// sends. readyState 1 = OPEN (matches the DO's open-socket filter).
class FakeWebSocketPair {
  0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
}

type FakeSocket = { send: ReturnType<typeof vi.fn>; readyState: number };

describe("SessionFeedDO fan-out + repo-access gate", () => {
  let SessionFeedDO: typeof import("../../../apps/control-plane-worker/src/session/feed-do").SessionFeedDO;

  beforeAll(async () => {
    ({ SessionFeedDO } = await import("../../../apps/control-plane-worker/src/session/feed-do"));
  });

  beforeEach(() => {
    (globalThis as { WebSocketPair?: unknown }).WebSocketPair = FakeWebSocketPair;
  });

  afterEach(() => {
    delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  });

  function createDo() {
    const state = new FakeDurableState(new FakeSqlStorage());
    const instance = new SessionFeedDO(state as never, {} as never);
    return { state, instance };
  }

  // Connecting forwards an upgrade with the auth + repo-set headers, exactly as
  // the route does. The 101 Response with a fake WebSocketPair throws RangeError
  // in this runtime; by then the socket is accepted and the repo set seeded.
  async function connect(instance: { fetch(request: Request): Promise<Response> }, uid: string, repos: string[]) {
    try {
      await instance.fetch(
        new Request("https://internal/feed/ws", {
          headers: { upgrade: "websocket", "x-auth-user-id": uid, "x-feed-repos": JSON.stringify(repos) },
        }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
    }
  }

  function socketForUid(state: FakeDurableState<FakeSqlStorage>, uid: string): FakeSocket {
    const match = state.getWebSockets("feed").find((socket) => state.getTags(socket).includes(`uid:${uid}`));
    return match as FakeSocket;
  }

  const ownedDelta: FeedDelta = {
    type: "session_upserted",
    sessionId: "s-1",
    ownerUserId: "owner",
    repoOwner: "acme",
    repoName: "widgets",
    source: "session-create",
    session: {
      sessionId: "s-1",
      ownerUserId: "owner",
      businessId: "biz-1",
      phase: "running",
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: "demo",
      prUrl: null,
    },
  };

  it("delivers to owner and in-repo member, suppresses out-of-repo member", async () => {
    const { state, instance } = createDo();
    await connect(instance, "owner", []);
    await connect(instance, "member-in", ["acme/widgets"]);
    await connect(instance, "member-out", ["other/repo"]);

    expect(state.getWebSockets("feed")).toHaveLength(3);

    const res = await instance.fetch(
      new Request("https://internal/feed/publish", { method: "POST", body: JSON.stringify(ownedDelta) }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, delivered: 2, suppressed: 1 });

    expect(socketForUid(state, "owner").send).toHaveBeenCalledTimes(1);
    expect(socketForUid(state, "owner").send).toHaveBeenCalledWith(JSON.stringify(ownedDelta));
    expect(socketForUid(state, "member-in").send).toHaveBeenCalledTimes(1);
    expect(socketForUid(state, "member-out").send).not.toHaveBeenCalled();
  });

  it("delivers a delta with no repo context only to the owner", async () => {
    const { state, instance } = createDo();
    await connect(instance, "owner", []);
    await connect(instance, "member-in", ["acme/widgets"]);

    const noRepoDelta: FeedDelta = {
      type: "session_status",
      sessionId: "s-2",
      ownerUserId: "owner",
      repoOwner: null,
      repoName: null,
      source: "status",
      phase: "running",
    };

    const res = await instance.fetch(
      new Request("https://internal/feed/publish", { method: "POST", body: JSON.stringify(noRepoDelta) }),
    );
    await expect(res.json()).resolves.toMatchObject({ delivered: 1, suppressed: 1 });
    expect(socketForUid(state, "owner").send).toHaveBeenCalledTimes(1);
    expect(socketForUid(state, "member-in").send).not.toHaveBeenCalled();
  });

  it("delivers to a singleton-business owner (one socket)", async () => {
    const { state, instance } = createDo();
    await connect(instance, "owner", []);

    const res = await instance.fetch(
      new Request("https://internal/feed/publish", { method: "POST", body: JSON.stringify(ownedDelta) }),
    );
    await expect(res.json()).resolves.toMatchObject({ delivered: 1, suppressed: 0 });
    expect(socketForUid(state, "owner").send).toHaveBeenCalledTimes(1);
  });

  it("re-seeds the repo set on reconnect (later connect wins)", async () => {
    const { state, instance } = createDo();
    // First connect: member has no access.
    await connect(instance, "member", []);
    // Reconnect with access granted.
    await connect(instance, "member", ["acme/widgets"]);

    const res = await instance.fetch(
      new Request("https://internal/feed/publish", { method: "POST", body: JSON.stringify(ownedDelta) }),
    );
    const body = (await res.json()) as { delivered: number };
    // Both sockets for "member" now see it (the stored set is keyed by user, not socket).
    expect(body.delivered).toBe(2);
  });

  it("returns 426 without an upgrade header and 404 for unknown paths", async () => {
    const { instance } = createDo();
    const noUpgrade = await instance.fetch(new Request("https://internal/feed/ws"));
    expect(noUpgrade.status).toBe(426);
    const unknown = await instance.fetch(new Request("https://internal/nope"));
    expect(unknown.status).toBe(404);
  });

  it("rejects a structurally malformed publish body (no owner-suppression on {})", async () => {
    const { instance } = createDo();
    for (const body of ["{}", JSON.stringify({ sessionId: "s", ownerUserId: "o" })]) {
      const res = await instance.fetch(new Request("https://internal/feed/publish", { method: "POST", body }));
      expect(res.status).toBe(400);
    }
  });

  // The repo-access store must be revoked when a user's last tab closes but
  // RETAINED while another tab for the same user is still open — otherwise a
  // close either leaks a stale grant or prematurely revokes a live tab's gate.
  function repoAccessRows(state: FakeDurableState<FakeSqlStorage>, uid: string): unknown[] {
    return state.storage.sql.exec("SELECT user_id FROM feed_repo_access WHERE user_id = ?", uid).toArray();
  }

  function closeSocket(instance: unknown, socket: FakeSocket): Promise<void> {
    return (
      instance as { webSocketClose(ws: unknown, code: number, reason: string, wasClean: boolean): Promise<void> }
    ).webSocketClose(socket, 1000, "", true);
  }

  it("deletes a user's repo-access row when their last feed socket closes", async () => {
    const { state, instance } = createDo();
    await connect(instance, "solo", ["acme/widgets"]);
    expect(repoAccessRows(state, "solo")).toHaveLength(1);

    await closeSocket(instance, socketForUid(state, "solo"));
    expect(repoAccessRows(state, "solo")).toHaveLength(0);
  });

  it("retains the repo-access row while another tab for the same user is open", async () => {
    const { state, instance } = createDo();
    await connect(instance, "duo", ["acme/widgets"]);
    await connect(instance, "duo", ["acme/widgets"]);
    const sockets = state.getWebSockets("feed") as FakeSocket[];
    expect(sockets).toHaveLength(2);

    await closeSocket(instance, sockets[0]);
    // A sibling socket for "duo" is still open, so the grant must persist.
    expect(repoAccessRows(state, "duo")).toHaveLength(1);
  });
});
