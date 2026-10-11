// Standalone public status page for Cycloid.
//
// Deployed independently from the UI (Pages) and control plane (Worker) so it
// stays up to report app outages. A human flips the status flag in KV during an
// incident; absence of the flag means operational.

import { HTTP_HEADER_NAMES } from "../../../shared/constants/http-headers.js";
import { escapeHtml } from "../../../shared/utils/html.js";

type StatusState = "up" | "down";

interface Env {
  STATUS_FLAG: KVNamespace;
}

interface StatusResult {
  state: StatusState;
  message: string;
  updatedAt: number | null;
}

interface RawStatusFlag {
  state?: unknown;
  message?: unknown;
  updatedAt?: unknown;
}

const STATUS_KEY = "current";
const LAST_KNOWN_GOOD_CACHE_KEY = "https://status.trycycloid.com/__last-known-good-status";
const CACHE_TTL_SECONDS = 60;
const MAX_STORED_MESSAGE_LENGTH = 1_000;
const MAX_RENDERED_MESSAGE_LENGTH = 200;
// Largest epoch-ms a JS Date can represent; beyond this `new Date(x).toISOString()`
// throws RangeError. A human-edited KV flag carrying a ns/us epoch must not crash
// the status page (the one page that must render during an incident).
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;
const DEFAULT_STATUS: StatusResult = { state: "up", message: "", updatedAt: null };

const BASE_HEADERS = {
  "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

const ALLOWED_METHODS = "GET, HEAD";

function logStatusWarning(event: string, details: Record<string, string | number | boolean | null> = {}) {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ event, ...details }));
}

function isRawStatusFlag(value: unknown): value is RawStatusFlag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStatusValue(value: unknown, options: { allowNullUpdatedAt: boolean }): StatusResult | null {
  if (!isRawStatusFlag(value)) {
    return null;
  }

  if (value.state !== "up" && value.state !== "down") {
    return null;
  }

  if (typeof value.message !== "string" || value.message.length > MAX_STORED_MESSAGE_LENGTH) {
    return null;
  }

  const updatedAtIsNull = value.updatedAt === null;
  if (
    !(options.allowNullUpdatedAt && updatedAtIsNull) &&
    (typeof value.updatedAt !== "number" ||
      !Number.isFinite(value.updatedAt) ||
      value.updatedAt < 0 ||
      value.updatedAt > MAX_VALID_DATE_MS)
  ) {
    return null;
  }
  const updatedAt: number | null = options.allowNullUpdatedAt && updatedAtIsNull ? null : (value.updatedAt as number);

  return {
    state: value.state,
    message: value.message,
    updatedAt,
  };
}

function validateStatusFlag(value: unknown): StatusResult | null {
  return validateStatusValue(value, { allowNullUpdatedAt: false });
}

function validateCachedStatus(value: unknown): StatusResult | null {
  return validateStatusValue(value, { allowNullUpdatedAt: true });
}

async function readLastKnownGood(): Promise<StatusResult | null> {
  try {
    const cached = await caches.default.match(new Request(LAST_KNOWN_GOOD_CACHE_KEY));
    if (!cached) {
      return null;
    }
    const validated = validateCachedStatus(await cached.json());
    if (!validated) {
      logStatusWarning("status_worker_last_known_good_invalid");
    }
    return validated;
  } catch {
    logStatusWarning("status_worker_last_known_good_read_failed");
    return null;
  }
}

function cacheLastKnownGood(ctx: ExecutionContext, status: StatusResult) {
  const response = new Response(JSON.stringify(status), {
    headers: {
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });

  ctx.waitUntil(caches.default.put(new Request(LAST_KNOWN_GOOD_CACHE_KEY), response));
}

async function fallbackStatus(reason: string): Promise<StatusResult> {
  const cached = await readLastKnownGood();
  if (cached) {
    logStatusWarning("status_worker_served_last_known_good", { reason });
    return cached;
  }

  logStatusWarning("status_worker_served_static_operational", { reason });
  return DEFAULT_STATUS;
}

async function getStatus(env: Env, ctx: ExecutionContext): Promise<StatusResult> {
  let raw: unknown;
  try {
    raw = await env.STATUS_FLAG.get(STATUS_KEY, { type: "json" });
  } catch {
    logStatusWarning("status_worker_kv_read_failed");
    return fallbackStatus("kv_read_failed");
  }

  if (raw === null) {
    cacheLastKnownGood(ctx, DEFAULT_STATUS);
    return DEFAULT_STATUS;
  }

  const status = validateStatusFlag(raw);
  if (!status) {
    logStatusWarning("status_worker_invalid_status_flag");
    return fallbackStatus("invalid_status_flag");
  }

  cacheLastKnownGood(ctx, status);
  return status;
}

function clampMessage(message: string): string {
  if (message.length <= MAX_RENDERED_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_RENDERED_MESSAGE_LENGTH - 3)}...`;
}

function formatTimestamp(updatedAt: number): string {
  // Defense in depth: never let an out-of-range epoch throw out of renderHtml.
  if (!Number.isFinite(updatedAt) || updatedAt < 0 || updatedAt > MAX_VALID_DATE_MS) {
    return "";
  }
  const date = new Date(updatedAt);
  const utc = `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
  const et = `${date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} ET`;
  return `${utc} (${et})`;
}

function renderHtml(result: StatusResult): string {
  const operational = result.state === "up";
  const headline = operational ? "All systems operational" : "Cycloid is down";
  const accent = operational ? "#16a34a" : "#dc2626";
  const message = clampMessage(result.message.trim());
  const messageLine = message ? `<p class="message">${escapeHtml(message)}</p>` : "";
  const timestampLine =
    result.updatedAt === null ? "" : `<p class="ts">Updated ${escapeHtml(formatTimestamp(result.updatedAt))}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cycloid Status</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0b0d10; color: #e6e8eb; }
  main { width: 100%; max-width: 480px; padding: 32px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 24px; }
  .banner { padding: 20px 24px; border: 1px solid ${accent}; border-left-width: 4px; border-radius: 8px; font-size: 22px; font-weight: 600; color: ${accent}; }
  .message { margin: 20px 0 0; color: #c9d1d9; font-size: 15px; line-height: 1.5; }
  .ts { margin-top: 24px; color: #6e7681; font-size: 12px; }
</style>
</head>
<body>
<main>
<h1>Cycloid</h1>
<div class="banner">${headline}</div>
${messageLine}
${timestampLine}
</main>
</body>
</html>`;
}

function jsonStatus(status: StatusResult): Response {
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      [HTTP_HEADER_NAMES.CONTENT_TYPE]: "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: {
          ...BASE_HEADERS,
          [HTTP_HEADER_NAMES.ALLOW]: ALLOWED_METHODS,
          [HTTP_HEADER_NAMES.CONTENT_TYPE]: "text/plain; charset=utf-8",
        },
      });
    }

    if (url.pathname !== "/" && url.pathname !== "/api/status") {
      return new Response("Not found", {
        status: 404,
        headers: { ...BASE_HEADERS, [HTTP_HEADER_NAMES.CONTENT_TYPE]: "text/plain; charset=utf-8" },
      });
    }

    const status = await getStatus(env, ctx);
    if (url.pathname === "/api/status") {
      return request.method === "HEAD" ? new Response(null, jsonStatus(status)) : jsonStatus(status);
    }

    return new Response(request.method === "HEAD" ? null : renderHtml(status), {
      status: 200,
      headers: { ...BASE_HEADERS, [HTTP_HEADER_NAMES.CONTENT_TYPE]: "text/html; charset=utf-8" },
    });
  },
};
