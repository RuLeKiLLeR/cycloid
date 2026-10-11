import type { CreateDesktopViewTicketResponse, DesktopViewTicket } from "../../../../shared/types/desktop-viewer.js";
import { createLogger } from "../logger";
import {
  E2BSandboxClient,
  type E2BSandboxPortConnection,
  E2BSandboxRuntimeError,
  type RunCommandResult,
} from "../sandbox/e2b-client";
import { E2B_CLOUD_RUNTIME_BACKEND } from "../sandbox/runtime-backend";
import type { Env } from "../types";

const DESKTOP_NOVNC_PORT = 6080;
const DESKTOP_WEBSOCKIFY_PATH = "/websockify";
const DESKTOP_PORT_CONNECT_TIMEOUT_MS = 30_000;
const DESKTOP_SUPERVISOR_START_TIMEOUT_MS = 30_000;
const DESKTOP_SUPERVISOR_START_COMMAND =
  'bash -lc \'command -v cycloid-desktop-supervisor >/dev/null 2>&1 && { cycloid-desktop-supervisor start-ready; rc=$?; if [ "$rc" -ne 0 ]; then cycloid-desktop-supervisor health || true; exit "$rc"; fi; }\'';
const DESKTOP_UPSTREAM_HOST_RE = /^(?:localhost|127\.0\.0\.1|[A-Za-z0-9][A-Za-z0-9._-]{0,251})(?::([0-9]{1,5}))?$/;
const RFB_PROTOCOL_VERSION_LENGTH = 12;
const RFB_MAX_CLIENT_BUFFER_BYTES = 64 * 1024;
const RFB_MAX_SET_ENCODINGS = 256;
const RFB_MAX_FENCE_PAYLOAD_BYTES = 64;
const RFB_CLIENT_CUT_TEXT_HEADER_BYTES = 8;
const RFB_EXTENDED_CLIPBOARD_ACTION_CAPS = 0x01000000;
const RFB_EXTENDED_CLIPBOARD_ACTION_MASK = 0xff000000;

const log = createLogger({ bindings: { component: "desktop-viewer-proxy" } });

export type DesktopViewerUpstream = {
  url: string;
  headers: Headers;
};

export type DesktopViewerInputAttempt =
  | "keyboard"
  | "pointer"
  | "clipboard"
  | "desktop_resize"
  | "power_control"
  | "unknown_client_message"
  | "protocol_violation";

type RfbClientParsePhase = "protocol_version" | "security_selection" | "client_init" | "normal";

type SandboxStateForDesktopProxy = {
  status?: unknown;
  runtimeBackend?: unknown;
  runtimeState?: unknown;
  runtimeSandboxId?: unknown;
  sandboxId?: unknown;
};

export type DesktopViewerUpstreamResolveDiagnostics = {
  phase:
    | "sandbox_state"
    | "sandbox_backend"
    | "sandbox_identity"
    | "supervisor_start"
    | "supervisor_health"
    | "dbus_start"
    | "x_display"
    | "window_manager"
    | "desktop_root"
    | "panel"
    | "screenshot_capture"
    | "screenshot_black_or_uniform"
    | "vnc_ready"
    | "websockify_ready"
    | "provider_port_resolve"
    | "ready";
  reason: string | null;
  durationMs: number;
  statusCode: 200 | 409 | 503;
  retryable: boolean;
  sandboxStatus: string | null;
  runtimeState: string | null;
  runtimeBackend: string | null;
  runtimeSandboxId: string | null;
  supervisorExitCode: number | null;
  supervisorStderr: string | null;
  supervisorHealthStatus: string | null;
  supervisorHealthFailedComponent: string | null;
  supervisorHealthFailedPhase: string | null;
  supervisorHealthLastError: string | null;
  supervisorHealthDisplay: string | null;
  supervisorHealthWidth: number | null;
  supervisorHealthHeight: number | null;
  supervisorHealthScreenshotOk: boolean | null;
  supervisorHealthScreenshotNonBlackPixelRatio: number | null;
  supervisorHealthScreenshotEntropy: number | null;
  supervisorHealthScreenshotUniform: boolean | null;
  supervisorHealthVncReachable: boolean | null;
  supervisorHealthNovncReachable: boolean | null;
  supervisorHealthLoopbackOnly: boolean | null;
  providerErrorCode: string | null;
  providerErrorStatus: number | null;
  providerErrorRetryAfterMs: number | null;
  providerErrorRequestSent: boolean | null;
  upstreamHostPresent: boolean;
  trafficAccessTokenPresent: boolean;
};

