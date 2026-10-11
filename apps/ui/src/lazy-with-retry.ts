import { lazy, type LazyExoticComponent } from "react";

import { clearPendingPreloadReload, isDynamicImportError } from "./stale-chunk-reload";

const RETRY_DELAY_MS = 500;

type ReactLazyFactory = Parameters<typeof lazy>[0];
type ReactLazyComponent = Awaited<ReturnType<ReactLazyFactory>>["default"];

export function lazyWithRetry<T extends ReactLazyComponent>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  const factory = async () => {
    try {
      return await load();
    } catch (err) {
      if (!isDynamicImportError(err)) throw err;
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, RETRY_DELAY_MS));
      clearPendingPreloadReload();
      return await load();
    }
  };

  return lazy(factory as () => Promise<{ default: T }>);
}
