import http from "node:http";
import https from "node:https";

import { afterEach, beforeEach } from "vitest";

const blockedTargets: string[] = [];

export function resetBlockedTargetsForTest(): void {
  blockedTargets.length = 0;
}

function normalizeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  return host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function isAllowedHost(host: string | null | undefined): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return true;
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "0.0.0.0";
}

function blockNetwork(target: string): never {
  blockedTargets.push(target);
  throw new Error(`Outbound network blocked in tests. Mock the external service instead: ${target}`);
}

function parseFetchTarget(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return input;
}

function parseJsonBody(body: RequestInit["body"] | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function openAiToolName(init?: RequestInit): string | null {
  const body = parseJsonBody(init?.body);
  const text = body?.text;
  if (!text || typeof text !== "object") return null;
  const format = (text as { format?: unknown }).format;
  if (!format || typeof format !== "object") return null;
  const name = (format as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function firstRepoCandidateFromPrompt(init?: RequestInit): { repoOwner: string; repoName: string } | null {
  const body = parseJsonBody(init?.body);
  const input = body?.input;
  if (typeof input !== "string") return null;
  const marker = "Allowed repositories:\n";
  const markerIndex = input.indexOf(marker);
  if (markerIndex === -1) return null;
  const jsonStart = markerIndex + marker.length;
  const jsonEnd = input.indexOf("\n\nText context:", jsonStart);
  if (jsonEnd === -1) return null;
  try {
    const parsed = JSON.parse(input.slice(jsonStart, jsonEnd)) as Array<{
      repoOwner?: unknown;
      repoName?: unknown;
    }>;
    const first = parsed[0];
    if (!first) return null;
    if (typeof first.repoOwner !== "string" || typeof first.repoName !== "string") return null;
    return { repoOwner: first.repoOwner, repoName: first.repoName };
  } catch {
    return null;
  }
}

function structuredOutputResponse(payload: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export async function maybeHandleKnownExternalFetch(target: string, init?: RequestInit): Promise<Response | null> {
  if (target === "https://slack.com/api/chat.postMessage") {
    return Response.json({ ok: true, ts: "1712345678.000100", channel: "C_TEST" });
  }
  if (target === "https://slack.com/api/reactions.add") {
    return Response.json({ ok: true });
  }
  // Default users.info stub: resolve nothing so Slack mention resolution fails
  // open (raw `<@ID>` token preserved), matching behavior for any test that
  // drives the Slack path without explicitly mocking getUserInfo. Tests that
  // assert resolved names mock getUserInfo directly, which bypasses fetch.
  if (target.startsWith("https://slack.com/api/users.info")) {
    return Response.json({ ok: false, error: "user_not_found" });
  }
  if (target === "https://api.linear.app/oauth/revoke") {
    return Response.json({ ok: true });
  }
  if (target === "https://api.linear.app/graphql") {
    const body = parseJsonBody(init?.body);
    const query = typeof body?.query === "string" ? body.query : "";
    if (query.includes("comments(last: 5)")) {
      return Response.json({
        data: {
          issue: {
            comments: {
              nodes: [{ body: "Stub Linear comment", user: { name: "Stub User" } }],
            },
          },
        },
      });
    }
    if (query.includes("attachmentCreate")) {
      return Response.json({ data: { attachmentCreate: { success: true } } });
    }
    if (query.includes("commentCreate")) {
      return Response.json({ data: { commentCreate: { success: true } } });
    }
    return Response.json({ data: {} });
  }
  if (target === "https://api.openai.com/v1/responses") {
    const toolName = openAiToolName(init);
    if (toolName === "generate_session_title") {
      return structuredOutputResponse({ title: "Test Session", tags: ["test"] });
    }
    if (toolName === "guess_repository_from_context") {
      const candidate = firstRepoCandidateFromPrompt(init) ?? { repoOwner: "test-owner", repoName: "test-repo" };
      return structuredOutputResponse({
        status: "matched",
        repoOwner: candidate.repoOwner,
        repoName: candidate.repoName,
        confidence: 0.95,
        reason: "Matched the first allowed repository in the test stub.",
        candidates: [],
      });
    }
    blockNetwork(`https://api.openai.com/v1/responses (missing stub for OpenAI tool: ${toolName ?? "unknown"})`);
  }
  return null;
}

export function assertUrlAllowed(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Relative URLs cannot target external hosts; treat as implicitly local.
    return;
  }
  if (!isAllowedHost(url.hostname)) {
    blockNetwork(url.toString());
  }
}

function extractHttpTarget(args: unknown[]): { url?: string; host?: string | null; path?: string | null } {
  const first = args[0];
  if (first instanceof URL) {
    return { url: first.toString(), host: first.hostname, path: first.pathname };
  }
  if (typeof first === "string") {
    if (/^https?:\/\//i.test(first)) {
      const url = new URL(first);
      return { url: url.toString(), host: url.hostname, path: url.pathname };
    }
    return { path: first };
  }
  if (first && typeof first === "object") {
    const options = first as {
      protocol?: string;
      host?: string;
      hostname?: string;
      path?: string;
      socketPath?: string;
      port?: number | string;
    };
    if (options.socketPath) return { path: options.socketPath };
    const host = options.hostname ?? options.host ?? null;
    const path = options.path ?? null;
    if (host && options.protocol) {
      const port = options.port ? `:${options.port}` : "";
      return { url: `${options.protocol}//${host}${port}${path ?? "/"}`, host, path };
    }
    return { host, path };
  }
  return {};
}

function assertHttpArgsAllowed(args: unknown[]): void {
  const target = extractHttpTarget(args);
  if (target.url) {
    assertUrlAllowed(target.url);
    return;
  }
  if (!isAllowedHost(target.host)) {
    blockNetwork(target.host ?? "unknown host");
  }
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = parseFetchTarget(input);
  const knownStub = await maybeHandleKnownExternalFetch(target, init);
  if (knownStub) return knownStub;
  assertUrlAllowed(target);
  return originalFetch(input as Parameters<typeof fetch>[0], init);
}) as typeof globalThis.fetch;

const originalHttpRequest = http.request.bind(http);
http.request = ((...args: Parameters<typeof http.request>) => {
  assertHttpArgsAllowed(args);
  return originalHttpRequest(...args);
}) as typeof http.request;

const originalHttpGet = http.get.bind(http);
http.get = ((...args: Parameters<typeof http.get>) => {
  assertHttpArgsAllowed(args);
  return originalHttpGet(...args);
}) as typeof http.get;

const originalHttpsRequest = https.request.bind(https);
https.request = ((...args: Parameters<typeof https.request>) => {
  assertHttpArgsAllowed(args);
  return originalHttpsRequest(...args);
}) as typeof https.request;

const originalHttpsGet = https.get.bind(https);
https.get = ((...args: Parameters<typeof https.get>) => {
  assertHttpArgsAllowed(args);
  return originalHttpsGet(...args);
}) as typeof https.get;

beforeEach(() => {
  resetBlockedTargetsForTest();
});

afterEach(() => {
  if (blockedTargets.length === 0) return;
  throw new Error(
    `Test attempted outbound network access without a mock: ${Array.from(new Set(blockedTargets)).join(", ")}`,
  );
});
