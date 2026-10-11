import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLATFORM_LLM_CALL_CONFIG,
  PLATFORM_LLM_MAX_REQUEST_BYTES,
} from "../../apps/control-plane-worker/src/constants/platform-llm";
import * as doDb from "../../apps/control-plane-worker/src/session/do-db";
import { initSchema } from "../../apps/control-plane-worker/src/session/schema";
import { computeSha256Hex } from "../../apps/control-plane-worker/src/utils";
import {
  FakeDurableState,
  FakeKV,
  FakeSqlStorage,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "../test_cloudflare/helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("../../apps/control-plane-worker/src/logger", () => {
  const createTestLogger = (): unknown => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => createTestLogger(),
  });
  return {
    createLogger: createTestLogger,
    setLoggerErrorHandler: () => {},
  };
});

vi.mock("../../apps/control-plane-worker/src/observability/exporter", () => ({
  flushSpansToQueue: () => Promise.resolve(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: () => Promise.resolve(),
}));

let workerModule: WorkerModule;

beforeAll(async () => {
  workerModule = await import("../../apps/control-plane-worker/src/index");
});

type BrokerHarness = {
  env: Record<string, unknown>;
  sql: SqlStorage;
  sessionId: string;
  sandboxId: string;
  sandboxToken: string;
  capabilityToken: string;
  sessionFetch: (path: string, init?: RequestInit) => Promise<Response>;
};

async function insertPromptPreparationCapability(
  sql: SqlStorage,
  params: {
    token: string;
    sessionId: string;
    sandboxId: string;
    promptId: string;
    callType?: "review_loop_triage";
  },
): Promise<void> {
  const now = Date.now();
  doDb.insertPlatformLlmCapability(sql, {
    idHash: await computeSha256Hex(params.token),
    sessionId: params.sessionId,
    sandboxId: params.sandboxId,
    promptId: params.promptId,
    callType: params.callType ?? "review_loop_triage",
    phase: "prompt_preparation",
    expiresAt: now + 60_000,
    createdAt: now,
  });
}

async function createBrokerHarness(): Promise<BrokerHarness> {
  const sessionId = "s-platform-llm";
  const sandboxId = "sandbox-1";
  const sandboxToken = "sandbox-token";
  const capabilityToken = "capability-token";
  const storage = new FakeSqlStorage();
  const state = new FakeDurableState(storage);
  const env: Record<string, unknown> = {
    DB: {},
    REPOS_CACHE: new FakeKV(),
    RATE_LIMITS: new FakeKV(),
    DERIVED_MODELS: new FakeKV(),
    WORKER_ENV: "test",
    FRONTEND_URL: "https://app.trycycloid.com",
    LOG_LEVEL: "info",
    ARCANIST_OPENAI_API_KEY: "sk-openai-test",
  };
  const sessionDo = new workerModule.SessionDO(state, env);
  const sessionFetch = (path: string, init?: RequestInit) =>
    sessionDo.fetch(new Request(new URL(path, "https://session.internal").toString(), init));
  env.SESSION = {
    idFromName: () => sessionId,
    get: () => ({
      fetch: (request: Request | string, init?: RequestInit) =>
        sessionDo.fetch(request instanceof Request ? request : new Request(request, init)),
    }),
  };

  initSchema(storage.sql as unknown as SqlStorage);
  const sql = storage.sql as unknown as SqlStorage;
  doDb.createSession(sql, { sessionId, ownerUserId: "1", businessId: "biz-1" });
  doDb.ensureSandboxState(sql, sessionId);
  doDb.updateSandboxState(sql, sessionId, {
    sandboxId,
    sandboxAuthTokenHash: await computeSha256Hex(sandboxToken),
  });
  await insertPromptPreparationCapability(sql, {
    token: capabilityToken,
    sessionId,
    sandboxId,
    promptId: "p-1",
  });

  return { env, sql, sessionId, sandboxId, sandboxToken, capabilityToken, sessionFetch };
}

function providerSuccessResponse(input: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify(input),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function brokerRequestBody(
  input: unknown = {
    repo: "trycycloid/cycloid",
    prNumber: 1,
    headSha: "abc123",
    items: [
      {
        sourceId: "comment:1",
        kind: "comment",
        authorLogin: "reviewer",
        authorType: "User",
        location: null,
        body: "Fix this",
        diffHunk: null,
      },
    ],
  },
): string {
  return JSON.stringify({
    callType: "review_loop_triage",
    phase: "prompt_preparation",
    input,
  });
}

const providerEnvKeys = [
  "ARCANIST_OPENAI_API_KEY",
  "ARCANIST_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY",
] as const;
const originalProviderEnv = new Map(providerEnvKeys.map((key) => [key, process.env[key]]));

function restoreProviderEnv(): void {
  for (const key of providerEnvKeys) {
    const original = originalProviderEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("platform LLM broker smoke", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreProviderEnv();
  });

  it("rejects sandbox auth alone without consuming a capability", async () => {
    const harness = await createBrokerHarness();

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "content-type": "application/json",
        },
        body: brokerRequestBody(),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, category: "capability_invalid" });
    expect(
      doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(harness.capabilityToken))?.usedAt,
    ).toBeNull();
  });

  it("rejects oversized input before capability consumption", async () => {
    const harness = await createBrokerHarness();

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "x-platform-llm-capability": harness.capabilityToken,
          "content-type": "application/json",
        },
        body: brokerRequestBody({
          repo: "trycycloid/cycloid",
          prNumber: 1,
          headSha: "abc123",
          items: [
            {
              sourceId: "comment:1",
              kind: "comment",
              authorLogin: "reviewer",
              authorType: "User",
              location: null,
              body: "x".repeat(PLATFORM_LLM_CALL_CONFIG.review_loop_triage.maxInputBytes + 1),
              diffHunk: null,
            },
          ],
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, category: "input_too_large" });
    expect(
      doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(harness.capabilityToken))?.usedAt,
    ).toBeNull();
  });

  it("rejects oversized Content-Length before buffering or capability consumption", async () => {
    const harness = await createBrokerHarness();

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "x-platform-llm-capability": harness.capabilityToken,
          "content-length": String(PLATFORM_LLM_MAX_REQUEST_BYTES + 1),
          "content-type": "application/json",
        },
        body: brokerRequestBody(),
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, category: "input_too_large" });
    expect(
      doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(harness.capabilityToken))?.usedAt,
    ).toBeNull();
  });

  it("rejects oversized item arrays before capability consumption", async () => {
    const harness = await createBrokerHarness();
    const token = "review-loop-triage-capability-token";
    await insertPromptPreparationCapability(harness.sql, {
      token,
      sessionId: harness.sessionId,
      sandboxId: harness.sandboxId,
      promptId: "p-review-loop-triage",
      callType: "review_loop_triage",
    });

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "x-platform-llm-capability": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          callType: "review_loop_triage",
          phase: "prompt_preparation",
          input: {
            repo: "trycycloid/cycloid",
            prNumber: 1,
            headSha: "abc123",
            items: Array.from({ length: 101 }, (_, index) => ({
              sourceId: `comment:${index}`,
              kind: "comment",
              authorLogin: "reviewer",
              authorType: "User",
              location: null,
              body: "Fix this",
              diffHunk: null,
            })),
          },
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, category: "input_too_large" });
    expect(doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(token))?.usedAt).toBeNull();
  });

  it("rejects oversized internal validation requests before capability consumption", async () => {
    const harness = await createBrokerHarness();

    const response = await harness.sessionFetch("/session/platform-llm/prompt-preparation", {
      method: "POST",
      headers: {
        authorization: `Bearer ${harness.sandboxToken}`,
        "x-platform-llm-capability": harness.capabilityToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        callType: "review_loop_triage",
        phase: "prompt_preparation",
        inputBytes: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.maxInputBytes + 1,
      }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, category: "input_too_large" });
    expect(
      doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(harness.capabilityToken))?.usedAt,
    ).toBeNull();
  });

  it("does not rate limit unauthenticated or missing-capability requests", async () => {
    const harness = await createBrokerHarness();
    const statuses: number[] = [];

    for (let i = 0; i < 21; i += 1) {
      const response = await workerFetch(
        workerModule,
        harness.env,
        `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${harness.sandboxToken}`,
            "content-type": "application/json",
          },
          body: brokerRequestBody(),
        },
      );
      statuses.push(response.status);
    }

    expect(statuses.every((status) => status === 409)).toBe(true);
    expect(
      doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(harness.capabilityToken))?.usedAt,
    ).toBeNull();
  });

  it("rate limits authenticated valid-capability requests before consuming the over-limit capability", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const harness = await createBrokerHarness();
    const tokens = Array.from({ length: 21 }, (_, index) => `rate-capability-token-${index}`);
    for (const [index, token] of tokens.entries()) {
      await insertPromptPreparationCapability(harness.sql, {
        token,
        sessionId: harness.sessionId,
        sandboxId: harness.sandboxId,
        promptId: `p-rate-${index}`,
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          providerSuccessResponse({
            actionItems: [{ instruction: "Fix this", sourceIds: ["comment:1"] }],
            droppedItems: [],
            conflicts: [],
          }),
        ),
      ),
    );

    const statuses: number[] = [];
    for (const token of tokens) {
      const response = await workerFetch(
        workerModule,
        harness.env,
        `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${harness.sandboxToken}`,
            "x-platform-llm-capability": token,
            "content-type": "application/json",
          },
          body: brokerRequestBody(),
        },
      );
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(tokens[20]))?.usedAt).toBeNull();
  });

  it("runs the public route through DO consume and provider transport", async () => {
    const harness = await createBrokerHarness();
    const providerFetch = vi.fn().mockResolvedValue(
      providerSuccessResponse({
        actionItems: [{ instruction: "Fix this", sourceIds: ["comment:1"] }],
        droppedItems: [],
        conflicts: [],
      }),
    );
    vi.stubGlobal("fetch", providerFetch);

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "x-platform-llm-capability": harness.capabilityToken,
          "content-type": "application/json",
        },
        body: brokerRequestBody(),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { actionItems: [{ instruction: "Fix this", sourceIds: ["comment:1"] }], droppedItems: [] },
      attempts: 1,
    });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(doDb.getPlatformLlmCapability(harness.sql, await computeSha256Hex(harness.capabilityToken))?.usedAt).toEqual(
      expect.any(Number),
    );
    expect(doDb.getPlatformLlmBudgetUsed(harness.sql, "p-1", "review_loop_triage")).toBe(1);
  });

  it("returns oversized provider output as output_too_large after consuming a valid capability", async () => {
    const harness = await createBrokerHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        providerSuccessResponse({
          actionItems: [{ instruction: "Fix this", sourceIds: ["comment:1"] }],
          droppedItems: [],
          conflicts: [],
          text: "x".repeat(PLATFORM_LLM_CALL_CONFIG.review_loop_triage.maxOutputBytes + 1),
        }),
      ),
    );

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "x-platform-llm-capability": harness.capabilityToken,
          "content-type": "application/json",
        },
        body: brokerRequestBody(),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      category: "output_too_large",
      details: expect.objectContaining({ maxOutputBytes: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.maxOutputBytes }),
    });
    expect(doDb.getPlatformLlmBudgetUsed(harness.sql, "p-1", "review_loop_triage")).toBe(1);
  });

  it("returns a typed provider failure after consuming a valid capability", async () => {
    const harness = await createBrokerHarness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [] }), { status: 200 })));

    const response = await workerFetch(
      workerModule,
      harness.env,
      `/api/sessions/${harness.sessionId}/platform-llm/prompt-preparation`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${harness.sandboxToken}`,
          "x-platform-llm-capability": harness.capabilityToken,
          "content-type": "application/json",
        },
        body: brokerRequestBody(),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, category: "output_shape" });
    expect(doDb.getPlatformLlmBudgetUsed(harness.sql, "p-1", "review_loop_triage")).toBe(1);
  });
});
