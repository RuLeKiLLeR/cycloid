import * as Sentry from "@sentry/cloudflare";
import { DurableObject } from "cloudflare:workers";

import { resolveSentryRuntimeOptions } from "../observability/sentry";
import type { Env } from "../types";
import { jsonErrorResponse, jsonResponse, parseJsonBody } from "../utils";

type ResumeRateLimitCounter = {
  failureTimestampsMs: number[];
  lockedUntilMs?: number;
  expiresAt: number;
};

const COUNTER_STORAGE_KEY = "counter";

function toPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

class SessionResumeRateLimiterDOBase extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonErrorResponse("Method not allowed", 405);
    }

    const body = await parseJsonBody(request);
    const max = toPositiveInteger(body?.max);
    const windowSeconds = toPositiveInteger(body?.windowSeconds);
    const lockoutSeconds = body?.lockoutSeconds === undefined ? null : toPositiveInteger(body.lockoutSeconds);
    if (!max || !windowSeconds) {
      return jsonErrorResponse("Invalid rate limit request", 400);
    }

    const windowMs = windowSeconds * 1000;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const now = Date.now();
      const current = await txn.get<ResumeRateLimitCounter>(COUNTER_STORAGE_KEY);
      const lockedUntilMs = typeof current?.lockedUntilMs === "number" ? current.lockedUntilMs : 0;
      if (lockedUntilMs > now) {
        return { allowed: false, remaining: 0, expiresAt: lockedUntilMs };
      }

      const shouldResetAfterLockout = lockedUntilMs > 0 && lockedUntilMs <= now;
      const failureTimestampsMs =
        !shouldResetAfterLockout && Array.isArray(current?.failureTimestampsMs)
          ? current.failureTimestampsMs.filter(
              (timestampMs) => typeof timestampMs === "number" && now - timestampMs < windowMs,
            )
          : [];
      if (!lockoutSeconds && failureTimestampsMs.length >= max) {
        const expiresAt = failureTimestampsMs[0] + windowMs;
        await txn.put(COUNTER_STORAGE_KEY, { failureTimestampsMs, expiresAt });
        return { allowed: false, remaining: 0, expiresAt };
      }

      failureTimestampsMs.push(now);
      const shouldLock = failureTimestampsMs.length >= max && lockoutSeconds;
      const expiresAt = shouldLock ? now + lockoutSeconds * 1000 : now + windowMs;
      await txn.put(COUNTER_STORAGE_KEY, {
        failureTimestampsMs,
        ...(shouldLock ? { lockedUntilMs: expiresAt } : {}),
        expiresAt,
      });
      return { allowed: true, remaining: Math.max(max - failureTimestampsMs.length, 0), expiresAt };
    });
    await this.ctx.storage.setAlarm(result.expiresAt);

    const retryAfterSeconds = Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000));
    return jsonResponse({
      ok: true,
      allowed: result.allowed,
      remaining: result.remaining,
      resetAtMs: result.expiresAt,
      retryAfterSeconds,
      max,
      windowSeconds,
    });
  }

  async alarm(): Promise<void> {
    const current = await this.ctx.storage.get<ResumeRateLimitCounter>(COUNTER_STORAGE_KEY);
    const expiresAt = typeof current?.expiresAt === "number" ? current.expiresAt : 0;
    if (expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }

    await this.ctx.storage.delete(COUNTER_STORAGE_KEY);
  }
}

const sentryConfig = (env: Env) => ({
  ...resolveSentryRuntimeOptions(env), // supplies dsn, enabled, environment
  release: env.SENTRY_RELEASE,
  tracesSampleRate: 0,
});

export const SessionResumeRateLimiterDO = Sentry.instrumentDurableObjectWithSentry(
  sentryConfig,
  SessionResumeRateLimiterDOBase,
);
