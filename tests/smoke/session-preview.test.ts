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

import {
  type ArtifactAccessMetadata,
  PUBLIC_ARTIFACT_CACHE_CONTROL,
} from "../../apps/control-plane-worker/src/session/artifacts.ts";
import * as doDb from "../../apps/control-plane-worker/src/session/do-db.ts";
import { computeSha256Hex } from "../../apps/control-plane-worker/src/utils.ts";
import { WEBM_VIDEO_MIME_TYPE, WEBM_VIDEO_SIZE_LIMIT_BYTES } from "../../shared/constants/artifacts.ts";
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

describe("smoke: session artifacts", () => {
  let workerModule: WorkerModule;

  beforeAll(async () => {
    const workerModulePath = "../../apps/control-plane-worker/src/index.js";
    workerModule = (await import(workerModulePath)) as WorkerModule;
  });

  beforeEach(() => {
    expect(workerModule).toBeDefined();
  });

  it("requires sandbox auth for artifact uploads and returns 404 for missing proxied artifacts", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user", 1007, "artifactuser");
    const headers = sessionTokenHeaders("artifact-user");

    await createSession(workerModule, env, headers, "s-artifacts");

    const unauthorizedRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-artifact-type": "screenshot",
        "x-artifact-label": "proof.png",
      },
    });
    expect(unauthorizedRes.status).toBe(401);
    await expect(unauthorizedRes.json()).resolves.toEqual({
      ok: false,
      error: "Missing sandbox auth token",
    });

    const sql = getSessionSql(env, "s-artifacts");
    doDb.ensureSandboxState(sql, "s-artifacts");
    doDb.updateSandboxState(sql, "s-artifacts", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-artifact-token"),
    });

    const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-artifact-token",
        "content-type": "image/png",
        "x-artifact-type": "screenshot",
        "x-artifact-label": "proof.png",
      },
    });
    expect(uploadRes.status).toBe(400);
    await expect(uploadRes.json()).resolves.toEqual({
      ok: false,
      error: "Artifact body is empty",
    });

    const invalidTypeRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-artifact-token",
        "content-type": "text/html",
        "x-artifact-type": "screenshot",
        "x-artifact-label": "proof.html",
      },
      body: "<!doctype html>",
    });
    expect(invalidTypeRes.status).toBe(415);
    await expect(invalidTypeRes.json()).resolves.toEqual({
      ok: false,
      error: "Unsupported artifact content type",
    });

    env.WORKER_ENV = "local";
    const reportUploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-artifact-token",
        "content-type": "text/html; charset=utf-8",
        "x-artifact-type": "report",
        "x-artifact-label": "playwright-report.html",
      },
      body: "<!doctype html><title>Playwright report</title>",
    });
    expect(reportUploadRes.status).toBe(200);
    const reportUploadBody = (await reportUploadRes.json()) as {
      ok: boolean;
      artifact?: { url: string };
    };
    expect(reportUploadBody.ok).toBe(true);
    expect(reportUploadBody.artifact?.url).toContain("/api/sessions/s-artifacts/artifacts/");
    expect(reportUploadBody.artifact?.url).not.toContain("artifactToken=");

    const reportArtifacts = doDb.listSessionArtifacts(sql, "s-artifacts");
    expect(reportArtifacts).toHaveLength(1);
    const reportArtifact = reportArtifacts[0]!;
    expect(reportArtifact.type).toBe("report");
    expect(reportArtifact.metadata).toMatchObject({
      filename: "playwright-report.html",
      contentType: "text/html",
    });

    const reportUrl = new URL(reportUploadBody.artifact!.url);
    const reportReadRes = await workerFetch(workerModule, env, reportUrl.pathname, {
      method: "GET",
      headers,
    });
    expect(reportReadRes.status).toBe(200);
    expect(reportReadRes.headers.get("content-type")).toBe("text/html");
    expect(reportReadRes.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(reportReadRes.text()).resolves.toBe("<!doctype html><title>Playwright report</title>");

    const proxyRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts/missing/proof.png", {
      method: "GET",
    });
    expect(proxyRes.status).toBe(404);
    await expect(proxyRes.text()).resolves.toBe("Not found");

    const malformedProxyRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts/missing/%zz", {
      method: "GET",
    });
    expect(malformedProxyRes.status).toBe(404);
    await expect(malformedProxyRes.text()).resolves.toBe("Not found");

    const malformedRevokeRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts/artifacts/%zz", {
      method: "DELETE",
      headers,
    });
    expect(malformedRevokeRes.status).toBe(404);
    await expect(malformedRevokeRes.json()).resolves.toEqual({
      ok: false,
      error: "Artifact not found",
    });
  });

  it("proxies intentionally public screenshot artifacts with expiring signed URLs", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user-2", 1008, "artifactuser2");
    const headers = sessionTokenHeaders("artifact-user-2");

    await createSession(workerModule, env, headers, "s-artifacts-proxy");

    const sql = getSessionSql(env, "s-artifacts-proxy");
    doDb.ensureSandboxState(sql, "s-artifacts-proxy");
    doDb.updateSandboxState(sql, "s-artifacts-proxy", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-proxy-token"),
    });
    // Mark the session as targeting a public repo so screenshot artifacts
    // get the public-URL treatment. See createArtifactAccessMetadata: only
    // sessions with repoPrivate === false get token-signed public URLs;
    // null/undefined fails safe to private.
    doDb.updateSessionFields(sql, "s-artifacts-proxy", { repoPrivate: false });

    env.S3_ACCESS_KEY_ID = "test-access-key";
    env.S3_SECRET_ACCESS_KEY = "test-secret-key";
    env.S3_SESSION_BUCKET = "test-session-bucket";
    env.S3_REGION = "us-east-1";
    env.FRONTEND_URL = "http://localhost:5173";
    env.CONTROL_PLANE_URL = "https://temporary-preview.ngrok-free.dev";

    const originalFetch = globalThis.fetch;
    const storedArtifacts = new Map<string, { body: Uint8Array; contentType: string }>();
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.startsWith("https://test-session-bucket.s3.us-east-1.amazonaws.com/")) {
        if (request.method === "PUT") {
          storedArtifacts.set(request.url, {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") || "application/octet-stream",
          });
          return new Response(null, { status: 200 });
        }

        const artifact = storedArtifacts.get(request.url);
        if (!artifact) return new Response("missing", { status: 404 });
        return new Response(artifact.body, {
          status: 200,
          headers: { "content-type": `${artifact.contentType}; charset=binary` },
        });
      }
      return originalFetch(input, init);
    };

    try {
      const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-proxy/artifacts", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-proxy-token",
          "content-type": "image/png; charset=binary",
          "x-artifact-type": "screenshot",
          "x-artifact-label": "proof.png",
        },
        body: new Uint8Array([137, 80, 78, 71]),
      });
      expect(uploadRes.status).toBe(200);
      const uploadBody = (await uploadRes.json()) as {
        ok: boolean;
        artifact?: { id: string; url: string };
      };
      expect(uploadBody.ok).toBe(true);
      expect(uploadBody.artifact?.url).toContain("/api/sessions/s-artifacts-proxy/artifacts/");
      expect(uploadBody.artifact?.url).toMatch(/^https:\/\/app\.trycycloid\.com\//);
      expect(uploadBody.artifact?.url).toContain("artifactToken=");

      const artifactPath = new URL(uploadBody.artifact!.url).pathname;
      const missingTokenRes = await workerFetch(workerModule, env, artifactPath, { method: "GET" });
      expect(missingTokenRes.status).toBe(404);
      await expect(missingTokenRes.text()).resolves.toBe("Not found");

      const artifactUrl = new URL(uploadBody.artifact!.url);
      const proxyRes = await workerFetch(workerModule, env, `${artifactUrl.pathname}${artifactUrl.search}`, {
        method: "GET",
      });
      expect(proxyRes.status).toBe(200);
      expect(proxyRes.headers.get("content-type")).toBe("image/png");
      expect(proxyRes.headers.get("x-content-type-options")).toBe("nosniff");
      expect(proxyRes.headers.get("cache-control")).toBe(PUBLIC_ARTIFACT_CACHE_CONTROL);
      await expect(proxyRes.arrayBuffer()).resolves.toEqual(new Uint8Array([137, 80, 78, 71]).buffer);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stores and serves local screenshot artifacts without S3", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user-local", 1012, "artifactuserlocal");
    const headers = sessionTokenHeaders("artifact-user-local");

    await createSession(workerModule, env, headers, "s-artifacts-local");

    const sql = getSessionSql(env, "s-artifacts-local");
    doDb.ensureSandboxState(sql, "s-artifacts-local");
    doDb.updateSandboxState(sql, "s-artifacts-local", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-local-artifact-token"),
    });
    // Public-screenshot path: see "proxies intentionally public" test above.
    doDb.updateSessionFields(sql, "s-artifacts-local", { repoPrivate: false });

    env.WORKER_ENV = "local";
    env.FRONTEND_URL = "http://localhost:5173";
    env.CONTROL_PLANE_URL = "https://temporary-preview.ngrok-free.dev";
    delete env.S3_ACCESS_KEY_ID;
    delete env.S3_SECRET_ACCESS_KEY;
    delete env.S3_SESSION_BUCKET;

    const screenshotBody = Uint8Array.from({ length: 200_000 }, (_, index) => index % 256);
    const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-local/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-local-artifact-token",
        "content-type": "image/png",
        "x-artifact-type": "screenshot",
        "x-artifact-label": "local-proof.png",
      },
      body: screenshotBody,
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      ok: boolean;
      artifact?: { id: string; url: string };
    };
    expect(uploadBody.ok).toBe(true);
    expect(uploadBody.artifact?.url).toMatch(/^https:\/\/temporary-preview\.ngrok-free\.dev\//);
    expect(uploadBody.artifact?.url).toContain("artifactToken=");

    const artifactUrl = new URL(uploadBody.artifact!.url);
    const missingTokenRes = await workerFetch(workerModule, env, artifactUrl.pathname, { method: "GET" });
    expect(missingTokenRes.status).toBe(404);

    const proxyRes = await workerFetch(workerModule, env, `${artifactUrl.pathname}${artifactUrl.search}`, {
      method: "GET",
    });
    expect(proxyRes.status).toBe(200);
    expect(proxyRes.headers.get("content-type")).toBe("image/png");
    expect(proxyRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(proxyRes.headers.get("cache-control")).toBe(PUBLIC_ARTIFACT_CACHE_CONTROL);
    await expect(proxyRes.arrayBuffer()).resolves.toEqual(screenshotBody.buffer);

    const artifact = doDb.listSessionArtifacts(sql, "s-artifacts-local")[0];
    expect(artifact.artifactId).toBe(uploadBody.artifact!.id);

    const revokeRes = await workerFetch(
      workerModule,
      env,
      `/api/sessions/s-artifacts-local/artifacts/${artifact.artifactId}`,
      {
        method: "DELETE",
        headers,
      },
    );
    expect(revokeRes.status).toBe(200);
    await expect(revokeRes.json()).resolves.toEqual({ ok: true });

    doDb.insertSessionArtifact(sql, artifact);
    const cleanedRes = await workerFetch(workerModule, env, `${artifactUrl.pathname}${artifactUrl.search}`, {
      method: "GET",
    });
    expect(cleanedRes.status).toBe(404);
  });

  it("stores desktop action screenshots as private authenticated artifacts", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user-desktop", 1018, "artifactuserdesktop");
    const headers = sessionTokenHeaders("artifact-user-desktop");

    await createSession(workerModule, env, headers, "s-artifacts-desktop-action");

    const sql = getSessionSql(env, "s-artifacts-desktop-action");
    doDb.ensureSandboxState(sql, "s-artifacts-desktop-action");
    doDb.updateSandboxState(sql, "s-artifacts-desktop-action", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-desktop-action-token"),
    });
    doDb.updateSessionFields(sql, "s-artifacts-desktop-action", { repoPrivate: false });

    env.WORKER_ENV = "local";
    env.FRONTEND_URL = "http://localhost:5173";
    env.CONTROL_PLANE_URL = "https://temporary-preview.ngrok-free.dev";
    delete env.S3_ACCESS_KEY_ID;
    delete env.S3_SECRET_ACCESS_KEY;
    delete env.S3_SESSION_BUCKET;

    const screenshotBody = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-desktop-action/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-desktop-action-token",
        "content-type": "image/png",
        "x-artifact-type": "screenshot",
        "x-artifact-kind": "desktop_action_screenshot",
        "x-artifact-label": "desktop-action.png",
        "x-desktop-action-id": "click-1",
        "x-desktop-phase": "agent",
        "x-desktop-scenario-id": "scenario-1",
      },
      body: screenshotBody,
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      ok: boolean;
      artifact?: {
        id: string;
        url: string;
        viewUrl: string;
        accessVisibility: "private" | "public";
        metadata: Record<string, unknown>;
      };
    };
    expect(uploadBody.ok).toBe(true);
    expect(uploadBody.artifact?.accessVisibility).toBe("private");
    expect(uploadBody.artifact?.url).not.toContain("artifactToken=");
    expect(uploadBody.artifact?.viewUrl).toBe(
      `/api/sessions/s-artifacts-desktop-action/artifacts/${uploadBody.artifact!.id}/view?filename=desktop-action.png`,
    );
    expect(uploadBody.artifact?.metadata).toMatchObject({
      kind: "desktop_action_screenshot",
      actionId: "click-1",
      phase: "agent",
      scenarioId: "scenario-1",
      access: { visibility: "private", expiresAt: null, revokedAt: null },
    });

    const artifact = doDb.listSessionArtifacts(sql, "s-artifacts-desktop-action")[0];
    expect(artifact.metadata).toMatchObject(uploadBody.artifact!.metadata);

    const publicPath = new URL(uploadBody.artifact!.url).pathname;
    const publicRes = await workerFetch(workerModule, env, publicPath, { method: "GET" });
    expect(publicRes.status).toBe(404);

    const authedRes = await workerFetch(workerModule, env, uploadBody.artifact!.viewUrl, {
      method: "GET",
      headers,
    });
    expect(authedRes.status).toBe(200);
    expect(authedRes.headers.get("content-type")).toBe("image/png");
    await expect(authedRes.arrayBuffer()).resolves.toEqual(screenshotBody.buffer);
  });

  it("stores an encoded display label separately from the transport-safe filename header", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user-display", 1013, "artifactuserdisplay");
    const headers = sessionTokenHeaders("artifact-user-display");

    await createSession(workerModule, env, headers, "s-artifacts-display-label");

    const sql = getSessionSql(env, "s-artifacts-display-label");
    doDb.ensureSandboxState(sql, "s-artifacts-display-label");
    doDb.updateSandboxState(sql, "s-artifacts-display-label", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-display-label-token"),
    });

    env.WORKER_ENV = "local";

    const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-display-label/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-display-label-token",
        "content-type": "image/png",
        "x-artifact-type": "screenshot",
        "x-artifact-label": "app-home.png",
        "x-artifact-display-label": encodeURIComponent("Visual assertion: Save works ✅ (app-home.png)"),
      },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      ok: boolean;
      artifact?: { id: string; label: string; url: string };
    };
    expect(uploadBody.ok).toBe(true);
    expect(uploadBody.artifact?.label).toBe("Visual assertion: Save works ✅ (app-home.png)");

    const artifact = doDb.listSessionArtifacts(sql, "s-artifacts-display-label")[0];
    expect(artifact.metadata?.label).toBe("Visual assertion: Save works ✅ (app-home.png)");
    expect(artifact.metadata?.filename).toBe("app-home.png");
  });

  it("stores and serves public WebM video artifacts and rejects non-WebM or oversized video uploads", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-video-user", 1013, "artifactvideouser");
    const headers = sessionTokenHeaders("artifact-video-user");

    await createSession(workerModule, env, headers, "s-artifacts-video");

    const sql = getSessionSql(env, "s-artifacts-video");
    doDb.ensureSandboxState(sql, "s-artifacts-video");
    doDb.updateSandboxState(sql, "s-artifacts-video", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-video-artifact-token"),
    });
    doDb.updateSessionFields(sql, "s-artifacts-video", { repoPrivate: false });

    env.WORKER_ENV = "local";
    env.FRONTEND_URL = "http://localhost:5173";
    env.CONTROL_PLANE_URL = "https://temporary-preview.ngrok-free.dev";
    delete env.S3_ACCESS_KEY_ID;
    delete env.S3_SECRET_ACCESS_KEY;
    delete env.S3_SESSION_BUCKET;

    const mp4Res = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-video/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-video-artifact-token",
        "content-type": "video/mp4",
        "x-artifact-type": "video",
        "x-artifact-label": "proof.mp4",
      },
      body: new Uint8Array([0, 0, 0, 1]),
    });
    expect(mp4Res.status).toBe(415);

    const oversizedRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-video/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-video-artifact-token",
        "content-type": WEBM_VIDEO_MIME_TYPE,
        "x-artifact-type": "video",
        "x-artifact-label": "oversized.webm",
      },
      body: new Uint8Array(WEBM_VIDEO_SIZE_LIMIT_BYTES + 1),
    });
    expect(oversizedRes.status).toBe(413);
    await expect(oversizedRes.json()).resolves.toEqual({
      ok: false,
      error: "Video artifact exceeds 50 MB limit",
    });

    const videoBody = new Uint8Array([26, 69, 223, 163]);
    const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-video/artifacts", {
      method: "POST",
      headers: {
        authorization: "Bearer sandbox-video-artifact-token",
        "content-type": `${WEBM_VIDEO_MIME_TYPE}; codecs=vp8`,
        "x-artifact-type": "video",
        "x-artifact-label": "e2e-playwright/video.webm",
      },
      body: videoBody,
    });
    expect(uploadRes.status).toBe(200);
    const uploadBody = (await uploadRes.json()) as {
      ok: boolean;
      artifact?: { id: string; type: string; url: string };
    };
    expect(uploadBody.ok).toBe(true);
    expect(uploadBody.artifact?.type).toBe("video");
    expect(uploadBody.artifact?.url).toContain("artifactToken=");

    const artifactUrl = new URL(uploadBody.artifact!.url);
    const proxyRes = await workerFetch(workerModule, env, `${artifactUrl.pathname}${artifactUrl.search}`, {
      method: "GET",
    });
    expect(proxyRes.status).toBe(200);
    expect(proxyRes.headers.get("content-type")).toBe(WEBM_VIDEO_MIME_TYPE);
    expect(proxyRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(proxyRes.headers.get("cache-control")).toBe(PUBLIC_ARTIFACT_CACHE_CONTROL);
    await expect(proxyRes.arrayBuffer()).resolves.toEqual(videoBody.buffer);
  });

  it("does not publicly serve private artifact types", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user-3", 1009, "artifactuser3");
    const headers = sessionTokenHeaders("artifact-user-3");

    await createSession(workerModule, env, headers, "s-artifacts-private");

    const sql = getSessionSql(env, "s-artifacts-private");
    doDb.ensureSandboxState(sql, "s-artifacts-private");
    doDb.updateSandboxState(sql, "s-artifacts-private", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-private-token"),
    });

    env.S3_ACCESS_KEY_ID = "test-access-key";
    env.S3_SECRET_ACCESS_KEY = "test-secret-key";
    env.S3_SESSION_BUCKET = "test-session-bucket";
    env.S3_REGION = "us-east-1";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.startsWith("https://test-session-bucket.s3.us-east-1.amazonaws.com/")) {
        return new Response(null, { status: 200 });
      }
      return originalFetch(input, init);
    };

    try {
      const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-private/artifacts", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-private-token",
          "content-type": "image/png",
          "x-artifact-type": "artifact",
          "x-artifact-label": "raw-proof.png",
        },
        body: new Uint8Array([137, 80, 78, 71]),
      });
      expect(uploadRes.status).toBe(200);
      const uploadBody = (await uploadRes.json()) as {
        ok: boolean;
        artifact?: { url: string };
      };
      expect(uploadBody.ok).toBe(true);
      expect(uploadBody.artifact?.url).toContain("/api/sessions/s-artifacts-private/artifacts/");
      expect(uploadBody.artifact?.url).not.toContain("artifactToken=");

      const artifactPath = new URL(uploadBody.artifact!.url).pathname;
      const proxyRes = await workerFetch(workerModule, env, artifactPath, { method: "GET" });
      expect(proxyRes.status).toBe(404);
      await expect(proxyRes.text()).resolves.toBe("Not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not publicly serve expired or revoked screenshot artifact URLs", async () => {
    const { env, db } = createWorkerEnv(workerModule);
    seedAuthUser(db, "artifact-user-4", 1010, "artifactuser4");
    const headers = sessionTokenHeaders("artifact-user-4");

    await createSession(workerModule, env, headers, "s-artifacts-revoked");

    const sql = getSessionSql(env, "s-artifacts-revoked");
    doDb.ensureSandboxState(sql, "s-artifacts-revoked");
    doDb.updateSandboxState(sql, "s-artifacts-revoked", {
      sandboxAuthTokenHash: await computeSha256Hex("sandbox-revoked-token"),
    });

    env.S3_ACCESS_KEY_ID = "test-access-key";
    env.S3_SECRET_ACCESS_KEY = "test-secret-key";
    env.S3_SESSION_BUCKET = "test-session-bucket";
    env.S3_REGION = "us-east-1";

    const originalFetch = globalThis.fetch;
    const storedArtifacts = new Map<string, { body: Uint8Array; contentType: string }>();
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.startsWith("https://test-session-bucket.s3.us-east-1.amazonaws.com/")) {
        if (request.method === "PUT") {
          storedArtifacts.set(request.url, {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") || "application/octet-stream",
          });
          return new Response(null, { status: 200 });
        }

        const artifact = storedArtifacts.get(request.url);
        if (!artifact) return new Response("missing", { status: 404 });
        return new Response(artifact.body, {
          status: 200,
          headers: { "content-type": artifact.contentType },
        });
      }
      return originalFetch(input, init);
    };

    try {
      const uploadRes = await workerFetch(workerModule, env, "/api/sessions/s-artifacts-revoked/artifacts", {
        method: "POST",
        headers: {
          authorization: "Bearer sandbox-revoked-token",
          "content-type": "image/png",
          "x-artifact-type": "screenshot",
          "x-artifact-label": "revoked.png",
        },
        body: new Uint8Array([137, 80, 78, 71]),
      });
      expect(uploadRes.status).toBe(200);
      const uploadBody = (await uploadRes.json()) as {
        ok: boolean;
        artifact?: { id: string; url: string };
      };
      expect(uploadBody.ok).toBe(true);

      const artifact = doDb.listSessionArtifacts(sql, "s-artifacts-revoked")[0];
      expect(artifact.artifactId).toBe(uploadBody.artifact!.id);
      const originalAccess = artifact.metadata?.access as ArtifactAccessMetadata;

      doDb.insertSessionArtifact(sql, {
        ...artifact,
        metadata: {
          ...artifact.metadata,
          access: { ...originalAccess, expiresAt: Date.now() - 1 },
        },
      });

      const artifactUrl = new URL(uploadBody.artifact!.url);
      const expiredRes = await workerFetch(workerModule, env, `${artifactUrl.pathname}${artifactUrl.search}`, {
        method: "GET",
      });
      expect(expiredRes.status).toBe(404);
      await expect(expiredRes.text()).resolves.toBe("Not found");

      doDb.insertSessionArtifact(sql, artifact);

      const revokeRes = await workerFetch(
        workerModule,
        env,
        `/api/sessions/s-artifacts-revoked/artifacts/${artifact.artifactId}`,
        {
          method: "DELETE",
          headers,
        },
      );
      expect(revokeRes.status).toBe(200);
      await expect(revokeRes.json()).resolves.toEqual({ ok: true });

      const revokedRes = await workerFetch(workerModule, env, `${artifactUrl.pathname}${artifactUrl.search}`, {
        method: "GET",
      });
      expect(revokedRes.status).toBe(404);
      await expect(revokedRes.text()).resolves.toBe("Not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
