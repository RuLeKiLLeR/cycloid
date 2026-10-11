import type {
  PlatformLlmCallPlan,
  PlatformLlmFailureCategory,
  PlatformLlmFailureDetails,
  PlatformLlmResponse,
} from "../../../../shared/llm/platform-llm-contract.js";
import {
  buildPostExecutionStructuredOutputRequest,
  isPostExecutionLlmCallType,
  parsePostExecutionStructuredOutput,
} from "../../../../shared/llm/post-execution.js";
import {
  buildPromptPreparationStructuredOutputRequest,
  isPromptPreparationLlmCallType,
  parsePromptPreparationStructuredOutput,
} from "../../../../shared/llm/prompt-preparation.js";
import {
  StructuredOutputAbortError,
  StructuredOutputError,
  type StructuredOutputFetch,
  type StructuredOutputRetryDependencies,
  type StructuredOutputTool,
} from "../../../../shared/llm/structured-output.js";
import type { Env } from "../types";
import { captureLlmProviderFailure } from "./llm-alerting";
import { queryPlatformStructuredOutput } from "./platform-structured-output";

interface ExecutePlatformLlmDependencies {
  fetchImpl?: StructuredOutputFetch;
  retryDependencies?: StructuredOutputRetryDependencies;
  now?: () => number;
}

type ExecutePlatformLlmResult = {
  status: number;
  response: PlatformLlmResponse<Record<string, unknown>>;
};

function getPlatformApiKey(env: Env): string | null {
  return env.ARCANIST_OPENAI_API_KEY || null;
}

function buildToolRequest(
  plan: PlatformLlmCallPlan,
  input: unknown,
): {
  tool: StructuredOutputTool;
  systemPrompt: string;
  userPrompt: string;
} | null {
  if (isPromptPreparationLlmCallType(plan.callType)) {
    const request = buildPromptPreparationStructuredOutputRequest(plan.callType, input as never);
    if (!request) return null;
    return {
      tool: request.tool as StructuredOutputTool,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
    };
  }
  if (isPostExecutionLlmCallType(plan.callType)) {
    const request = buildPostExecutionStructuredOutputRequest(plan.callType, input as never);
    if (!request) return null;
    return {
      tool: request.tool as StructuredOutputTool,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
    };
  }
  return null;
}

function parseToolResult(plan: PlatformLlmCallPlan, raw: Record<string, unknown>): Record<string, unknown> | null {
  if (isPromptPreparationLlmCallType(plan.callType)) {
    const parsed = parsePromptPreparationStructuredOutput(plan.callType, raw);
    return parsed ? (parsed as Record<string, unknown>) : null;
  }
  if (isPostExecutionLlmCallType(plan.callType)) {
    const parsed = parsePostExecutionStructuredOutput(plan.callType, raw);
    return parsed ? (parsed as Record<string, unknown>) : null;
  }

  return null;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function failureResponse(
  plan: PlatformLlmCallPlan,
  category: PlatformLlmFailureCategory,
  attempts: number,
  startedAt: number,
  now: () => number,
  details?: PlatformLlmFailureDetails,
): PlatformLlmResponse<Record<string, unknown>> {
  return {
    ok: false,
    category,
    attempts,
    durationMs: Math.max(0, now() - startedAt),
    model: plan.model,
    toolName: plan.toolName,
    ...(details ? { details } : {}),
  };
}

function categoryForStructuredOutputError(error: StructuredOutputError): PlatformLlmFailureCategory {
  if (error.failureKind === "output_shape") return "output_shape";
  if (error.failureKind === "transport") return "provider_error_retryable";

  const status = error.status;
  if (status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500)) {
    return "provider_error_retryable";
  }
  return "provider_error_nonretryable";
}

function capturePlatformLlmFailure(params: {
  plan: PlatformLlmCallPlan;
  error: unknown;
  category: PlatformLlmFailureCategory;
  failureKind?: string;
  status?: number;
}): void {
  captureLlmProviderFailure(params.error, {
    operation: "platform_llm",
    provider: params.plan.provider,
    model: params.plan.model,
    callType: params.plan.callType,
    phase: params.plan.phase,
    toolName: params.plan.toolName,
    failureCategory: params.category,
    failureKind: params.failureKind,
    status: params.status,
    sessionId: params.plan.sessionId,
    promptId: params.plan.promptId,
    sandboxId: params.plan.sandboxId,
  });
}

