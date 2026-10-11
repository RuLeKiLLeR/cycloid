import * as Sentry from "@sentry/cloudflare";

import { type Logger, phaseLogFields } from "../logger";
import type { PromptState, SessionState } from "../types";
import type { ErrorCode, ErrorDetails } from "../ws/types.js";

interface PromptTerminalTelemetry {
  btSpanId?: string;
  errorCode?: ErrorCode;
  errorDetails?: ErrorDetails;
  traceExpected?: boolean;
  recoverStalePrompt?: boolean;
  spawnAlarmOvershootMs?: number;
}

export interface PromptFinalizeContext {
  repo: string | null;
  sandboxId: string | null;
  modalObjectId: string | null;
  agentSessionId: string | null;
  promptDispatchedToAgent: boolean | null;
  // Runtime attribution snapshotted at scheduling time (before terminal cleanup
  // can null sandbox_state), so prompt.trace.finalized can split E2B-cloud vs
  // self-hosted failures.
  runtimeProvider: string | null;
  runtimeBackend: string | null;
}

interface PromptCompletionWrite {
  diffSummary?: string;
  branch?: string;
  commitSha?: string;
  success?: boolean;
}

interface PromptTerminalSideEffectsRequest {
  sessionId: string;
  prompt: PromptState;
  session: SessionState;
  reason: string;
  writeUsageRecord?: boolean;
  // Plan-mode planning turns still write usage + finalize telemetry (billing and
  // trace completeness), but skip the memory-review bot: it would open a
  // premature memory PR off a plan that has not been implemented yet.
  suppressMemoryReviewBot?: boolean;
  completion?: PromptCompletionWrite;
  finalize?: {
    telemetry?: PromptTerminalTelemetry;
    context?: PromptFinalizeContext;
  };
}

interface PromptTerminalSideEffectsHost {
  readonly log: Logger;
  enqueueTerminalSideEffects(task: () => Promise<void>): void;
  capturePromptFinalizeContext(sessionId: string): PromptFinalizeContext;
  writeUsageToD1(sessionId: string, ownerUserId: string, promptId: string): Promise<void>;
  writeCompletionToD1(
    sessionId: string,
    ownerUserId: string,
    promptId: string,
    event?: PromptCompletionWrite,
  ): Promise<void>;
  finalizePromptRun(
    sessionId: string,
    prompt: PromptState,
    session: SessionState,
    telemetry?: PromptTerminalTelemetry,
    context?: PromptFinalizeContext,
  ): Promise<void>;
  runMemoryReviewBot(sessionId: string, prompt: PromptState, session: SessionState): Promise<void>;
}

function cloneRequest(request: PromptTerminalSideEffectsRequest): PromptTerminalSideEffectsRequest {
  return {
    ...request,
    prompt: structuredClone(request.prompt),
    session: structuredClone(request.session),
    ...(request.completion ? { completion: { ...request.completion } } : {}),
    ...(request.finalize
      ? {
          finalize: {
            ...(request.finalize.telemetry ? { telemetry: structuredClone(request.finalize.telemetry) } : {}),
            ...(request.finalize.context ? { context: structuredClone(request.finalize.context) } : {}),
          },
        }
      : {}),
  };
}

export function schedulePromptTerminalSideEffects(
  host: PromptTerminalSideEffectsHost,
  request: PromptTerminalSideEffectsRequest,
): void {
  const clonedRequest = cloneRequest({
    ...request,
    ...(request.finalize
      ? {
          finalize: {
            ...request.finalize,
            context: request.finalize.context ?? host.capturePromptFinalizeContext(request.sessionId),
          },
        }
      : {}),
  });

  host.enqueueTerminalSideEffects(async () => {
    const startedAt = Date.now();
    const { sessionId, prompt, session, reason } = clonedRequest;

    host.log.info(
      phaseLogFields("prompt.complete", {
        step: "terminal_side_effects",
        phase_status: "started",
        sessionId,
        promptId: prompt.promptId,
        reason,
        writeUsageRecord: clonedRequest.writeUsageRecord === true,
        finalize: Boolean(clonedRequest.finalize),
        completionWrite: Boolean(clonedRequest.completion),
      }),
      "Prompt terminal side effects started",
    );

    try {
      if (clonedRequest.writeUsageRecord) {
        await host.writeUsageToD1(sessionId, session.ownerUserId, prompt.promptId);
      }
      if (clonedRequest.completion) {
        await host.writeCompletionToD1(sessionId, session.ownerUserId, prompt.promptId, clonedRequest.completion);
      }
      if (clonedRequest.finalize) {
        await host.finalizePromptRun(
          sessionId,
          prompt,
          session,
          clonedRequest.finalize.telemetry,
          clonedRequest.finalize.context,
        );
        if (prompt.status === "completed" && !clonedRequest.suppressMemoryReviewBot) {
          await host.runMemoryReviewBot(sessionId, prompt, session);
        }
      }
    } catch (error) {
      host.log.error(
        { sessionId, promptId: prompt.promptId, reason, error: String(error) },
        "Prompt terminal side effects failed",
      );
      Sentry.captureException(error, {
        tags: {
          sessionId,
          promptId: prompt.promptId,
          operation: "prompt_terminal_side_effects",
        },
      });
    } finally {
      host.log.info(
        phaseLogFields("prompt.complete", {
          step: "terminal_side_effects",
          phase_status: "completed",
          sessionId,
          promptId: prompt.promptId,
          reason,
          durationMs: Date.now() - startedAt,
        }),
        "Prompt terminal side effects finished",
      );
    }
  });
}
