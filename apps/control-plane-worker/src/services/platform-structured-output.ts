import { OpenAICanonicalServiceTier, OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import {
  type AnthropicStructuredOutputOptions,
  type BasetenStructuredOutputOptions,
  queryAnthropicStructuredOutput,
  queryBasetenStructuredOutput,
  queryOpenAIStructuredOutput,
  StructuredOutputError,
  type StructuredOutputFetch,
  type StructuredOutputOptions,
  type StructuredOutputProvider,
  type StructuredOutputQueryResult,
  type StructuredOutputRetryDependencies,
  type StructuredOutputUsage,
} from "../../../../shared/llm/structured-output.js";
import { type AnthropicMessagesUsage, computeAnthropicMessagesCostUsdMicros } from "../anthropic/cost";
import { type BasetenChatCompletionsUsage, computeBasetenCostUsdMicros } from "../baseten/cost";
import type { Logger } from "../logger";
import { createLogger } from "../logger";
import { computeOpenAIResponsesCostUsdMicros, type OpenAIResponsesUsage } from "../openai-gateway/cost";
import type { Env } from "../types";

export type PlatformStructuredOutputEnv = Pick<
  Env,
  "ARCANIST_OPENAI_API_KEY" | "ARCANIST_BASETEN_API_KEY" | "ARCANIST_ANTHROPIC_API_KEY"
>;

export type PlatformStructuredOutputPhase =
  "session_create" | "prompt_preparation" | "post_execution" | "memory" | "background" | "webhook";

export type PlatformStructuredOutputTelemetry = {
  subsystem: string;
  callType: string;
  phase: PlatformStructuredOutputPhase;
  sourceId: string;
  sessionId?: string;
  promptId?: string;
  sandboxId?: string;
  businessId?: string | null;
  ownerUserId?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type SessionMetadataTelemetryContext = Partial<
  Pick<
    PlatformStructuredOutputTelemetry,
    "sessionId" | "promptId" | "businessId" | "ownerUserId" | "repoOwner" | "repoName" | "waitUntil"
  >
>;

export type PlatformStructuredOutputOptions = Omit<StructuredOutputOptions, "apiKey" | "returnMetadata"> & {
  apiKey?: string;
  provider?: StructuredOutputProvider;
  baseUrl?: string;
};

type PlatformStructuredOutputDependencies = {
  now?: () => number;
  logger?: Logger;
  emitUsageEvent?: (eventId: string, event: Record<string, unknown>) => Promise<void>;
  fetchImpl?: StructuredOutputFetch;
  retryDependencies?: StructuredOutputRetryDependencies;
};

const USAGE_EVENT_VERSION = 1;

export async function queryPlatformStructuredOutput(
  env: PlatformStructuredOutputEnv,
  options: PlatformStructuredOutputOptions,
  telemetry: PlatformStructuredOutputTelemetry,
  deps: PlatformStructuredOutputDependencies = {},
): Promise<Record<string, unknown> | null> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const logger = deps.logger ?? createLogger();
  const inputBytes = estimateInputBytes(options.systemPrompt, options.userPrompt);
  const provider = options.provider ?? "openai";
  const apiKey = resolvePlatformApiKey(env, options, provider);

  if (apiKey === undefined || isMissingPlatformApiKey(apiKey)) {
    emitUsageEvent(
      logger,
      telemetry,
      buildUsageEvent({
        provider,
        telemetry,
        options,
        startedAt,
        now,
        inputBytes,
        outcome: "failure",
        failureCategory: "missing_api_key",
        attempts: 0,
        maxAttempts: options.retry?.maxAttempts ?? 1,
      }),
      deps,
    );
    throw new Error("Platform structured output API key is missing");
  }
  const resolvedApiKey = apiKey;

  try {
    const result = normalizeStructuredOutputResult(
      await queryProviderStructuredOutput(provider, {
        ...options,
        apiKey: resolvedApiKey,
        fetchImpl: deps.fetchImpl ?? options.fetchImpl,
        retryDependencies: deps.retryDependencies ?? options.retryDependencies,
        returnMetadata: true,
      }),
      provider,
      options,
      now() - startedAt,
    );

    emitUsageEvent(
      logger,
      telemetry,
      buildUsageEvent({
        provider,
        telemetry,
        options,
        startedAt,
        now,
        inputBytes,
        outcome: "success",
        result,
        attempts: result.metadata.attempts,
        maxAttempts: result.metadata.maxAttempts,
      }),
      deps,
    );
    return result.output;
  } catch (error) {
    if (isAbortLike(error)) {
      emitUsageEvent(
        logger,
        telemetry,
        buildUsageEvent({
          provider,
          telemetry,
          options,
          startedAt,
          now,
          inputBytes,
          outcome: "failure",
          failureCategory: "provider_timeout",
          attempts: 1,
          maxAttempts: options.retry?.maxAttempts ?? 1,
        }),
        deps,
      );
      throw error;
    }

    const structured = error instanceof StructuredOutputError ? error : null;
    emitUsageEvent(
      logger,
      telemetry,
      buildUsageEvent({
        provider,
        telemetry,
        options,
        startedAt,
        now,
        inputBytes,
        outcome: "failure",
        failureCategory: structured ? structured.failureKind : "unknown",
        status: structured?.status,
        requestID: structured?.requestID,
        failureUsage: structured?.usage ?? null,
        attempts: structured?.attempts ?? 1,
        maxAttempts: structured?.maxAttempts ?? options.retry?.maxAttempts ?? 1,
      }),
      deps,
    );
    throw error;
  }
}

function resolvePlatformApiKey(
  env: PlatformStructuredOutputEnv,
  options: PlatformStructuredOutputOptions,
  provider: StructuredOutputProvider,
): string | undefined {
  if (options.apiKey !== undefined) return options.apiKey;
  switch (provider) {
    case "openai":
      return env.ARCANIST_OPENAI_API_KEY;
    case "baseten":
      return env.ARCANIST_BASETEN_API_KEY;
    case "anthropic":
      return env.ARCANIST_ANTHROPIC_API_KEY;
  }
}

function isMissingPlatformApiKey(apiKey: string | undefined): boolean {
  if (apiKey === undefined) return true;
  const trimmed = apiKey.trim();
  return trimmed.length === 0 || trimmed === "CHANGE_ME";
}

function queryProviderStructuredOutput(
  provider: StructuredOutputProvider,
  options: PlatformStructuredOutputOptions & { apiKey: string; returnMetadata: true },
): Promise<StructuredOutputQueryResult> {
  switch (provider) {
    case "openai":
      return queryOpenAIStructuredOutput(options);
    case "baseten":
      return queryBasetenStructuredOutput(options as BasetenStructuredOutputOptions & { returnMetadata: true });
    case "anthropic":
      return queryAnthropicStructuredOutput(options as AnthropicStructuredOutputOptions & { returnMetadata: true });
  }
}

function normalizeStructuredOutputResult(
  result: StructuredOutputQueryResult | Record<string, unknown> | null,
  provider: StructuredOutputProvider,
  options: PlatformStructuredOutputOptions,
  durationMs: number,
): StructuredOutputQueryResult {
  if (result && typeof result === "object" && "metadata" in result && "output" in result) {
    return result as StructuredOutputQueryResult;
  }
  return {
    output: result,
    metadata: {
      provider,
      model: options.model,
      toolName: options.tool.name,
      attempts: options.retry?.maxAttempts ?? 1,
      maxAttempts: options.retry?.maxAttempts ?? 1,
      durationMs,
      usage: null,
      serviceTier: null,
    },
  };
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "StructuredOutputAbortError" || name === "AbortError" || name === "TimeoutError";
}

function buildUsageEvent(params: {
  provider: StructuredOutputProvider;
  telemetry: PlatformStructuredOutputTelemetry;
  options: PlatformStructuredOutputOptions;
  startedAt: number;
  now: () => number;
  inputBytes: number;
  outcome: "success" | "failure";
  result?: StructuredOutputQueryResult;
  failureUsage?: StructuredOutputUsage | null;
  failureCategory?: string;
  status?: number;
  requestID?: string;
  attempts: number;
  maxAttempts: number;
}): Record<string, unknown> {
  const usage = params.result?.metadata.usage ?? params.failureUsage ?? null;
  // Requested tier from options; actual tier from the provider's returned service_tier (which can
  // degrade flex->default under capacity pressure). Both canonicalized to standard|flex so the
  // dashboard split is not fragmented across null/"default"/"auto". Cost is priced by the actual
  // tier so a flex->default fallback is costed correctly.
  const requestedServiceTier = params.provider === "openai" ? canonicalServiceTier(params.options.serviceTier) : null;
  const serviceTier = params.provider === "openai" ? canonicalServiceTier(params.result?.metadata.serviceTier) : null;
  const pricing = pricingForUsage(params.provider, params.options, usage, serviceTier);
  return {
    event: "platform_llm.usage_event",
    version: USAGE_EVENT_VERSION,
    eventId: buildUsageEventId(params.telemetry, params.startedAt),
    timestampMs: params.startedAt,
    subsystem: params.telemetry.subsystem,
    callType: params.telemetry.callType,
    phase: params.telemetry.phase,
    sourceId: params.telemetry.sourceId,
    provider: params.provider,
    model: params.options.model,
    toolName: params.options.tool.name,
    reasoningEffort: params.options.reasoningEffort ?? null,
    requestedServiceTier,
    serviceTier,
    timeoutMs: params.options.timeoutMs ?? null,
    maxTokens: params.options.maxTokens,
    maxAttempts: params.maxAttempts,
    attempts: params.attempts,
    durationMs: params.result?.metadata.durationMs ?? Math.max(0, params.now() - params.startedAt),
    inputBytes: params.inputBytes,
    outcome: params.outcome,
    requestId: params.result?.metadata.requestID ?? params.requestID ?? null,
    status: params.status ?? null,
    failureCategory: params.failureCategory ?? null,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          reasoningOutputTokens: usage.reasoningOutputTokens,
        }
      : null,
    costUsdMicros: pricing?.costUsdMicros ?? null,
    pricing: pricing?.provenance ?? null,
    pricingUnavailableReason: pricing?.pricingUnavailableReason ?? null,
    sessionId: params.telemetry.sessionId ?? null,
    promptId: params.telemetry.promptId ?? null,
    sandboxId: params.telemetry.sandboxId ?? null,
    businessId: params.telemetry.businessId ?? null,
    ownerUserId: params.telemetry.ownerUserId ?? null,
    repoOwner: params.telemetry.repoOwner ?? null,
    repoName: params.telemetry.repoName ?? null,
  };
}

