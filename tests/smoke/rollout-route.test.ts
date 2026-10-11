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

vi.mock("../../apps/control-plane-worker/src/github/octokit", () => ({
  createInstallationToken: async () => "ghs_install_token",
  createScopedInstallationToken: async () => "ghs_install_token",
  sandboxInstallationTokenScope: (repoName: string) => ({
    repositories: [repoName],
    permissions: { contents: "write", pull_requests: "read" },
  }),
  getAppSlug: async () => "cycloid-dev",
}));

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

async function createSession(
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
}

describe("smoke: rollout route", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  it("enforces sandbox auth, rejects empty bodies, and round-trips rollout bytes via S3", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "rollout-user", 2001, "rolloutuser");
    const headers = sessionTokenHeaders("rollout-user");

    await createSession(workerModule, env, headers, "s-rollout");

    // --- case 1: PUT with no auth → 401 ---
    const unauthorizedRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
    });
    expect(unauthorizedRes.status).toBe(401);

    // --- case 1b: GET with no auth → 401 ---
    const unauthorizedGet = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "GET",
    });
    expect(unauthorizedGet.status).toBe(401);

    // Seed the sandbox auth token + a ready sandbox so the active-session gate on
    // the rollout PUT passes (the session is created 'active' by default).
    const sql = getSessionSql(env, "s-rollout");
    doDb.ensureSandboxState(sql, "s-rollout");
    doDb.updateSandboxState(sql, "s-rollout", {
      sandboxAuthTokenHash: await computeSha256Hex("rollout-sandbox-token"),
      status: "ready",
    });

    // --- case 2: PUT with auth but empty body → 400 ---
    const emptyBodyRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
      method: "PUT",
      headers: {
        authorization: "Bearer rollout-sandbox-token",
        "content-type": "application/gzip",
      },
    });
    expect(emptyBodyRes.status).toBe(400);
    await expect(emptyBodyRes.json()).resolves.toMatchObject({ ok: false });

    // Set S3 env vars for the remaining cases.
    env.S3_ACCESS_KEY_ID = "test-access-key";
    env.S3_SECRET_ACCESS_KEY = "test-secret-key";
    env.S3_SESSION_BUCKET = "test-session-bucket";
    env.S3_REGION = "us-east-1";

    const S3_PREFIX = "https://test-session-bucket.s3.us-east-1.amazonaws.com/";
    const originalFetch = globalThis.fetch;
    const stored = new Map<string, Uint8Array>();

    // --- case 3: PUT with auth + non-empty body, mocked S3 PUT → 200 { ok: true } ---
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url.startsWith(S3_PREFIX)) {
        if (req.method === "PUT") {
          stored.set(req.url, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        const body = stored.get(req.url);
        if (!body) return new Response("not found", { status: 404 });
        return new Response(body, { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      const rolloutBody = new Uint8Array([1, 2, 3, 4, 5]);
      const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
        method: "PUT",
        headers: {
          authorization: "Bearer rollout-sandbox-token",
          "content-type": "application/gzip",
        },
        body: rolloutBody,
      });
      expect(uploadRes.status).toBe(200);
      await expect(uploadRes.json()).resolves.toEqual({ ok: true });
      // The worker forwarded the body to the DO without buffering; the DO
      // assembled the bounded chunks and writeRollout stored the exact bytes.
      const storedUpload = stored.get(`${S3_PREFIX}sessions/s-rollout/codex-rollout.tar.gz`);
      expect(storedUpload).toEqual(rolloutBody);

      // --- case 3b: streaming ReadableStream body (no Content-Length) → 200, bytes stored ---
      stored.clear();
      const streamedBytes = new Uint8Array([10, 20, 30, 40]);
      const streamBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(streamedBytes.slice(0, 2));
          controller.enqueue(streamedBytes.slice(2));
          controller.close();
        },
      });
      const streamUploadRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
        method: "PUT",
        headers: {
          authorization: "Bearer rollout-sandbox-token",
          "content-type": "application/gzip",
        },
        body: streamBody,
        // Required when a fetch body is a ReadableStream.
        duplex: "half",
      } as RequestInit);
      expect(streamUploadRes.status).toBe(200);
      await expect(streamUploadRes.json()).resolves.toEqual({ ok: true });
      const storedStream = stored.get(`${S3_PREFIX}sessions/s-rollout/codex-rollout.tar.gz`);
      expect(storedStream).toEqual(streamedBytes);

      // --- case 4: GET with auth, S3 returns 404 → route returns 404 ---
      stored.clear(); // remove the stored body so S3 mock returns 404
      const missingRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
        method: "GET",
        headers: { authorization: "Bearer rollout-sandbox-token" },
      });
      expect(missingRes.status).toBe(404);

      // --- case 5: GET with auth, S3 returns bytes → 200 and bytes round-trip ---
      const expectedBytes = new Uint8Array([7, 7, 7]);
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (req.url.startsWith(S3_PREFIX)) {
          if (req.method === "GET") {
            return new Response(expectedBytes, { status: 200 });
          }
          return new Response(null, { status: 200 });
        }
        return originalFetch(input, init);
      };

      const downloadRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
        method: "GET",
        headers: { authorization: "Bearer rollout-sandbox-token" },
      });
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers.get("content-type")).toBe("application/gzip");
      const downloadedBuffer = await downloadRes.arrayBuffer();
      expect(new Uint8Array(downloadedBuffer)).toEqual(expectedBytes);

      // --- case 6: archived session rejects PUT (active-session gate) → 403 ---
      doDb.updateSession(sql, "s-rollout", { status: "archived" });
      const archivedPutRes = await workerFetch(workerModule, env, "/api/sessions/s-rollout/rollout", {
        method: "PUT",
        headers: { authorization: "Bearer rollout-sandbox-token", "content-type": "application/gzip" },
        body: new Uint8Array([9, 9]),
      });
      expect(archivedPutRes.status).toBe(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
