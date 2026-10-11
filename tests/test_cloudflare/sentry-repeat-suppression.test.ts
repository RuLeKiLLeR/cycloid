/**
 * Tests for the in-memory Sentry repeat-suppression gate. First occurrence of
 * a (scope, error) pair reports immediately; repeats within the window are
 * counted silently; the first repeat after the window re-reports with the
 * suppressed count.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/cloudflare", () => ({
  captureException,
}));

import {
  captureRepeatedException,
  resetSentryRepeatSuppression,
  SENTRY_SUPPRESSION_WINDOW_MS,
} from "../../apps/control-plane-worker/src/observability/sentry-repeat-suppression";

const BASE_TS = 1_750_000_000_000;

describe("captureRepeatedException", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSentryRepeatSuppression();
  });

  it("reports the first occurrence with the caller's tags and extra", () => {
    const err = new Error("Warm probe failed with status 522");
    const reported = captureRepeatedException("Fetch-path warm probe failed", err, {
      tags: { component: "scheduler" },
      extra: { failureMessage: "Fetch-path warm probe failed" },
      now: () => BASE_TS,
    });

    expect(reported).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(err, {
      tags: { component: "scheduler" },
      extra: { failureMessage: "Fetch-path warm probe failed" },
    });
  });

  it("suppresses repeats of the same scope and error within the window", () => {
    const err = new Error("Warm probe failed with status 522");
    let ts = BASE_TS;
    const now = () => ts;

    expect(captureRepeatedException("warm probe", err, { now })).toBe(true);
    for (let tick = 1; tick <= 11; tick++) {
      ts = BASE_TS + tick * 5 * 60 * 1000; // every 5 minutes, still inside 1h
      expect(captureRepeatedException("warm probe", err, { now })).toBe(false);
    }
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("re-reports after the window with the suppressed count and resets the counter", () => {
    const err = new Error("Warm probe failed with status 522");
    let ts = BASE_TS;
    const now = () => ts;

    captureRepeatedException("warm probe", err, {
      tags: { component: "scheduler" },
      extra: { failureMessage: "warm probe" },
      now,
    });
    for (let tick = 1; tick <= 3; tick++) {
      ts = BASE_TS + tick * 1000;
      captureRepeatedException("warm probe", err, {
        tags: { component: "scheduler" },
        extra: { failureMessage: "warm probe" },
        now,
      });
    }

    ts = BASE_TS + SENTRY_SUPPRESSION_WINDOW_MS;
    expect(
      captureRepeatedException("warm probe", err, {
        tags: { component: "scheduler" },
        extra: { failureMessage: "warm probe" },
        now,
      }),
    ).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(2);
    // Re-report preserves caller tags/extra and adds the suppression stats.
    expect(captureException).toHaveBeenLastCalledWith(err, {
      tags: { component: "scheduler" },
      extra: {
        failureMessage: "warm probe",
        suppressedSinceLastReport: 3,
        firstSeenAt: BASE_TS,
      },
    });

    // Counter reset: the next post-window re-report counts only new repeats.
    ts = BASE_TS + SENTRY_SUPPRESSION_WINDOW_MS + 1000;
    captureRepeatedException("warm probe", err, { now });
    ts = BASE_TS + 2 * SENTRY_SUPPRESSION_WINDOW_MS;
    captureRepeatedException("warm probe", err, { now });
    expect(captureException).toHaveBeenCalledTimes(3);
    expect(captureException.mock.lastCall?.[1]).toMatchObject({
      extra: { suppressedSinceLastReport: 1, firstSeenAt: BASE_TS },
    });
  });

  it("treats a recurrence after a quiet window as a fresh episode without suppression stats", () => {
    const err = new Error("Warm probe failed with status 522");
    let ts = BASE_TS;
    const now = () => ts;

    captureRepeatedException("warm probe", err, { tags: { component: "scheduler" }, now });

    // Quiet for a full window with nothing suppressed, then one recurrence:
    // reported as a fresh occurrence, not a re-report with a zero count.
    ts = BASE_TS + SENTRY_SUPPRESSION_WINDOW_MS + 1;
    const episodeStart = ts;
    expect(captureRepeatedException("warm probe", err, { tags: { component: "scheduler" }, now })).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenLastCalledWith(err, { tags: { component: "scheduler" } });

    // The fresh episode restarts the clock: a later re-report anchors
    // firstSeenAt at the recurrence, not the original first sighting.
    ts = episodeStart + 1000;
    expect(captureRepeatedException("warm probe", err, { now })).toBe(false);
    ts = episodeStart + SENTRY_SUPPRESSION_WINDOW_MS;
    expect(captureRepeatedException("warm probe", err, { now })).toBe(true);
    expect(captureException.mock.lastCall?.[1]).toMatchObject({
      extra: { suppressedSinceLastReport: 1, firstSeenAt: episodeStart },
    });
  });

  it("tracks different scopes independently", () => {
    const err = new Error("D1_ERROR: no such table");
    const now = () => BASE_TS;

    expect(captureRepeatedException("task A", err, { now })).toBe(true);
    expect(captureRepeatedException("task B", err, { now })).toBe(true);
    expect(captureRepeatedException("task A", err, { now })).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("tracks different error messages independently", () => {
    const now = () => BASE_TS;

    expect(captureRepeatedException("task A", new Error("first failure"), { now })).toBe(true);
    expect(captureRepeatedException("task A", new Error("second failure"), { now })).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("keys errors by stable code/status over volatile message details", () => {
    const now = () => BASE_TS;
    const makeErr = (message: string, code: string, status?: number) => {
      const err = new Error(message) as Error & { code: string; status?: number };
      err.name = "E2BSandboxRuntimeError";
      err.code = code;
      if (status !== undefined) err.status = status;
      return err;
    };

    // Same classification, different volatile message tails: one key.
    expect(
      captureRepeatedException("e2b", makeErr("Unauthorized (sandbox sb-111)", "unauthorized", 401), { now }),
    ).toBe(true);
    expect(
      captureRepeatedException("e2b", makeErr("Unauthorized (sandbox sb-222)", "unauthorized", 401), { now }),
    ).toBe(false);
    // Distinct stable code: independent key.
    expect(
      captureRepeatedException("e2b", makeErr("Unauthorized (sandbox sb-333)", "rate_limited", 429), { now }),
    ).toBe(true);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("suppresses repeated non-Error values by their string form", () => {
    const now = () => BASE_TS;

    expect(captureRepeatedException("task A", "string failure", { now })).toBe(true);
    expect(captureRepeatedException("task A", "string failure", { now })).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("evicts the oldest-inserted key when the map is full", () => {
    const now = () => BASE_TS;

    captureRepeatedException("scope", new Error("error 0"), { now });
    expect(captureRepeatedException("scope", new Error("error 0"), { now })).toBe(false);

    // Fill the map past the 200-entry cap; "error 0" is evicted first.
    for (let i = 1; i <= 200; i++) {
      captureRepeatedException("scope", new Error(`error ${i}`), { now });
    }

    // Evicted key reports again as a first occurrence (no suppression stats).
    expect(captureRepeatedException("scope", new Error("error 0"), { now })).toBe(true);
    expect(captureException.mock.lastCall?.[1]).toEqual({ tags: undefined });
  });
});
