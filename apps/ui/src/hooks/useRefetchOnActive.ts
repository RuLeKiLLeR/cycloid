import { useRef } from "react";

import { useSyncEffect } from "./useEffects";

// A tab switch fires `focus` and `visibilitychange` back to back; coalesce them
// so the consumer only refetches once per return-to-foreground.
const DEFAULT_COALESCE_MS = 1_000;

type UseRefetchOnActiveOptions = {
  /**
   * Called when the tab returns to the foreground (window `focus` or
   * `document` becoming visible) and on each visible poll tick. Always reads
   * the latest reference, so callers may pass a fresh closure each render.
   */
  onActive: (source: "focus" | "poll") => void;
  /** When set, also run an interval that fires `onActive` only while the document is visible. Independent of the focus/visibility coalesce gate. */
  pollMs?: number;
  /** Minimum gap between activations; collapses the focus + visibilitychange pair a tab switch emits. */
  coalesceMs?: number;
  /** Defaults to true. When false, no listeners or polling are attached. */
  enabled?: boolean;
};

/**
 * Refetch when the tab returns to the foreground. Covers both signals because
 * they do not overlap: switching browser tabs fires `visibilitychange`, while
 * switching desktop apps (tab stays "visible") fires only window `focus`.
 * Never fires on mount -- initial load is the caller's responsibility.
 */
export function useRefetchOnActive({
  onActive,
  pollMs,
  coalesceMs = DEFAULT_COALESCE_MS,
  enabled = true,
}: UseRefetchOnActiveOptions) {
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;
  const lastActiveAtRef = useRef(Number.NEGATIVE_INFINITY);

  useSyncEffect(() => {
    if (!enabled) return;

    // Start each subscription with a fresh gate so a stale timestamp from a
    // previous enable cycle cannot swallow the first activation after listeners
    // are re-attached (e.g. an enabled true -> false -> true flip within coalesceMs).
    lastActiveAtRef.current = Number.NEGATIVE_INFINITY;

    // Coalesce only the focus + visibilitychange pair that a single tab switch
    // emits. The poll deliberately bypasses this gate (see below).
    const activate = () => {
      const now = Date.now();
      if (now - lastActiveAtRef.current < coalesceMs) return;
      lastActiveAtRef.current = now;
      onActiveRef.current("focus");
    };

    const handleFocus = () => activate();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") activate();
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let pollId: ReturnType<typeof setInterval> | undefined;
    if (pollMs != null) {
      // The poll fires `onActive` directly rather than through `activate`: a poll
      // tick must never write `lastActiveAtRef`, or a return to the foreground in
      // the second after a tick would be coalesced away and the refetch dropped.
      pollId = setInterval(() => {
        if (document.visibilityState === "visible") onActiveRef.current("poll");
      }, pollMs);
    }

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (pollId !== undefined) clearInterval(pollId);
    };
  }, [enabled, pollMs, coalesceMs]);
}
