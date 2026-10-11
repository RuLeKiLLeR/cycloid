/**
 * Sentry error tracking integration. All SDK access is lazy -- the heavy @sentry packages
 * are only imported when initSentry() is called. This prevents
 * test suites that transitively import api.ts from pulling in browser-only deps.
 */
import { ENVIRONMENT, normalizeEnvironment } from "../../../shared/constants/environment.js";
import { SENTRY_DSN } from "./constants/sentry";

type SentryHub = typeof import("@sentry/react");
type ViteEnv = Record<string, string | boolean | undefined>;

let sentry: SentryHub | null = null;
const pendingSentryOperations: Array<(nextSentry: SentryHub) => void> = [];

function envFlag(viteEnv: ViteEnv, key: string): string | boolean | undefined {
  return viteEnv[key] ?? (globalThis as unknown as { process?: { env?: ViteEnv } }).process?.env?.[key];
}

function envString(viteEnv: ViteEnv, key: string): string | undefined {
  const value = envFlag(viteEnv, key);
  return typeof value === "string" ? value : undefined;
}

function shouldInitSentry(viteEnv: ViteEnv): boolean {
  const dsn = envString(viteEnv, "VITE_SENTRY_DSN") || SENTRY_DSN;
  if (!dsn) return false;
  // Report only from production. Every other environment (qa, local, future
  // staging/preview) stays silent unless VITE_SENTRY_ENABLE_LOCAL opts it in
  // for local debugging. VITE_SENTRY_ENV is stamped at build time per deploy
  // workflow ("production" vs "qa").
  if (envString(viteEnv, "VITE_SENTRY_ENV") === ENVIRONMENT.Production) return true;
  return envFlag(viteEnv, "VITE_SENTRY_ENABLE_LOCAL") === "true";
}

function withSentry(operation: (nextSentry: SentryHub) => void) {
  if (sentry) {
    operation(sentry);
    return;
  }
  pendingSentryOperations.push(operation);
}

function flushPendingSentryOperations(nextSentry: SentryHub) {
  for (const operation of pendingSentryOperations.splice(0)) {
    try {
      operation(nextSentry);
    } catch (error) {
      console.error("[sentry] Failed to replay queued operation:", error);
    }
  }
}

export async function initSentry(): Promise<void> {
  const viteEnv = (import.meta as unknown as { env: ViteEnv }).env;
  const dsn = envString(viteEnv, "VITE_SENTRY_DSN") || SENTRY_DSN;
  if (!shouldInitSentry(viteEnv)) return;

  const Sentry = await import("@sentry/react");

  Sentry.init({
    dsn,
    environment: normalizeEnvironment(envString(viteEnv, "VITE_SENTRY_ENV"), ENVIRONMENT.Development),
    release: envString(viteEnv, "VITE_SENTRY_RELEASE"),
    integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
    tracesSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
  });

  sentry = Sentry;
  flushPendingSentryOperations(Sentry);
}

export function setSentryUser(user: { id: string | number; name?: string | null }) {
  withSentry((nextSentry) =>
    nextSentry.setUser({
      id: String(user.id),
      username: user.name ?? undefined,
    }),
  );
}

export function clearSentryUser() {
  withSentry((nextSentry) => nextSentry.setUser(null));
}

export function captureUiError(err: unknown, context?: Record<string, string>) {
  withSentry((nextSentry) => nextSentry.captureException(err, { tags: context }));
}
