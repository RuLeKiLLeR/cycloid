/**
 * Rollout upload size-cap defense (PR6).
 *
 * The DO reads the streamed rollout body incrementally and returns 413 the
 * moment the running byte total exceeds ROLLOUT_MAX_BYTES, even when
 * Content-Length is absent or understates the real size. We mock the archive
 * module with a tiny cap so we can prove the mid-read 413 with a small crafted
 * stream instead of allocating the real 100MB ceiling.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROLLOUT_CAP = 8;
const writeRolloutSpy = vi.fn(async (..._args: unknown[]) => true);

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

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

// Keep every other archive export real; only shrink the cap and spy writeRollout
// so we observe what the DO ultimately passed (or did not pass) to storage.
vi.mock("../../apps/control-plane-worker/src/services/archive.js", async () => {
  const actual = await vi.importActual<typeof import("../../apps/control-plane-worker/src/services/archive")>(
    "../../apps/control-plane-worker/src/services/archive",
  );
  return {
    ...actual,
    ROLLOUT_MAX_BYTES: TEST_ROLLOUT_CAP,
    writeRollout: (...args: Parameters<typeof actual.writeRollout>) => writeRolloutSpy(...args),
  };
});

import * as doDb from "../../apps/control-plane-worker/src/session/do-db.ts";
import { computeSha256Hex } from "../../apps/control-plane-worker/src/utils.ts";
import type { DurableNamespace } from "../test_cloudflare/helpers/worker-harness";
import { createWorkerEnv, seedAuthUser, sessionTokenHeaders, workerFetch, type WorkerModule } from "./helpers";

type SessionSql = Parameters<typeof doDb.ensureSandboxState>[0];

function getSessionSql(env: Record<string, unknown>, sessionId: string): SessionSql {
  const state = (env.SESSION as DurableNamespace)._getState(sessionId);
  expect(state).toBeDefined();
  return (state!.storage as unknown as { sql: SessionSql }).sql;
}

async function seedReadySession(
  workerModule: WorkerModule,
  env: Record<string, unknown>,
  headers: Record<string, string>,
  sessionId: string,
): Promise<void> {
  const createRes = await workerFetch(workerModule, env, "/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId,
      repoUrl: "https://github.com/test-owner/test-repo",
      baseBranch: "main",
    }),
  });
  expect(createRes.status).toBe(201);

  const sql = getSessionSql(env, sessionId);
  doDb.ensureSandboxState(sql, sessionId);
  doDb.updateSandboxState(sql, sessionId, {
    sandboxAuthTokenHash: await computeSha256Hex("cap-sandbox-token"),
    status: "ready",
  });
}

describe("smoke: rollout upload size cap (mid-read 413)", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    writeRolloutSpy.mockClear();
  });

  it("413s when a streamed body exceeds the cap with NO Content-Length, without buffering past the cap", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "cap-user", 3001, "capuser");
    const headers = sessionTokenHeaders("cap-user");
    await seedReadySession(workerModule, env, headers, "s-cap-nolen");

    // 6 chunks * 4 bytes = 24 bytes total, cap is 8. No Content-Length header.
    // Track how many chunks the DO actually pulled before bailing.
    let chunksRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead >= 6) {
          controller.close();
          return;
        }
        chunksRead += 1;
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
    });

    const res = await workerFetch(workerModule, env, "/api/sessions/s-cap-nolen/rollout", {
      method: "PUT",
      headers: { authorization: "Bearer cap-sandbox-token", "content-type": "application/gzip" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    // Never wrote anything to storage.
    expect(writeRolloutSpy).not.toHaveBeenCalled();
    // Stopped reading as soon as the running total crossed the cap (8 bytes ->
    // 3 chunks), rather than draining all 24 bytes.
    expect(chunksRead).toBeLessThan(6);
  });

  it("413s via the Content-Length precheck when the DO sees a declared length over the cap", async () => {
    // Drive the DO route directly so the client's honest Content-Length header
    // reaches the precheck (the worker's stream-forwarding harness does not
    // propagate it). 12-byte body, matching Content-Length of 12 > cap (8).
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "cap-user-fp", 3004, "capuserfp");
    const headers = sessionTokenHeaders("cap-user-fp");
    await seedReadySession(workerModule, env, headers, "s-cap-fastpath");

    const namespace = env.SESSION as DurableNamespace & {
      get(id: string): { fetch(request: Request): Promise<Response> };
    };
    const stub = namespace.get("s-cap-fastpath");
    const doRequest = new Request("https://do.internal/session/rollout", {
      method: "PUT",
      headers: {
        authorization: "Bearer cap-sandbox-token",
        "content-type": "application/gzip",
        "content-length": "12",
      },
      body: new Uint8Array(12),
    });

    const res = await stub.fetch(doRequest);
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    expect(writeRolloutSpy).not.toHaveBeenCalled();
  });

  it("413s when Content-Length UNDERSTATES a streamed body that exceeds the cap", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "cap-user2", 3002, "capuser2");
    const headers = sessionTokenHeaders("cap-user2");
    await seedReadySession(workerModule, env, headers, "s-cap-lies");

    // Declared length is under the cap (a lie); the actual stream is 24 bytes.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 6; i += 1) controller.enqueue(new Uint8Array([9, 9, 9, 9]));
        controller.close();
      },
    });

    const res = await workerFetch(workerModule, env, "/api/sessions/s-cap-lies/rollout", {
      method: "PUT",
      headers: {
        authorization: "Bearer cap-sandbox-token",
        "content-type": "application/gzip",
        "content-length": "4",
      },
      body,
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBe(413);
    expect(writeRolloutSpy).not.toHaveBeenCalled();
  });

  it("stores a streamed body that stays within the cap (200)", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "cap-user3", 3003, "capuser3");
    const headers = sessionTokenHeaders("cap-user3");
    await seedReadySession(workerModule, env, headers, "s-cap-ok");

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });

    const res = await workerFetch(workerModule, env, "/api/sessions/s-cap-ok/rollout", {
      method: "PUT",
      headers: { authorization: "Bearer cap-sandbox-token", "content-type": "application/gzip" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(writeRolloutSpy).toHaveBeenCalledTimes(1);
    const passedBody = writeRolloutSpy.mock.calls[0]![2] as Uint8Array;
    expect(passedBody).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});
