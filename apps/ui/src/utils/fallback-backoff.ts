import { FALLBACK_POLL_INITIAL_MS, FALLBACK_POLL_JITTER_RATIO, FALLBACK_POLL_MAX_MS } from "../constants";
import { additiveRatioBackoffMs } from "./backoff";

/**
 * Repeatedly invokes `tick` on an exponential backoff schedule
 * (FALLBACK_POLL_INITIAL_MS doubling up to FALLBACK_POLL_MAX_MS, each delay
 * stretched by up to FALLBACK_POLL_JITTER_RATIO of random jitter so clients
 * desynchronize instead of thundering-herding the API during WS outages).
 * FALLBACK_POLL_MAX_MS is a hard cap including jitter, so steady state
 * converges on exactly the resilience cadence.
 * Returns a cancel function. Restarting (a fresh call) resets to the
 * initial delay.
 */
export function startFallbackBackoff(tick: () => void): () => void {
  let delay = FALLBACK_POLL_INITIAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const schedule = () => {
    timer = setTimeout(
      () => {
        if (cancelled) return;
        tick();
        delay = Math.min(delay * 2, FALLBACK_POLL_MAX_MS);
        schedule();
      },
      additiveRatioBackoffMs({
        delayMs: delay,
        maxMs: FALLBACK_POLL_MAX_MS,
        jitterRatio: FALLBACK_POLL_JITTER_RATIO,
      }),
    );
  };
  schedule();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
