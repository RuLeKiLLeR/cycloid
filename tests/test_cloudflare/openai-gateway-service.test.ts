import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeDurableState, FakeStorage, mockCloudflareWorkers, mockSentryCloudflare } from "./helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

let OpenAIGatewayBudgetDO: typeof import("../../apps/control-plane-worker/src/openai-gateway/budget-do").OpenAIGatewayBudgetDO;
let createOpenAIGatewaySessionToken: typeof import("../../apps/control-plane-worker/src/openai-gateway/db").createOpenAIGatewaySessionToken;
let hashVirtualKey: typeof import("../../apps/control-plane-worker/src/openai-gateway/db").hashVirtualKey;
let handleOpenAIResponses: typeof import("../../apps/control-plane-worker/src/openai-gateway/service").handleOpenAIResponses;
let observeOpenAIResponseJson: typeof import("../../apps/control-plane-worker/src/openai-gateway/service").observeOpenAIResponseJson;

class SqliteD1 {
  readonly db = new Database(":memory:");
  failLedgerInserts = false;
  failNextSettleUpdate = false;
  failSettleUpdateCount = 0;
  // Fails the first `settlement_unresolved` release UPDATE and records how many
  // times it fired. `releaseGatewayLedgerRow` binds the status as a parameter
  // (`SET lifecycle_status = ?`), so injection must inspect the bound value.
  failNextUnresolvedReleaseUpdate = false;
  unresolvedReleaseUpdateFailures = 0;

  constructor() {
    this.db.exec(readFileSync(resolve("apps/control-plane-worker/migrations/0109_openai_gateway.sql"), "utf8"));
    this.db.exec(
      readFileSync(resolve("apps/control-plane-worker/migrations/0141_openai_gateway_byok_sources.sql"), "utf8"),
    );
    this.db.exec(`
      CREATE TABLE user_integrations (
        user_id INTEGER NOT NULL,
        integration_id TEXT NOT NULL,
        api_key TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        last_validation_status TEXT,
        PRIMARY KEY (user_id, integration_id)
      );
      CREATE TABLE business_integration_credentials (
        business_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        api_key TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        last_validation_status TEXT,
        PRIMARY KEY (business_id, integration_id)
      );
      CREATE TABLE session_index (
        session_id TEXT PRIMARY KEY,
        initiation_mode TEXT NOT NULL DEFAULT 'user'
      );
    `);
  }

  prepare(query: string) {
    const db = this.db;
    const dbWrapper = this;
    let values: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        values = bound;
        return this;
      },
      async run() {
        if (query.includes("INSERT INTO openai_gateway_ledger") && dbWrapper.failLedgerInserts) {
          throw new Error("ledger insert failed");
        }
        if (query.includes("SET lifecycle_status = 'settled'") && dbWrapper.failNextSettleUpdate) {
          dbWrapper.failNextSettleUpdate = false;
          throw new Error("settle update failed");
        }
        if (query.includes("SET lifecycle_status = 'settled'") && dbWrapper.failSettleUpdateCount > 0) {
          dbWrapper.failSettleUpdateCount -= 1;
          throw new Error("settle update failed");
        }
        if (
          query.includes("settlement_source = 'none'") &&
          values[0] === "settlement_unresolved" &&
          dbWrapper.failNextUnresolvedReleaseUpdate
        ) {
          dbWrapper.failNextUnresolvedReleaseUpdate = false;
          dbWrapper.unresolvedReleaseUpdateFailures += 1;
          throw new Error("unresolved release update failed");
        }
        db.prepare(query).run(...values);
        return { success: true };
      },
      async first<T>() {
        return (db.prepare(query).get(...values) as T | undefined) ?? null;
      },
    };
  }
}

function createBudgetNamespace(env: Record<string, unknown>) {
  const instances = new Map<string, InstanceType<typeof OpenAIGatewayBudgetDO>>();
  return {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      return {
        fetch: async (request: Request | string, init?: RequestInit) => {
          let instance = instances.get(id);
          if (!instance) {
            instance = new OpenAIGatewayBudgetDO(
              new FakeDurableState(new FakeStorage()) as unknown as DurableObjectState,
              env as never,
            );
            instances.set(id, instance);
          }
          return instance.fetch(request instanceof Request ? request : new Request(request, init));
        },
      };
    },
  };
}

