import type {
  ErrorCode,
  ErrorDetails,
  ExecutionVerification,
  PrReadinessCommand,
  VerificationVerdict,
} from "../../../../../shared/types/sandbox.js";

/**
 * Describes how a prompt ended abnormally (user stop or Codex execution error)
 * so post-execution can still emit a publishable, honestly-caveated result
 * instead of a silent completion.
 */
export type PostExecutionFailureContext = {
  kind: "aborted" | "prompt_error";
  reason: string;
  errorCode?: ErrorCode;
  errorDetails?: ErrorDetails;
};

/**
 * The publish-prep claim to surface when a prompt ended abnormally. `undefined`
 * for the normal (no-failure) path, in which case the caller keeps its own claim.
 */
export function buildFailureClaim(failureContext: PostExecutionFailureContext | undefined): string | undefined {
  if (!failureContext) return undefined;
  return failureContext.kind === "aborted"
    ? "Prompt changes were preserved, but post-execution publish preparation did not complete before the session stopped."
    : "Prompt execution ended before post-execution publish preparation completed.";
}

/**
 * Compose the caveat list for an abnormal post-execution result: any
 * branch-specific `baseCaveats`, the failure-kind explanation, and a note when
 * no configured pre-publish gate ran. De-duplicated and trimmed.
 */
export function buildFailureCaveats(
  failureContext: PostExecutionFailureContext | undefined,
  readinessCommands: readonly PrReadinessCommand[],
  baseCaveats: readonly string[] = [],
): string[] {
  const caveats = [...baseCaveats];
  if (failureContext) {
    caveats.push(
      failureContext.kind === "aborted"
        ? `Session stopped before post-execution publish preparation completed: ${failureContext.reason}`
        : `Codex prompt execution failed before the agent reached idle: ${failureContext.reason}`,
    );
  }
  if (readinessCommands.length === 0) {
    caveats.push("No configured pre-publish gate completed before session termination.");
  }
  return Array.from(new Set(caveats.map((item) => item.trim()).filter(Boolean)));
}

export type FailurePublishDecision = {
  publishMode: NonNullable<ExecutionVerification["publishMode"]>;
  publishWarnReasons: string[];
  manualReviewReason?: string;
  verdict: VerificationVerdict;
};

/**
 * Decide publish mode + verdict for an abnormal prompt. Failed/stopped prompts
 * require manual review.
 */
export function resolveFailurePublishDecision(
  failureContext: PostExecutionFailureContext | undefined,
): FailurePublishDecision {
  return {
    publishMode: "draft",
    publishWarnReasons: [],
    manualReviewReason: failureContext?.reason,
    verdict: "INCONCLUSIVE",
  };
}
