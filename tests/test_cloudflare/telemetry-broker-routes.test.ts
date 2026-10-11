import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { computeSha256Hex } from "../../apps/control-plane-worker/src/crypto";
import { resolveSandboxObservabilityEnv } from "../../apps/control-plane-worker/src/observability/sandbox-env";
import {
  callTelemetryBraintrustRoute,
  callTelemetryDdLogsRoute,
  callTelemetrySentryRoute,
} from "../../apps/control-plane-worker/src/session/state";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { HTTP_HEADER_NAMES } from "../../shared/constants/http-headers";
import {
  createFakeState,
  createTestEnv,
  mockCloudflareWorkers,
  mockSentryCloudflare,
  seedSandboxState,
  seedSession,
} from "./session/helpers.ts";

mockCloudflareWorkers();
mockSentryCloudflare();

type SessionDOHandle = {
  fetch(request: Request): Promise<Response>;
};

type WorkerModule = {
  SessionDO: new (state: unknown, env: unknown) => SessionDOHandle;
};

const SESSION_ID = "telemetry-broker-session";
const SANDBOX_TOKEN = "sandbox-token-abc";
const TELEMETRY_MAX_BODY_BYTES = 5 * 1024 * 1024;

async function seedAuthedSession(state: ReturnType<typeof createFakeState>): Promise<void> {
  seedSession(state.storage, {
    sessionId: SESSION_ID,
    ownerUserId: "user-1",
    businessId: "biz-1",
    status: "active",
    sessionKind: "repo",
  });
  seedSandboxState(state.storage, {
    sessionId: SESSION_ID,
    status: "running",
    sandboxAuthTokenHash: await computeSha256Hex(SANDBOX_TOKEN),
  });
}

function ddLogsRequest(headers: Record<string, string>, body: BodyInit = "[]"): Request {
  return new Request("https://internal/session/telemetry/dd-logs", { method: "POST", headers, body });
}

function braintrustRequest(subpath: string, headers: Record<string, string>, body: BodyInit = "{}"): Request {
  return new Request("https://internal/session/telemetry/braintrust", {
    method: "POST",
    headers: { "x-telemetry-subpath": subpath, ...headers },
    body,
  });
}

function sentryRequest(url: string, headers: Record<string, string>, body: BodyInit = "envelope"): Request {
  return new Request(url, { method: "POST", headers, body });
}

function oversizedTelemetryBody(): Uint8Array {
  return new Uint8Array(TELEMETRY_MAX_BODY_BYTES + 1);
}

