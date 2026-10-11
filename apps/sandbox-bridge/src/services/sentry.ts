/**
 * Sentry error tracking for the sandbox-bridge process.
 * Events ship through the control-plane telemetry broker (Sentry's envelope
 * `tunnel`), which holds the real SENTRY_DSN and forwards to the ingest — the
 * platform DSN is no longer present in the sandbox. The SDK is given a
 * syntactically-valid placeholder DSN (it refuses to send without one) and the
 * tunnel carries the session token via the `?st=` param the broker validates.
 * No-ops if the broker is unreachable. Local dev requires SENTRY_ENABLE_LOCAL=true.
 * SDK is lazy-loaded to avoid startup cost when not configured.
 */

import type { ErrorEvent, NodeOptions } from "@sentry/node";

import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import { resolveTelemetryBrokerEndpoint } from "./telemetry-broker.js";

type SentryModule = typeof import("@sentry/node");

let Sentry: SentryModule | null = null;

/**
 * Placeholder DSN: the SDK disables sending without a parseable DSN and only
 * attaches the envelope `dsn` header when both `tunnel` and `dsn` are set. The
 * value is non-secret — the broker ignores it and forwards to the real ingest
 * derived from the worker-held SENTRY_DSN.
 */
const SENTRY_PLACEHOLDER_DSN = "https://placeholder@telemetry.cycloid.invalid/1";

/**
 * Reliable runtime-environment signal inside the sandbox. The control plane
 * stamps it from WORKER_ENV ("production" | "qa" | "local"); SENTRY_ENV and
 * WORKER_ENV are not passed through to the sandbox, so this is the source of
 * truth here.
 */
export function isProductionSentryContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARCANIST_RUNTIME_ENVIRONMENT === ENVIRONMENT.Production;
}

export function shouldInitSentry(env: NodeJS.ProcessEnv = process.env): boolean {
  // Reachable only when the telemetry broker is resolvable (control-plane URL +
  // session token); the platform DSN no longer gates this.
  if (!resolveTelemetryBrokerEndpoint(env)) return false;
  // Report only from production. Every other environment (qa, local) stays
  // silent unless SENTRY_ENABLE_LOCAL opts it in for local debugging.
  if (isProductionSentryContext(env)) return true;
  return env.SENTRY_ENABLE_LOCAL === "true";
}

export async function initSentry(): Promise<void> {
  const broker = resolveTelemetryBrokerEndpoint();
  if (!broker || !shouldInitSentry()) return;

  // Tunnel envelopes to the broker; `?st=` carries the session token the broker
  // validates (the SDK tunnel sends no Authorization header).
  const tunnel = `${broker.base}/sentry?st=${encodeURIComponent(broker.sandboxAuthToken)}`;

  const sentry = await import("@sentry/node");
  const options: NodeOptions = {
    dsn: SENTRY_PLACEHOLDER_DSN,
    tunnel,
    // ARCANIST_RUNTIME_ENVIRONMENT is the reliable in-sandbox signal; SENTRY_ENV
    // is never forwarded here. Tagging by runtime env keeps SENTRY_ENABLE_LOCAL
    // opt-in events (e.g. a qa sandbox) filterable instead of all landing under
    // environment: production.
    environment: normalizeEnvironment(process.env.ARCANIST_RUNTIME_ENVIRONMENT, ENVIRONMENT.Production),
    tracesSampleRate: 0,
    // No captureConsoleIntegration -- the bridge logger auto-captures to Sentry
    // at the structured level (with proper Error objects and context tags).
    beforeSend(event: ErrorEvent) {
      event.tags = {
        ...event.tags,
        sessionId: process.env.SESSION_ID,
        sandboxId: process.env.SANDBOX_ID,
      };
      return event;
    },
  };

  sentry.init(options);

  Sentry = sentry;
}

export function captureBridgeException(err: unknown, context?: Record<string, string>): void {
  if (!Sentry) return;
  Sentry.captureException(err, { tags: context });
}

export async function flushSentry(): Promise<void> {
  if (!Sentry) return;
  await Sentry.flush(2000);
}
