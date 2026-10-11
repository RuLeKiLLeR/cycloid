/**
 * Operator-only Datadog Logs deep-link builder.
 *
 * Bridge logs are tagged with `sessionId`, which the DD Logs shipper renames to the `session_id`
 * attribute (see services/dd-logs.ts FIELD_MAP), so the Logs Explorer query uses `@session_id:`.
 * The returned URL is for operators on Cycloid's Datadog (us5) only — never put it in a
 * customer-facing PR. Pure helper: all environment/time inputs are passed in.
 */
import { DD_DEFAULT_SITE, OTEL_SERVICE_NAME } from "../constants/observability.js";

/** Default lookback for the deep-link window so the link lands on the failure, not a 15-min default. */
const DEFAULT_LOOKBACK_MS = 15 * 60_000;
const DEFAULT_LOOKAHEAD_MS = 5 * 60_000;

export type DatadogLogsUrlParams = {
  /** Correlation session id the bridge tags every log line with. */
  sessionId: string;
  /** Whether Datadog log shipping is actually enabled (DD_API_KEY present). */
  enabled: boolean;
  /** Datadog site host, e.g. `us5.datadoghq.com`. Defaults to the us5 constant. */
  ddSite?: string;
  /** Runtime environment tag (`env:`), e.g. `production`. */
  env?: string;
  /** Optional event marker to scope the query (`@event:`). */
  event?: string;
  /** Window start (epoch ms). Defaults to `nowMs - 15m`. */
  fromMs?: number;
  /** Window end (epoch ms). Defaults to `nowMs + 5m`. */
  toMs?: number;
  /** Current time (epoch ms), used to derive the default window. */
  nowMs?: number;
};

/**
 * Build a Datadog Logs Explorer URL scoped to a session, or `undefined` when no useful link can be
 * made — specifically when shipping is disabled (logs only hit the local archive, so a Datadog link
 * would 404) or no session id is available. Callers fall back to the Cycloid session URL.
 */
export function buildDatadogLogsUrl(params: DatadogLogsUrlParams): string | undefined {
  const sessionId = params.sessionId.trim();
  if (!params.enabled || !sessionId) return undefined;

  const site = (params.ddSite?.trim() || DD_DEFAULT_SITE).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const env = params.env?.trim();

  // Datadog facet values containing hyphens (e.g. UUID session ids, `cycloid-sandbox-bridge`),
  // spaces, or operator characters must be double-quoted or the Explorer splits/mis-parses them.
  const queryParts = [`@session_id:${quoteFacetValue(sessionId)}`, `service:${quoteFacetValue(OTEL_SERVICE_NAME)}`];
  if (env) queryParts.push(`env:${quoteFacetValue(env)}`);
  if (params.event?.trim()) queryParts.push(`@event:${quoteFacetValue(params.event.trim())}`);

  const now = typeof params.nowMs === "number" ? params.nowMs : undefined;
  const fromMs =
    typeof params.fromMs === "number" ? params.fromMs : now !== undefined ? now - DEFAULT_LOOKBACK_MS : undefined;
  const toMs =
    typeof params.toMs === "number" ? params.toMs : now !== undefined ? now + DEFAULT_LOOKAHEAD_MS : undefined;

  const search = new URLSearchParams({ query: queryParts.join(" ") });
  if (typeof fromMs === "number") search.set("from_ts", String(Math.round(fromMs)));
  if (typeof toMs === "number") search.set("to_ts", String(Math.round(toMs)));

  return `https://${site}/logs?${search.toString()}`;
}

/** Double-quote a Datadog facet value, escaping embedded quotes/backslashes, so special characters do not break the query. */
function quoteFacetValue(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}
