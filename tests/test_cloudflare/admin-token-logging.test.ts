import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("@sentry/cloudflare", () => ({
  instrumentDurableObjectWithSentry: (_optionsCallback: unknown, DurableObjectClass: unknown) => DurableObjectClass,
  withSentry: (_optionsCallback: unknown, handler: unknown) => handler,
  setTag: () => {},
  setUser: () => {},
  captureException: () => {},
}));

import { createWorkerEnv, seedAuthUser } from "../smoke/helpers";
import { workerFetch, type WorkerModule } from "./helpers/worker-harness";

describe("admin token auth logging", () => {
  let workerModule: WorkerModule;
  let env: Record<string, unknown>;

  const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeAll(async () => {
    const workerModulePath: string = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    const created = createWorkerEnv(workerModule);
    env = created.env;
    seedAuthUser(created.db, "session-token-user", 1, "testuser");
  });

  it("logs a warn-level event when admin token is used", async () => {
    await workerFetch(workerModule, env, "/api/sessions", {
      headers: {
        authorization: "Bearer admin-secret",
        "content-type": "application/json",
      },
    });

    const adminLogCall = consoleSpy.mock.calls.find((call) => {
      const msg = String(call[0]);
      return msg.includes("admin_token_used");
    });

    expect(adminLogCall).toBeDefined();
    const parsed = JSON.parse(String(adminLogCall![0]));
    expect(parsed.action).toBe("admin_token_used");
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/api/sessions");
  });

  it("does not log admin_token_used for regular session auth", async () => {
    await workerFetch(workerModule, env, "/api/sessions", {
      headers: {
        cookie: "session_token=session-token-user",
        "content-type": "application/json",
      },
    });

    const allCalls = [...consoleSpy.mock.calls, ...consoleLogSpy.mock.calls];
    const adminLogCall = allCalls.find((call) => {
      const msg = String(call[0]);
      return msg.includes("admin_token_used");
    });

    expect(adminLogCall).toBeUndefined();
  });

  it("does not log admin_token_used for unknown bearer token auth", async () => {
    await workerFetch(workerModule, env, "/api/sessions", {
      headers: {
        authorization: "Bearer mcp-secret",
        "content-type": "application/json",
      },
    });

    const allCalls = [...consoleSpy.mock.calls, ...consoleLogSpy.mock.calls];
    const adminLogCall = allCalls.find((call) => {
      const msg = String(call[0]);
      return msg.includes("admin_token_used");
    });

    expect(adminLogCall).toBeUndefined();
  });
});
