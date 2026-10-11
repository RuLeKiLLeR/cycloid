/**
 * Shared resolver for the control-plane telemetry broker. The bridge ships
 * Datadog logs and Sentry envelopes to session-scoped control-plane routes that
 * inject the platform secret server-side, so the platform telemetry credentials
 * never enter the sandbox. Braintrust reaches the same base via the SDK's
 * `BRAINTRUST_API_URL`/`BRAINTRUST_APP_URL` (injected by the control plane).
 */

export type TelemetryBrokerEndpoint = {
  /** Base URL: `${CONTROL_PLANE_URL}/api/sessions/${SESSION_ID}/sandbox/telemetry`. */
  base: string;
  /** Session-scoped bearer for dd-logs and the Sentry `?st=` tunnel param. */
  sandboxAuthToken: string;
};

export const DD_LOGS_BROKER_READY_ENV = "ARCANIST_DD_LOGS_BROKER_READY";

/**
 * Resolve the broker endpoint from env, or null when it is unreachable
 * (missing control-plane URL, session id, or session token — e.g. local dev
 * with no control plane). Callers no-op telemetry shipping when null.
 */
export function resolveTelemetryBrokerEndpoint(env: NodeJS.ProcessEnv = process.env): TelemetryBrokerEndpoint | null {
  const controlPlaneUrl = env.CONTROL_PLANE_URL;
  const sessionId = env.SESSION_ID;
  const sandboxAuthToken = env.SANDBOX_AUTH_TOKEN;
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) return null;
  const trimmed = controlPlaneUrl.replace(/\/+$/, "");
  return {
    base: `${trimmed}/api/sessions/${encodeURIComponent(sessionId)}/sandbox/telemetry`,
    sandboxAuthToken,
  };
}

/**
 * Honest DD log readiness after platform credentials moved server-side. The
 * bridge can prove its endpoint/token locally, while the control plane injects
 * this non-secret flag only when its worker-held DD_API_KEY is configured.
 */
export function isDdLogsBrokerReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DD_LOGS_BROKER_READY_ENV] === "1" && resolveTelemetryBrokerEndpoint(env) !== null;
}
