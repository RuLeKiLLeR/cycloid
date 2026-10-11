import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import { StructuredOutputAbortError, StructuredOutputError } from "../../../../shared/llm/structured-output.js";
import {
  guessRepoFromTextContext,
  REPO_GUESS_CONFIDENCE_THRESHOLD,
  type RepoCandidate,
  type RepoGuessModelClassifier,
  type RepoGuessResult,
  type RepoGuessTextContext,
} from "../../../../shared/repo-resolution/index.js";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { tracedFetch } from "../observability/wrappers";
import type { Env } from "../types";
import { queryPlatformStructuredOutput } from "./platform-structured-output";

const REPO_RESOLUTION_TIMEOUT_MS = 15_000;
const LINEAR_REPO_RESOLUTION_TIMEOUT_MS = 7_500;
const REPO_RESOLUTION_MAX_TOKENS = 800;
const REPO_RESOLUTION_MAX_ATTEMPTS = 3;
const LINEAR_REPO_RESOLUTION_MAX_ATTEMPTS = 3;
const REPO_RESOLUTION_PROVIDER = "openai";
const REPO_RESOLUTION_FALLBACK_METRIC = "repo_resolution.model_fallback";
// Slack repo inference runs after webhook ack with a 15s per-attempt budget and
// wrong matches launch sessions in the wrong repo. GPT-5.4 mini is the right
// tradeoff for nuanced bounded-candidate reasoning here.
const REPO_RESOLUTION_MODEL = OpenAIModel.GPT54Mini;
// Linear webhook repo inference has a 7.5s budget and cleaner ticket metadata,
// so GPT-5.4 mini provides enough candidate matching accuracy without delaying
// the issue-link path behind a larger model call.
const LINEAR_REPO_RESOLUTION_MODEL = OpenAIModel.GPT54Mini;

type RepoResolutionEnv = Pick<Env, "ARCANIST_OPENAI_API_KEY" | "DD_API_KEY" | "DD_SITE" | "WORKER_ENV">;
type WaitUntil = (promise: Promise<unknown>) => void;
export type RepoResolutionMode = "slack" | "linear";
export type RepoResolutionFallbackFailureCategory =
  | "aborted"
  | "auth"
  | "output_shape"
  | "provider"
  | "provider_4xx"
  | "provider_5xx"
  | "rate_limited"
  | "timeout"
  | "transport"
  | "unknown";

type ResolveRepoFromTextContextResult = RepoGuessResult & {
  llmFailure?: RepoResolutionFallbackFailureCategory;
};

interface RepoResolutionModelConfig {
  model: string;
  apiKey: string;
  maxAttempts: number;
  timeoutMs: number;
  mode: RepoResolutionMode;
}

function getRepoResolutionModelConfig(
  env: Pick<Env, "ARCANIST_OPENAI_API_KEY">,
  mode: RepoResolutionMode,
): RepoResolutionModelConfig {
  return {
    model: mode === "linear" ? LINEAR_REPO_RESOLUTION_MODEL : REPO_RESOLUTION_MODEL,
    apiKey: env.ARCANIST_OPENAI_API_KEY,
    maxAttempts: mode === "linear" ? LINEAR_REPO_RESOLUTION_MAX_ATTEMPTS : REPO_RESOLUTION_MAX_ATTEMPTS,
    timeoutMs: mode === "linear" ? LINEAR_REPO_RESOLUTION_TIMEOUT_MS : REPO_RESOLUTION_TIMEOUT_MS,
    mode,
  };
}

function createRepoClassifier(
  env: RepoResolutionEnv,
  config: RepoResolutionModelConfig,
  hooks: {
    onStart?: () => void;
    onResult?: (result: { attempts: number; maxAttempts: number }) => void;
  } = {},
): RepoGuessModelClassifier {
  return async ({ systemPrompt, userPrompt, tool }) => {
    hooks.onStart?.();
    return queryPlatformStructuredOutput(
      env,
      {
        apiKey: config.apiKey,
        model: config.model,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool,
        systemPrompt,
        userPrompt,
        maxTokens: REPO_RESOLUTION_MAX_TOKENS,
        timeoutMs: config.timeoutMs,
        fetchImpl: tracedFetch,
        spanName: "openai.repoResolution",
        strictErrors: true,
        retry: { maxAttempts: config.maxAttempts, onResult: hooks.onResult },
      },
      {
        subsystem: "repo_resolution",
        callType: "repo_resolution",
        phase: config.mode === "linear" ? "webhook" : "session_create",
        sourceId: `repo_resolution:${config.mode}:${Date.now()}`,
      },
    );
  };
}

function getErrorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (!error || typeof error !== "object" || !("name" in error)) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function isTimeoutLike(error: unknown): boolean {
  const name = getErrorName(error);
  return name === "TimeoutError" || name === "AbortError";
}

