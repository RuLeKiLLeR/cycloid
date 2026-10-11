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

function createEnv(options: { migrationRows?: Array<{ name: string }>; allError?: Error } = {}) {
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      first: vi.fn().mockResolvedValue({ ok: 1 }),
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockImplementation(() => {
        if (!sql.includes("d1_migrations")) return Promise.resolve({ results: [] });
        if (options.allError) return Promise.reject(options.allError);
        return Promise.resolve({ results: options.migrationRows ?? [] });
      }),
      run: vi.fn().mockResolvedValue({ success: true }),
    })),
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

describe("schema-version route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated requests (no deploy metadata on the public surface)", async () => {
    const env = createEnv({ migrationRows: [{ name: "0001_init.sql" }] });

    const response = await workerFetch(workerModule, env, "/api/health/schema");

    expect(response.status).toBe(401);
  });

  it("returns applied migration names for automation tokens", async () => {
    const env = createEnv({ migrationRows: [{ name: "0001_init.sql" }, { name: "0002_sessions.sql" }] });

    const response = await workerFetch(workerModule, env, "/api/health/schema", {
      headers: { authorization: "Bearer ci-secret" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      appliedNames: ["0001_init.sql", "0002_sessions.sql"],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns applied migration names for the admin token", async () => {
    const env = createEnv({ migrationRows: [{ name: "0001_init.sql" }] });

    const response = await workerFetch(workerModule, env, "/api/health/schema", {
      headers: { authorization: "Bearer admin-secret" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, appliedNames: ["0001_init.sql"] });
  });

  it("fails closed with 500 when d1_migrations is unreadable", async () => {
    const env = createEnv({ allError: new Error("no such table: d1_migrations") });

    const response = await workerFetch(workerModule, env, "/api/health/schema", {
      headers: { authorization: "Bearer ci-secret" },
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Schema version unavailable");
  });
});
