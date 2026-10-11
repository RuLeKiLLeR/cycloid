import { useState } from "react";

import { hasStaleChunkUnrecoverableFired, STALE_CHUNK_UNRECOVERABLE_EVENT } from "../stale-chunk-reload";
import { useSyncEffect } from "./useEffects";

export function useStaleChunkUnrecoverable() {
  // Seed from the module-level latch so listeners mounted after
  // dispatchUnrecoverable() fired (e.g. when reloadIfStaleImport runs in the
  // pre-React boot path) still observe the unrecoverable state.
  const [unrecoverable, setUnrecoverable] = useState(hasStaleChunkUnrecoverableFired);

  useSyncEffect(() => {
    function handleUnrecoverable() {
      setUnrecoverable(true);
    }

    window.addEventListener(STALE_CHUNK_UNRECOVERABLE_EVENT, handleUnrecoverable);
    return () => window.removeEventListener(STALE_CHUNK_UNRECOVERABLE_EVENT, handleUnrecoverable);
  }, []);

  return unrecoverable;
}