function categorizeRepoResolutionFallback(error: unknown): RepoResolutionFallbackFailureCategory {
  if (error instanceof StructuredOutputAbortError) return "aborted";

  if (error instanceof StructuredOutputError) {
    if (isTimeoutLike(error.cause)) return "timeout";
    if (error.failureKind === "transport") return "transport";
    if (error.failureKind === "output_shape") return "output_shape";
    if (error.status === 401 || error.status === 403) return "auth";
    if (error.status === 408) return "timeout";
    if (error.status === 429) return "rate_limited";
    if (typeof error.status === "number" && error.status >= 500) return "provider_5xx";
    if (typeof error.status === "number" && error.status >= 400) return "provider_4xx";
    return "provider";
  }

  if (isTimeoutLike(error)) return "timeout";
  return "unknown";
}

function buildRepoResolutionFallbackEvent(params: {
  config: RepoResolutionModelConfig;
  error: unknown;
  failureCategory: RepoResolutionFallbackFailureCategory;
}): Record<string, unknown> {
  const structuredError = params.error instanceof StructuredOutputError ? params.error : null;
  return {
    event: "llm_call.completed",
    action: REPO_RESOLUTION_FALLBACK_METRIC,
    metric: REPO_RESOLUTION_FALLBACK_METRIC,
    count: 1,
    callType: "repo_resolution",
    outcome: "failure",
    fallback: "deterministic",
    provider: REPO_RESOLUTION_PROVIDER,
    model: params.config.model,
    mode: params.config.mode,
    failureCategory: params.failureCategory,
    failureKind: structuredError?.failureKind ?? null,
    status: structuredError?.status ?? null,
    attempts: structuredError?.attempts ?? null,
    maxAttempts: structuredError?.maxAttempts ?? params.config.maxAttempts,
    durationMs: structuredError?.durationMs ?? null,
    timeoutMs: params.config.timeoutMs,
    requestId: structuredError?.requestID ?? null,
    toolName: structuredError?.toolName ?? null,
    timestamp: new Date().toISOString(),
  };
}

function emitRepoResolutionFallbackObservability(params: {
  env: Pick<Env, "DD_API_KEY" | "DD_SITE" | "WORKER_ENV">;
  logger: Logger;
  config: RepoResolutionModelConfig;
  error: unknown;
  failureCategory: RepoResolutionFallbackFailureCategory;
  waitUntil?: WaitUntil;
}): void {
  const event = buildRepoResolutionFallbackEvent({
    config: params.config,
    error: params.error,
    failureCategory: params.failureCategory,
  });
  params.logger.warn({ ...event, error: String(params.error) }, "Repo resolution model failed");

  const exportPromise = postStructuredEventToDd(params.env, event).catch((exportError) => {
    params.logger.warn(
      {
        metric: `${REPO_RESOLUTION_FALLBACK_METRIC}.export_failed`,
        provider: REPO_RESOLUTION_PROVIDER,
        model: params.config.model,
        mode: params.config.mode,
        exportError: String(exportError),
      },
      "Repo resolution fallback observability export failed",
    );
  });

  if (params.waitUntil) {
    params.waitUntil(exportPromise);
    return;
  }

  void exportPromise;
}

export async function resolveRepoFromTextContext(params: {
  env: RepoResolutionEnv;
  context: RepoGuessTextContext;
  candidates: readonly RepoCandidate[];
  logger: Logger;
  mode?: RepoResolutionMode;
  waitUntil?: WaitUntil;
}): Promise<ResolveRepoFromTextContextResult> {
  const config = getRepoResolutionModelConfig(params.env, params.mode ?? "slack");
  let callStartedAt: number | null = null;
  let classifierRan = false;
  let attemptsUsed = 1;
  let maxAttempts = config.maxAttempts;

  try {
    const result = await guessRepoFromTextContext({
      context: params.context,
      candidates: params.candidates,
      classify: createRepoClassifier(params.env, config, {
        onStart: () => {
          classifierRan = true;
          callStartedAt = Date.now();
        },
        onResult: ({ attempts, maxAttempts: observedMaxAttempts }) => {
          attemptsUsed = attempts;
          maxAttempts = observedMaxAttempts;
        },
      }),
      confidenceThreshold: REPO_GUESS_CONFIDENCE_THRESHOLD,
    });
    if (classifierRan) {
      params.logger.info(
        {
          event: "llm_call.completed",
          callType: "repo_resolution",
          outcome: "success",
          provider: REPO_RESOLUTION_PROVIDER,
          model: config.model,
          toolName: "guess_repo_from_text_context",
          mode: config.mode,
          status: result.status,
          confidence: result.confidence,
          attempts: attemptsUsed,
          maxAttempts,
          timeoutMs: config.timeoutMs,
          durationMs: callStartedAt === null ? 0 : Date.now() - callStartedAt,
        },
        "Repo resolution completed",
      );
    }
    return result;
  } catch (error) {
    const llmFailure = categorizeRepoResolutionFallback(error);
    emitRepoResolutionFallbackObservability({
      env: params.env,
      logger: params.logger,
      config,
      error,
      failureCategory: llmFailure,
      waitUntil: params.waitUntil,
    });
    const deterministic = await guessRepoFromTextContext({
      context: params.context,
      candidates: params.candidates,
      confidenceThreshold: REPO_GUESS_CONFIDENCE_THRESHOLD,
    });
    return { ...deterministic, llmFailure };
  }
}
