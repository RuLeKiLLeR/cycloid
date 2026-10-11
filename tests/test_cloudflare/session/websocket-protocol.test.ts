import { beforeAll, describe, expect, it, vi } from "vitest";

import { SEEDED_BUSINESS_IDS } from "../../../apps/control-plane-worker/src/constants/businesses.ts";
import { bulkUpdatePrompts, getPrompts } from "../../../apps/control-plane-worker/src/session/do-db.ts";
import {
  ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY,
  OUTBOX_SIGNING_KEY_STORAGE_KEY,
  SANDBOX_WS_AUTH_STORAGE_PREFIX,
} from "../../../apps/control-plane-worker/src/session/ws-manager.ts";
import type { PromptState } from "../../../apps/control-plane-worker/src/types.ts";
import { computeSha256Hex } from "../../../apps/control-plane-worker/src/utils.ts";
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_PROTOCOL_VERSION_HEADER } from "../../../shared/constants/bridge-protocol.ts";
import { REPLAY_WINDOW_SIZE } from "../../../shared/constants/session.js";
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
  SessionDO: new (
    state: unknown,
    env: unknown,
  ) => {
    fetch(request: Request): Promise<Response>;
    webSocketMessage(ws: unknown, message: string): Promise<void>;
  };
};

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "test-session-1",
    ownerUserId: "user-1",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    lastEventId: null,
    title: null,
    ...overrides,
  };
}

function insertPrompt(sql: SqlStorage, sessionId: string, prompt: PromptState): void {
  bulkUpdatePrompts(sql, sessionId, [...getPrompts(sql, sessionId), prompt]);
}