function createBudgetNamespaceWithFailures(failures: { release?: boolean; settle?: boolean }) {
  return {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        fetch: async (request: Request | string, init?: RequestInit) => {
          const url = request instanceof Request ? request.url : request;
          const pathname = new URL(url).pathname;
          if (pathname === "/budget/reserve") {
            return new Response(JSON.stringify({ reservedUsdMicros: 100_000, month: "2026-06" }), {
              headers: { "content-type": "application/json" },
            });
          }
          if (pathname === "/budget/release") {
            return new Response("release failed", { status: failures.release ? 500 : 200 });
          }
          if (pathname === "/budget/settle") {
            return new Response("settle failed", { status: failures.settle ? 500 : 200 });
          }
          if (pathname === "/budget/state") {
            return new Response(JSON.stringify({ state: { spentUsdMicros: 0, reservedUsdMicros: 0 } }), {
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`Unexpected budget request: ${pathname} ${init?.body ?? ""}`);
        },
      };
    },
  };
}

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

async function createEnv(limit = 100_000_000) {
  const db = new SqliteD1();
  const env: Record<string, unknown> = {
    DB: db,
    ARCANIST_OPENAI_API_KEY: "real-openai-key",
    OPENAI_GATEWAY_BUDGET: null,
  };
  env.OPENAI_GATEWAY_BUDGET = createBudgetNamespace(env);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO openai_virtual_keys (
        id, key_hash, owner_user_id, business_id, monthly_limit_usd_micros, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind("vk_1", await hashVirtualKey("arc-vk-virtual-secret"), "user-1", "biz-1", limit, now, now)
    .run();
  return { env, db };
}

function request(body: Record<string, unknown>) {
  return new Request("https://worker.test/openai/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer arc-vk-virtual-secret",
      "content-type": "application/json",
      "x-request-id": "req-1",
      "x-cycloid-session-id": "session-1",
      "x-cycloid-prompt-id": "prompt-1",
    },
    body: JSON.stringify(body),
  });
}

function automationRequest(body: Record<string, unknown>) {
  return new Request("https://worker.test/openai/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer arc-vk-virtual-secret",
      "content-type": "application/json",
      "x-request-id": "req-automation",
      "x-cycloid-session-id": "automation-session",
      "x-cycloid-prompt-id": "prompt-automation",
    },
    body: JSON.stringify(body),
  });
}

