/**
 * Datadog RUM integration. All SDK access is lazy — the heavy @datadog packages
 * are only imported when initDatadog() is called. This prevents
 * test suites that transitively import api.ts from pulling in browser-only deps.
 */
import { ENVIRONMENT, normalizeEnvironment } from "../../../shared/constants/environment.js";
import {
  DD_APP_ID,
  DD_CLIENT_TOKEN,
  DD_DEFAULT_SITE,
  DD_REPLAY_SAMPLE_RATE,
  DD_SERVICE_NAME,
  DD_SESSION_SAMPLE_RATE,
} from "./constants/datadog";

type DatadogRum = typeof import("@datadog/browser-rum").datadogRum;

let rum: DatadogRum | null = null;
const pendingRumOperations: Array<(nextRum: DatadogRum) => void> = [];

function withRum(operation: (nextRum: DatadogRum) => void) {
  if (rum) {
    operation(rum);
    return;
  }
  pendingRumOperations.push(operation);
}

function flushPendingRumOperations(nextRum: DatadogRum) {
  for (const operation of pendingRumOperations.splice(0)) {
    try {
      operation(nextRum);
    } catch (error) {
      console.error("[datadog] Failed to replay queued operation:", error);
    }
  }
}

export async function initDatadog(): Promise<void> {
  // Idempotent: callers on multiple boot paths (authenticated-app post-paint,
  // signed-out / probe-failure prefetch telemetry) may both reach this. Second
  // call is a no-op so the RUM SDK is initialized exactly once per page load.
  if (rum) return;

  const viteEnv = (import.meta as unknown as { env: Record<string, string> }).env;
  const env = normalizeEnvironment(viteEnv.VITE_DD_ENV, ENVIRONMENT.Development);

  const [{ datadogRum }, { reactPlugin }] = await Promise.all([
    import("@datadog/browser-rum"),
    import("@datadog/browser-rum-react"),
  ]);

  datadogRum.init({
    applicationId: viteEnv.VITE_DD_RUM_APP_ID || DD_APP_ID,
    clientToken: viteEnv.VITE_DD_RUM_CLIENT_TOKEN || DD_CLIENT_TOKEN,
    site: viteEnv.VITE_DD_SITE || DD_DEFAULT_SITE,
    service: DD_SERVICE_NAME,
    env,
    sessionSampleRate: DD_SESSION_SAMPLE_RATE,
    sessionReplaySampleRate: DD_REPLAY_SAMPLE_RATE,
    defaultPrivacyLevel: "mask-user-input",
    trackResources: true,
    trackLongTasks: true,
    trackUserInteractions: true,
    allowedTracingUrls: [
      { match: "https://app.trycycloid.com", propagatorTypes: ["tracecontext"] },
      { match: /^http:\/\/localhost:3000/, propagatorTypes: ["tracecontext"] },
    ],
    plugins: [reactPlugin({ router: true })],
  });

  rum = datadogRum;
  flushPendingRumOperations(datadogRum);
}

/**
 * Set authenticated user context. Call after auth completes.
 */
export function setDatadogUser(user: { id: string | number; name?: string | null }) {
  withRum((nextRum) =>
    nextRum.setUser({
      id: String(user.id),
      name: user.name ?? undefined,
    }),
  );
}

/**
 * Set session context for cross-system correlation.
 */
export function setDatadogSessionContext(sessionId: string) {
  withRum((nextRum) => nextRum.setGlobalContext({ sessionId }));
}

/**
 * Clear session context when leaving session view.
 */
export function clearDatadogSessionContext() {
  withRum((nextRum) => nextRum.removeGlobalContextProperty("sessionId"));
}

/**
 * Custom actions at interaction boundaries.
 */
export function trackAction(name: string, context?: Record<string, unknown>) {
  withRum((nextRum) => nextRum.addAction(name, context));
}

/**
 * Record a custom RUM timing on the current view, measured from the view's
 * start. Because the React Router plugin opens a fresh RUM view on each session
 * navigation, a timing added when a session's content first paints yields the
 * session-open -> first-paint latency users actually feel.
 *
 * Pass `epochMs` (a `Date.now()` epoch timestamp) captured at paint time so the
 * timing is fixed to the actual paint moment, not whenever the lazily-imported
 * Datadog chunk resolves or RUM finishes initializing. The SDK treats a value
 * above ONE_YEAR as an epoch timestamp and stores `epochMs - viewStart`; a
 * `performance.now()`-style value would instead be used as-is and mis-attribute
 * the page-load->view-start gap into the timing.
 */
export function addSessionTiming(name: string, epochMs?: number) {
  withRum((nextRum) => nextRum.addTiming(name, epochMs));
}
