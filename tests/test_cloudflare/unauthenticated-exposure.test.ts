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
  const env = {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    },
    REPOS_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    RATE_LIMITS: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    DERIVED_MODELS: { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) },
    TRACE_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    WORKER_ENV: "test",
    FRONTEND_URL: "https://app.trycycloid.com",
    LOG_LEVEL: "info",
  } as Record<string, unknown>;

  env.SESSION = createDurableNamespace(workerModule.SessionDO, env, { sqlStorage: true });
  return env;
}

async function expectFailClosed(env: Record<string, unknown>, method: string, path: string, allowedStatuses: number[]) {
  const response = await workerFetch(workerModule, env, path, { method });
  const body = await response.text();
  expect(allowedStatuses, `${method} ${path}: ${body}`).toContain(response.status);
  expect(body, `${method} ${path} should not expose repo URLs`).not.toContain("repoUrl");
  expect(body, `${method} ${path} should not expose logs`).not.toContain("stdout");
  expect(body, `${method} ${path} should not expose sqlite artifacts`).not.toContain(".sqlite");
}

describe("unauthenticated exposure boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated application API routes", async () => {
    const env = createEnv();
    const routes: Array<[string, string]> = [
      ["GET", "/auth/me"],
      ["GET", "/api/bootstrap"],
      ["GET", "/api/sessions"],
      ["GET", "/api/models"],
      ["GET", "/api/repos"],
      ["GET", "/api/cli-tokens"],
    ];

    for (const [method, path] of routes) {
      await expectFailClosed(env, method, path, [401, 404]);
    }
  });

  it("fails closed for random public bridge and artifact routes", async () => {
    const env = createEnv();
    const sessionId = "00000000-0000-4000-8000-000000000537";
    const artifactId = "00000000-0000-4000-8000-000000000538";
    const routes: Array<[string, string, number[]]> = [
      ["GET", `/api/sessions/${sessionId}/clone-token`, [401, 403, 404]],
      ["GET", `/api/sessions/${sessionId}/cli-auth-token`, [401, 403, 404]],
      ["POST", `/api/sessions/${sessionId}/platform-llm/prompt-preparation`, [400, 401, 403, 404]],
      ["POST", `/api/sessions/${sessionId}/platform-llm/post-execution`, [400, 401, 403, 404]],
      ["POST", `/api/sessions/${sessionId}/artifacts`, [401, 403, 404]],
      ["GET", `/api/sessions/${sessionId}/artifacts/${artifactId}/artifact.txt`, [404]],
    ];

    for (const [method, path, allowedStatuses] of routes) {
      await expectFailClosed(env, method, path, allowedStatuses);
    }
  });
});
