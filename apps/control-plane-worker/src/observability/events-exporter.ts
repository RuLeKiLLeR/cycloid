import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { traceLogFields } from "../../../../shared/observability/logger.js";
import { CONTROL_PLANE_SERVICE_NAME, DD_DEFAULT_SITE, DD_HOSTNAME, DD_SOURCE } from "../constants/observability";
import type { Env } from "../types";
import { currentContext } from "./context";

const DATADOG_BODY_PREVIEW_LIMIT = 1000;
const DATADOG_ERROR_PREVIEW_LIMIT = 1000;

export interface ExportEndpointMetadata {
  host: string;
  path: string;
}

export interface DatadogLogsPostResult {
  ok: boolean;
  endpoint: ExportEndpointMetadata;
  itemCount: number;
  status?: number;
  statusText?: string;
  bodyPreview?: string;
  error?: string;
  skipped?: "missing_dd_api_key";
}

export function endpointMetadata(url: string): ExportEndpointMetadata {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.host,
      path: parsed.pathname,
    };
  } catch {
    return {
      host: "invalid_url",
      path: "",
    };
  }
}

function previewText(value: unknown, maxChars: number): string {
  const text = String(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

export function redactDiagnosticText(value: unknown, redactions: Array<string | undefined>, maxChars: number): string {
  let text = String(value);
  for (const redaction of redactions) {
    if (redaction) {
      text = text.split(redaction).join("[redacted]");
    }
  }
  return previewText(text, maxChars);
}

export async function responseBodyPreview(
  response: Response,
  redactions: Array<string | undefined>,
): Promise<string | undefined> {
  try {
    const body = await response.text();
    return redactDiagnosticText(body, redactions, DATADOG_BODY_PREVIEW_LIMIT);
  } catch (err) {
    return redactDiagnosticText(
      `failed to read response body: ${String(err)}`,
      redactions,
      DATADOG_ERROR_PREVIEW_LIMIT,
    );
  }
}

function buildControlPlaneTags(env: Pick<Env, "WORKER_ENV">): string {
  const workerEnv = normalizeEnvironment(env.WORKER_ENV, ENVIRONMENT.Production);
  return [`env:${workerEnv}`, "worker:control-plane", `script:cycloid-control-plane-${workerEnv}`].join(",");
}

export async function postDatadogLogs(
  env: Pick<Env, "DD_API_KEY">,
  entries: Record<string, unknown>[],
): Promise<DatadogLogsPostResult> {
  const ddApiKey = env.DD_API_KEY;
  const url = `https://http-intake.logs.${DD_DEFAULT_SITE}/api/v2/logs`;
  const endpoint = endpointMetadata(url);

  if (!ddApiKey) {
    return {
      ok: false,
      endpoint,
      itemCount: entries.length,
      skipped: "missing_dd_api_key",
    };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": ddApiKey,
      },
      body: JSON.stringify(entries),
    });

    const ok = response.ok;
    return {
      ok,
      endpoint,
      itemCount: entries.length,
      status: response.status,
      statusText: response.statusText,
      ...(ok ? {} : { bodyPreview: await responseBodyPreview(response, [ddApiKey]) }),
    };
  } catch (err) {
    return {
      ok: false,
      endpoint,
      itemCount: entries.length,
      error: redactDiagnosticText(err, [ddApiKey, url], DATADOG_ERROR_PREVIEW_LIMIT),
    };
  }
}

/**
 * Returns whether the event was accepted (or there was nothing to post). A
 * `false` return means the POST was rejected and the caller may retry; callers
 * that gate a once-only marker on the result must not cache on `false`.
 */
export async function postStructuredEventToDd(
  env: Pick<Env, "DD_API_KEY" | "WORKER_ENV">,
  event: Record<string, unknown>,
): Promise<boolean> {
  const ddApiKey = env.DD_API_KEY;
  if (!ddApiKey) return true;

  const ctx = currentContext();
  const traceCorrelation = ctx && !ctx.isExporterContext ? traceLogFields(ctx) : {};

  const payload = {
    ddsource: DD_SOURCE,
    ddtags: buildControlPlaneTags(env),
    hostname: DD_HOSTNAME,
    service: CONTROL_PLANE_SERVICE_NAME,
    ...traceCorrelation,
    _direct_post: true,
    ...event,
    message: JSON.stringify(event),
  };

  const response = await postDatadogLogs(env, [payload]);

  if (response.skipped === "missing_dd_api_key") return true;
  if (!response.ok) {
    console.warn(
      "[events-exporter] direct-POST failed:",
      response.error ?? `${response.status} ${response.statusText}`,
    );
    return false;
  }
  return true;
}
