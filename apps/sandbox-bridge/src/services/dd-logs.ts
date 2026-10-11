/**
 * Datadog Logs shipper via the control-plane telemetry broker.
 * Buffers structured log entries and batch-ships them to the control plane, which
 * injects the platform DD-API-KEY server-side and forwards to the DD Logs intake.
 * The platform `DD_API_KEY`/`DD_SITE` are no longer present in the sandbox.
 * No-ops DD shipping if the broker is unreachable (no control-plane URL / session
 * token).
 */

import { gzipSync } from "zlib";

import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { LOG_CORRELATION_FIELD_NAMES } from "../../../../shared/observability/logger.js";
import { redactObject } from "../../../../shared/observability/redact.js";
import {
  DD_LOGS_FETCH_TIMEOUT_MS,
  DD_LOGS_FLUSH_INTERVAL_MS,
  DD_LOGS_HOSTNAME,
  DD_LOGS_MAX_BATCH_SIZE,
  DD_LOGS_MAX_BUFFER_BYTES,
  DD_LOGS_MAX_BUFFER_SIZE,
  DD_LOGS_MAX_ENTRY_BYTES,
  DD_LOGS_MAX_PAYLOAD_BYTES,
  DD_LOGS_SOURCE,
  OTEL_SERVICE_NAME,
} from "../constants/observability.js";
import { resolveTelemetryBrokerEndpoint } from "./telemetry-broker.js";

/** Field renames: bridge log fields → Datadog reserved names. */
const FIELD_MAP: Record<string, string> = {
  ts: "timestamp",
  msg: "message",
  [LOG_CORRELATION_FIELD_NAMES[3]]: "session_id",
  [LOG_CORRELATION_FIELD_NAMES[5]]: "sandbox_id",
};

let brokerUrl: string | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

let buffer: string[] = [];
let bufferBytes = 0;
let inFlight: Promise<void> | null = null;

/**
 * Initialize the DD Logs shipper. Resolves the control-plane telemetry broker
 * endpoint; the platform DD-API-KEY is injected server-side, never read here.
 * Call once at startup, before any logging. No-op DD shipping if the broker is
 * unreachable.
 */
export function initDdLogs(): void {
  const broker = resolveTelemetryBrokerEndpoint();
  if (!broker) return;

  brokerUrl = `${broker.base}/dd-logs`;

  flushTimer = setInterval(() => {
    if (inFlight || buffer.length === 0) return;
    flushDdLogs().catch((err) => console.error("[dd-logs] timer flush failed:", err));
  }, DD_LOGS_FLUSH_INTERVAL_MS);

  // Prevent the timer from keeping the process alive
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Buffer a log entry for shipping to Datadog. Sync, non-blocking.
 * Applies redaction, field normalization, and per-entry truncation.
 */
export function ddLog(entry: Record<string, unknown>): void {
  // Redact secrets before anything is buffered for shipping.
  const redacted = redactObject(entry);

  // Normalize field names
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redacted)) {
    const mapped = FIELD_MAP[key] ?? key;
    normalized[mapped] = value;
  }

  // Add DD envelope fields
  normalized.ddsource = DD_LOGS_SOURCE;
  normalized.ddtags = `env:${normalizeEnvironment(process.env.ARCANIST_RUNTIME_ENVIRONMENT, ENVIRONMENT.Production)},service:${OTEL_SERVICE_NAME}`;
  normalized.hostname = DD_LOGS_HOSTNAME;
  normalized.service = OTEL_SERVICE_NAME;

  let serialized = JSON.stringify(normalized);
  let byteLen = Buffer.byteLength(serialized, "utf8");

  // Per-entry truncation: if over limit, truncate the longest string field
  if (byteLen > DD_LOGS_MAX_ENTRY_BYTES) {
    const longestKey = findLongestStringField(normalized);
    if (longestKey) {
      const val = normalized[longestKey] as string;
      const excess = byteLen - DD_LOGS_MAX_ENTRY_BYTES;
      normalized[longestKey] = val.slice(0, Math.max(0, val.length - excess - 20)) + " [truncated]";
      serialized = JSON.stringify(normalized);
      byteLen = Buffer.byteLength(serialized, "utf8");
    }
  }

  // DD buffer (only if DD is enabled)
  if (!brokerUrl) return;

  // Drop oldest entries if count or byte cap exceeded
  while (
    buffer.length > 0 &&
    (buffer.length >= DD_LOGS_MAX_BUFFER_SIZE || bufferBytes + byteLen > DD_LOGS_MAX_BUFFER_BYTES)
  ) {
    const dropped = buffer.shift()!;
    bufferBytes -= Buffer.byteLength(dropped, "utf8");
  }

  buffer.push(serialized);
  bufferBytes += byteLen;

  // Trigger flush if byte size exceeds payload limit
  if (bufferBytes >= DD_LOGS_MAX_PAYLOAD_BYTES && !inFlight) {
    flushDdLogs().catch((err) => console.error("[dd-logs] overflow flush failed:", err));
  }
}