function clientWsRequest(url = "https://internal/session/ws", headers: HeadersInit = {}): Request {
  return new Request(url, {
    headers: {
      upgrade: "websocket",
      "x-auth-user-id": "user-1",
      "x-auth-can-access-all": "false",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

class UserProfileD1Statement {
  constructor(
    private readonly users: Map<string, { login: string; avatar_url: string | null }>,
    private readonly queryCounts: Map<string, number>,
    private readonly failures: Set<string>,
    private readonly queryBatches: string[][],
    private readonly query: string,
  ) {}

  private userIds: string[] = [];

  bind(...userIds: string[]): this {
    this.userIds = userIds;
    return this;
  }

  async first(): Promise<{ login: string; avatar_url: string | null } | null> {
    const rows = await this.all<{ login: string; avatar_url: string | null }>();
    return rows.results[0] ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    expect(this.query).toMatch(/^SELECT id, login, avatar_url FROM users WHERE id IN \((\?,? ?)+\)$/);
    this.queryBatches.push([...this.userIds]);
    for (const userId of this.userIds) {
      this.queryCounts.set(userId, (this.queryCounts.get(userId) ?? 0) + 1);
      if (this.failures.delete(userId)) throw new Error(`transient failure for ${userId}`);
    }
    return {
      results: this.userIds
        .map((userId) => {
          const user = this.users.get(userId);
          return user ? ({ id: userId, ...user } as T) : null;
        })
        .filter((row): row is T => row !== null),
    };
  }
}

class UserProfileD1 {
  readonly users = new Map<string, { login: string; avatar_url: string | null }>();
  readonly queryCounts = new Map<string, number>();
  readonly failures = new Set<string>();
  readonly queryBatches: string[][] = [];

  prepare(query: string): UserProfileD1Statement {
    return new UserProfileD1Statement(this.users, this.queryCounts, this.failures, this.queryBatches, query);
  }

  failOnce(userId: string): void {
    this.failures.add(userId);
  }

  queryCount(userId: string): number {
    return this.queryCounts.get(userId) ?? 0;
  }

  batchCount(userIds: string[]): number {
    return this.queryBatches.filter(
      (batch) => batch.length === userIds.length && batch.every((userId, index) => userId === userIds[index]),
    ).length;
  }
}

describe("SessionDO client websocket protocol", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../../apps/control-plane-worker/src/session/durable-object.ts")) as WorkerModule;
  });

  it("rejects client websocket upgrades without internal auth headers", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      status: session.status,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const response = await instance.fetch(
      new Request("https://internal/session/ws", {
        headers: { upgrade: "websocket" },
      }),
    );

    expect(response.status).toBe(404);
    expect(fakeState.getWebSockets("client")).toHaveLength(0);
  });

  it("sends a subscribed snapshot with batched replay events", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    const replayEvents = [
      { sequence: 1, type: "prompt_processing", data: { promptId: "p-1" } },
      { sequence: 2, type: "text", data: { promptId: "p-1", text: "hello" } },
    ];

    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      status: session.status,
    });
    insertPrompt(fakeState.storage.sql, session.sessionId, {
      promptId: "p-1",
      prompt: "Follow up from a teammate",
      actorUserId: "user-2",
      status: "processing",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });
    insertPrompt(fakeState.storage.sql, session.sessionId, {
      promptId: "p-2",
      prompt: "Follow up from another teammate",
      actorUserId: "user-3",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });
    for (const event of replayEvents) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        event.sequence,
        `event-${event.sequence}`,
        session.sessionId,
        event.data.promptId,
        event.type,
        Date.now(),
        JSON.stringify(event.data),
      );
    }
    await fakeState.storage.put("replay", {
      sessionId: session.sessionId,
      lastEventSequence: 2,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const db = new UserProfileD1();
    db.users.set("user-1", { login: "session-owner", avatar_url: "https://avatars.example.com/user-1.png" });
    db.users.set("user-2", { login: "teammate", avatar_url: "https://avatars.example.com/user-2.png" });
    db.users.set("user-3", { login: "reviewer", avatar_url: "https://avatars.example.com/user-3.png" });
    const instance = new workerModule.SessionDO(fakeState, { ...createTestEnv(), DB: db });
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    expect(fakeState.getTags(clientSocket)).toContain("uid:user-1");

    const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: "subscribed",
      version: 2,
      lastDurableSequence: 2,
      queue: {
        queuedCount: 1,
        // p-1 is seeded with status="processing" above; with the derived
        // active-prompt-id helper (session.active_prompt_id was dropped in
        // migration 70), processingPromptId now reflects the prompts table
        // directly instead of a separately-set pointer.
        processingPromptId: "p-1",
      },
      replay: {
        afterSequence: 0,
        hasMore: false,
        droppedCount: 0,
        firstSequence: 1,
        lastSequence: 2,
        events: [
          {
            sequence: 1,
            type: "prompt_processing",
            data: { promptId: "p-1" },
          },
          {
            sequence: 2,
            type: "text",
            data: { promptId: "p-1", text: "hello" },
          },
        ],
      },
      session: {
        sessionId: "test-session-1",
        ownerUserId: "user-1",
        ownerLogin: "session-owner",
        ownerAvatarUrl: "https://avatars.example.com/user-1.png",
        // Was "idle" before PR2; the derived active-prompt-id reflects the
        // seeded processing p-1, so the phase computation now flips to
        // "running" (a processing prompt means a running session).
        phase: "running",
      },
      prompts: [
        {
          promptId: "p-1",
          actorUserId: "user-2",
          actorLogin: "teammate",
          actorAvatarUrl: "https://avatars.example.com/user-2.png",
        },
        {
          promptId: "p-2",
          actorUserId: "user-3",
          actorLogin: "reviewer",
          actorAvatarUrl: "https://avatars.example.com/user-3.png",
        },
      ],
      sandbox: {
        status: null,
        connected: false,
      },
    });
    expect(db.queryCount("user-2")).toBe(1);
    expect(db.queryCount("user-3")).toBe(1);
    expect(db.batchCount(["user-2", "user-3"])).toBe(1);

    const cachedPromptsResponse = await instance.fetch(new Request("https://internal/session/prompts"));
    expect(cachedPromptsResponse.status).toBe(200);
    await cachedPromptsResponse.json();
    expect(db.queryCount("user-2")).toBe(1);
    expect(db.queryCount("user-3")).toBe(1);
  });

  it("broadcasts a fresh subscribed snapshot on the internal snapshot endpoint", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      status: session.status,
    });
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }

      const clientSocket = fakeState.getWebSockets("client")[0] as { send: ReturnType<typeof vi.fn> };
      expect(clientSocket.send).toHaveBeenCalledTimes(1);

      const response = await instance.fetch(
        new Request("https://internal/session/broadcast-snapshot", { method: "POST" }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });

      expect(clientSocket.send).toHaveBeenCalledTimes(2);
      const broadcast = JSON.parse(clientSocket.send.mock.calls[1]?.[0] as string);
      expect(broadcast).toMatchObject({
        type: "subscribed",
        version: 2,
        session: { sessionId: session.sessionId },
      });
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }
  });

  it("includes desktop action path availability in the subscribed snapshot", async () => {
    const fakeState = createFakeState();
    const session = makeSession({ model: "kimi-k2.7-code" });
    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      businessId: SEEDED_BUSINESS_IDS.cycloid,
      status: session.status,
      model: "kimi-k2.7-code",
      agentRuntimeBackend: "opencode",
    });
    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    const payload = JSON.parse(clientSocket.send.mock.calls[0]?.[0] as string);

    expect(payload).toMatchObject({
      type: "subscribed",
      session: {
        sessionId: session.sessionId,
        desktopActionPathAvailable: true,
      },
    });
  });

  it("retries actor profile lookup after a transient D1 failure", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      status: session.status,
    });
    insertPrompt(fakeState.storage.sql, session.sessionId, {
      promptId: "p-1",
      prompt: "Follow up from a teammate",
      actorUserId: "user-2",
      status: "processing",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      updatedAt: new Date().toISOString(),
      result: null,
      error: null,
    });

    const db = new UserProfileD1();
    db.users.set("user-2", { login: "teammate", avatar_url: "https://avatars.example.com/user-2.png" });
    db.failOnce("user-2");
    const instance = new workerModule.SessionDO(fakeState, { ...createTestEnv(), DB: db });

    const failedLookupResponse = await instance.fetch(new Request("https://internal/session/prompts"));
    expect(failedLookupResponse.status).toBe(200);
    const failedLookupPayload = (await failedLookupResponse.json()) as {
      prompts: Array<{ actorLogin?: string; actorAvatarUrl?: string }>;
    };
    expect(failedLookupPayload).toMatchObject({
      ok: true,
      prompts: [
        {
          promptId: "p-1",
          actorUserId: "user-2",
        },
      ],
    });
    expect(failedLookupPayload.prompts[0]?.actorLogin).toBeUndefined();
    expect(failedLookupPayload.prompts[0]?.actorAvatarUrl).toBeUndefined();

    const retriedLookupResponse = await instance.fetch(new Request("https://internal/session/prompts"));
    expect(retriedLookupResponse.status).toBe(200);
    await expect(retriedLookupResponse.json()).resolves.toMatchObject({
      ok: true,
      prompts: [
        {
          promptId: "p-1",
          actorUserId: "user-2",
          actorLogin: "teammate",
          actorAvatarUrl: "https://avatars.example.com/user-2.png",
        },
      ],
    });
    expect(db.queryCount("user-2")).toBe(2);
  });

  it("returns replay metadata from SQL-backed event rows", async () => {
    const fakeState = createFakeState();
    const session = makeSession();
    const lastEventTimestamp = "2026-04-01T12:03:00.000Z";

    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      status: session.status,
    });
    fakeState.storage.sql.exec(
      `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
      7,
      "event-7",
      session.sessionId,
      null,
      "session_error",
      Date.parse(lastEventTimestamp),
      JSON.stringify({ error: "boom" }),
    );

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const response = await instance.fetch(new Request("https://internal/session/replay"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      replay: {
        sessionId: session.sessionId,
        lastEventSequence: 7,
        lastEventTimestamp,
      },
    });
  });

  it("includes closeReason in the subscribed snapshot for archived sessions", async () => {
    const fakeState = createFakeState();
    const session = makeSession({ status: "archived", closedAt: new Date().toISOString() });

    seedSession(fakeState.storage, {
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      status: "archived",
      closedAt: Date.now(),
      prUrl: "https://github.com/acme/repo/pull/42",
    });
    fakeState.storage.sql.exec(
      `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
      1,
      "event-1",
      session.sessionId,
      null,
      "session_closed",
      Date.now(),
      JSON.stringify({ reason: "pr_merged", prUrl: "https://github.com/acme/repo/pull/42" }),
    );

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));

    expect(payloads[0]).toMatchObject({
      type: "subscribed",
      session: {
        sessionId: "test-session-1",
        phase: "archived",
        prUrl: "https://github.com/acme/repo/pull/42",
        closeReason: "pr_merged",
      },
    });
  });

  it("serves older replay pages over the websocket", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: "test-session-1",
      ownerUserId: "user-1",
      status: "active",
    });

    for (let sequence = 1; sequence <= 5; sequence++) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        `event-${sequence}`,
        "test-session-1",
        "p-1",
        "text",
        Date.now(),
        JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
      );
    }

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    clientSocket.send.mockClear();

    await (
      instance as unknown as {
        webSocketMessage(ws: unknown, message: string): Promise<void>;
      }
    ).webSocketMessage(
      clientSocket,
      JSON.stringify({
        type: "request_replay_page",
        beforeSequence: 4,
        limit: 2,
      }),
    );

    const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: "replay_page",
      afterSequence: 0,
      beforeSequence: 4,
      hasMore: true,
      droppedCount: 1,
      firstSequence: 2,
      lastSequence: 3,
      events: [
        {
          sequence: 2,
          type: "text",
          data: { promptId: "p-1", id: "t-2", text: "chunk-2" },
        },
        {
          sequence: 3,
          type: "text",
          data: { promptId: "p-1", id: "t-3", text: "chunk-3" },
        },
      ],
    });
  });

  it("allows replay reads but rejects mutating frames on read-only impersonation websockets", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: "test-session-1",
      ownerUserId: "user-1",
      status: "active",
    });

    for (let sequence = 1; sequence <= 2; sequence++) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        `event-${sequence}`,
        "test-session-1",
        "p-1",
        "text",
        Date.now(),
        JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
      );
    }

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest("https://internal/session/ws", { "x-auth-impersonation-id": "imp-1" }));
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    expect(fakeState.getTags(clientSocket)).toEqual(
      expect.arrayContaining(["client", "uid:user-1", "readonly", "imp:imp-1"]),
    );

    clientSocket.send.mockClear();
    await (
      instance as unknown as {
        webSocketMessage(ws: unknown, message: string): Promise<void>;
      }
    ).webSocketMessage(
      clientSocket,
      JSON.stringify({
        type: "request_replay_page",
        afterSequence: 0,
        limit: 1,
      }),
    );

    expect(clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string))[0]).toMatchObject({
      type: "replay_page",
      events: [{ sequence: 2, type: "text" }],
    });

    clientSocket.send.mockClear();
    await (
      instance as unknown as {
        webSocketMessage(ws: unknown, message: string): Promise<void>;
      }
    ).webSocketMessage(
      clientSocket,
      JSON.stringify({
        type: "send_prompt",
        prompt: "mutate",
      }),
    );

    expect(clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string))).toEqual([
      {
        type: "replay_error",
        message: "Forbidden: session WebSocket is read-only",
      },
    ]);
  });

  it("replays missed events on resume messages", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: "test-session-1",
      ownerUserId: "user-1",
      status: "active",
    });

    for (let sequence = 1; sequence <= 3; sequence++) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        `event-${sequence}`,
        "test-session-1",
        "p-1",
        "text",
        Date.now(),
        JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
      );
    }

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    clientSocket.send.mockClear();

    await (
      instance as unknown as {
        webSocketMessage(ws: unknown, message: string): Promise<void>;
      }
    ).webSocketMessage(
      clientSocket,
      JSON.stringify({
        type: "resume",
        afterSequence: 1,
      }),
    );

    const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
    expect(payloads).toEqual([
      {
        type: "replay_event",
        event: {
          sequence: 2,
          type: "text",
          data: { promptId: "p-1", id: "t-2", text: "chunk-2", timestamp: expect.any(String) },
        },
      },
      {
        type: "replay_event",
        event: {
          sequence: 3,
          type: "text",
          data: { promptId: "p-1", id: "t-3", text: "chunk-3", timestamp: expect.any(String) },
        },
      },
    ]);
  });

  it("replays only the missing durable events in the subscribed snapshot after reconnect", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: "test-session-1",
      ownerUserId: "user-1",
      status: "active",
    });

    for (let sequence = 1; sequence <= 3; sequence++) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        `event-${sequence}`,
        "test-session-1",
        "p-1",
        "text",
        Date.now(),
        JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
      );
    }
    await fakeState.storage.put("replay", {
      sessionId: "test-session-1",
      lastEventSequence: 3,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }

      for (let sequence = 4; sequence <= 5; sequence++) {
        fakeState.storage.sql.exec(
          `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
          sequence,
          `event-${sequence}`,
          "test-session-1",
          "p-1",
          "text",
          Date.now(),
          JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
        );
      }
      await fakeState.storage.put("replay", {
        sessionId: "test-session-1",
        lastEventSequence: 5,
        lastEventTimestamp: null,
        updatedAt: null,
      });

      try {
        await instance.fetch(clientWsRequest("https://internal/session/ws?afterSequence=3"));
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSockets = fakeState.getWebSockets("client");
    expect(clientSockets).toHaveLength(2);

    const reconnectSocket = clientSockets[1] as {
      send: ReturnType<typeof vi.fn>;
    };
    const payloads = reconnectSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: "subscribed",
      version: 2,
      lastDurableSequence: 5,
      replay: {
        afterSequence: 3,
        hasMore: false,
        droppedCount: 0,
        firstSequence: 4,
        lastSequence: 5,
        events: [
          { sequence: 4, type: "text", data: { promptId: "p-1", id: "t-4", text: "chunk-4" } },
          { sequence: 5, type: "text", data: { promptId: "p-1", id: "t-5", text: "chunk-5" } },
        ],
      },
    });
    expect(fakeState.storage.sql.exec("SELECT COUNT(*) AS count FROM ws_recovery").toArray()[0]).toEqual({ count: 0 });
  });

  it("emits replay_truncated after a subscribed replay gap exceeds the websocket replay window", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: "test-session-1",
      ownerUserId: "user-1",
      status: "active",
    });

    const totalEvents = REPLAY_WINDOW_SIZE + 50;
    for (let sequence = 1; sequence <= totalEvents; sequence++) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        `event-${sequence}`,
        "test-session-1",
        "p-1",
        "text",
        Date.now(),
        JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
      );
    }
    await fakeState.storage.put("replay", {
      sessionId: "test-session-1",
      lastEventSequence: totalEvents,
      lastEventTimestamp: null,
      updatedAt: null,
    });

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest("https://internal/session/ws?afterSequence=1"));
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const reconnectSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    const payloads = reconnectSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      type: "subscribed",
      replay: {
        afterSequence: 1,
        hasMore: true,
        droppedCount: 1,
        firstSequence: 51,
        lastSequence: totalEvents,
      },
    });
    expect(payloads[1]).toEqual({
      type: "replay_truncated",
      requestedAfterSequence: 1,
      firstReturnedSequence: 51,
      lastReturnedSequence: totalEvents,
      droppedCount: 1,
    });
  });

  it("emits replay_truncated after replaying a truncated resume window", async () => {
    const fakeState = createFakeState();
    seedSession(fakeState.storage, {
      sessionId: "test-session-1",
      ownerUserId: "user-1",
      status: "active",
    });

    const totalEvents = REPLAY_WINDOW_SIZE + 50;
    for (let sequence = 1; sequence <= totalEvents; sequence++) {
      fakeState.storage.sql.exec(
        `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
        sequence,
        `event-${sequence}`,
        "test-session-1",
        "p-1",
        "text",
        Date.now(),
        JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
      );
    }

    const instance = new workerModule.SessionDO(fakeState, createTestEnv());
    const wsGlobal = globalThis as {
      WebSocketPair?: new () => {
        0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      };
    };
    const previousWebSocketPair = wsGlobal.WebSocketPair;
    wsGlobal.WebSocketPair = class {
      0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    };

    try {
      try {
        await instance.fetch(clientWsRequest());
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }
    } finally {
      if (previousWebSocketPair === undefined) {
        delete wsGlobal.WebSocketPair;
      } else {
        wsGlobal.WebSocketPair = previousWebSocketPair;
      }
    }

    const clientSocket = fakeState.getWebSockets("client")[0] as {
      send: ReturnType<typeof vi.fn>;
    };
    clientSocket.send.mockClear();

    await (
      instance as unknown as {
        webSocketMessage(ws: unknown, message: string): Promise<void>;
      }
    ).webSocketMessage(
      clientSocket,
      JSON.stringify({
        type: "resume",
        afterSequence: 1,
      }),
    );

    const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
    const expectedFirstSequence = totalEvents - REPLAY_WINDOW_SIZE + 1;
    expect(payloads).toHaveLength(REPLAY_WINDOW_SIZE + 1);
    expect(payloads[0]).toMatchObject({
      type: "replay_event",
      event: {
        sequence: expectedFirstSequence,
      },
    });
    expect(payloads[REPLAY_WINDOW_SIZE - 1]).toMatchObject({
      type: "replay_event",
      event: {
        sequence: totalEvents,
      },
    });
    expect(payloads[REPLAY_WINDOW_SIZE]).toEqual({
      type: "replay_truncated",
      requestedAfterSequence: 1,
      firstReturnedSequence: expectedFirstSequence,
      lastReturnedSequence: totalEvents,
      droppedCount: 1,
    });
  });

  describe("request_replay_page validation", () => {
    async function setupClientSocket(sequenceCount: number): Promise<{
      instance: { webSocketMessage(ws: unknown, message: string): Promise<void> };
      clientSocket: { send: ReturnType<typeof vi.fn> };
      restore: () => void;
    }> {
      const fakeState = createFakeState();
      seedSession(fakeState.storage, {
        sessionId: "test-session-1",
        ownerUserId: "user-1",
        status: "active",
      });
      for (let sequence = 1; sequence <= sequenceCount; sequence++) {
        fakeState.storage.sql.exec(
          `INSERT INTO events (sequence, event_id, session_id, prompt_id, type, created_at, data_json, delivery_class)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'canonical')`,
          sequence,
          `event-${sequence}`,
          "test-session-1",
          "p-1",
          "text",
          Date.now(),
          JSON.stringify({ promptId: "p-1", id: `t-${sequence}`, text: `chunk-${sequence}` }),
        );
      }

      const instance = new workerModule.SessionDO(fakeState, createTestEnv());
      const wsGlobal = globalThis as {
        WebSocketPair?: new () => {
          0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
          1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        };
      };
      const previousWebSocketPair = wsGlobal.WebSocketPair;
      wsGlobal.WebSocketPair = class {
        0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
        1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      };

      try {
        try {
          await instance.fetch(clientWsRequest());
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
        }
      } finally {
        // Leave the patched constructor in place for the duration of the test;
        // restore() unpins it.
      }

      const clientSocket = fakeState.getWebSockets("client")[0] as { send: ReturnType<typeof vi.fn> };
      clientSocket.send.mockClear();
      const restore = () => {
        if (previousWebSocketPair === undefined) {
          delete wsGlobal.WebSocketPair;
        } else {
          wsGlobal.WebSocketPair = previousWebSocketPair;
        }
      };
      return {
        instance: instance as unknown as { webSocketMessage(ws: unknown, message: string): Promise<void> },
        clientSocket,
        restore,
      };
    }

    it("rejects non-integer afterSequence with replay_error and does not send a replay_page", async () => {
      const { instance, clientSocket, restore } = await setupClientSocket(3);
      try {
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            afterSequence: "not-a-number",
          }),
        );
        const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: "replay_error",
          message: expect.stringContaining("afterSequence"),
        });
      } finally {
        restore();
      }
    });

    it("rejects negative beforeSequence with replay_error", async () => {
      const { instance, clientSocket, restore } = await setupClientSocket(3);
      try {
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            beforeSequence: -1,
          }),
        );
        const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: "replay_error",
          message: expect.stringContaining("beforeSequence"),
        });
      } finally {
        restore();
      }
    });

    it("rejects request_replay_page with both afterSequence and beforeSequence", async () => {
      const { instance, clientSocket, restore } = await setupClientSocket(3);
      try {
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            afterSequence: 1,
            beforeSequence: 4,
          }),
        );
        const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: "replay_error",
          message: "afterSequence cannot be combined with beforeSequence",
        });
      } finally {
        restore();
      }
    });

    it("rejects limit over the WS cap with replay_error", async () => {
      const { instance, clientSocket, restore } = await setupClientSocket(3);
      try {
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            afterSequence: 0,
            limit: 99999,
          }),
        );
        const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: "replay_error",
          message: expect.stringContaining("limit"),
        });
      } finally {
        restore();
      }
    });

    it("rejects zero limit with replay_error", async () => {
      const { instance, clientSocket, restore } = await setupClientSocket(3);
      try {
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            limit: 0,
          }),
        );
        const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
        expect(payloads).toHaveLength(1);
        expect(payloads[0]).toMatchObject({
          type: "replay_error",
          message: expect.stringContaining("limit"),
        });
      } finally {
        restore();
      }
    });

    it("accepts a well-formed request_replay_page after a malformed one", async () => {
      const { instance, clientSocket, restore } = await setupClientSocket(3);
      try {
        // Bad request first
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            afterSequence: "garbage",
          }),
        );
        // Good request second -- the connection should still be live
        await instance.webSocketMessage(
          clientSocket,
          JSON.stringify({
            type: "request_replay_page",
            afterSequence: 0,
            limit: 10,
          }),
        );
        const payloads = clientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
        expect(payloads).toHaveLength(2);
        expect(payloads[0]).toMatchObject({ type: "replay_error" });
        expect(payloads[1]).toMatchObject({ type: "replay_page", afterSequence: 0, hasMore: false });
      } finally {
        restore();
      }
    });
  });

  describe("sandbox websocket auth exchange", () => {
    async function setupSandboxSocket(
      options: { bridgeProtocolVersionHeader?: string | null; workerVersionId?: string; activePrompt?: boolean } = {},
    ): Promise<{
      fakeState: ReturnType<typeof createFakeState>;
      instance: InstanceType<WorkerModule["SessionDO"]>;
      sandboxSocket: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
      sessionKey: string;
      connectionGeneration: number;
      nextAuthToken: string;
      pendingOneTimeAuthKey: string;
      outboxSigningKey: string;
      logWarn: ReturnType<typeof vi.fn>;
      logInfo: ReturnType<typeof vi.fn>;
      restore: () => void;
    }> {
      const fakeState = createFakeState();
      const sessionId = "test-session-1";
      const sandboxId = "sandbox-1";
      const oneTimeToken = "sandbox-token-1";
      const oneTimeTokenHash = await computeSha256Hex(oneTimeToken);
      const pendingOneTimeAuthKey = `sandbox_pending_one_time_auth:${sessionId}:${sandboxId}`;
      seedSession(fakeState.storage, {
        sessionId,
        ownerUserId: "user-1",
        status: "active",
      });
      seedSandboxState(fakeState.storage, {
        sessionId,
        status: "ready",
        sandboxId,
        sandboxAuthTokenHash: oneTimeTokenHash,
      });
      if (options.activePrompt) {
        insertPrompt(fakeState.storage.sql, sessionId, {
          promptId: "prompt-in-flight",
          prompt: "long running prompt",
          actorUserId: "user-1",
          status: "processing",
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          updatedAt: new Date().toISOString(),
          result: null,
          error: null,
        });
      }

      const workerVersionId = options.workerVersionId ?? "worker-version-a";
      const instance = new workerModule.SessionDO(fakeState, {
        ...createTestEnv(),
        VERSION_METADATA: { id: workerVersionId, tag: workerVersionId, timestamp: new Date().toISOString() },
      });
      const logWarn = vi.fn();
      const logInfo = vi.fn();
      (instance as { log: { warn: typeof logWarn; info: typeof logInfo } }).log.warn = logWarn;
      (instance as { log: { warn: typeof logWarn; info: typeof logInfo } }).log.info = logInfo;
      const wsGlobal = globalThis as {
        WebSocketPair?: new () => {
          0: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
          1: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; readyState: number };
        };
      };
      const previousWebSocketPair = wsGlobal.WebSocketPair;
      wsGlobal.WebSocketPair = class {
        0 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
        1 = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      };
      const bridgeProtocolVersionHeader =
        "bridgeProtocolVersionHeader" in options
          ? options.bridgeProtocolVersionHeader
          : String(BRIDGE_PROTOCOL_VERSION);

      try {
        await instance.fetch(
          new Request(`https://internal/session/ws?type=sandbox&sessionId=${sessionId}&sandboxId=${sandboxId}`, {
            headers: {
              upgrade: "websocket",
              authorization: `Bearer ${oneTimeToken}`,
              "x-sandbox-id": sandboxId,
              ...(bridgeProtocolVersionHeader === null
                ? {}
                : { [BRIDGE_PROTOCOL_VERSION_HEADER]: bridgeProtocolVersionHeader }),
            },
          }),
        );
      } catch (err) {
        expect(err).toBeInstanceOf(RangeError);
      }

      const sandboxSocket = fakeState.getWebSockets("sandbox")[0] as {
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        readyState: number;
      };
      const sessionMessage = JSON.parse(sandboxSocket.send.mock.calls[0][0] as string) as {
        type: string;
        sessionKey: string;
        connectionGeneration: number;
        nextAuthToken: string;
        bridgeProtocolVersion: number;
        outboxSigningKey: string;
        workerVersionId: string;
      };
      expect(sessionMessage.type).toBe("sandbox_session");
      expect(sessionMessage.bridgeProtocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
      const restore = () => {
        if (previousWebSocketPair === undefined) {
          delete wsGlobal.WebSocketPair;
        } else {
          wsGlobal.WebSocketPair = previousWebSocketPair;
        }
      };

      return {
        fakeState,
        instance,
        sandboxSocket,
        sessionKey: sessionMessage.sessionKey,
        connectionGeneration: sessionMessage.connectionGeneration,
        nextAuthToken: sessionMessage.nextAuthToken,
        pendingOneTimeAuthKey,
        outboxSigningKey: sessionMessage.outboxSigningKey,
        logWarn,
        logInfo,
        restore,
      };
    }

    it("records the bridge-reported protocol version in sandbox state", async () => {
      const { fakeState, restore } = await setupSandboxSocket();
      try {
        expect(querySandboxState(fakeState.storage, "test-session-1")?.bridge_protocol_version).toBe(
          BRIDGE_PROTOCOL_VERSION,
        );
      } finally {
        restore();
      }
    });

    it("preserves an active prompt across a same-sandbox Worker-version handoff", async () => {
      const first = await setupSandboxSocket({ workerVersionId: "worker-version-a", activePrompt: true });
      try {
        const second = new workerModule.SessionDO(first.fakeState, {
          ...createTestEnv(),
          VERSION_METADATA: { id: "worker-version-b", tag: "worker-version-b", timestamp: new Date().toISOString() },
        });
        try {
          await second.fetch(
            new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
              headers: {
                upgrade: "websocket",
                authorization: `Bearer ${first.nextAuthToken}`,
                "x-sandbox-id": "sandbox-1",
                [BRIDGE_PROTOCOL_VERSION_HEADER]: String(BRIDGE_PROTOCOL_VERSION),
              },
            }),
          );
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
        }
        const record = await first.fakeState.storage.get<{
          acceptedVersionId?: string;
          authenticatedRuntimeSandboxId?: string;
          connectionGeneration?: number;
        }>(ACCEPTED_SANDBOX_HANDOFF_STORAGE_KEY);
        expect(record).toMatchObject({
          acceptedVersionId: "worker-version-b",
          authenticatedRuntimeSandboxId: "sandbox-1",
        });
        expect(record?.connectionGeneration).toBeGreaterThan(first.connectionGeneration);
        expect(getPrompts(first.fakeState.storage.sql, "test-session-1")).toEqual(
          expect.arrayContaining([expect.objectContaining({ promptId: "prompt-in-flight", status: "processing" })]),
        );
      } finally {
        first.restore();
      }
    });

    it("treats missing bridge protocol version as pre-versioning without rejecting the socket", async () => {
      const { fakeState, restore } = await setupSandboxSocket({ bridgeProtocolVersionHeader: null });
      try {
        expect(querySandboxState(fakeState.storage, "test-session-1")?.bridge_protocol_version).toBeNull();
      } finally {
        restore();
      }
    });

    it("logs protocol skew when the bridge reports a different version", async () => {
      const bridgeProtocolVersion = BRIDGE_PROTOCOL_VERSION + 1;
      const { fakeState, logWarn, restore } = await setupSandboxSocket({
        bridgeProtocolVersionHeader: String(bridgeProtocolVersion),
      });
      try {
        expect(querySandboxState(fakeState.storage, "test-session-1")?.bridge_protocol_version).toBe(
          bridgeProtocolVersion,
        );
        expect(logWarn).toHaveBeenCalledWith(
          {
            event: "bridge.protocol_skew",
            sessionId: "test-session-1",
            sandboxId: "sandbox-1",
            bridgeVersion: bridgeProtocolVersion,
            workerVersion: BRIDGE_PROTOCOL_VERSION,
          },
          "Sandbox bridge protocol version differs from control-plane worker version",
        );
      } finally {
        restore();
      }
    });

    it("issues a per-session outbox signing key, persists it, and keeps it stable across reconnects", async () => {
      const { instance, fakeState, nextAuthToken, outboxSigningKey, restore } = await setupSandboxSocket();
      try {
        // Issued in the authenticated frame and persisted in DO storage (so a
        // restarted bridge re-receives the same key and can verify prior records).
        expect(typeof outboxSigningKey).toBe("string");
        expect(outboxSigningKey.length).toBeGreaterThan(0);
        await expect(fakeState.storage.get(OUTBOX_SIGNING_KEY_STORAGE_KEY)).resolves.toBe(outboxSigningKey);

        // Reconnect with the rotated token: the signing key is unchanged.
        try {
          await instance.fetch(
            new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
              headers: {
                upgrade: "websocket",
                authorization: `Bearer ${nextAuthToken}`,
                "x-sandbox-id": "sandbox-1",
                [BRIDGE_PROTOCOL_VERSION_HEADER]: String(BRIDGE_PROTOCOL_VERSION),
              },
            }),
          );
        } catch (err) {
          expect(err).toBeInstanceOf(RangeError);
        }
        const sockets = fakeState.getWebSockets("sandbox") as Array<{ send: ReturnType<typeof vi.fn> }>;
        const reconnectFrame = JSON.parse(sockets[sockets.length - 1].send.mock.calls[0][0] as string) as {
          type: string;
          outboxSigningKey: string;
        };
        expect(reconnectFrame.type).toBe("sandbox_session");
        expect(reconnectFrame.outboxSigningKey).toBe(outboxSigningKey);
      } finally {
        restore();
      }
    });

    it("rejects replaying a consumed one-time sandbox token", async () => {
      const { instance, restore } = await setupSandboxSocket();
      try {
        const response = await instance.fetch(
          new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
            headers: {
              upgrade: "websocket",
              authorization: "Bearer sandbox-token-1",
              "x-sandbox-id": "sandbox-1",
            },
          }),
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringContaining("already exchanged"),
        });
      } finally {
        restore();
      }
    });

    it("allows retrying an unconfirmed one-time token after the socket drops before sandbox auth", async () => {
      const { fakeState, instance, sandboxSocket, restore } = await setupSandboxSocket();
      try {
        sandboxSocket.readyState = 3;
        await instance.webSocketClose(sandboxSocket as WebSocket, 1006, "network drop", false);

        await expect(
          instance.fetch(
            new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
              headers: {
                upgrade: "websocket",
                authorization: "Bearer sandbox-token-1",
                "x-sandbox-id": "sandbox-1",
              },
            }),
          ),
        ).rejects.toThrow(RangeError);

        expect(fakeState.getWebSockets("sandbox")).toHaveLength(2);
      } finally {
        restore();
      }
    });

    it("rejects replaying a one-time token after the sandbox session key is confirmed", async () => {
      const { instance, sandboxSocket, sessionKey, restore } = await setupSandboxSocket();
      try {
        await instance.webSocketMessage(
          sandboxSocket as WebSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
            auth: { sessionKey, nonce: 1 },
          }),
        );
        sandboxSocket.readyState = 3;
        await instance.webSocketClose(sandboxSocket as WebSocket, 1006, "network drop", false);

        const response = await instance.fetch(
          new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
            headers: {
              upgrade: "websocket",
              authorization: "Bearer sandbox-token-1",
              "x-sandbox-id": "sandbox-1",
            },
          }),
        );
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: expect.stringContaining("already exchanged"),
        });
      } finally {
        restore();
      }
    });

    it("deletes the pending one-time auth pointer after transferring it to the websocket auth record", async () => {
      const { fakeState, pendingOneTimeAuthKey, restore } = await setupSandboxSocket();
      try {
        await expect(fakeState.storage.get(pendingOneTimeAuthKey)).resolves.toBeUndefined();
      } finally {
        restore();
      }
    });

    it("accepts reconnects that use the rotated sandbox token", async () => {
      const { instance, nextAuthToken, restore } = await setupSandboxSocket();
      try {
        await expect(
          instance.fetch(
            new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
              headers: {
                upgrade: "websocket",
                authorization: `Bearer ${nextAuthToken}`,
                "x-sandbox-id": "sandbox-1",
              },
            }),
          ),
        ).rejects.toThrow(RangeError);
      } finally {
        restore();
      }
    });

    it("retains the last N prior tokens across reconnects (N-generation overlap)", async () => {
      const { fakeState, instance, nextAuthToken, restore } = await setupSandboxSocket();
      const priorHashes = (sessionId: string): string[] => {
        const raw = querySandboxState(fakeState.storage, sessionId)?.prev_sandbox_auth_token_hashes;
        return (JSON.parse((raw as string | null) ?? "[]") as Array<{ hash: string; expiresAt: number }>).map(
          (g) => g.hash,
        );
      };
      try {
        // First accept rolls the seeded (current) token into the prior-generation list.
        expect(priorHashes("test-session-1")).toEqual([await computeSha256Hex("sandbox-token-1")]);

        // Second reconnect (with the rotated token) rolls that token in too; both
        // prior generations stay valid, newest-first — the multi-generation 403 fix.
        await expect(
          instance.fetch(
            new Request("https://internal/session/ws?type=sandbox&sessionId=test-session-1&sandboxId=sandbox-1", {
              headers: {
                upgrade: "websocket",
                authorization: `Bearer ${nextAuthToken}`,
                "x-sandbox-id": "sandbox-1",
              },
            }),
          ),
        ).rejects.toThrow(RangeError);

        expect(priorHashes("test-session-1")).toEqual([
          await computeSha256Hex(nextAuthToken),
          await computeSha256Hex("sandbox-token-1"),
        ]);
      } finally {
        restore();
      }
    });

    it("requires the connection session key and monotonic nonce on sandbox messages", async () => {
      const { fakeState, instance, sandboxSocket, sessionKey, connectionGeneration, restore } =
        await setupSandboxSocket();
      const authStorageKey = `${SANDBOX_WS_AUTH_STORAGE_PREFIX}${connectionGeneration}`;
      try {
        await instance.webSocketMessage(
          sandboxSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
          }),
        );
        await expect(fakeState.storage.get<{ lastNonce: number }>(authStorageKey)).resolves.toMatchObject({
          lastNonce: 0,
        });

        await instance.webSocketMessage(
          sandboxSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
            auth: { sessionKey, nonce: 1 },
          }),
        );
        await expect(fakeState.storage.get<{ lastNonce: number }>(authStorageKey)).resolves.toMatchObject({
          lastNonce: 1,
        });

        await instance.webSocketMessage(
          sandboxSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
            auth: { sessionKey, nonce: 1 },
          }),
        );
        await expect(fakeState.storage.get<{ lastNonce: number }>(authStorageKey)).resolves.toMatchObject({
          lastNonce: 1,
        });

        const authRecord = await fakeState.storage.get<{ sessionKeyHash: string }>(authStorageKey);
        expect(authRecord).toBeDefined();
        await fakeState.storage.put(authStorageKey, {
          sessionKeyHash: authRecord?.sessionKeyHash ?? "",
          lastNonce: 1,
          expiresAt: 0,
        });
        await instance.webSocketMessage(
          sandboxSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
            auth: { sessionKey, nonce: 2 },
          }),
        );
        expect(sandboxSocket.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "auth_error", reason: "expired_session_key" }),
        );
        expect(sandboxSocket.close).toHaveBeenCalledWith(4003, "Sandbox session key expired");
        await expect(fakeState.storage.get<{ lastNonce: number }>(authStorageKey)).resolves.toMatchObject({
          lastNonce: 1,
        });
      } finally {
        restore();
      }
    });

    it("replies to a heartbeat carrying an echoNonce with a typed heartbeat_echo", async () => {
      const { instance, sandboxSocket, sessionKey, restore } = await setupSandboxSocket();
      try {
        // First send (index 0) is the sandbox_session frame; clear it so the
        // heartbeat_echo reply is unambiguous.
        sandboxSocket.send.mockClear();

        await instance.webSocketMessage(
          sandboxSocket as WebSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
            echoNonce: "nonce-abc",
            auth: { sessionKey, nonce: 1 },
          }),
        );

        const echo = sandboxSocket.send.mock.calls
          .map(([payload]) => JSON.parse(payload as string) as Record<string, unknown>)
          .find((message) => message.type === "heartbeat_echo");
        expect(echo).toEqual({ type: "heartbeat_echo", echoNonce: "nonce-abc" });
      } finally {
        restore();
      }
    });

    it("does not reply with a heartbeat_echo when the heartbeat omits echoNonce (older bridge)", async () => {
      const { instance, sandboxSocket, sessionKey, restore } = await setupSandboxSocket();
      try {
        sandboxSocket.send.mockClear();

        await instance.webSocketMessage(
          sandboxSocket as WebSocket,
          JSON.stringify({
            type: "heartbeat",
            sandboxId: "sandbox-1",
            status: "ready",
            timestamp: Date.now(),
            auth: { sessionKey, nonce: 1 },
          }),
        );

        const echo = sandboxSocket.send.mock.calls
          .map(([payload]) => JSON.parse(payload as string) as Record<string, unknown>)
          .find((message) => message.type === "heartbeat_echo");
        expect(echo).toBeUndefined();
      } finally {
        restore();
      }
    });
  });
});
