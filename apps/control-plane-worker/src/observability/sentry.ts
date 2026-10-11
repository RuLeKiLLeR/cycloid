import type { CloudflareOptions, ErrorEvent } from "@sentry/cloudflare";

import { ENVIRONMENT, normalizeEnvironment } from "../../../../shared/constants/environment.js";
import type { Env } from "../types";
import { currentContext } from "./context";

type SentryEnv = Pick<Env, "SENTRY_DSN" | "SENTRY_ENABLE_LOCAL" | "WORKER_ENV">;
type SentryCorrelationContext =
  | {
      traceId: string;
      spanId: string;
      parentSpanId: string | null;
      isExporterContext?: boolean;
      attributes: Record<string, unknown>;
    }
  | undefined;

// Mute-coupled: changing this string creates a new, unmuted Sentry issue that
// can page again. Re-mute the new group before changing it.
const TRANSIENT_UPSTREAM_READ_FINGERPRINT = Object.freeze(["github-upstream-read-5xx"]);
const TRANSIENT_UPSTREAM_READ_MESSAGE = /GitHub .+ (?:lookup|fetch) failed \((?:502|503|522|524)\)/;

/**
 * Single source of truth for "should this worker emit Sentry events". Used both
 * for the worker's own SDK options and to gate the sandbox telemetry broker, so
 * non-prod sandboxes fail closed even if an older bridge keeps tunneling.
 */
export function shouldReportToSentry(env: Partial<SentryEnv>): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  // Report only from production. Every other environment (qa, local, future
  // staging/preview) stays silent unless SENTRY_ENABLE_LOCAL opts it in for
  // local debugging.
  if (env.WORKER_ENV === ENVIRONMENT.Production) return true;
  return env.SENTRY_ENABLE_LOCAL === "true";
}

/**
 * The Sentry `environment` tag. Co-located with `shouldReportToSentry` so the
 * tag and the reporting gate can never disagree: a local-opt-in run
 * (`SENTRY_ENABLE_LOCAL=true`) with `WORKER_ENV` unset must NOT report as
 * `production`. The fallback is `Local`, not `Production` -- real prod always
 * sets `WORKER_ENV=production` explicitly (wrangler.toml), so an unset/unknown
 * value is never genuinely prod.
 */
function resolveSentryEnvironment(env: Pick<SentryEnv, "WORKER_ENV">): string {
  return normalizeEnvironment(env.WORKER_ENV, ENVIRONMENT.Local);
}

function setSentryTag(tags: Record<string, string>, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    tags[key] = value;
  }
}

export function sentryCorrelationTagsFromContext(
  ctx: SentryCorrelationContext = currentContext(),
): Record<string, string> {
  if (!ctx || ctx.isExporterContext) return {};

  const tags: Record<string, string> = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
  };
  if (ctx.parentSpanId) {
    tags.parentSpanId = ctx.parentSpanId;
  }

  setSentryTag(tags, "requestId", ctx.attributes["request.id"]);
  setSentryTag(tags, "sessionId", ctx.attributes["session.id"]);
  setSentryTag(tags, "promptId", ctx.attributes["prompt.id"]);
  setSentryTag(tags, "sandboxId", ctx.attributes["sandbox.id"]);
  return tags;
}

export function applySentryCorrelationTags(
  event: ErrorEvent,
  ctx: SentryCorrelationContext = currentContext(),
): ErrorEvent {
  const tags = sentryCorrelationTagsFromContext(ctx);
  if (Object.keys(tags).length > 0) {
    event.tags = { ...tags, ...(event.tags ?? {}) };
  }
  return event;
}

export function transientUpstreamReadFingerprint(event: ErrorEvent): string[] | null {
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === "string" && TRANSIENT_UPSTREAM_READ_MESSAGE.test(exception.value)) {
      return [...TRANSIENT_UPSTREAM_READ_FINGERPRINT];
    }
  }
  return null;
}

export function resolveSentryRuntimeOptions(env: SentryEnv): CloudflareOptions {
  const enabled = shouldReportToSentry(env);
  return {
    dsn: enabled ? env.SENTRY_DSN?.trim() : undefined,
    enabled,
    environment: resolveSentryEnvironment(env),
    beforeSend: (event) => {
      if (!enabled) return null;
      const fingerprint = transientUpstreamReadFingerprint(event);
      if (fingerprint) {
        event.fingerprint = fingerprint;
      }
      return applySentryCorrelationTags(event);
    },
  };
}
