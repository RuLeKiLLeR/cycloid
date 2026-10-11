import { useCallback, useState } from "react";

import { useOnChange } from "./useEffects";

// Per-family collapse overrides for the sidebar sub-agents summary line. We
// persist only the user's explicit choices, keyed by the family head's session
// id — never the computed default. The effective state is `override ?? default`,
// so a family the user never touched re-opens on its own the moment a child
// starts working (the default is recomputed every render).
const SUBAGENT_COLLAPSE_KEY = "cycloid:sidebar.subagentsCollapsed";
// Bound the persisted map so a user who toggles many families over time can't
// grow it without limit. Session ids are ephemeral, so old entries reference
// archived sessions that will never render again; we evict the least-recently
// set once past the cap. Far larger than the number of families ever visible at
// once, so it never drops an override the user could still be looking at.
const MAX_OVERRIDES = 200;

type OverrideMap = Record<string, boolean>;

function readOverrides(): OverrideMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(SUBAGENT_COLLAPSE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") return parsed as OverrideMap;
  } catch {
    // localStorage unavailable or corrupt JSON — fall back to no overrides.
  }
  return {};
}

export type SubagentCollapse = {
  /** Explicit user override for a family, or `undefined` when it should use its default. */
  overrideFor: (headId: string) => boolean | undefined;
  /** Record an explicit collapse/expand choice for a family and persist it. */
  setCollapsed: (headId: string, collapsed: boolean) => void;
};

export function useSubagentCollapse(): SubagentCollapse {
  const [overrides, setOverrides] = useState<OverrideMap>(readOverrides);

  // Persist as a post-commit effect, not inside the state updater: the updater
  // must stay pure (React double-invokes it under StrictMode), so the write
  // belongs here. useOnChange skips the mount run, so we don't rewrite the value
  // we just hydrated from storage — only actual user changes persist.
  useOnChange([overrides], () => {
    try {
      localStorage.setItem(SUBAGENT_COLLAPSE_KEY, JSON.stringify(overrides));
    } catch {
      // Persisting is best-effort; the in-memory state still drives this session.
    }
  });

  const setCollapsed = useCallback((headId: string, collapsed: boolean) => {
    setOverrides((prev) => {
      // Re-insert at the end so a re-toggled family counts as most-recent, then
      // evict from the front once past the cap (object key order is insertion order).
      const next: OverrideMap = { ...prev };
      delete next[headId];
      next[headId] = collapsed;
      const keys = Object.keys(next);
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_OVERRIDES))) delete next[stale];
      return next;
    });
  }, []);

  const overrideFor = useCallback((headId: string) => overrides[headId], [overrides]);

  return { overrideFor, setCollapsed };
}