export type DesktopViewerWebSocketHandshakeDiagnostics = {
  statusCode: number | null;
  hasWebSocket: boolean;
  closeReason: string | null;
  durationMs: number;
  errorType: string | null;
  errorMessage: string | null;
};

export type DesktopViewerWebSocketCloseDiagnostics = {
  reason: string;
  source: "client" | "upstream" | "proxy";
  code: number | null;
  socketReason: string | null;
  wasClean: boolean | null;
};

type DesktopSupervisorHealthSnapshot = {
  status: string | null;
  failedComponent: string | null;
  failedPhase: DesktopViewerUpstreamResolveDiagnostics["phase"] | null;
  lastError: string | null;
  display: string | null;
  width: number | null;
  height: number | null;
  screenshotOk: boolean | null;
  screenshotNonBlackPixelRatio: number | null;
  screenshotEntropy: number | null;
  screenshotUniform: boolean | null;
  vncReachable: boolean | null;
  novncReachable: boolean | null;
  loopbackOnly: boolean | null;
};

type DesktopProviderErrorSnapshot = {
  code: string | null;
  status: number | null;
  retryAfterMs: number | null;
  requestSent: boolean | null;
};

type DesktopViewerUpstreamResolveResult =
  | { ok: true; upstream: DesktopViewerUpstream; diagnostics: DesktopViewerUpstreamResolveDiagnostics }
  | { ok: false; status: 409 | 503; error: string; diagnostics: DesktopViewerUpstreamResolveDiagnostics };

type DesktopViewerFailure = {
  status: 409 | 503;
  error: string;
  phase: DesktopViewerUpstreamResolveDiagnostics["phase"];
  reason: string;
  retryable: boolean;
};

function desktopSandboxFailure(sandboxState: SandboxStateForDesktopProxy): DesktopViewerFailure | null {
  const sandboxStatus = stringOrNull(sandboxState?.status);
  const runtimeState = stringOrNull(sandboxState?.runtimeState);
  if (sandboxStatus === "failed") {
    return {
      status: 409,
      error: "Desktop live view is unavailable because the sandbox failed",
      phase: "sandbox_state",
      reason: "sandbox_failed",
      retryable: false,
    };
  }
  if (sandboxStatus === "stopped") {
    return {
      status: 409,
      error: "Desktop live view is unavailable because the sandbox is stopped",
      phase: "sandbox_state",
      reason: "sandbox_stopped",
      retryable: false,
    };
  }
  if (runtimeState === "killed") {
    return {
      status: 409,
      error: "Desktop live view is unavailable because the runtime was killed",
      phase: "sandbox_state",
      reason: "runtime_killed",
      retryable: false,
    };
  }
  if (runtimeState === "paused") {
    return {
      status: 409,
      error: "Desktop live view is unavailable because the runtime is paused",
      phase: "sandbox_state",
      reason: "runtime_paused",
      retryable: false,
    };
  }
  return null;
}

function supervisorHealthReason(health: DesktopSupervisorHealthSnapshot | null, fallback: string): string {
  return health?.lastError ?? health?.failedComponent ?? fallback;
}

function supervisorHealthPhase(
  health: DesktopSupervisorHealthSnapshot | null,
  fallback: DesktopViewerUpstreamResolveDiagnostics["phase"],
): DesktopViewerUpstreamResolveDiagnostics["phase"] {
  return health?.failedPhase ?? fallback;
}

function supervisorHealthRetryable(health: DesktopSupervisorHealthSnapshot | null): boolean {
  if (!health) return true;
  if (health.lastError === "non_loopback_binding") return false;
  if (health.failedComponent === "ports" && health.loopbackOnly === false) return false;
  return true;
}

export function buildDesktopViewTicketPaths(
  sessionId: string,
  ticket: DesktopViewTicket,
): CreateDesktopViewTicketResponse {
  const encodedSessionId = encodeURIComponent(sessionId);
  const encodedTicketId = encodeURIComponent(ticket.ticketId);
  const basePath = `/api/sessions/${encodedSessionId}/desktop/view-ticket/${encodedTicketId}`;
  return {
    ok: true,
    ticket: {
      ...ticket,
      websocketPath: `${basePath}/ws`,
      heartbeatPath: `${basePath}/heartbeat`,
      revokePath: basePath,
      statusPath: `${basePath}/status`,
    },
  };
}

function runtimeSandboxIdFromState(sandboxState: SandboxStateForDesktopProxy): string | null {
  if (typeof sandboxState.runtimeSandboxId === "string" && sandboxState.runtimeSandboxId.length > 0) {
    return sandboxState.runtimeSandboxId;
  }
  return typeof sandboxState.sandboxId === "string" && sandboxState.sandboxId.length > 0
    ? sandboxState.sandboxId
    : null;
}

