import { ENVIRONMENT } from "../../../../shared/constants/environment.js";
import type { ErrorCode } from "../../../../shared/types/sandbox.js";
import type { Env } from "../types";

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;
const WEBSOCKET_ROUTE_EXPECTED_STATUS = 426;

type LocalCallbackEnv = Pick<Env, "CONTROL_PLANE_URL" | "WORKER_ENV">;

type CallbackPreflightCheck = "configuration" | "health" | "websocket";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type LoggerLike = {
  info(fields: Record<string, unknown>, message: string): void;
};

export class SandboxCallbackPreflightError extends Error {
  readonly errorCode: ErrorCode = "sandbox_callback";
  readonly check: CallbackPreflightCheck;
  readonly url?: string;
  readonly status?: number;
  declare readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      check: CallbackPreflightCheck;
      url?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "SandboxCallbackPreflightError";
    this.check = options.check;
    this.url = options.url;
    this.status = options.status;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
      });
    }
  }
}

export function isSandboxCallbackPreflightError(err: unknown): err is SandboxCallbackPreflightError {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { name?: unknown }).name === "SandboxCallbackPreflightError" ||
      (err as { errorCode?: unknown }).errorCode === "sandbox_callback")
  );
}

export async function assertLocalControlPlaneCallbackReachable({
  env,
  sessionId,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
  logger,
}: {
  env: LocalCallbackEnv;
  sessionId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  logger?: LoggerLike;
}): Promise<void> {
  if (env.WORKER_ENV !== ENVIRONMENT.Local) return;

  const baseUrl = resolveLocalCallbackBaseUrl(env.CONTROL_PLANE_URL);
  await assertEndpointStatus({
    check: "health",
    fetchImpl,
    expectedStatus: 200,
    timeoutMs,
    url: new URL("/api/health", baseUrl),
  });
  await assertEndpointStatus({
    check: "websocket",
    fetchImpl,
    expectedStatus: WEBSOCKET_ROUTE_EXPECTED_STATUS,
    timeoutMs,
    url: new URL(`/api/sessions/${encodeURIComponent(sessionId)}/ws?type=sandbox`, baseUrl),
  });

  logger?.info(
    {
      sessionId,
      controlPlaneUrl: baseUrl.origin,
      callbackPreflight: "passed",
    },
    "Local control-plane callback preflight passed",
  );
}

function resolveLocalCallbackBaseUrl(rawUrl: string | undefined): URL {
  if (!rawUrl?.trim()) {
    throw new SandboxCallbackPreflightError(
      "Local control-plane callback URL is not configured. Start the full dev stack with npm run dev:full so CONTROL_PLANE_URL points at a live public tunnel.",
      { check: "configuration" },
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (cause) {
    throw new SandboxCallbackPreflightError(
      `Local control-plane callback URL is invalid: ${redactUrlForMessage(rawUrl)}. Start the full dev stack with npm run dev:full so CONTROL_PLANE_URL points at a live public tunnel.`,
      { check: "configuration", cause },
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SandboxCallbackPreflightError(
      `Local control-plane callback URL must use http or https, got ${url.protocol}.`,
      { check: "configuration", url: url.href },
    );
  }

  if (isLocalOnlyHost(url.hostname)) {
    throw new SandboxCallbackPreflightError(
      `Local control-plane callback URL must be reachable from the sandbox runtime, got ${url.origin}. Start the full dev stack with npm run dev:full so CONTROL_PLANE_URL points at a live public tunnel.`,
      { check: "configuration", url: url.href },
    );
  }

  if (isHostedCycloidHost(url.hostname)) {
    throw new SandboxCallbackPreflightError(
      `Local control-plane callback URL must not point at hosted Cycloid, got ${url.origin}. Start the full dev stack with npm run dev:full so CONTROL_PLANE_URL points at your local API tunnel.`,
      { check: "configuration", url: url.href },
    );
  }

  return url;
}

function isHostedCycloidHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "app.trycycloid.com" || host === "qa.app.trycycloid.com" || host === "qa.trycycloid.com";
}

function isLocalOnlyHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "host.docker.internal" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Literal(host);
  if (ipv4) {
    const [firstOctet, secondOctet] = ipv4;
    if (firstOctet === 127 || firstOctet === 10) return true;
    if (firstOctet === 192 && secondOctet === 168) return true;
    if (firstOctet === 169 && secondOctet === 254) return true;
    if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;
  }

  return false;
}

function normalizeHostname(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function parseIpv4Literal(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as [number, number, number, number];
}

async function assertEndpointStatus({
  check,
  expectedStatus,
  fetchImpl,
  timeoutMs,
  url,
}: {
  check: Exclude<CallbackPreflightCheck, "configuration">;
  expectedStatus: number;
  fetchImpl: FetchLike;
  timeoutMs: number;
  url: URL;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  } catch (cause) {
    throw new SandboxCallbackPreflightError(
      `Local control-plane callback preflight failed: GET ${redactUrlForMessage(url, { includePath: true })} was not reachable (${formatCause(cause)}). Restart npm run dev:full so CONTROL_PLANE_URL points at a live tunnel.`,
      { check, url: url.href, cause },
    );
  }

  if (response.status !== expectedStatus) {
    throw new SandboxCallbackPreflightError(
      `Local control-plane callback preflight failed: GET ${redactUrlForMessage(url, { includePath: true })} returned HTTP ${response.status}, expected HTTP ${expectedStatus}. Restart npm run dev:full so CONTROL_PLANE_URL points at a live tunnel.`,
      { check, url: url.href, status: response.status },
    );
  }
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

function redactUrlForMessage(value: string | URL, options: { includePath?: boolean } = {}): string {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const path = options.includePath && url.pathname !== "/" ? url.pathname : "";
    return `${url.origin}${path}`;
  } catch {
    return "<invalid-url>";
  }
}
