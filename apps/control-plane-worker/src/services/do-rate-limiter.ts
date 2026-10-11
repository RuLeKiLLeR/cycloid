import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger({ bindings: { component: "do-rate-limiter" } });

const LIMITER_CHECK_URL = "https://internal/rate-limiter/check";

export type DurableObjectRateLimitOptions = {
  max: number;
  windowSeconds: number;
  lockoutSeconds?: number;
};

type RateLimitResponse = {
  ok: true;
  allowed: boolean;
  remaining: number;
  resetAtMs?: number;
  retryAfterSeconds?: number;
  max?: number;
  windowSeconds?: number;
};

export type DurableObjectRateLimitResult = {
  limited: boolean;
  remaining: number | null;
  resetAtMs: number | null;
  retryAfterSeconds: number | null;
  max: number;
  windowSeconds: number;
};

type FailOpenReason = "backend_unavailable" | "non_2xx" | "invalid_body" | "missing_binding";

/**
 * Emit a first-class structured signal on every fail-open path so a future
 * log-derived metric can group on `event` + `reason` + `keyPrefix`. Worker
 * metrics in this repo are log-derived, hence the stable structured shape.
 */
function logFailOpen(key: string, reason: FailOpenReason): void {
  const keyPrefix = key.split(":")[0];
  log.warn({ event: "rate_limiter.fail_open", keyPrefix, reason }, "Rate limit backend unavailable; allowing request");
}

function isRateLimitResponse(value: unknown): value is RateLimitResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { allowed?: unknown }).allowed === "boolean" &&
    typeof (value as { remaining?: unknown }).remaining === "number"
  );
}

/**
 * Atomic sliding-window rate limit check backed by SessionResumeRateLimiterDO.
 * Each distinct key gets its own single-writer Durable Object, so concurrent
 * Worker isolates cannot overshoot the cap. Fails open (with a warning) if the
 * limiter backend is unavailable.
 */
export async function checkDurableObjectRateLimit(
  env: Pick<Env, "SESSION_RESUME_RATE_LIMITER">,
  key: string,
  options: DurableObjectRateLimitOptions,
): Promise<DurableObjectRateLimitResult> {
  if (!env.SESSION_RESUME_RATE_LIMITER) {
    logFailOpen(key, "missing_binding");
    return {
      limited: false,
      remaining: null,
      resetAtMs: null,
      retryAfterSeconds: null,
      max: options.max,
      windowSeconds: options.windowSeconds,
    };
  }

  try {
    const limiterId = env.SESSION_RESUME_RATE_LIMITER.idFromName(key);
    const response = await env.SESSION_RESUME_RATE_LIMITER.get(limiterId).fetch(LIMITER_CHECK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      logFailOpen(key, "non_2xx");
      return {
        limited: false,
        remaining: null,
        resetAtMs: null,
        retryAfterSeconds: null,
        max: options.max,
        windowSeconds: options.windowSeconds,
      };
    }

    const body = await response.json();
    if (!isRateLimitResponse(body)) {
      logFailOpen(key, "invalid_body");
      return {
        limited: false,
        remaining: null,
        resetAtMs: null,
        retryAfterSeconds: null,
        max: options.max,
        windowSeconds: options.windowSeconds,
      };
    }

    return {
      limited: !body.allowed,
      remaining: body.remaining,
      resetAtMs: typeof body.resetAtMs === "number" ? body.resetAtMs : null,
      retryAfterSeconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : null,
      max: typeof body.max === "number" ? body.max : options.max,
      windowSeconds: typeof body.windowSeconds === "number" ? body.windowSeconds : options.windowSeconds,
    };
  } catch {
    // Fail open by design: this limiter is a soft guardrail, not a security
    // boundary, so a Durable Object storage fault here must never block a
    // request. The fault is not fatal, so do NOT Sentry.captureException it - a
    // regional DO/D1 wobble would otherwise fill Sentry with this fail-open
    // frame and misattribute the incident to the limiter. Visibility is
    // preserved by the structured `rate_limiter.fail_open` log below, which the
    // arcanist.rate_limiter.fail_open log-derived metric groups on.
    logFailOpen(key, "backend_unavailable");
    return {
      limited: false,
      remaining: null,
      resetAtMs: null,
      retryAfterSeconds: null,
      max: options.max,
      windowSeconds: options.windowSeconds,
    };
  }
}
