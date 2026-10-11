import type { BridgeLogger, LogLevel } from "../../logger.js";

export type PostExecutionObservationUtility = "trace" | "progress" | "decision" | "degraded" | "failure";

const POST_EXECUTION_OBSERVATION_LEVELS: Record<PostExecutionObservationUtility, LogLevel> = {
  trace: "debug",
  progress: "info",
  decision: "info",
  degraded: "warn",
  failure: "error",
};

export function postExecutionLogLevelForUtility(utility: PostExecutionObservationUtility): LogLevel {
  return POST_EXECUTION_OBSERVATION_LEVELS[utility];
}

export function observePostExecution(
  log: BridgeLogger,
  args: {
    utility: PostExecutionObservationUtility;
    event: string;
    message: string;
    fields?: Record<string, unknown>;
  },
): void {
  const level = postExecutionLogLevelForUtility(args.utility);
  log[level](
    {
      ...args.fields,
      event: args.event,
      observabilityUtility: args.utility,
    },
    args.message,
  );
}
