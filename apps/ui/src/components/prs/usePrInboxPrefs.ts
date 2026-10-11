import { useCallback, useState } from "react";

import type { PrInboxBucket } from "../../api/pr-inbox";
import { PR_INBOX_COLLAPSED_STORAGE_KEY } from "../../constants/pr-inbox";
import { useOnChange } from "../../hooks/useEffects";
import { parseCollapsedBuckets } from "./inbox-filters";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // localStorage unavailable (e.g. blocked) — behave as unset.
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persisting is best-effort; in-memory state still drives this session.
  }
}

/** Collapsed bucket sections, hydrated from and persisted to localStorage. */
export function useCollapsedBuckets() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<PrInboxBucket>>(
    () => new Set(parseCollapsedBuckets(readStorage(PR_INBOX_COLLAPSED_STORAGE_KEY))),
  );

  useOnChange([collapsed], () => {
    writeStorage(PR_INBOX_COLLAPSED_STORAGE_KEY, JSON.stringify([...collapsed]));
  });

  const setBucketOpen = useCallback((bucket: PrInboxBucket, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  return [collapsed, setBucketOpen] as const;
}
