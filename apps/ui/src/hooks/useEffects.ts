import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Run an effect exactly once on mount. Wraps useEffect with [] deps.
 * Use for: DOM integration, external system subscriptions, initial data fetches.
 */
export function useMountEffect(effect: () => void | (() => void)) {
  useEffect(effect, []);
}

/**
 * Run an effect when specific dependencies change, skipping the initial mount.
 * Use for: resetting state when a prop/ID changes, refetching on scope change.
 */
export function useOnChange(deps: readonly unknown[], effect: () => void | (() => void)) {
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    return effect();
  }, deps);
}

/**
 * Run an effect whenever dependencies change, including the initial mount.
 * Use for: document event listeners, timers tied to changing props.
 *
 * This is a named wrapper around useEffect that makes intent explicit.
 * Prefer useMountEffect (mount-only) or useOnChange (skip-mount) when possible.
 */
export function useSyncEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
  useEffect(effect, deps);
}

export function useLayoutSyncEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
  useLayoutEffect(effect, deps);
}
