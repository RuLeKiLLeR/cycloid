import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_POLL_INITIAL_MS,
  FALLBACK_POLL_JITTER_RATIO,
  FALLBACK_POLL_MAX_MS,
} from "../../apps/ui/src/constants";
import { startFallbackBackoff } from "../../apps/ui/src/utils/fallback-backoff";

describe("startFallbackBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("doubles the delay each tick up to the max", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter
    const tick = vi.fn();
    const cancel = startFallbackBackoff(tick);

    const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    expect(FALLBACK_POLL_INITIAL_MS).toBe(expectedDelays[0]);
    expect(FALLBACK_POLL_MAX_MS).toBe(expectedDelays[expectedDelays.length - 1]);

    let ticks = 0;
    for (const delay of expectedDelays) {
      vi.advanceTimersByTime(delay - 1);
      expect(tick).toHaveBeenCalledTimes(ticks);
      vi.advanceTimersByTime(1);
      ticks += 1;
      expect(tick).toHaveBeenCalledTimes(ticks);
    }
    cancel();
  });

  it("applies bounded jitter on top of the base delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // max jitter
    const tick = vi.fn();
    const cancel = startFallbackBackoff(tick);

    const maxFirstDelay = FALLBACK_POLL_INITIAL_MS * (1 + FALLBACK_POLL_JITTER_RATIO);
    // Base delay alone must not fire (jitter pushed it later)...
    vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS);
    expect(tick).not.toHaveBeenCalled();
    // ...but the jitter ceiling is the hard upper bound.
    vi.advanceTimersByTime(maxFirstDelay - FALLBACK_POLL_INITIAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("caps the interval at FALLBACK_POLL_MAX_MS even with max jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // max jitter
    const tick = vi.fn();
    const cancel = startFallbackBackoff(tick);

    // Walk the schedule until the base delay has reached the cap.
    let delay = FALLBACK_POLL_INITIAL_MS;
    let ticks = 0;
    while (delay < FALLBACK_POLL_MAX_MS) {
      vi.advanceTimersByTime(Math.min(delay * (1 + FALLBACK_POLL_JITTER_RATIO), FALLBACK_POLL_MAX_MS));
      ticks += 1;
      expect(tick).toHaveBeenCalledTimes(ticks);
      delay = Math.min(delay * 2, FALLBACK_POLL_MAX_MS);
    }

    // At steady state the interval is exactly the cap, jitter included.
    vi.advanceTimersByTime(FALLBACK_POLL_MAX_MS - 1);
    expect(tick).toHaveBeenCalledTimes(ticks);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(ticks + 1);
    cancel();
  });

  it("stops ticking after cancel", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const tick = vi.fn();
    const cancel = startFallbackBackoff(tick);
    vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    cancel();
    vi.advanceTimersByTime(FALLBACK_POLL_MAX_MS * 4);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("restarting resets to the initial delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const tick = vi.fn();
    let cancel = startFallbackBackoff(tick);
    // three ticks, delay now at 8x initial
    vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS + FALLBACK_POLL_INITIAL_MS * 2 + FALLBACK_POLL_INITIAL_MS * 4);
    expect(tick).toHaveBeenCalledTimes(3);

    cancel();
    cancel = startFallbackBackoff(tick); // fresh start (e.g. new WS outage)
    vi.advanceTimersByTime(FALLBACK_POLL_INITIAL_MS);
    expect(tick).toHaveBeenCalledTimes(4);
    cancel();
  });
});