class FakeSocket {
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  accept() {}

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function webSocketRequest() {
  return new Request("https://worker.test/openai/responses", {
    method: "GET",
    headers: {
      authorization: "Bearer arc-vk-virtual-secret",
      upgrade: "websocket",
      "x-request-id": "req-ws-1",
      "x-cycloid-session-id": "session-1",
      "x-cycloid-prompt-id": "prompt-1",
    },
  });
}

function automationWebSocketRequest() {
  return new Request("https://worker.test/openai/responses", {
    method: "GET",
    headers: {
      authorization: "Bearer arc-vk-virtual-secret",
      upgrade: "websocket",
      "x-request-id": "req-ws-automation",
      "x-cycloid-session-id": "automation-session",
      "x-cycloid-prompt-id": "prompt-automation",
    },
  });
}

describe("OpenAI gateway service", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    ({ OpenAIGatewayBudgetDO } = await import("../../apps/control-plane-worker/src/openai-gateway/budget-do"));
    ({ createOpenAIGatewaySessionToken, hashVirtualKey } =
      await import("../../apps/control-plane-worker/src/openai-gateway/db"));
    ({ handleOpenAIResponses, observeOpenAIResponseJson } =
      await import("../../apps/control-plane-worker/src/openai-gateway/service"));
  });

  it("settles SSE response.completed from actual usage", async () => {
    const { env, db } = await createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            sse([
              {
                type: "response.completed",
                response: { id: "resp_1", usage: { input_tokens: 1_000, output_tokens: 100 } },
              },
            ]),
            {
              headers: { "content-type": "text/event-stream" },
            },
          ),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      request({ model: "gpt-5.4-mini", input: "hello", stream: true }),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    await response.text();
    await Promise.all(waitUntil);

    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row.lifecycle_status).toBe("settled");
    expect(row.openai_response_id).toBe("resp_1");
    expect(row.input_tokens).toBe(1_000);
    expect(row.output_tokens).toBe(100);
    expect(row.actual_cost_usd_micros).toBe(1200);
  });

  it("routes user BYOK session tokens through the gateway and attributes source spend", async () => {
    const { env, db } = await createEnv();
    db.db
      .prepare("INSERT INTO user_integrations (user_id, integration_id, api_key, encrypted) VALUES (?, ?, ?, 0)")
      .run(7, "openai", "user-openai-key");
    const { token } = await createOpenAIGatewaySessionToken(db as unknown as D1Database, {
      ownerUserId: 7,
      businessId: "biz-1",
      credentialSource: "user_byok",
      credentialOwnerId: "7",
      sessionId: "session-byok",
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-openai-key");
      return new Response(JSON.stringify({ id: "resp_byok", usage: { input_tokens: 1_000, output_tokens: 100 } }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(
      new Request("https://worker.test/openai/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-request-id": "req-byok",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger WHERE request_id = 'req-byok'").get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      virtual_key_id: null,
      owner_user_id: "7",
      business_id: "biz-1",
      session_id: "session-byok",
      credential_source: "user_byok",
      upstream_credential_ref: "user:7:openai",
      lifecycle_status: "settled",
      openai_response_id: "resp_byok",
    });
  });

  it("uses flex service tier for automation session Responses requests", async () => {
    const { env, db } = await createEnv();
    db.db
      .prepare("INSERT INTO session_index (session_id, initiation_mode) VALUES (?, ?)")
      .run("automation-session", "automation");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-5.4-mini",
        service_tier: "flex",
      });
      return new Response(JSON.stringify({ id: "resp_flex", usage: { input_tokens: 1_000, output_tokens: 100 } }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(
      automationRequest({ model: "gpt-5.4-mini", input: "hello" }),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not set flex service tier for non-automation session Responses requests", async () => {
    const { env } = await createEnv();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("service_tier");
      return new Response(JSON.stringify({ id: "resp_user", usage: { input_tokens: 1_000, output_tokens: 100 } }), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(request({ model: "gpt-5.4-mini", input: "hello" }), env as never);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when a valid BYOK session token has no upstream key", async () => {
    const { env, db } = await createEnv();
    const { token } = await createOpenAIGatewaySessionToken(db as unknown as D1Database, {
      ownerUserId: 7,
      businessId: "biz-1",
      credentialSource: "user_byok",
      credentialOwnerId: "7",
      sessionId: "session-byok-missing-key",
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(
      new Request("https://worker.test/openai/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
      }),
      env as never,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "OpenAI gateway upstream key unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes business BYOK session tokens through the gateway and attributes source spend", async () => {
    const { env, db } = await createEnv();
    db.db
      .prepare(
        "INSERT INTO business_integration_credentials (business_id, integration_id, api_key, encrypted) VALUES (?, ?, ?, 0)",
      )
      .run("biz-1", "openai", "business-openai-key");
    const { token } = await createOpenAIGatewaySessionToken(db as unknown as D1Database, {
      ownerUserId: 7,
      businessId: "biz-1",
      credentialSource: "business_byok",
      credentialOwnerId: "biz-1",
      sessionId: "session-business-byok",
      expiresAt: Date.now() + 60_000,
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer business-openai-key");
      return new Response(
        JSON.stringify({ id: "resp_business_byok", usage: { input_tokens: 1_000, output_tokens: 100 } }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(
      new Request("https://worker.test/openai/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-request-id": "req-business-byok",
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
      }),
      env as never,
    );

    expect(response.status).toBe(200);
    const row = db.db
      .prepare("SELECT * FROM openai_gateway_ledger WHERE request_id = 'req-business-byok'")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      virtual_key_id: null,
      owner_user_id: "7",
      business_id: "biz-1",
      session_id: "session-business-byok",
      credential_source: "business_byok",
      upstream_credential_ref: "business:biz-1:openai",
      lifecycle_status: "settled",
      openai_response_id: "resp_business_byok",
    });
  });

  it("retrieves usage when terminal event omits it", async () => {
    const { env, db } = await createEnv();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(sse([{ type: "response.completed", response: { id: "resp_2" } }]), {
            headers: { "content-type": "text/event-stream" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "resp_2", usage: { input_tokens: 2_000, output_tokens: 0 } })),
        ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      request({ model: "gpt-5.4-mini", input: "hello", stream: true }),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    await response.text();
    await Promise.all(waitUntil);

    const row = db.db.prepare("SELECT settlement_source, input_tokens FROM openai_gateway_ledger").get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ settlement_source: "response_retrieve", input_tokens: 2_000 });
  });

  it("retries transient retrieve failures when terminal event omits usage", async () => {
    vi.useFakeTimers();
    const { env, db } = await createEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(sse([{ type: "response.completed", response: { id: "resp_retry" } }]), {
          headers: { "content-type": "text/event-stream" },
        }),
      )
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "resp_retry", usage: { input_tokens: 3_000, output_tokens: 0 } })),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const waitUntil: Promise<unknown>[] = [];
      const response = await handleOpenAIResponses(
        request({ model: "gpt-5.4-mini", input: "hello", stream: true }),
        env as never,
        {
          waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
        } as ExecutionContext,
      );
      await response.text();
      const settled = Promise.all(waitUntil);
      await vi.runAllTimersAsync();
      await settled;

      const row = db.db.prepare("SELECT settlement_source, input_tokens FROM openai_gateway_ledger").get() as Record<
        string,
        unknown
      >;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(row).toMatchObject({ settlement_source: "response_retrieve", input_tokens: 3_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks unresolved and releases when usage cannot be retrieved", async () => {
    const { env, db } = await createEnv();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(sse([{ type: "response.created", response: { id: "resp_3" } }]), {
            headers: { "content-type": "text/event-stream" },
          }),
        )
        .mockImplementation(async () => new Response("{}", { status: 200 })),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      request({ model: "gpt-5.4-mini", input: "hello", stream: true }),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    await response.text();
    await Promise.all(waitUntil);

    const row = db.db
      .prepare("SELECT lifecycle_status, actual_cost_usd_micros FROM openai_gateway_ledger")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({ lifecycle_status: "settlement_unresolved", actual_cost_usd_micros: 0 });
  });

  it("releases reservation on upstream rejection", async () => {
    const { env, db } = await createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    const response = await handleOpenAIResponses(request({ model: "gpt-5.4-mini", input: "hello" }), env as never);

    expect(response.status).toBe(429);
    const row = db.db.prepare("SELECT lifecycle_status FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row.lifecycle_status).toBe("released");
  });

  it("logs and preserves the upstream response when budget release returns non-ok", async () => {
    const { env, db } = await createEnv();
    env.OPENAI_GATEWAY_BUDGET = createBudgetNamespaceWithFailures({ release: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    const response = await handleOpenAIResponses(request({ model: "gpt-5.4-mini", input: "hello" }), env as never);

    expect(response.status).toBe(429);
    const row = db.db.prepare("SELECT lifecycle_status FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row.lifecycle_status).toBe("released");
    const logEntry = consoleError.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => {
        return entry.msg === "OpenAI gateway budget DO call failed";
      });
    expect(logEntry).toMatchObject({
      component: "openai-gateway",
      budgetKeyId: "vk_1",
      operation: "release",
      status: 500,
    });
  });

  it("logs and still settles the ledger when budget settle returns non-ok", async () => {
    const { env, db } = await createEnv();
    env.OPENAI_GATEWAY_BUDGET = createBudgetNamespaceWithFailures({ settle: true });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: "resp_settle_non_ok", usage: { input_tokens: 1_000, output_tokens: 100 } }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    const response = await handleOpenAIResponses(request({ model: "gpt-5.4-mini", input: "hello" }), env as never);

    expect(response.status).toBe(200);
    const row = db.db.prepare("SELECT lifecycle_status, openai_response_id FROM openai_gateway_ledger").get() as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ lifecycle_status: "settled", openai_response_id: "resp_settle_non_ok" });
    const logEntry = consoleError.mock.calls
      .map(([entry]) => JSON.parse(String(entry)))
      .find((entry) => {
        return entry.msg === "OpenAI gateway budget DO call failed";
      });
    expect(logEntry).toMatchObject({
      component: "openai-gateway",
      budgetKeyId: "vk_1",
      operation: "settle",
      status: 500,
    });
  });

  it("releases reservation when ledger insert fails", async () => {
    const { env, db } = await createEnv();
    db.failLedgerInserts = true;
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      handleOpenAIResponses(request({ model: "gpt-5.4-mini", input: "hello" }), env as never),
    ).rejects.toThrow("ledger insert failed");

    expect(fetchMock).not.toHaveBeenCalled();
    const budget = env.OPENAI_GATEWAY_BUDGET as ReturnType<typeof createBudgetNamespace>;
    const stateResponse = await budget.get(budget.idFromName("vk_1")).fetch("https://internal/budget/state");
    await expect(stateResponse.json()).resolves.toMatchObject({
      state: { spentUsdMicros: 0, reservedUsdMicros: 0 },
    });
  });

  it("returns a distinct Cycloid budget error on exhaustion", async () => {
    const { env } = await createEnv(10);
    const response = await handleOpenAIResponses(request({ model: "gpt-5.4-mini", input: "hello" }), env as never);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      code: "cycloid_openai_budget_exhausted",
    });
  });

  it("observes WebSocket terminal usage frames", () => {
    const state: Parameters<typeof observeOpenAIResponseJson>[0] = { responseId: null, terminal: null };
    observeOpenAIResponseJson(
      state,
      JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws", usage: { input_tokens: 500, output_tokens: 50 } },
      }),
    );

    expect(state.responseId).toBe("resp_ws");
    expect(state.terminal?.usage).toMatchObject({ input_tokens: 500, output_tokens: 50 });
  });

  it("settles WebSocket terminal usage before the socket closes", async () => {
    const { env, db } = await createEnv();
    const upstreamSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    const gatewaySocket = new FakeSocket();
    const RealResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          const status = init?.status;
          super(body, status === 101 ? { ...init, status: 200 } : init);
          if (status === 101) Object.defineProperty(this, "status", { value: 101 });
          if (init?.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      },
    );
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = clientSocket;
        1 = gatewaySocket;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 101, webSocket: upstreamSocket } as ResponseInit & { webSocket: unknown }),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      webSocketRequest(),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    expect(response.status).toBe(101);

    gatewaySocket.emit("message", {
      data: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
    });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(1);
    });

    upstreamSocket.emit("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_settle", usage: { input_tokens: 500, output_tokens: 50 } },
      }),
    });

    await vi.waitFor(() => {
      const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
      expect(row.lifecycle_status).toBe("settled");
      expect(row.openai_response_id).toBe("resp_ws_settle");
      expect(row.input_tokens).toBe(500);
      expect(row.output_tokens).toBe(50);
    });

    const proxyStillOpen = Promise.race([
      Promise.all(waitUntil).then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("open"), 0)),
    ]);
    await expect(proxyStillOpen).resolves.toBe("open");
  });

  it("starts a fresh gateway context for each WebSocket response.create message", async () => {
    const { env, db } = await createEnv();
    const upstreamSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    const gatewaySocket = new FakeSocket();
    const RealResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          const status = init?.status;
          super(body, status === 101 ? { ...init, status: 200 } : init);
          if (status === 101) Object.defineProperty(this, "status", { value: 101 });
          if (init?.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      },
    );
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = clientSocket;
        1 = gatewaySocket;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 101, webSocket: upstreamSocket } as ResponseInit & { webSocket: unknown }),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      webSocketRequest(),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    expect(response.status).toBe(101);

    gatewaySocket.emit("message", {
      data: JSON.stringify({ model: "gpt-5.4-mini", input: "first" }),
    });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(1);
    });
    upstreamSocket.emit("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_first", usage: { input_tokens: 100, output_tokens: 10 } },
      }),
    });
    await vi.waitFor(() => {
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM openai_gateway_ledger").get()).toMatchObject({ count: 1 });
    });

    gatewaySocket.emit("message", {
      data: JSON.stringify({ model: "gpt-5.4-mini", input: "second" }),
    });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(2);
    });
    expect(JSON.parse(String(upstreamSocket.sent[0]))).toMatchObject({ input: "first" });
    expect(JSON.parse(String(upstreamSocket.sent[1]))).toMatchObject({ input: "second" });

    upstreamSocket.emit("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_second", usage: { input_tokens: 200, output_tokens: 20 } },
      }),
    });
    await vi.waitFor(() => {
      const rows = db.db
        .prepare(
          "SELECT openai_response_id, input_tokens, output_tokens FROM openai_gateway_ledger ORDER BY created_at",
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        { openai_response_id: "resp_ws_first", input_tokens: 100, output_tokens: 10 },
        { openai_response_id: "resp_ws_second", input_tokens: 200, output_tokens: 20 },
      ]);
    });

    upstreamSocket.close();
    await expect(Promise.all(waitUntil)).resolves.toEqual([undefined]);
  });

  it("uses flex service tier for automation session WebSocket payloads", async () => {
    const { env, db } = await createEnv();
    db.db
      .prepare("INSERT INTO session_index (session_id, initiation_mode) VALUES (?, ?)")
      .run("automation-session", "automation");
    const upstreamSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    const gatewaySocket = new FakeSocket();
    const RealResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          const status = init?.status;
          super(body, status === 101 ? { ...init, status: 200 } : init);
          if (status === 101) Object.defineProperty(this, "status", { value: 101 });
          if (init?.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      },
    );
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = clientSocket;
        1 = gatewaySocket;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 101, webSocket: upstreamSocket } as ResponseInit & { webSocket: unknown }),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      automationWebSocketRequest(),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    expect(response.status).toBe(101);

    gatewaySocket.emit("message", {
      data: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
    });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(1);
    });
    expect(JSON.parse(String(upstreamSocket.sent[0]))).toMatchObject({
      model: "gpt-5.4-mini",
      service_tier: "flex",
    });

    upstreamSocket.emit("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_flex", usage: { input_tokens: 500, output_tokens: 50 } },
      }),
    });
    upstreamSocket.close();
    await expect(Promise.all(waitUntil)).resolves.toEqual([undefined]);
  });

  it("keeps WebSocket cleanup running when early settlement rejects", async () => {
    const { env, db } = await createEnv();
    db.failNextSettleUpdate = true;
    const upstreamSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    const gatewaySocket = new FakeSocket();
    const RealResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          const status = init?.status;
          super(body, status === 101 ? { ...init, status: 200 } : init);
          if (status === 101) Object.defineProperty(this, "status", { value: 101 });
          if (init?.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      },
    );
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = clientSocket;
        1 = gatewaySocket;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 101, webSocket: upstreamSocket } as ResponseInit & { webSocket: unknown }),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      webSocketRequest(),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    expect(response.status).toBe(101);

    gatewaySocket.emit("message", {
      data: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
    });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(1);
    });

    upstreamSocket.emit("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_retry_settle", usage: { input_tokens: 500, output_tokens: 50 } },
      }),
    });
    upstreamSocket.close();

    await expect(Promise.all(waitUntil)).resolves.toEqual([undefined]);
    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row.lifecycle_status).toBe("settled");
    expect(row.openai_response_id).toBe("resp_ws_retry_settle");
    const budget = env.OPENAI_GATEWAY_BUDGET as ReturnType<typeof createBudgetNamespace>;
    const stateResponse = await budget.get(budget.idFromName("vk_1")).fetch("https://internal/budget/state");
    const stateBody = (await stateResponse.json()) as { state: { spentUsdMicros: number; reservedUsdMicros: number } };
    expect(stateBody.state.reservedUsdMicros).toBe(0);
    expect(stateBody.state.spentUsdMicros).toBe(row.actual_cost_usd_micros);
  });

  it("does not propagate WebSocket settlement retry failures", async () => {
    const { env, db } = await createEnv();
    db.failSettleUpdateCount = 2;
    const upstreamSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    const gatewaySocket = new FakeSocket();
    const RealResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          const status = init?.status;
          super(body, status === 101 ? { ...init, status: 200 } : init);
          if (status === 101) Object.defineProperty(this, "status", { value: 101 });
          if (init?.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      },
    );
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = clientSocket;
        1 = gatewaySocket;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 101, webSocket: upstreamSocket } as ResponseInit & { webSocket: unknown }),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      webSocketRequest(),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    expect(response.status).toBe(101);

    gatewaySocket.emit("message", {
      data: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }),
    });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(1);
    });

    upstreamSocket.emit("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_ws_failed_settle", usage: { input_tokens: 500, output_tokens: 50 } },
      }),
    });
    upstreamSocket.close();

    await expect(Promise.all(waitUntil)).resolves.toEqual([undefined]);
  });

  it("does not double-release the reservation when a WebSocket settlement retry re-marks unresolved", async () => {
    const { env, db } = await createEnv();
    // The WebSocket settlement releases its reservation once. A second,
    // unrelated reservation shares the same budget DO; a double-release would
    // silently eat its funds instead of clamping harmlessly at zero.
    const releaseLedgerIds: Array<string | undefined> = [];
    const realBudget = env.OPENAI_GATEWAY_BUDGET as ReturnType<typeof createBudgetNamespace>;
    env.OPENAI_GATEWAY_BUDGET = {
      idFromName: (name: string) => realBudget.idFromName(name),
      get: (id: string) => {
        const inner = realBudget.get(id);
        return {
          fetch: async (request: Request | string, init?: RequestInit) => {
            const url = request instanceof Request ? request.url : request;
            if (new URL(url).pathname === "/budget/release") {
              const raw = request instanceof Request ? await request.clone().text() : String(init?.body ?? "");
              releaseLedgerIds.push((JSON.parse(raw) as { ledgerId?: string }).ledgerId);
            }
            return inner.fetch(request, init);
          },
        };
      },
    } as typeof realBudget;
    const budget = env.OPENAI_GATEWAY_BUDGET as ReturnType<typeof createBudgetNamespace>;

    const otherReservation = 50_000_000;
    await budget.get(budget.idFromName("vk_1")).fetch("https://internal/budget/reserve", {
      method: "POST",
      body: JSON.stringify({ estimateUsdMicros: otherReservation, monthlyLimitUsdMicros: 100_000_000 }),
    });

    // First `settlement_unresolved` D1 update throws after the budget release
    // succeeds, forcing the WebSocket retry back through markSettlementUnresolved.
    db.failNextUnresolvedReleaseUpdate = true;

    const upstreamSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    const gatewaySocket = new FakeSocket();
    const RealResponse = Response;
    vi.stubGlobal(
      "Response",
      class extends RealResponse {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          const status = init?.status;
          super(body, status === 101 ? { ...init, status: 200 } : init);
          if (status === 101) Object.defineProperty(this, "status", { value: 101 });
          if (init?.webSocket) Object.defineProperty(this, "webSocket", { value: init.webSocket });
        }
      },
    );
    vi.stubGlobal(
      "WebSocketPair",
      class {
        0 = clientSocket;
        1 = gatewaySocket;
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 101, webSocket: upstreamSocket } as ResponseInit & { webSocket: unknown }),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      webSocketRequest(),
      env as never,
      {
        waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise),
      } as ExecutionContext,
    );
    expect(response.status).toBe(101);

    gatewaySocket.emit("message", { data: JSON.stringify({ model: "gpt-5.4-mini", input: "hello" }) });
    await vi.waitFor(() => {
      expect(upstreamSocket.sent).toHaveLength(1);
    });

    // Terminal frame with no usage and no response id routes straight to
    // markSettlementUnresolved -> releaseBudgetReservation.
    upstreamSocket.emit("message", {
      data: JSON.stringify({ type: "response.completed", response: {} }),
    });
    upstreamSocket.close();

    await expect(Promise.all(waitUntil)).resolves.toEqual([undefined]);

    // The compound failure fired exactly once and drove a retry.
    expect(db.unresolvedReleaseUpdateFailures).toBe(1);
    expect(releaseLedgerIds).toHaveLength(2);
    expect(releaseLedgerIds[0]).toBeDefined();
    expect(releaseLedgerIds[1]).toBe(releaseLedgerIds[0]);

    // The WebSocket reservation was released exactly once, leaving the other
    // reservation untouched (a double-release would drop this below 50M).
    const stateResponse = await budget.get(budget.idFromName("vk_1")).fetch("https://internal/budget/state");
    const stateBody = (await stateResponse.json()) as { state: { spentUsdMicros: number; reservedUsdMicros: number } };
    expect(stateBody.state.reservedUsdMicros).toBe(otherReservation);
    expect(stateBody.state.spentUsdMicros).toBe(0);

    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row.lifecycle_status).toBe("settlement_unresolved");
  });
});