/**
 * Flush buffered logs to Datadog. Serializes concurrent flushes via inFlight guard.
 */
export async function flushDdLogs(): Promise<void> {
  if (!brokerUrl) return;

  // Wait for any in-flight flush to complete first
  if (inFlight) {
    await inFlight;
  }

  if (buffer.length === 0) return;

  // Drain/swap: atomically take current buffer, reset for new entries
  const toFlush = buffer;
  buffer = [];
  bufferBytes = 0;

  inFlight = doFlush(toFlush);
  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Shutdown: clear timers, await in-flight, final DD flush.
 */
export async function shutdownDdLogs(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  if (inFlight) {
    await inFlight;
  }

  await flushDdLogs();
}

// ---------------------------------------------------------------------------
// Internal helpers (DD HTTP intake)
// ---------------------------------------------------------------------------

async function doFlush(entries: string[]): Promise<void> {
  // Split entries into chunks that fit within the payload limit
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry, "utf8");

    if (
      chunk.length > 0 &&
      (chunkBytes + entryBytes + 1 > DD_LOGS_MAX_PAYLOAD_BYTES || chunk.length >= DD_LOGS_MAX_BATCH_SIZE)
    ) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(entry);
    chunkBytes += entryBytes + 1; // +1 for comma/bracket overhead
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  // Re-read the session token on every flush. The control plane rotates
  // SANDBOX_AUTH_TOKEN on each sandbox WS handshake (control-plane-session.ts
  // updates process.env), so a token cached at init goes stale after a
  // reconnect and every 5s flush would then 403 — tripping the control plane's
  // sandbox-auth-failure lockout. Reading it fresh tracks the live token.
  const sandboxAuthToken = resolveTelemetryBrokerEndpoint()?.sandboxAuthToken;
  if (!sandboxAuthToken) return;

  for (const batch of chunks) {
    const payload = `[${batch.join(",")}]`;
    const compressed = gzipSync(Buffer.from(payload, "utf8"));

    try {
      const resp = await fetch(brokerUrl!, {
        method: "POST",
        headers: {
          // Session-scoped bearer; the control plane validates it and injects
          // the platform DD-API-KEY before forwarding to the DD intake.
          Authorization: `Bearer ${sandboxAuthToken}`,
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
        },
        body: compressed,
        signal: AbortSignal.timeout(DD_LOGS_FETCH_TIMEOUT_MS),
      });

      if (!resp.ok) {
        // eslint-disable-next-line no-console
        console.error(`[dd-logs] POST failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[dd-logs] POST error:", err);
    }
  }
}

function findLongestStringField(obj: Record<string, unknown>): string | null {
  let longest: string | null = null;
  let maxLen = 0;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.length > maxLen) {
      longest = key;
      maxLen = value.length;
    }
  }

  return longest;
}
