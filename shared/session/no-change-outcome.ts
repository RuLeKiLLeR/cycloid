/**
 * Shared mapping from a persisted prompt-result `noChangeReason` to user-facing
 * outcome copy. Consumed by the control-plane session view and the CLI so every
 * surface explains a completed-without-PR session with identical wording.
 *
 * The reason is stored on `prompt.result` as `{ noChanges: true, noChangeReason }`
 * (see `prompt-queue.ts`). Surfaces must not leak the raw enum value to users.
 */

export type NoChangesPromptResult = {
  noChanges: true;
  noChangeReason?: string | null;
};

/**
 * Type guard for a persisted no-change prompt result. Input is `unknown` because
 * `prompt.result` is `string | Record<string, unknown> | null` on the wire — a
 * truncated string result (`"[Result truncated]"`) must not be treated as a
 * no-change result.
 */
export function isNoChangesPromptResult(result: unknown): result is NoChangesPromptResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "noChanges" in result &&
    (result as { noChanges?: unknown }).noChanges === true
  );
}

export function latestCompletedPromptResult(prompts: ReadonlyArray<{ status: string; result: unknown }>): unknown {
  for (let i = prompts.length - 1; i >= 0; i--) {
    if (prompts[i].status === "completed") return prompts[i].result;
  }
  return null;
}

export function isLatestCompletedPromptNoChanges(prompts: ReadonlyArray<{ status: string; result: unknown }>): boolean {
  return isNoChangesPromptResult(latestCompletedPromptResult(prompts));
}

/**
 * Output `state`/`tone` are the same union as `SessionViewOutcome`
 * (`shared/types/session-view.ts`). The UI renders tone as binary (error vs
 * muted), so there is intentionally no `warning` tone: abnormal/unknown uses
 * `error`.
 */
export type NoChangeOutcomeCopy = {
  state: "no_changes" | "no_change_abnormal";
  tone: "info" | "error";
  title: string;
  detail: string | null;
};

/**
 * Map a stored `noChangeReason` to outcome copy. Input is intentionally
 * `unknown`: persisted results are `Record<string, unknown>` and the reason is
 * optional, so unknown/missing/legacy values are reachable and must route to the
 * abnormal path rather than hide a possible finalization failure.
 *
 * Bridge-emitted abnormal reasons stay explicit so dashboards and user copy do
 * not collapse true prep failures with post-prep finalization failures.
 */
export function noChangeOutcomeCopy(reason: unknown): NoChangeOutcomeCopy {
  switch (reason) {
    case "no_diff":
      return {
        state: "no_changes",
        tone: "info",
        title: "Completed without code changes - no PR created.",
        detail: null,
      };
    case "no_staged_files":
      return {
        state: "no_changes",
        tone: "info",
        title: "Completed without publishable code changes - no PR created.",
        detail: null,
      };
    case "prep_failed":
      return {
        state: "no_change_abnormal",
        tone: "error",
        title: "Finalization failed before changes could be prepared.",
        detail: null,
      };
    case "post_prep_failed":
      return {
        state: "no_change_abnormal",
        tone: "error",
        title: "Finalization failed after changes were prepared.",
        detail: null,
      };
    default:
      // Unknown or missing reason. Fail safe: abnormal, not a clean no-op.
      return {
        state: "no_change_abnormal",
        tone: "error",
        title: "Completed without code changes, but finalization did not report a clean no-op reason.",
        detail: null,
      };
  }
}
