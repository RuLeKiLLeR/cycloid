import { ENVIRONMENT } from "../../../shared/constants/environment.js";
import { buildContentSecurityPolicy } from "../../../shared/security/content-security-policy.js";
import { parseBearerToken } from "../../../shared/utils/auth.js";
import { bytesToHex } from "../../../shared/utils/hex.js";
import { asNonEmptyString as asSharedNonEmptyString } from "../../../shared/utils/type-guards.js";
import { IMPERSONATION_COOKIE_NAME } from "./constants/auth";
import { HTTP_RESPONSE_BODY } from "./constants/http-responses";
import { computeHmacHex, computeSha256Hex, timingSafeEqualString } from "./crypto";
import { createLogger } from "./logger";
import { createSignedToken, verifySignedToken } from "./signed-token";
import type { Env, ReplayState, SessionEvent } from "./types";

export { computeHmacHex, computeSha256Hex, timingSafeEqualString };
export { parseBearerToken };

const JSON_HEADERS: HeadersInit = {
  "content-type": "application/json; charset=utf-8",
};

export const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

const securityHeadersLog = createLogger({ bindings: { component: "security-headers" } });

export function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/**
 * Standard helper for returning `{ ok: false, error }` JSON error responses.
 * Use `extras` to merge additional fields into the body (e.g. `prUrl`).
 */
export function jsonErrorResponse(
  error: string,
  status = 400,
  extras?: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  return jsonResponse({ ok: false, error, ...extras }, status, headers);
}

const MAX_RESULT_DEPTH = 64;

/**
 * Recursively truncate a value to a maximum nesting depth.
 * Prevents JSON.stringify stack overflow on deeply nested callback results.
 */
