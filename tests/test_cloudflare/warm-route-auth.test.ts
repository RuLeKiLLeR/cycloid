import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDurableNamespace,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  workerFetch,
  type WorkerModule,
} from "./helpers/worker-harness";

mockCloudflareWorkers();
mockSentryCloudflare();

vi.mock("../../apps/control-plane-worker/src/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  setLoggerErrorHandler: () => {},
}));

vi.mock("../../apps/control-plane-worker/src/observability/wrappers", () => ({
  tracedEnv: (env: unknown) => env,
  tracedFetch: vi.fn(),
}));

vi.mock("../../apps/control-plane-worker/src/observability/exporter", () => ({
  flushSpansToQueue: () => Promise.resolve(),
}));

let workerModule: WorkerModule;

beforeAll(async () => {
  workerModule = await import("../../apps/control-plane-worker/src/index");
});

function createEnv() {
  const db = {
    prepare: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue({ ok: 1 }),
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    }),
  };

  const env = {
    DB: db,
    REPOS_CACHE: { get: vi.fn().mockResolvedValue(null) },
    RATE_LIMITS: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    DERIVED_MODELS: { get: vi.fn().mockResolvedValue(null) },
    TRACE_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    ARCANIST_ADMIN_TOKEN: "admin-secret",
    CI_AUTOMATION_TOKEN: "ci-secret",
    WORKER_ENV: "test",
    FRONTEND_URL: "https://app.trycycloid.com",
    LOG_LEVEL: "info",
  } as Record<string, unknown>;

  env.SESSION = createDurableNamespace(workerModule.SessionDO, env);
  return env;
}

describe("warm route auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated warm requests", async () => {
    const env = createEnv();

    const response = await workerFetch(workerModule, env, "/api/health/warm");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "Unauthorized" });
  });

  it("allows automation-authenticated warm requests", async () => {
    const env = createEnv();

    const response = await workerFetch(workerModule, env, "/api/health/warm", {
      headers: { authorization: "Bearer ci-secret" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
