import { createContext, type ReactNode, useContext } from "react";

import type { FinalizingStep, Phase } from "../types";

type ProgressContextValue = {
  phase: Phase;
  finalizingStep: FinalizingStep | null;
  queueLength: number;
};

const SessionProgressContext = createContext<ProgressContextValue>({
  phase: "running",
  finalizingStep: null,
  queueLength: 0,
});

export function SessionProgressProvider({ value, children }: { value: ProgressContextValue; children: ReactNode }) {
  return <SessionProgressContext.Provider value={value}>{children}</SessionProgressContext.Provider>;
}

export function progressLabel(value: ProgressContextValue): string {
  if (value.phase === "finalizing" && value.finalizingStep === "post_execution") return "Running checks…";
  if (value.phase === "finalizing" && value.finalizingStep === "publishing") return "Publishing changes…";
  if (value.phase === "waiting_for_input") return "Waiting for your answer";
  return "Working…";
}

export function SessionProgressIndicator() {
  const progress = useContext(SessionProgressContext);
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted" role="status" aria-live="polite">
      <span>{progressLabel(progress)}</span>
      {progress.queueLength > 0 && (
        <span className="border-l border-border pl-2 font-mono-tabular text-text-secondary">
          {progress.queueLength} queued
        </span>
      )}
    </div>
  );
}