export function truncateDepth(value: unknown, maxDepth = MAX_RESULT_DEPTH, currentDepth = 0): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (currentDepth >= maxDepth) return "[truncated: max depth exceeded]";

  if (Array.isArray(value)) {
    return value.map((item) => truncateDepth(item, maxDepth, currentDepth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = truncateDepth(val, maxDepth, currentDepth + 1);
  }
  return result;
}

export async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    // The one sanctioned request.json() cast: this helper is what every other
    // call site routes through (see eslint.config.js BAN_REQUEST_JSON_CAST).
    // eslint-disable-next-line no-restricted-syntax
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractMarkdownSection(body: string, heading: string): string | null {
  const lines = body.split("\n");
  const headingLine = `### ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex < 0) return null;
  const collected: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("### ") || line.startsWith("## ")) break;
    collected.push(line);
  }
  const section = collected.join("\n").trim();
  return section.length > 0 ? section : null;
}

export function extractListItems(section: string | null): string[] {
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const bulletMatch = line.match(/^[-*]\s+(.+)$/);
      if (bulletMatch) return bulletMatch[1].trim();
      const numberedMatch = line.match(/^\d+\.\s+(.+)$/);
      if (numberedMatch) return numberedMatch[1].trim();
      return "";
    })
    .filter((line) => line.length > 0);
}

function normalizeOrigin(rawOrigin: string): string | null {
  try {
    return new URL(rawOrigin).origin;
  } catch {
    return null;
  }
}

export function corsOrigin(request: Request, env: Env): string | null {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return null;

  const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
  if (!normalizedRequestOrigin) return null;

  const allowedOrigins = new Set<string>();
  allowedOrigins.add(normalizeOrigin(env.FRONTEND_URL || "https://app.trycycloid.com") || "https://app.trycycloid.com");

  if (env.WORKER_ENV === ENVIRONMENT.Local) {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://localhost:5173");
  }

  return allowedOrigins.has(normalizedRequestOrigin) ? normalizedRequestOrigin : null;
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get("vary");
  if (!existing) {
    headers.set("vary", value);
    return;
  }

  const values = new Set(
    existing
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  values.add(value);
  headers.set("vary", Array.from(values).join(", "));
}

export function applyStandardHeaders(response: Response, request: Request, env: Env): Response {
  // WebSocket upgrade responses cannot be reconstructed: status 101 is rejected
  // by the standard Response constructor, and cloning also drops Cloudflare's
  // non-standard `webSocket` property required to complete the upgrade.
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) {
    return response;
  }

  const headers = new Headers(response.headers);
  const scriptNonce = headers.get("x-script-nonce");
  const validatedScriptNonce = scriptNonce && /^[A-Za-z0-9_-]{16,}$/.test(scriptNonce) ? scriptNonce : undefined;
  if (validatedScriptNonce) {
    securityHeadersLog.info({}, "Accepted internal script nonce for CSP generation");
  }
  if (scriptNonce && !validatedScriptNonce) {
    securityHeadersLog.warn({}, "Invalid internal script nonce header dropped before CSP generation");
  }
  headers.delete("x-script-nonce");

  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  headers.set(
    "content-security-policy",
    buildContentSecurityPolicy({
      includeLocalDev: env.WORKER_ENV === ENVIRONMENT.Local,
      scriptNonce: validatedScriptNonce,
    }),
  );

  const allowedOrigin = corsOrigin(request, env);
  if (allowedOrigin) {
    headers.set("access-control-allow-origin", allowedOrigin);
    headers.set("access-control-allow-credentials", "true");
    appendVary(headers, "Origin");
  } else {
    headers.delete("access-control-allow-origin");
    headers.delete("access-control-allow-credentials");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const SANDBOX_CALLBACK_TTL_MS = 30 * 60 * 1000;
const TERRAFORM_PLACEHOLDER_SECRET = "CHANGE_ME";

function configuredSecret(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  if (value.trim().length === 0 || value === TERRAFORM_PLACEHOLDER_SECRET) return null;
  return value;
}

export function resolveSandboxCallbackSecret(env: Pick<Env, "SANDBOX_CALLBACK_SECRET">): string | null {
  return configuredSecret(env.SANDBOX_CALLBACK_SECRET);
}

interface SandboxPromptPayload {
  sessionId: string;
  promptId: string;
  expiresAt: number;
}

const sandboxPromptCodec = {
  encode(payload: SandboxPromptPayload): string {
    return `${payload.sessionId}:${payload.promptId}:${payload.expiresAt}`;
  },
  decode(raw: string): SandboxPromptPayload | null {
    const parts = raw.split(":");
    if (parts.length !== 3) return null;
    const [sessionId, promptId, rawExpiry] = parts;
    const expiresAt = Number(rawExpiry);
    if (!Number.isFinite(expiresAt)) return null;
    return { sessionId, promptId, expiresAt };
  },
};

export async function generateSandboxPromptCallbackToken(
  sessionId: string,
  promptId: string,
  secret: string,
  expiresAt = Date.now() + SANDBOX_CALLBACK_TTL_MS,
): Promise<string> {
  return createSignedToken({ sessionId, promptId, expiresAt }, secret, sandboxPromptCodec);
}

async function verifySandboxPromptCallbackToken(
  sessionId: string,
  promptId: string,
  token: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const payload = await verifySignedToken(token, secret, sandboxPromptCodec);
  if (!payload) return false;
  if (payload.sessionId !== sessionId || payload.promptId !== promptId) return false;
  if (payload.expiresAt <= now) return false;
  return true;
}

function parseCookieValue(request: Request, cookieName: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const cookiePart of cookieHeader.split(";")) {
    const [rawKey, ...rawValue] = cookiePart.trim().split("=");
    if (rawKey === cookieName) {
      return rawValue.join("=") || null;
    }
  }
  return null;
}

export function parseSessionTokenCookie(request: Request): string | null {
  return parseCookieValue(request, "session_token");
}

export function parseImpersonationTokenCookie(request: Request): string | null {
  return parseCookieValue(request, IMPERSONATION_COOKIE_NAME);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Map items with bounded concurrency, in waves of `concurrency` parallel
 * calls. A mapper rejection rejects the whole call; wrap the mapper
 * (e.g. `.catch(() => null)`) when per-item isolation is required.
 */
export async function mapBounded<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const step = Math.max(1, Math.floor(concurrency));
  const results: R[] = [];
  for (let index = 0; index < items.length; index += step) {
    const chunk = items.slice(index, index + step);
    results.push(...(await Promise.all(chunk.map(mapper))));
  }
  return results;
}

export function parseNonNegativeInteger(rawValue: unknown, fallback = 0): number {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

export function parsePositiveIntegerUserId(rawValue: unknown): number | null {
  if (typeof rawValue === "number") {
    return Number.isSafeInteger(rawValue) && rawValue > 0 ? rawValue : null;
  }

  if (typeof rawValue !== "string") return null;

  const normalized = rawValue.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseEventSequence(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined) return null;

  const normalized = String(rawValue).trim();
  if (normalized.length === 0) return null;

  const bareNumberMatch = normalized.match(/^\d+$/);
  if (bareNumberMatch) {
    return parseNonNegativeInteger(bareNumberMatch[0], 0);
  }

  const eventIdMatch = normalized.match(/^event-(\d+)$/i);
  if (eventIdMatch) {
    return parseNonNegativeInteger(eventIdMatch[1], 0);
  }

  return null;
}

export function normalizeEventSequence(rawValue: unknown, fallback = 0): number {
  const parsed = parseEventSequence(rawValue);
  return parsed === null ? fallback : parsed;
}

export function asNonEmptyString(value: unknown): string | null {
  return asSharedNonEmptyString(value) ?? null;
}

/**
 * POSIX-style single-quote shell escaping. Safe for substituting into
 * `bash -c`-style commands the worker sends to E2B sandboxes.
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function normalizeWebhookReference(rawValue: unknown): string | null {
  return asNonEmptyString(rawValue);
}

export function normalizeStoredEvents(value: unknown): SessionEvent[] {
  return Array.isArray(value) ? value : [];
}

export function baseReplayState(sessionId: string): ReplayState {
  return {
    sessionId,
    lastEventSequence: 0,
    lastEventTimestamp: null,
    updatedAt: null,
  };
}

export function generateRandomHex(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return bytesToHex(array);
}

export function setCookieHeader(
  name: string,
  value: string,
  opts: { httpOnly?: boolean; maxAge?: number; path?: string } = {},
): string {
  const parts = [`${name}=${value}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  parts.push("Secure", "SameSite=Lax");
  return parts.join("; ");
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie") || "";
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

export async function verifySandboxPromptCallbackAuth(
  request: Request,
  env: Env,
  sessionId: string,
  promptId: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const secret = resolveSandboxCallbackSecret(env);
  if (!secret) {
    return { ok: false, response: jsonErrorResponse("Prompt callback secret is not configured", 503) };
  }

  const bearerToken = parseBearerToken(request);
  if (!bearerToken) {
    return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
  }

  if (await verifySandboxPromptCallbackToken(sessionId, promptId, bearerToken, secret)) {
    return { ok: true };
  }

  return { ok: false, response: jsonErrorResponse(HTTP_RESPONSE_BODY.UNAUTHORIZED, 401) };
}