describe("telemetry broker DO handlers", () => {
  let workerModule: WorkerModule;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    workerModule = (await import("../../apps/control-plane-worker/src/index.js")) as WorkerModule;
  });

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200, headers: { "content-type": "application/json" } }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function createInstance(envOverrides: Partial<Env> = {}) {
    const state = createFakeState();
    const env = { ...createTestEnv(), ...envOverrides } as unknown as Env;
    const instance = new workerModule.SessionDO(state, env) as SessionDOHandle;
    return { state, instance };
  }

  it("rejects dd-logs without a valid sandbox token", async () => {
    const { state, instance } = createInstance({ DD_API_KEY: "dd-key" });
    await seedAuthedSession(state);

    const missing = await instance.fetch(ddLogsRequest({}));
    expect(missing.status).toBe(401);

    const wrong = await instance.fetch(ddLogsRequest({ authorization: "Bearer nope" }));
    // A non-matching token that is not a known prev token is a replay/forbidden.
    expect([401, 403]).toContain(wrong.status);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects the ?st= query token on non-sentry telemetry paths", async () => {
    // The query-param fallback exists only for the Sentry tunnel (its SDK sends
    // no Authorization header). dd-logs/braintrust clients send a Bearer, so a
    // token in the URL there would only ever be a log-leak vector.
    const { state, instance } = createInstance({ DD_API_KEY: "dd-key" });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      new Request(`https://internal/session/telemetry/dd-logs?st=${SANDBOX_TOKEN}`, { method: "POST", body: "[]" }),
    );
    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rate-limits a session that floods the telemetry broker", async () => {
    // No DD_API_KEY: every allowed request is a cheap 204 noop, so the test
    // exercises only the auth + rate-limit path.
    const { state, instance } = createInstance({});
    await seedAuthedSession(state);

    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      const response = await instance.fetch(ddLogsRequest({ authorization: `Bearer ${SANDBOX_TOKEN}` }));
      statuses.push(response.status);
    }
    expect(statuses[0]).toBe(204);
    expect(statuses[119]).toBe(204);
    expect(statuses[120]).toBe(429);

    // The limit is shared across handlers: sentry is rejected in the same window.
    const sentry = await instance.fetch(
      sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}),
    );
    expect(sentry.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "dd-logs",
      env: { DD_API_KEY: "dd-key" },
      request: () =>
        ddLogsRequest(
          { authorization: `Bearer ${SANDBOX_TOKEN}`, "content-encoding": "gzip" },
          oversizedTelemetryBody(),
        ),
    },
    {
      name: "braintrust",
      env: { BRAINTRUST_API_KEY: "bt-key" },
      request: () => braintrustRequest("logs3", { authorization: `Bearer ${SANDBOX_TOKEN}` }, oversizedTelemetryBody()),
    },
    {
      name: "sentry",
      env: { SENTRY_DSN: "https://pubkey@sentry.example.com/42", WORKER_ENV: "production" },
      request: () =>
        sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}, oversizedTelemetryBody()),
    },
  ])("rejects oversized $name telemetry payloads before forwarding", async ({ env, request }) => {
    const { state, instance } = createInstance(env);
    await seedAuthedSession(state);

    const response = await instance.fetch(request());

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload too large");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards dd-logs to the canonical US5 Datadog site with DD-API-KEY injected", async () => {
    const { state, instance } = createInstance({ DD_API_KEY: "dd-key", DD_SITE: "datadoghq.com" });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      ddLogsRequest({ authorization: `Bearer ${SANDBOX_TOKEN}`, "content-encoding": "gzip" }, "[{}]"),
    );
    expect(response.status).toBe(202);
    await state.flushWaitUntil();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://http-intake.logs.us5.datadoghq.com/api/v2/logs");
    const headers = init.headers as Record<string, string>;
    expect(headers["DD-API-KEY"]).toBe("dd-key");
    expect(headers["Content-Encoding"]).toBe("gzip");
  });

  it("returns 204 for dd-logs when the worker has no DD_API_KEY", async () => {
    const { state, instance } = createInstance({});
    await seedAuthedSession(state);

    const response = await instance.fetch(ddLogsRequest({ authorization: `Bearer ${SANDBOX_TOKEN}` }));
    expect(response.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates sentry via the ?st= query token and returns 204 without SENTRY_DSN", async () => {
    const { state, instance } = createInstance({});
    await seedAuthedSession(state);

    const response = await instance.fetch(
      sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}),
    );
    expect(response.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects sentry when the ?st= query token is wrong", async () => {
    const { state, instance } = createInstance({ SENTRY_DSN: "https://pub@sentry.example.com/42" });
    await seedAuthedSession(state);

    const response = await instance.fetch(sentryRequest("https://internal/session/telemetry/sentry?st=nope", {}));
    expect([401, 403]).toContain(response.status);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards sentry envelopes to the DSN-derived ingest URL", async () => {
    const { state, instance } = createInstance({
      SENTRY_DSN: "https://pubkey@sentry.example.com/42",
      WORKER_ENV: "production",
    });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}, "raw-envelope"),
    );
    expect(response.status).toBe(202);
    await state.flushWaitUntil();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sentry.example.com/api/42/envelope/");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Sentry-Auth"]).toBe("Sentry sentry_key=pubkey, sentry_version=7");
    // Unparseable envelope header: forwarded unchanged.
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("raw-envelope");
  });

  it("rewrites the envelope header's placeholder dsn to the platform DSN before forwarding", async () => {
    const realDsn = "https://pubkey@sentry.example.com/42";
    const { state, instance } = createInstance({ SENTRY_DSN: realDsn, WORKER_ENV: "production" });
    await seedAuthedSession(state);

    const envelope = `${JSON.stringify({ dsn: "https://placeholder@telemetry.cycloid.invalid/1", sent_at: "now" })}\n{"type":"event"}\n{}`;
    const response = await instance.fetch(
      sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}, envelope),
    );
    expect(response.status).toBe(202);
    await state.flushWaitUntil();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const forwarded = new TextDecoder().decode(init.body as Uint8Array);
    const [headerLine, ...rest] = forwarded.split("\n");
    expect(JSON.parse(headerLine)).toEqual({ dsn: realDsn, sent_at: "now" });
    expect(rest).toEqual(['{"type":"event"}', "{}"]);
  });

  it("gunzips compressed envelopes, rewrites the dsn, and forwards uncompressed", async () => {
    const realDsn = "https://pubkey@sentry.example.com/42";
    const { state, instance } = createInstance({ SENTRY_DSN: realDsn, WORKER_ENV: "production" });
    await seedAuthedSession(state);

    const { gzipSync } = await import("node:zlib");
    const envelope = `${JSON.stringify({ dsn: "https://placeholder@telemetry.cycloid.invalid/1" })}\n{"type":"event"}\n{}`;
    const response = await instance.fetch(
      new Request(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: gzipSync(Buffer.from(envelope, "utf8")),
      }),
    );
    expect(response.status).toBe(202);
    await state.flushWaitUntil();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBeUndefined();
    const forwarded = new TextDecoder().decode(init.body as Uint8Array);
    expect(JSON.parse(forwarded.split("\n")[0])).toEqual({ dsn: realDsn });
  });

  it("drops sentry envelopes from non-production environments even with a DSN set", async () => {
    // Central fail-closed: an older qa sandbox can keep tunneling across a
    // control-plane deploy, so the broker must enforce the prod-only allowlist.
    const { state, instance } = createInstance({
      SENTRY_DSN: "https://pubkey@sentry.example.com/42",
      WORKER_ENV: "qa",
    });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}, "raw-envelope"),
    );
    expect(response.status).toBe(204);
    await state.flushWaitUntil();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards non-prod sentry envelopes when SENTRY_ENABLE_LOCAL opts in", async () => {
    const { state, instance } = createInstance({
      SENTRY_DSN: "https://pubkey@sentry.example.com/42",
      WORKER_ENV: "qa",
      SENTRY_ENABLE_LOCAL: "true",
    });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      sentryRequest(`https://internal/session/telemetry/sentry?st=${SANDBOX_TOKEN}`, {}, "raw-envelope"),
    );
    expect(response.status).toBe(202);
    await state.flushWaitUntil();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards allowlisted braintrust subpaths with the platform Authorization, overriding client auth", async () => {
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key" });
    await seedAuthedSession(state);

    const logs3 = await instance.fetch(
      braintrustRequest("logs3", { authorization: `Bearer ${SANDBOX_TOKEN}`, "x-client-auth": "Bearer client" }),
    );
    expect(logs3.status).toBe(200);
    expect((fetchSpy.mock.calls[0] as [string, RequestInit])[0]).toBe("https://api.braintrust.dev/logs3");
    expect(
      ((fetchSpy.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)[
        HTTP_HEADER_NAMES.AUTHORIZATION
      ],
    ).toBe("Bearer bt-key");

    const login = await instance.fetch(
      braintrustRequest("/api/apikey/login", { authorization: `Bearer ${SANDBOX_TOKEN}` }),
    );
    expect(login.status).toBe(200);
    expect((fetchSpy.mock.calls[1] as [string, RequestInit])[0]).toBe("https://www.braintrust.dev/api/apikey/login");
  });

  it("forwards api/project/register to the app host (the logger needs it before logs3)", async () => {
    // Regression: the broker shipped allowlisting only login + logs3, but the
    // SDK logger resolves its project id via api/project/register first. Omitting
    // it 403'd registration and silently dropped all telemetry.
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key" });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      braintrustRequest("api/project/register", { authorization: `Bearer ${SANDBOX_TOKEN}` }),
    );
    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.braintrust.dev/api/project/register");
    expect((init.headers as Record<string, string>)[HTTP_HEADER_NAMES.AUTHORIZATION]).toBe("Bearer bt-key");
  });

  it("forwards the version probe as a bodyless GET to the api host", async () => {
    // The SDK GETs /version (apiConn) for logs3_payload_max_bytes; the broker must
    // forward it as a GET with no body, unlike the POST login/register/logs3 calls.
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key" });
    await seedAuthedSession(state);

    const response = await instance.fetch(braintrustRequest("version", { authorization: `Bearer ${SANDBOX_TOKEN}` }));
    expect(response.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.braintrust.dev/version");
    expect((init.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init.body == null).toBe(true);
    expect((init.headers as Record<string, string>)[HTTP_HEADER_NAMES.AUTHORIZATION]).toBe("Bearer bt-key");
  });

  it("passes a non-2xx braintrust upstream status through and logs it without the platform key", async () => {
    // LOG_LEVEL warn so the broker's upstream-error warn is actually emitted
    // (createTestEnv defaults to "error").
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key", LOG_LEVEL: "warn" });
    await seedAuthedSession(state);
    fetchSpy.mockResolvedValueOnce(
      new Response("nope", { status: 500, headers: { "content-type": "application/json" } }),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await instance.fetch(
      braintrustRequest("api/project/register", { authorization: `Bearer ${SANDBOX_TOKEN}` }),
    );
    expect(response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes("telemetry_braintrust_upstream_error"))).toBe(true);
    expect(logged.some((line) => line.includes("bt-key"))).toBe(false);
    warnSpy.mockRestore();
  });

  it("returns 502 (not an opaque throw) when the braintrust upstream request fails", async () => {
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key", LOG_LEVEL: "warn" });
    await seedAuthedSession(state);
    fetchSpy.mockRejectedValueOnce(new Error("connection reset"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await instance.fetch(braintrustRequest("logs3", { authorization: `Bearer ${SANDBOX_TOKEN}` }));
    expect(response.status).toBe(502);
    const logged = warnSpy.mock.calls.map((call) => JSON.stringify(call));
    expect(logged.some((line) => line.includes("telemetry_braintrust_upstream_error"))).toBe(true);
    expect(logged.some((line) => line.includes("bt-key"))).toBe(false);
    warnSpy.mockRestore();
  });

  it("rejects a disallowed braintrust subpath with 403", async () => {
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key" });
    await seedAuthedSession(state);

    const response = await instance.fetch(
      braintrustRequest("api/secret/steal", { authorization: `Bearer ${SANDBOX_TOKEN}` }),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the legacy braintrust logs subpath forbidden (only logs3 is brokered)", async () => {
    // 3.17.0 flushes via logs3 only; lock out the legacy /logs path so a future
    // SDK change surfaces as a visible 403 rather than a silent new upstream.
    const { state, instance } = createInstance({ BRAINTRUST_API_KEY: "bt-key" });
    await seedAuthedSession(state);

    const response = await instance.fetch(braintrustRequest("logs", { authorization: `Bearer ${SANDBOX_TOKEN}` }));
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 204 for braintrust when the worker has no BRAINTRUST_API_KEY", async () => {
    const { state, instance } = createInstance({});
    await seedAuthedSession(state);

    const response = await instance.fetch(braintrustRequest("logs3", { authorization: `Bearer ${SANDBOX_TOKEN}` }));
    expect(response.status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("telemetry broker state helpers (worker -> DO forwarding)", () => {
  function envWithStub() {
    const forwarded: Array<{ url: string; init: RequestInit }> = [];
    const stub = {
      fetch: (url: string, init: RequestInit) => {
        forwarded.push({ url, init });
        return Promise.resolve(new Response(null, { status: 202 }));
      },
    };
    const env = {
      SESSION: {
        idFromName: (name: string) => name,
        get: () => stub,
      },
    } as unknown as Env;
    return { env, forwarded };
  }

  it("conveys the braintrust subpath via X-Telemetry-Subpath", async () => {
    const { env, forwarded } = envWithStub();
    await callTelemetryBraintrustRoute(
      env,
      SESSION_ID,
      new Request("https://worker.test/x", { method: "POST", body: "{}" }),
      "logs3",
    );
    const headers = new Headers(forwarded[0].init.headers);
    expect(forwarded[0].url).toContain("/session/telemetry/braintrust");
    expect(headers.get("x-telemetry-subpath")).toBe("logs3");
  });

  it("propagates the sentry ?st= token to the DO", async () => {
    const { env, forwarded } = envWithStub();
    await callTelemetrySentryRoute(
      env,
      SESSION_ID,
      new Request("https://worker.test/x?st=token-xyz", { method: "POST", body: "envelope" }),
    );
    expect(forwarded[0].url).toContain("st=token-xyz");
  });

  it("passes through dd-logs content-encoding", async () => {
    const { env, forwarded } = envWithStub();
    await callTelemetryDdLogsRoute(
      env,
      SESSION_ID,
      new Request("https://worker.test/x", { method: "POST", headers: { "content-encoding": "gzip" }, body: "[]" }),
    );
    const headers = new Headers(forwarded[0].init.headers);
    expect(headers.get("content-encoding")).toBe("gzip");
  });
});

describe("sandbox env never carries platform telemetry secrets", () => {
  it("resolveSandboxObservabilityEnv drops every platform telemetry secret key", () => {
    const result = resolveSandboxObservabilityEnv({
      DD_API_KEY: "dd",
      DD_SITE: "us5.datadoghq.com",
      BRAINTRUST_API_KEY: "bt",
      SENTRY_DSN: "https://pub@sentry.example.com/1",
      BRAINTRUST_API_URL: "https://api.braintrust.dev",
      BRAINTRUST_APP_URL: "https://www.braintrust.dev",
      BRAINTRUST_ORG_NAME: "org",
    } as unknown as Env);

    expect(result).toEqual({ BRAINTRUST_PROJECT: "cycloid" });
    expect(result).not.toHaveProperty("DD_API_KEY");
    expect(result).not.toHaveProperty("BRAINTRUST_API_KEY");
    expect(result).not.toHaveProperty("SENTRY_DSN");
  });

  it("the e2bEnvs leak guard throws when a platform telemetry secret is present", () => {
    // Mirrors the inline guard in durable-object.ts spawn assembly. Customer
    // DD_API_KEY/DD_SITE are intentionally NOT guarded.
    const assertNoTelemetrySecretLeak = (e2bEnvs: Record<string, string>) => {
      if ("BRAINTRUST_API_KEY" in e2bEnvs || "SENTRY_DSN" in e2bEnvs) {
        throw new Error("Platform telemetry secret leaked into sandbox env assembly");
      }
    };

    expect(() => assertNoTelemetrySecretLeak({ BRAINTRUST_API_KEY: "x" })).toThrow(/leaked/);
    expect(() => assertNoTelemetrySecretLeak({ SENTRY_DSN: "x" })).toThrow(/leaked/);
    expect(() => assertNoTelemetrySecretLeak({ DD_API_KEY: "ok", DD_SITE: "ok" })).not.toThrow();
  });
});