function compactRequest(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request("https://worker.test/openai/responses/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer arc-vk-virtual-secret",
      "content-type": "application/json",
      "x-request-id": "req-compact-1",
      "x-cycloid-session-id": "session-1",
      "x-cycloid-prompt-id": "prompt-1",
      ...headers,
    },
    body,
  });
}

function compactPayload() {
  return JSON.stringify({
    model: "gpt-5.4-mini",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [],
    parallel_tool_calls: false,
  });
}

describe("OpenAI gateway compact", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    ({ OpenAIGatewayBudgetDO } = await import("../../apps/control-plane-worker/src/openai-gateway/budget-do"));
    ({ createOpenAIGatewaySessionToken, hashVirtualKey } =
      await import("../../apps/control-plane-worker/src/openai-gateway/db"));
    ({ handleOpenAIResponses } = await import("../../apps/control-plane-worker/src/openai-gateway/service"));
  });

  it("registers POST /openai/responses/compact in the route table", async () => {
    const { controlPlaneRoutes } = await import("../../apps/control-plane-worker/src/routes/table");
    const match = controlPlaneRoutes.find(
      (route) => route.method === "POST" && route.pattern.test("/openai/responses/compact"),
    );
    expect(match).toBeDefined();
    expect(match?.auth).toBe("public");
  });

  it("forwards compact requests to the compact upstream URL with auth swap and settles usage", async () => {
    const { env, db } = await createEnv();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.openai.com/v1/responses/compact");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer real-openai-key");
      return new Response(
        JSON.stringify({ id: "resp_compact", output: [], usage: { input_tokens: 1_000, output_tokens: 100 } }),
        { headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(compactRequest(compactPayload()), env as never, undefined, "compact");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "resp_compact", output: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      lifecycle_status: "settled",
      openai_response_id: "resp_compact",
      input_tokens: 1_000,
      output_tokens: 100,
    });
  });

  it("settles at the reserved estimate when compact usage is missing", async () => {
    const { env, db } = await createEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ output: [] })));
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(compactRequest(compactPayload()), env as never, undefined, "compact");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ output: [] });
    // No retrieve-by-id attempt: compact response IDs are not retrievable.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      lifecycle_status: "settled",
      settlement_source: "compact_estimate",
    });
    const settledCost = row.actual_cost_usd_micros as number;
    expect(settledCost).toBeGreaterThan(0);
    expect(settledCost).toBe(row.reserved_cost_usd_micros);
    // Budget cap is charged the estimate: no reservation left, spend recorded.
    const budget = env.OPENAI_GATEWAY_BUDGET as ReturnType<typeof createBudgetNamespace>;
    const stateResponse = await budget.get(budget.idFromName("vk_1")).fetch("https://internal/budget/state");
    await expect(stateResponse.json()).resolves.toMatchObject({
      state: { spentUsdMicros: settledCost, reservedUsdMicros: 0 },
    });
  });

  it("marks settlement unresolved for malformed compact responses", async () => {
    const { env, db } = await createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const response = await handleOpenAIResponses(compactRequest(compactPayload()), env as never, undefined, "compact");

    expect(response.status).toBe(200);
    const row = db.db.prepare("SELECT * FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      lifecycle_status: "settlement_unresolved",
      unresolved_reason: "compact_response_malformed",
    });
  });

  it("releases the reservation and passes through compact upstream rejections", async () => {
    const { env, db } = await createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );

    const response = await handleOpenAIResponses(compactRequest(compactPayload()), env as never, undefined, "compact");

    expect(response.status).toBe(429);
    const row = db.db.prepare("SELECT lifecycle_status FROM openai_gateway_ledger").get() as Record<string, unknown>;
    expect(row.lifecycle_status).toBe("released");
  });

  it("still returns the compact body when settlement fails after upstream success", async () => {
    const { env, db } = await createEnv();
    db.failNextSettleUpdate = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: "resp_compact_fail", output: [], usage: { input_tokens: 100, output_tokens: 10 } }),
          ),
      ),
    );

    const waitUntil: Promise<unknown>[] = [];
    const response = await handleOpenAIResponses(
      compactRequest(compactPayload()),
      env as never,
      { waitUntil: (promise: Promise<unknown>) => waitUntil.push(promise) } as ExecutionContext,
      "compact",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "resp_compact_fail", output: [] });
    await expect(Promise.all(waitUntil)).resolves.toEqual([undefined]);
  });

  it("rejects compact requests with an invalid gateway token before side effects", async () => {
    const { env, db } = await createEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(
      compactRequest(compactPayload(), { authorization: "Bearer arc-vk-wrong" }),
      env as never,
      undefined,
      "compact",
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM openai_gateway_ledger").get()).toMatchObject({ n: 0 });
  });

  it("rejects invalid compact payloads with 400", async () => {
    const { env } = await createEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(compactRequest("not json"), env as never, undefined, "compact");

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects compact payloads without a model before reserving budget", async () => {
    const { env, db } = await createEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleOpenAIResponses(
      compactRequest(JSON.stringify({ input: [] })),
      env as never,
      undefined,
      "compact",
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM openai_gateway_ledger").get()).toMatchObject({ n: 0 });
  });

  it("returns the Cycloid budget error on compact when the budget is exhausted", async () => {
    const { env } = await createEnv(10);
    const response = await handleOpenAIResponses(compactRequest(compactPayload()), env as never, undefined, "compact");

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "cycloid_openai_budget_exhausted" });
  });
});