export async function executePlatformLlmCall(
  env: Env,
  plan: PlatformLlmCallPlan,
  input: unknown,
  signal?: AbortSignal,
  deps: ExecutePlatformLlmDependencies = {},
): Promise<ExecutePlatformLlmResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const apiKey = getPlatformApiKey(env);
  if (!apiKey) {
    return {
      status: 503,
      response: failureResponse(plan, "provider_error_nonretryable", 0, startedAt, now),
    };
  }

  const request = buildToolRequest(plan, input);
  if (!request) {
    return {
      status: 400,
      response: failureResponse(plan, "output_shape", 0, startedAt, now),
    };
  }
  let attempts = 0;

  try {
    const opts = {
      apiKey,
      model: plan.model,
      reasoningEffort: plan.reasoningEffort,
      serviceTier: plan.serviceTier,
      tool: request.tool,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      maxTokens: plan.maxTokens,
      timeoutMs: plan.timeoutMs,
      signal,
      strictErrors: true,
      retry: {
        maxAttempts: plan.maxAttempts,
        onResult: (result: { attempts: number }) => {
          attempts = result.attempts;
        },
      },
      retryDependencies: deps.retryDependencies,
      fetchImpl: deps.fetchImpl,
      spanName: `platform_llm.${plan.callType}`,
    };

    const raw = await queryPlatformStructuredOutput(
      env,
      opts,
      {
        subsystem: "platform_llm_broker",
        callType: plan.callType,
        phase: plan.phase,
        sourceId: `${plan.sessionId}:${plan.promptId}:${plan.callType}`,
        sessionId: plan.sessionId,
        promptId: plan.promptId,
        sandboxId: plan.sandboxId,
      },
      {
        now,
        fetchImpl: deps.fetchImpl,
        retryDependencies: deps.retryDependencies,
      },
    );

    attempts = Math.max(attempts, 1);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      capturePlatformLlmFailure({
        plan,
        error: new Error("Platform LLM provider returned empty or non-object structured output"),
        category: "output_shape",
        failureKind: "output_shape",
      });
      return {
        status: 503,
        response: failureResponse(plan, "output_shape", attempts, startedAt, now),
      };
    }

    const data = parseToolResult(plan, raw as Record<string, unknown>);
    if (!data) {
      capturePlatformLlmFailure({
        plan,
        error: new Error("Platform LLM provider returned structured output that failed call-type validation"),
        category: "output_shape",
        failureKind: "output_shape",
      });
      return {
        status: 503,
        response: failureResponse(plan, "output_shape", attempts, startedAt, now),
      };
    }

    const outputBytes = byteLength(data);
    if (outputBytes > plan.maxOutputBytes) {
      capturePlatformLlmFailure({
        plan,
        error: new Error("Platform LLM provider returned structured output above the broker output byte limit"),
        category: "output_too_large",
        failureKind: "output_too_large",
      });
      return {
        status: 503,
        response: failureResponse(plan, "output_too_large", attempts, startedAt, now, {
          outputBytes,
          maxOutputBytes: plan.maxOutputBytes,
        }),
      };
    }

    return {
      status: 200,
      response: {
        ok: true,
        data,
        attempts,
        durationMs: Math.max(0, now() - startedAt),
        model: plan.model,
        toolName: plan.toolName,
      },
    };
  } catch (error) {
    const resolvedAttempts = error instanceof StructuredOutputError ? error.attempts : Math.max(attempts, 1);
    if (error instanceof StructuredOutputAbortError || signal?.aborted) {
      capturePlatformLlmFailure({
        plan,
        error,
        category: "provider_timeout",
      });
      return {
        status: 503,
        response: failureResponse(plan, "provider_timeout", resolvedAttempts, startedAt, now),
      };
    }
    if (error instanceof StructuredOutputError) {
      const category = categoryForStructuredOutputError(error);
      capturePlatformLlmFailure({
        plan,
        error,
        category,
        failureKind: error.failureKind,
        status: error.status,
      });
      return {
        status: 503,
        response: failureResponse(plan, category, resolvedAttempts, startedAt, now),
      };
    }
    capturePlatformLlmFailure({
      plan,
      error,
      category: "provider_error_retryable",
    });
    return {
      status: 503,
      response: failureResponse(plan, "provider_error_retryable", resolvedAttempts, startedAt, now),
    };
  }
}
