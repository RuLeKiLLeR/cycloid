import { describe, expect, it } from "vitest";

import {
  buildFailureCaveats,
  buildFailureClaim,
  type PostExecutionFailureContext,
  resolveFailurePublishDecision,
} from "../../apps/sandbox-bridge/src/services/post-execution/failure-context.js";
import type { PrReadinessCommand } from "../../shared/types/sandbox.js";

const aborted: PostExecutionFailureContext = { kind: "aborted", reason: "user stopped" };
const promptError: PostExecutionFailureContext = { kind: "prompt_error", reason: "codex crashed" };

function command(over: Partial<PrReadinessCommand> = {}): PrReadinessCommand {
  return { command: "npm test", exitCode: 0, ...over } as PrReadinessCommand;
}

describe("buildFailureClaim", () => {
  it("returns undefined on the normal (no-failure) path", () => {
    expect(buildFailureClaim(undefined)).toBeUndefined();
  });

  it("distinguishes aborted from prompt_error wording", () => {
    expect(buildFailureClaim(aborted)).toContain("did not complete before the session stopped");
    expect(buildFailureClaim(promptError)).toContain("ended before post-execution publish preparation completed");
  });
});

describe("buildFailureCaveats", () => {
  it("returns only the base caveats when there is no failure and commands ran", () => {
    expect(buildFailureCaveats(undefined, [command()], ["base caveat"])).toEqual(["base caveat"]);
  });

  it("adds the abort explanation and the no-command note, de-duplicated and trimmed", () => {
    const caveats = buildFailureCaveats(aborted, [], ["  base  "]);
    expect(caveats).toEqual([
      "base",
      "Session stopped before post-execution publish preparation completed: user stopped",
      "No configured pre-publish gate completed before session termination.",
    ]);
  });

  it("uses the prompt_error explanation and omits the no-command note when commands ran", () => {
    const caveats = buildFailureCaveats(promptError, [command()]);
    expect(caveats).toEqual(["Codex prompt execution failed before the agent reached idle: codex crashed"]);
  });

  it("collapses duplicate caveats", () => {
    const dup = "Session stopped before post-execution publish preparation completed: user stopped";
    expect(buildFailureCaveats(aborted, [command()], [dup])).toEqual([dup]);
  });

  // Documents the inherited boundary (Greptile P2): the empty-command note keys off
  // readinessCommands alone, not failureContext. This case is unreachable at current
  // call sites — the finalizer only invokes the port on failure/error finalization
  // (verification-finalizer.ts), never the success path — so the note only
  // surfaces on abnormal paths where it is appropriate. Behavior preserved from the
  // original bridge closure; pinned here so any future change is deliberate.
  it("still emits the no-command note for an empty command list even without a failure context", () => {
    expect(buildFailureCaveats(undefined, [], [])).toEqual([
      "No configured pre-publish gate completed before session termination.",
    ]);
  });
});

describe("resolveFailurePublishDecision", () => {
  it("drafts for manual review, with no warnings", () => {
    const decision = resolveFailurePublishDecision(promptError);
    expect(decision.publishMode).toBe("draft");
    expect(decision.verdict).toBe("INCONCLUSIVE");
    expect(decision.publishWarnReasons).toEqual([]);
    expect(decision.manualReviewReason).toBe("codex crashed");
  });

  it("carries the failure reason for aborted prompts", () => {
    const decision = resolveFailurePublishDecision(aborted);
    expect(decision.publishMode).toBe("draft");
    expect(decision.verdict).toBe("INCONCLUSIVE");
    expect(decision.publishWarnReasons).toEqual([]);
    expect(decision.manualReviewReason).toBe("user stopped");
  });

  it("leaves manualReviewReason undefined when there is no failure context", () => {
    const decision = resolveFailurePublishDecision(undefined);
    expect(decision.publishMode).toBe("draft");
    expect(decision.manualReviewReason).toBeUndefined();
  });
});