// Canonicalize a requested or actual service tier to the two-value dashboard axis. Anything that
// is not an explicit flex (undefined, "auto", "default", or an unknown provider value) is standard.
function canonicalServiceTier(tier: string | null | undefined): OpenAICanonicalServiceTier {
  return tier === OpenAIServiceTier.Flex ? OpenAICanonicalServiceTier.Flex : OpenAICanonicalServiceTier.Standard;
}

function pricingForUsage(
  provider: StructuredOutputProvider,
  options: PlatformStructuredOutputOptions,
  usage: StructuredOutputUsage | null,
  serviceTier: OpenAICanonicalServiceTier | null,
):
  | (ReturnType<typeof computeOpenAIResponsesCostUsdMicros> & { pricingUnavailableReason?: never })
  | ReturnType<typeof computeBasetenCostUsdMicros>
  | ReturnType<typeof computeAnthropicMessagesCostUsdMicros>
  | null {
  if (!usage) return null;
  if (provider === "baseten") {
    return computeBasetenCostUsdMicros({
      model: options.model,
      baseUrl: options.baseUrl,
      usage: {
        prompt_tokens: usage.inputTokens ?? undefined,
        completion_tokens: usage.outputTokens ?? undefined,
        prompt_tokens_details: {
          cached_tokens: usage.cachedInputTokens ?? undefined,
        },
      } satisfies BasetenChatCompletionsUsage,
    });
  }
  if (provider === "anthropic") {
    return computeAnthropicMessagesCostUsdMicros({
      model: options.model,
      usage: {
        input_tokens: usage.inputTokens ?? undefined,
        output_tokens: usage.outputTokens ?? undefined,
        cache_read_input_tokens: usage.cachedInputTokens ?? undefined,
        cache_creation_input_tokens: usage.cacheCreationInputTokens ?? undefined,
      } satisfies AnthropicMessagesUsage,
    });
  }
  try {
    return computeOpenAIResponsesCostUsdMicros({
      model: options.model,
      serviceTier: serviceTier ?? OpenAICanonicalServiceTier.Standard,
      usage: {
        input_tokens: usage.inputTokens ?? undefined,
        output_tokens: usage.outputTokens ?? undefined,
        input_tokens_details: {
          cached_tokens: usage.cachedInputTokens ?? undefined,
        },
        output_tokens_details: {
          reasoning_tokens: usage.reasoningOutputTokens ?? undefined,
        },
      } satisfies OpenAIResponsesUsage,
    });
  } catch {
    return null;
  }
}

function estimateInputBytes(systemPrompt: string, userPrompt: string): number {
  return new TextEncoder().encode(`${systemPrompt}\n${userPrompt}`).length;
}

function buildUsageEventId(telemetry: PlatformStructuredOutputTelemetry, startedAt: number): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return [telemetry.subsystem, telemetry.callType, telemetry.sourceId, String(startedAt), random].join(".");
}

function emitUsageEvent(
  logger: Logger,
  telemetry: PlatformStructuredOutputTelemetry,
  event: Record<string, unknown>,
  deps: PlatformStructuredOutputDependencies,
): void {
  logger.info(event, "Platform LLM usage event");
  const eventId = typeof event.eventId === "string" ? event.eventId : buildUsageEventId(telemetry, Date.now());
  const write = deps.emitUsageEvent ? deps.emitUsageEvent(eventId, event) : Promise.resolve();
  if (telemetry.waitUntil) {
    telemetry.waitUntil(write);
  } else {
    void write;
  }
}
