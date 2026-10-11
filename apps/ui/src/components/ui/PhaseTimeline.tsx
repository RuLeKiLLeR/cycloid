import { cx } from "./utils";

export type PhaseState = "done" | "current" | "paused" | "failed" | "pending" | "skipped";

export type Phase = {
  key: string;
  label: string;
};

export type PhaseTimelineProps = {
  phases: Phase[];
  /** Zero-based index of the current phase. Ignored when `states` is provided. */
  currentIndex?: number;
  /** Explicit per-phase state, overrides `currentIndex`. */
  states?: PhaseState[];
  orientation?: "vertical" | "horizontal";
  className?: string;
};

function resolveState(index: number, currentIndex: number, states?: PhaseState[]): PhaseState {
  if (states) return states[index] ?? "pending";
  if (index < currentIndex) return "done";
  if (index === currentIndex) return "current";
  return "pending";
}

const dotClasses: Record<PhaseState, string> = {
  // Done is grayscale (white ink); the current/running step is live (violet) and
  // breathes with the sanctioned heartbeat; pending is a bordered empty node.
  done: "bg-text-primary",
  current: "bg-live review-loop-breathe",
  paused: "border border-border-hover bg-surface-1",
  failed: "bg-error",
  pending: "border border-border-strong bg-surface-1",
  // Skipped reads as "never happened": dashed hollow node + struck label, so a
  // settled timeline cannot be misread as still waiting on these stages.
  skipped: "border border-dashed border-border-strong bg-transparent",
};

const labelClasses: Record<PhaseState, string> = {
  done: "text-text-secondary",
  current: "text-text-primary font-medium",
  paused: "text-text-primary font-medium",
  failed: "text-error font-medium",
  pending: "text-text-muted",
  skipped: "text-text-muted line-through",
};

function isCurrentStep(state: PhaseState): boolean {
  return state === "current" || state === "paused" || state === "failed";
}

function Dot({ state }: { state: PhaseState }) {
  return <span aria-hidden className={cx("status-dot size-2 shrink-0 rounded-full", dotClasses[state])} />;
}

export function PhaseTimeline({
  phases,
  currentIndex = 0,
  states,
  orientation = "vertical",
  className,
}: PhaseTimelineProps) {
  if (orientation === "horizontal") {
    return (
      <ol className={cx("flex items-center", className)}>
        {phases.map((phase, index) => {
          const state = resolveState(index, currentIndex, states);
          const isLast = index === phases.length - 1;
          return (
            <li
              key={phase.key}
              data-state={state}
              aria-current={isCurrentStep(state) ? "step" : undefined}
              className="flex min-w-0 items-center gap-2"
            >
              <Dot state={state} />
              <span className={cx("truncate text-xs", labelClasses[state])}>
                {phase.label}
                {state === "skipped" && <span className="sr-only"> (skipped)</span>}
              </span>
              {!isLast && (
                <span
                  aria-hidden
                  className={cx("mx-1 h-px w-8 shrink-0", state === "done" ? "bg-border-hover" : "bg-border")}
                />
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <ol className={cx("flex flex-col", className)}>
      {phases.map((phase, index) => {
        const state = resolveState(index, currentIndex, states);
        const isLast = index === phases.length - 1;
        return (
          <li
            key={phase.key}
            data-state={state}
            aria-current={isCurrentStep(state) ? "step" : undefined}
            className="flex gap-3"
          >
            <div className="flex flex-col items-center pt-1">
              <Dot state={state} />
              {!isLast && (
                <span
                  aria-hidden
                  className={cx("mt-1 min-h-4 w-px flex-1", state === "done" ? "bg-border-hover" : "bg-border")}
                />
              )}
            </div>
            <span className={cx("pb-4 text-md", labelClasses[state])}>
              {phase.label}
              {state === "skipped" && <span className="sr-only"> (skipped)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
