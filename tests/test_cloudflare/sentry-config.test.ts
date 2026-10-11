import type { ErrorEvent } from "@sentry/cloudflare";
import { describe, expect, it } from "vitest";

import {
  applySentryCorrelationTags,
  resolveSentryRuntimeOptions,
  sentryCorrelationTagsFromContext,
  transientUpstreamReadFingerprint,
} from "../../apps/control-plane-worker/src/observability/sentry";

// resolveSentryRuntimeOptions always sets beforeSend; the Sentry type marks it
// optional, so assert and call with the (event, hint) arity the type requires.
function runBeforeSend(options: ReturnType<typeof resolveSentryRuntimeOptions>, event: ErrorEvent) {
  return options.beforeSend!(event, {});
}

function errorEvent(value: string): ErrorEvent {
  return {
    exception: {
      values: [{ value }],
    },
  };
}

describe("Sentry config", () => {
  it("sends errors from production", () => {
    const event: ErrorEvent = { event_id: "event" };
    const options = resolveSentryRuntimeOptions({
      SENTRY_DSN: "https://example@sentry.test/1",
      WORKER_ENV: "production",
    });
    expect(options.enabled).toBe(true);
    expect(runBeforeSend(options, event)).toBe(event);
  });

  it("does not send from non-production environments", () => {
    for (const WORKER_ENV of ["qa", "local", "staging", undefined]) {
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        WORKER_ENV,
      });
      expect(options.enabled).toBe(false);
      expect(runBeforeSend(options, { event_id: "event" })).toBeNull();
    }
  });

  it("requires a DSN even in production", () => {
    expect(resolveSentryRuntimeOptions({ WORKER_ENV: "production" }).enabled).toBe(false);
  });

  it("allows explicit local Sentry opt-in", () => {
    const event: ErrorEvent = { event_id: "event" };
    const options = resolveSentryRuntimeOptions({
      SENTRY_DSN: "https://example@sentry.test/1",
      SENTRY_ENABLE_LOCAL: "true",
      WORKER_ENV: "local",
    });
    expect(runBeforeSend(options, event)).toBe(event);
  });

  describe("environment tag", () => {
    it("tags production when WORKER_ENV is production", () => {
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        WORKER_ENV: "production",
      });
      expect(options.environment).toBe("production");
    });

    // Regression guard for CYCLOID-98: a local opt-in run with WORKER_ENV
    // unset reported AND was tagged `production`, tripping a prod alert. The tag
    // must follow the gate, not default to prod.
    it("does not tag a local opt-in run as production when WORKER_ENV is unset", () => {
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        SENTRY_ENABLE_LOCAL: "true",
        WORKER_ENV: undefined,
      });
      expect(options.enabled).toBe(true);
      expect(options.environment).toBe("local");
    });

    it("preserves a known non-prod environment under local opt-in", () => {
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        SENTRY_ENABLE_LOCAL: "true",
        WORKER_ENV: "qa",
      });
      expect(options.environment).toBe("qa");
    });

    it("falls back to local for unknown WORKER_ENV values", () => {
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        WORKER_ENV: "staging",
      });
      expect(options.environment).toBe("local");
    });
  });

  describe("transient upstream read fingerprint", () => {
    it.each(["GitHub PR review comments fetch failed (522): error code: 522", "GitHub check-runs lookup failed (503)"])(
      "groups transient GitHub read-path upstream failures: %s",
      (value) => {
        expect(transientUpstreamReadFingerprint(errorEvent(value))).toEqual(["github-upstream-read-5xx"]);
      },
    );

    it.each([
      "GitHub PR creation failed (503): error code: 503",
      "Warm probe failed with status 522",
      "Upstream request failed (522): error code: 522",
      "GitHub PR review comments lookup failed (404): Not Found",
      "GitHub PR review comments fetch failed (422): Validation failed",
    ])("does not group non-read or non-transient failures: %s", (value) => {
      expect(transientUpstreamReadFingerprint(errorEvent(value))).toBeNull();
    });

    it("does not inspect the top-level Sentry message", () => {
      expect(
        transientUpstreamReadFingerprint({
          message: "GitHub PR review comments fetch failed (522): error code: 522",
        }),
      ).toBeNull();
    });

    it("does not group events with no exception value", () => {
      expect(transientUpstreamReadFingerprint({ exception: { values: [{}] } })).toBeNull();
      expect(transientUpstreamReadFingerprint({})).toBeNull();
    });

    it("keeps the disabled beforeSend gate ahead of fingerprinting", () => {
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        WORKER_ENV: "qa",
      });
      expect(
        runBeforeSend(options, errorEvent("GitHub PR review comments fetch failed (522): error code: 522")),
      ).toBeNull();
    });

    it("sets the fingerprint on the same enabled event object", () => {
      const event = errorEvent("GitHub PR review comments fetch failed (522): error code: 522");
      const options = resolveSentryRuntimeOptions({
        SENTRY_DSN: "https://example@sentry.test/1",
        WORKER_ENV: "production",
      });

      expect(runBeforeSend(options, event)).toBe(event);
      expect(event.fingerprint).toEqual(["github-upstream-read-5xx"]);
    });
  });

  describe("correlation tags", () => {
    it("derives correlation tags from the current worker span context", () => {
      expect(
        sentryCorrelationTagsFromContext({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          parentSpanId: "c".repeat(16),
          isExporterContext: false,
          attributes: {
            "request.id": "req-1",
            "session.id": "sess-1",
            "prompt.id": "prompt-1",
            "sandbox.id": "sb-1",
          },
        }),
      ).toEqual({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        parentSpanId: "c".repeat(16),
        requestId: "req-1",
        sessionId: "sess-1",
        promptId: "prompt-1",
        sandboxId: "sb-1",
      });
    });

    it("merges correlation tags into enabled events without dropping existing tags", () => {
      const event: ErrorEvent = { event_id: "event", tags: { operation: "publish" } };

      expect(
        applySentryCorrelationTags(event, {
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          parentSpanId: null,
          isExporterContext: false,
          attributes: {
            "request.id": "req-1",
            "session.id": "sess-1",
            "prompt.id": "prompt-1",
          },
        }),
      ).toBe(event);
      expect(event.tags).toEqual({
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        requestId: "req-1",
        sessionId: "sess-1",
        promptId: "prompt-1",
        operation: "publish",
      });
    });
  });
});