function isE2BDesktopProxyState(sandboxState: SandboxStateForDesktopProxy): boolean {
  const backend = sandboxState.runtimeBackend;
  return backend === undefined || backend === null || backend === E2B_CLOUD_RUNTIME_BACKEND;
}

function fetchSchemeForHost(host: string): "http" | "https" {
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:") ? "http" : "https";
}

function splitHostPort(host: string): { hostname: string; port: number | null } | null {
  const match = DESKTOP_UPSTREAM_HOST_RE.exec(host);
  if (!match) return null;
  const portRaw = match[1];
  if (!portRaw) return { hostname: host, port: null };
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { hostname: host.slice(0, -(portRaw.length + 1)), port };
}

function isRawIpv4Address(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

export function isValidDesktopViewerUpstreamHost(host: string): boolean {
  if (host.trim() !== host || host.length === 0) return false;
  const parsed = splitHostPort(host);
  if (!parsed) return false;
  if (isRawIpv4Address(parsed.hostname) && parsed.hostname !== "127.0.0.1") return false;
  return true;
}

function buildWebsockifyUrl(host: string): string {
  if (!isValidDesktopViewerUpstreamHost(host)) {
    throw new Error("Invalid desktop viewer upstream host");
  }
  const url = new URL(`${fetchSchemeForHost(host)}://${host}`);
  url.pathname = DESKTOP_WEBSOCKIFY_PATH;
  return url.toString();
}

export function buildDesktopViewerUpstream(connection: E2BSandboxPortConnection): DesktopViewerUpstream {
  const headers = new Headers({ upgrade: "websocket" });
  if (connection.trafficAccessToken) {
    headers.set("x-e2b-access-token", connection.trafficAccessToken);
  }
  return {
    url: buildWebsockifyUrl(connection.host),
    headers,
  };
}

export async function resolveDesktopViewerUpstream(params: {
  env: Pick<Env, "E2B_API_KEY" | "E2B_DOMAIN">;
  sandboxState: SandboxStateForDesktopProxy | null | undefined;
  resolveE2BPort?: (runtimeSandboxId: string, port: number, timeoutMs: number) => Promise<E2BSandboxPortConnection>;
  startDesktopSupervisor?: (runtimeSandboxId: string, timeoutMs: number) => Promise<RunCommandResult>;
}): Promise<DesktopViewerUpstreamResolveResult> {
  const startedAt = Date.now();
  const sandboxState = params.sandboxState;
  let supervisorHealth: DesktopSupervisorHealthSnapshot | null = null;
  let providerError: DesktopProviderErrorSnapshot | null = null;
  const diagnosticsBase = () => ({
    durationMs: Date.now() - startedAt,
    retryable: true,
    sandboxStatus: stringOrNull(sandboxState?.status),
    runtimeState: stringOrNull(sandboxState?.runtimeState),
    runtimeBackend: stringOrNull(sandboxState?.runtimeBackend),
    runtimeSandboxId: stringOrNull(sandboxState?.runtimeSandboxId) ?? stringOrNull(sandboxState?.sandboxId),
    supervisorExitCode: null,
    supervisorStderr: null,
    supervisorHealthStatus: supervisorHealth?.status ?? null,
    supervisorHealthFailedComponent: supervisorHealth?.failedComponent ?? null,
    supervisorHealthFailedPhase: supervisorHealth?.failedPhase ?? null,
    supervisorHealthLastError: supervisorHealth?.lastError ?? null,
    supervisorHealthDisplay: supervisorHealth?.display ?? null,
    supervisorHealthWidth: supervisorHealth?.width ?? null,
    supervisorHealthHeight: supervisorHealth?.height ?? null,
    supervisorHealthScreenshotOk: supervisorHealth?.screenshotOk ?? null,
    supervisorHealthScreenshotNonBlackPixelRatio: supervisorHealth?.screenshotNonBlackPixelRatio ?? null,
    supervisorHealthScreenshotEntropy: supervisorHealth?.screenshotEntropy ?? null,
    supervisorHealthScreenshotUniform: supervisorHealth?.screenshotUniform ?? null,
    supervisorHealthVncReachable: supervisorHealth?.vncReachable ?? null,
    supervisorHealthNovncReachable: supervisorHealth?.novncReachable ?? null,
    supervisorHealthLoopbackOnly: supervisorHealth?.loopbackOnly ?? null,
    providerErrorCode: providerError?.code ?? null,
    providerErrorStatus: providerError?.status ?? null,
    providerErrorRetryAfterMs: providerError?.retryAfterMs ?? null,
    providerErrorRequestSent: providerError?.requestSent ?? null,
    upstreamHostPresent: false,
    trafficAccessTokenPresent: false,
  });
  const failureResult = (failure: DesktopViewerFailure): DesktopViewerUpstreamResolveResult => ({
    ok: false,
    status: failure.status,
    error: failure.error,
    diagnostics: {
      ...diagnosticsBase(),
      phase: failure.phase,
      reason: failure.reason,
      statusCode: failure.status,
      retryable: failure.retryable,
    },
  });
  if (!sandboxState) {
    return failureResult({
      status: 503,
      error: "Desktop sandbox is not available",
      phase: "sandbox_state",
      reason: "sandbox_state_missing",
      retryable: true,
    });
  }
  const sandboxFailure = desktopSandboxFailure(sandboxState);
  if (sandboxFailure) return failureResult(sandboxFailure);
  if (!isE2BDesktopProxyState(sandboxState)) {
    return {
      ok: false,
      status: 503,
      error: "Desktop live view is unsupported for this sandbox backend",
      diagnostics: {
        ...diagnosticsBase(),
        phase: "sandbox_backend",
        reason: "unsupported_sandbox_backend",
        statusCode: 503,
        retryable: false,
      },
    };
  }
  const runtimeSandboxId = runtimeSandboxIdFromState(sandboxState);
  if (!runtimeSandboxId) {
    return {
      ok: false,
      status: 409,
      error: "Desktop sandbox is not connected",
      diagnostics: {
        ...diagnosticsBase(),
        phase: "sandbox_identity",
        reason: "runtime_sandbox_id_missing",
        statusCode: 409,
        retryable: true,
      },
    };
  }

  const client = new E2BSandboxClient({
    apiKey: params.env.E2B_API_KEY,
    domain: params.env.E2B_DOMAIN,
    logger: log,
  });
  const startDesktopSupervisor =
    params.startDesktopSupervisor ??
    ((sandboxId: string, timeoutMs: number) =>
      client.runCommand({
        runtimeSandboxId: sandboxId,
        command: DESKTOP_SUPERVISOR_START_COMMAND,
        timeoutMs,
      }));
  let supervisorResult: RunCommandResult;
  try {
    supervisorResult = await startDesktopSupervisor(runtimeSandboxId, DESKTOP_SUPERVISOR_START_TIMEOUT_MS);
  } catch (error) {
    providerError = providerErrorSnapshot(error);
    log.warn(
      { runtimeSandboxId, error: String(error), providerError },
      "Desktop supervisor start errored before viewer proxy connection",
    );
    return {
      ok: false,
      status: 503,
      error: "Desktop supervisor is unavailable",
      diagnostics: {
        ...diagnosticsBase(),
        phase: "supervisor_start",
        reason: "supervisor_start_error",
        statusCode: 503,
        retryable: true,
      },
    };
  }
  if (supervisorResult.exitCode !== 0) {
    supervisorHealth = parseSupervisorHealth(supervisorResult.stdout);
    const retryable = supervisorHealthRetryable(supervisorHealth);
    log.warn(
      {
        runtimeSandboxId,
        exitCode: supervisorResult.exitCode,
        stderr: supervisorResult.stderr.slice(0, 500),
        failedComponent: supervisorHealth?.failedComponent,
        failedPhase: supervisorHealth?.failedPhase,
        lastError: supervisorHealth?.lastError,
        retryable,
      },
      "Desktop supervisor start failed before viewer proxy connection",
    );
    return {
      ok: false,
      status: 503,
      error: "Desktop supervisor is unavailable",
      diagnostics: {
        ...diagnosticsBase(),
        phase: supervisorHealthPhase(supervisorHealth, "supervisor_start"),
        reason: supervisorHealthReason(supervisorHealth, "supervisor_start_exit_nonzero"),
        statusCode: 503,
        retryable,
        supervisorExitCode: supervisorResult.exitCode,
        supervisorStderr: supervisorResult.stderr.slice(0, 500),
      },
    };
  }
  supervisorHealth = parseSupervisorHealth(supervisorResult.stdout);
  if (supervisorHealth?.status === "unavailable") {
    const retryable = supervisorHealthRetryable(supervisorHealth);
    log.warn(
      {
        runtimeSandboxId,
        failedComponent: supervisorHealth.failedComponent,
        failedPhase: supervisorHealth.failedPhase,
        lastError: supervisorHealth.lastError,
        display: supervisorHealth.display,
        retryable,
      },
      "Desktop supervisor health is unavailable before viewer proxy connection",
    );
    return {
      ok: false,
      status: 503,
      error: "Desktop supervisor health is unavailable",
      diagnostics: {
        ...diagnosticsBase(),
        phase: supervisorHealth.failedPhase ?? "supervisor_health",
        reason: supervisorHealth.lastError ?? "supervisor_health_unavailable",
        statusCode: 503,
        retryable,
        supervisorExitCode: supervisorResult.exitCode,
        supervisorStderr: supervisorResult.stderr.slice(0, 500),
      },
    };
  }

  const resolveE2BPort =
    params.resolveE2BPort ??
    ((sandboxId: string, port: number, timeoutMs: number) => client.resolveSandboxPort(sandboxId, port, timeoutMs));

  let connection: E2BSandboxPortConnection;
  try {
    connection = await resolveE2BPort(runtimeSandboxId, DESKTOP_NOVNC_PORT, DESKTOP_PORT_CONNECT_TIMEOUT_MS);
  } catch (error) {
    providerError = providerErrorSnapshot(error);
    log.warn({ runtimeSandboxId, error: String(error), providerError }, "Desktop noVNC port resolution failed");
    return {
      ok: false,
      status: 503,
      error: "Desktop noVNC port is unavailable",
      diagnostics: {
        ...diagnosticsBase(),
        phase: "provider_port_resolve",
        reason: "port_resolve_error",
        statusCode: 503,
        retryable: true,
      },
    };
  }
  let upstream: DesktopViewerUpstream;
  try {
    upstream = buildDesktopViewerUpstream(connection);
  } catch (error) {
    log.warn(
      {
        runtimeSandboxId,
        upstreamHostPresent: connection.host.length > 0,
        trafficAccessTokenPresent: Boolean(connection.trafficAccessToken),
        error: String(error),
      },
      "Desktop noVNC port resolution returned an invalid upstream host",
    );
    return {
      ok: false,
      status: 503,
      error: "Desktop noVNC port is unavailable",
      diagnostics: {
        ...diagnosticsBase(),
        phase: "provider_port_resolve",
        reason: "invalid_port_host",
        statusCode: 503,
        retryable: true,
        upstreamHostPresent: connection.host.length > 0,
        trafficAccessTokenPresent: Boolean(connection.trafficAccessToken),
      },
    };
  }
  return {
    ok: true,
    upstream,
    diagnostics: {
      ...diagnosticsBase(),
      phase: "ready",
      reason: null,
      statusCode: 200,
      retryable: false,
      upstreamHostPresent: connection.host.length > 0,
      trafficAccessTokenPresent: Boolean(connection.trafficAccessToken),
    },
  };
}

function providerErrorSnapshot(error: unknown): DesktopProviderErrorSnapshot | null {
  if (!(error instanceof E2BSandboxRuntimeError)) return null;
  return {
    code: error.code,
    status: typeof error.status === "number" ? error.status : null,
    retryAfterMs: typeof error.retryAfterMs === "number" ? error.retryAfterMs : null,
    requestSent: error.requestSent,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function desktopResolvePhaseOrNull(value: unknown): DesktopViewerUpstreamResolveDiagnostics["phase"] | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "sandbox_state":
    case "sandbox_backend":
    case "sandbox_identity":
    case "supervisor_start":
    case "supervisor_health":
    case "dbus_start":
    case "x_display":
    case "window_manager":
    case "desktop_root":
    case "panel":
    case "screenshot_capture":
    case "screenshot_black_or_uniform":
    case "vnc_ready":
    case "websockify_ready":
    case "provider_port_resolve":
    case "ready":
      return value;
    default:
      return null;
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseSupervisorHealth(stdout: string): DesktopSupervisorHealthSnapshot | null {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const root = objectOrNull(parsed);
  if (!root) return null;
  const size = objectOrNull(root.size);
  const ports = objectOrNull(root.ports);
  const vnc = objectOrNull(ports?.vnc);
  const novnc = objectOrNull(ports?.novnc);
  const checks = objectOrNull(root.checks);
  const screenshot = objectOrNull(root.screenshot);
  return {
    status: stringOrNull(root.status),
    failedComponent: stringOrNull(root.failedComponent),
    failedPhase: desktopResolvePhaseOrNull(root.failedPhase),
    lastError: stringOrNull(root.lastError),
    display: stringOrNull(root.display),
    width: numberOrNull(size?.width),
    height: numberOrNull(size?.height),
    screenshotOk: booleanOrNull(checks?.screenshot),
    screenshotNonBlackPixelRatio: numberOrNull(screenshot?.nonBlackPixelRatio),
    screenshotEntropy: numberOrNull(screenshot?.entropy),
    screenshotUniform: booleanOrNull(screenshot?.uniform),
    vncReachable: booleanOrNull(vnc?.reachable),
    novncReachable: booleanOrNull(novnc?.reachable),
    loopbackOnly: booleanOrNull(ports?.loopbackOnly),
  };
}

function dataToUint8Array(data: string | ArrayBuffer): Uint8Array | null {
  if (typeof data === "string") {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      out[i] = data.charCodeAt(i) & 0xff;
    }
    return out;
  }
  return new Uint8Array(data);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);
}

function countLow16Bits(value: number): number {
  let count = 0;
  let remaining = value & 0xffff;
  while (remaining !== 0) {
    remaining &= remaining - 1;
    count += 1;
  }
  return count;
}

function rfbProtocolVersion(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function classifyRfbClientMessageType(type: number): DesktopViewerInputAttempt | null {
  if (type === 4 || type === 255) return "keyboard";
  if (type === 5) return "pointer";
  if (type === 6) return "clipboard";
  if (type === 250) return "power_control";
  if (type === 251) return "desktop_resize";
  return null;
}

export function detectRfbInputAttempt(data: string | ArrayBuffer): DesktopViewerInputAttempt | null {
  const bytes = dataToUint8Array(data);
  if (!bytes || bytes.length === 0) return null;
  return classifyRfbClientMessageType(bytes[0]);
}

type RfbClientMessageParseResult =
  | { status: "allowed"; length: number }
  | { status: "need_more" }
  | { status: "blocked"; inputType: DesktopViewerInputAttempt };

function parseNormalRfbClientMessage(bytes: Uint8Array): RfbClientMessageParseResult {
  if (bytes.length === 0) return { status: "need_more" };
  const type = bytes[0];
  if (type === 4 || type === 255) return { status: "blocked", inputType: "keyboard" };
  if (type === 5) return { status: "blocked", inputType: "pointer" };
  if (type === 250) return { status: "blocked", inputType: "power_control" };
  if (type === 251) return { status: "blocked", inputType: "desktop_resize" };

  switch (type) {
    case 0:
      return bytes.length >= 20 ? { status: "allowed", length: 20 } : { status: "need_more" };
    case 2: {
      if (bytes.length < 4) return { status: "need_more" };
      const encodingCount = readUint16(bytes, 2);
      if (encodingCount > RFB_MAX_SET_ENCODINGS) {
        return { status: "blocked", inputType: "protocol_violation" };
      }
      const length = 4 + encodingCount * 4;
      return bytes.length >= length ? { status: "allowed", length } : { status: "need_more" };
    }
    case 3:
      return bytes.length >= 10 ? { status: "allowed", length: 10 } : { status: "need_more" };
    case 6: {
      if (bytes.length < RFB_CLIENT_CUT_TEXT_HEADER_BYTES) return { status: "need_more" };
      const encodedLength = readUint32(bytes, 4);
      if (encodedLength <= 0x7fffffff) return { status: "blocked", inputType: "clipboard" };
      const payloadLength = 0x100000000 - encodedLength;
      if (payloadLength < 4) return { status: "blocked", inputType: "protocol_violation" };
      if (bytes.length < RFB_CLIENT_CUT_TEXT_HEADER_BYTES + Math.min(payloadLength, 4)) return { status: "need_more" };
      const flags = readUint32(bytes, RFB_CLIENT_CUT_TEXT_HEADER_BYTES);
      const actions = flags & RFB_EXTENDED_CLIPBOARD_ACTION_MASK;
      if ((actions & RFB_EXTENDED_CLIPBOARD_ACTION_CAPS) === 0) {
        return { status: "blocked", inputType: "clipboard" };
      }
      const formatCount = countLow16Bits(flags);
      const expectedCapsPayloadLength = 4 + formatCount * 4;
      if (payloadLength !== expectedCapsPayloadLength) {
        return { status: "blocked", inputType: "protocol_violation" };
      }
      const length = RFB_CLIENT_CUT_TEXT_HEADER_BYTES + payloadLength;
      return bytes.length >= length ? { status: "allowed", length } : { status: "need_more" };
    }
    case 150:
      return bytes.length >= 10 ? { status: "allowed", length: 10 } : { status: "need_more" };
    case 248: {
      if (bytes.length < 9) return { status: "need_more" };
      const payloadLength = bytes[8];
      if (payloadLength > RFB_MAX_FENCE_PAYLOAD_BYTES) {
        return { status: "blocked", inputType: "protocol_violation" };
      }
      const length = 9 + payloadLength;
      return bytes.length >= length ? { status: "allowed", length } : { status: "need_more" };
    }
    default:
      return { status: "blocked", inputType: "unknown_client_message" };
  }
}

export class RfbViewOnlyInputGuard {
  private phase: RfbClientParsePhase = "protocol_version";
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();

  inspectClientMessage(data: string | ArrayBuffer): DesktopViewerInputAttempt | null {
    const bytes = dataToUint8Array(data);
    if (!bytes || bytes.length === 0) return null;
    this.pending = concatBytes(this.pending, bytes);
    if (this.pending.length > RFB_MAX_CLIENT_BUFFER_BYTES) {
      return "protocol_violation";
    }
    return this.drainPending();
  }

  private drainPending(): DesktopViewerInputAttempt | null {
    while (this.pending.length > 0) {
      if (this.phase === "protocol_version") {
        if (this.pending.length < RFB_PROTOCOL_VERSION_LENGTH) return null;
        const versionBytes = this.pending.slice(0, RFB_PROTOCOL_VERSION_LENGTH);
        const version = rfbProtocolVersion(versionBytes);
        if (!/^RFB 003\.(?:003|007|008)\n$/.test(version)) {
          return "protocol_violation";
        }
        this.consume(RFB_PROTOCOL_VERSION_LENGTH);
        this.phase = version === "RFB 003.003\n" ? "client_init" : "security_selection";
        continue;
      }

      if (this.phase === "security_selection") {
        if (this.pending.length < 1) return null;
        if (this.pending[0] === 0) return "protocol_violation";
        this.consume(1);
        this.phase = "client_init";
        continue;
      }

      if (this.phase === "client_init") {
        if (this.pending.length < 1) return null;
        this.consume(1);
        this.phase = "normal";
        continue;
      }

      const parsed = parseNormalRfbClientMessage(this.pending);
      if (parsed.status === "need_more") return null;
      if (parsed.status === "blocked") return parsed.inputType;
      this.consume(parsed.length);
    }
    return null;
  }

  private consume(length: number): void {
    this.pending = this.pending.slice(length);
  }
}

type FetchWebSocket = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function closeReasonForUpstreamResponse(response: Response): string {
  if (response.status === 401 || response.status === 403) return "upstream_forbidden";
  return "upstream_unavailable";
}

function sanitizeProxyErrorMessage(message: string): string {
  return message.replace(/\b(?:https?|wss?):\/\/[^\s)]+/gi, "<redacted-url>").slice(0, 240);
}

function safeProxyErrorDiagnostics(error: unknown): { errorType: string; errorMessage: string } {
  if (error instanceof Error) {
    return {
      errorType: error.name || "Error",
      errorMessage: sanitizeProxyErrorMessage(error.message),
    };
  }
  return { errorType: typeof error, errorMessage: sanitizeProxyErrorMessage(String(error)) };
}

export async function proxyDesktopViewerWebSocket(params: {
  upstream: DesktopViewerUpstream;
  clientSocket: WebSocket;
  maxConnectionDurationMs?: number;
  fetchImpl?: FetchWebSocket;
  onInputAttempt?: (inputType: DesktopViewerInputAttempt) => void;
  onHandshake?: (diagnostics: DesktopViewerWebSocketHandshakeDiagnostics) => Promise<void> | void;
  onClose?: (diagnostics: DesktopViewerWebSocketCloseDiagnostics) => Promise<void>;
}): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  let upstreamSocket: WebSocket | null = null;
  let maxConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  const handshakeStartedAt = Date.now();
  let handshakeReported = false;
  let closeNotified = false;
  let closeReasonOverride: string | null = null;
  const closeBothSockets = (code: number, reason: string) => {
    try {
      params.clientSocket.close(code, reason);
    } catch {
      // Already closed.
    }
    try {
      upstreamSocket?.close(code, reason);
    } catch {
      // Already closed.
    }
  };
  const reportHandshake = async (diagnostics: Omit<DesktopViewerWebSocketHandshakeDiagnostics, "durationMs">) => {
    handshakeReported = true;
    try {
      await params.onHandshake?.({ ...diagnostics, durationMs: Date.now() - handshakeStartedAt });
    } catch (error) {
      log.warn({ error: String(error) }, "Desktop viewer WebSocket handshake handler failed");
    }
  };
  const closeDiagnostics = (
    reason: string,
    source: DesktopViewerWebSocketCloseDiagnostics["source"],
    event: Event | null = null,
  ): DesktopViewerWebSocketCloseDiagnostics => {
    const closeEvent = event as CloseEvent | null;
    return {
      reason,
      source,
      code: typeof closeEvent?.code === "number" ? closeEvent.code : null,
      socketReason:
        typeof closeEvent?.reason === "string" && closeEvent.reason.length > 0
          ? sanitizeProxyErrorMessage(closeEvent.reason)
          : null,
      wasClean: typeof closeEvent?.wasClean === "boolean" ? closeEvent.wasClean : null,
    };
  };
  const notifyClose = async (diagnostics: DesktopViewerWebSocketCloseDiagnostics): Promise<void> => {
    if (closeNotified) return;
    closeNotified = true;
    try {
      await params.onClose?.(diagnostics);
    } catch (error) {
      log.warn(
        { error: String(error), reason: diagnostics.reason, source: diagnostics.source },
        "Desktop viewer WebSocket close handler failed",
      );
    }
  };
  try {
    const upstreamResponse = await fetchImpl(params.upstream.url, { headers: params.upstream.headers });
    upstreamSocket = (upstreamResponse as Response & { webSocket?: WebSocket }).webSocket ?? null;
    if (!upstreamSocket) {
      const reason = closeReasonForUpstreamResponse(upstreamResponse);
      await reportHandshake({
        statusCode: upstreamResponse.status,
        hasWebSocket: false,
        closeReason: reason,
        errorType: null,
        errorMessage: null,
      });
      params.clientSocket.close(
        1011,
        reason === "upstream_forbidden" ? "Desktop upstream rejected live view" : "Desktop upstream unavailable",
      );
      await notifyClose(closeDiagnostics(reason, "proxy"));
      return;
    }
    await reportHandshake({
      statusCode: upstreamResponse.status,
      hasWebSocket: true,
      closeReason: null,
      errorType: null,
      errorMessage: null,
    });
    upstreamSocket.accept();
    if (typeof params.maxConnectionDurationMs === "number" && Number.isFinite(params.maxConnectionDurationMs)) {
      maxConnectionTimer = setTimeout(
        () => {
          closeReasonOverride = "ticket_expired";
          closeBothSockets(1008, "Desktop viewer ticket expired");
        },
        Math.max(0, params.maxConnectionDurationMs),
      );
    }
    const inputGuard = new RfbViewOnlyInputGuard();

    params.clientSocket.addEventListener("message", (event) => {
      const inputAttempt = inputGuard.inspectClientMessage(event.data as string | ArrayBuffer);
      if (inputAttempt) {
        closeReasonOverride = "input_blocked";
        try {
          params.onInputAttempt?.(inputAttempt);
        } catch (error) {
          log.warn({ error: String(error), inputAttempt }, "Desktop viewer input-attempt callback failed");
        }
        closeBothSockets(1008, "Desktop viewer input is disabled");
        return;
      }
      try {
        upstreamSocket?.send(event.data);
      } catch {
        closeReasonOverride = "proxy_failed";
        closeBothSockets(1011, "Desktop proxy failed");
      }
    });
    upstreamSocket.addEventListener("message", (event) => {
      try {
        params.clientSocket.send(event.data);
      } catch {
        closeReasonOverride = "proxy_failed";
        closeBothSockets(1011, "Desktop proxy failed");
      }
    });

    const close = await new Promise<DesktopViewerWebSocketCloseDiagnostics>((resolve) => {
      const clientClose = (event: Event) =>
        resolve(
          closeDiagnostics(closeReasonOverride ?? "client_closed", closeReasonOverride ? "proxy" : "client", event),
        );
      const upstreamClose = (event: Event) =>
        resolve(
          closeDiagnostics(closeReasonOverride ?? "upstream_closed", closeReasonOverride ? "proxy" : "upstream", event),
        );
      params.clientSocket.addEventListener("close", clientClose);
      upstreamSocket?.addEventListener("close", upstreamClose);
      params.clientSocket.addEventListener("error", clientClose);
      upstreamSocket?.addEventListener("error", upstreamClose);
    });
    await notifyClose(close);
  } catch (error) {
    const errorDiagnostics = safeProxyErrorDiagnostics(error);
    log.warn(errorDiagnostics, "Desktop viewer WebSocket proxy failed");
    if (!handshakeReported) {
      await reportHandshake({
        statusCode: null,
        hasWebSocket: false,
        closeReason: "proxy_failed",
        ...errorDiagnostics,
      });
    }
    try {
      params.clientSocket.close(1011, "Desktop proxy failed");
    } catch {
      // Already closed.
    }
    await notifyClose(closeDiagnostics("proxy_failed", "proxy"));
  } finally {
    if (maxConnectionTimer) clearTimeout(maxConnectionTimer);
    try {
      upstreamSocket?.close();
    } catch {
      // Already closed.
    }
    try {
      params.clientSocket.close();
    } catch {
      // Already closed.
    }
  }
}
