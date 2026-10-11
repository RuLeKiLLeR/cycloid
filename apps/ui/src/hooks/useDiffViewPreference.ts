import { useCallback, useState } from "react";

import { DIFF_VIEW_DEFAULT, DIFF_VIEW_STORAGE_KEY, type DiffViewMode, parseDiffViewMode } from "../constants/diff-view";

/**
 * Read the persisted diff view mode. Safe to call anywhere (render initializers
 * included): falls back to the default when storage is unavailable or holds an
 * unknown value.
 */
export function readDiffViewPreference(): DiffViewMode {
  try {
    return parseDiffViewMode(localStorage.getItem(DIFF_VIEW_STORAGE_KEY));
  } catch {
    return DIFF_VIEW_DEFAULT;
  }
}

/**
 * Diff view preference backed by localStorage. Purely visual — the control
 * plane never reads it, so it is deliberately not part of user_settings.
 * Consumers that only render (e.g. transcript diffs) should call
 * `readDiffViewPreference()` in a state initializer instead of this hook.
 */
export function useDiffViewPreference(): [DiffViewMode, (mode: DiffViewMode) => void] {
  const [mode, setMode] = useState<DiffViewMode>(readDiffViewPreference);

  const set = useCallback((next: DiffViewMode) => {
    setMode(next);
    try {
      localStorage.setItem(DIFF_VIEW_STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; in-memory state still drives this session.
    }
  }, []);

  return [mode, set];
}
