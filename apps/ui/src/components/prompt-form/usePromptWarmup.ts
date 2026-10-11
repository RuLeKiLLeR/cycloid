import { useCallback, useRef } from "react";

import type { Phase } from "../../../../../shared/session/phase.js";
import { useSyncEffect } from "../../hooks/useEffects";

export function usePromptWarmup({ phase, onWarm }: { phase: Phase; onWarm?: (reasoningEffort?: string) => void }) {
  const warmedRef = useRef(false);

  const warmWithReasoningEffort = useCallback(
    (effort: string | undefined) => {
      if (phase === "idle" && !warmedRef.current && onWarm) {
        warmedRef.current = true;
        onWarm(effort);
      }
    },
    [onWarm, phase],
  );

  const resetWarmup = useCallback(() => {
    warmedRef.current = false;
  }, []);

  useSyncEffect(() => {
    if (phase !== "idle") {
      warmedRef.current = false;
    }
  }, [phase]);

  return { warmWithReasoningEffort, resetWarmup };
}
