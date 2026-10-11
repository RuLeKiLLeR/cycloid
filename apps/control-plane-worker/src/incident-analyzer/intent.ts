import { GPT54_MINI_SIDECAR_REASONING_EFFORT, OpenAIModel } from "../../../../shared/constants/models.js";
import {
  StructuredOutputAbortError,
  StructuredOutputError,
  type StructuredOutputTool,
} from "../../../../shared/llm/structured-output.js";
import { createBoundedTtlMemoryCache } from "../bounded-memory-cache";
import type { Logger } from "../logger";
import { postStructuredEventToDd } from "../observability/events-exporter";
import { tracedFetch } from "../observability/wrappers";
import { queryPlatformStructuredOutput } from "../services/platform-structured-output";
import type { Env } from "../types";

const INCIDENT_INTENT_TIMEOUT_MS = 5_000;
const INCIDENT_INTENT_MAX_TOKENS = 300;
const INCIDENT_INTENT_MAX_ATTEMPTS = 1;
const INCIDENT_INTENT_MODEL = OpenAIModel.GPT54Mini;
const INCIDENT_INTENT_PROVIDER = "openai";
const INCIDENT_INTENT_TOOL_NAME = "detect_incident_intent";
const INCIDENT_INTENT_FALLBACK_METRIC = "incident_intent.model_fallback";
const INCIDENT_SIGNAL_WINDOW_CHARS = 80;
const INCIDENT_INTENT_CACHE_MAX_ENTRIES = 1_000;
const INCIDENT_INTENT_CACHE_TTL_MS = 10 * 60 * 1000;

const INVESTIGATE_REGEX = /\binvestigat(?:e|es|ed|ing|ion)\b/i;
const INCIDENT_SIGNAL_REGEX = /\b(?:incident|outage|prod(?:uction)?|sev\s*[0-9]+|p[0-9]|customer-impacting|alert)\b/i;

type IncidentIntentEnv = Pick<Env, "ARCANIST_OPENAI_API_KEY" | "DD_API_KEY" | "DD_SITE" | "WORKER_ENV">;
type WaitUntil = (promise: Promise<unknown>) => void;

export interface IncidentIntentDetectionResult {
  isIncident: boolean;
  confidence: number;
  reasoning: string;
  source: "llm" | "fallback";
}

export interface IncidentIntentDetectionParams {
  env: IncidentIntentEnv;
  prompt: string;
  logger: Logger;
  waitUntil?: WaitUntil;
}

const incidentIntentTool = {
  name: INCIDENT_INTENT_TOOL_NAME,
  description: "Classify whether a user prompt asks Cycloid to investigate an operational or customer incident.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      isIncident: {
        type: "boolean",
        description:
          "True only when the user is asking for incident, outage, alert, SEV, prod, or customer-impact investigation.",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Classifier confidence from 0 to 1.",
      },
      reasoning: {
        type: "string",
        description: "Brief reason for the classification.",
      },
    },
    required: ["isIncident", "confidence", "reasoning"],
    additionalProperties: false,
  },
} satisfies StructuredOutputTool;

const incidentIntentCache = createBoundedTtlMemoryCache<string, Promise<IncidentIntentDetectionResult>>(
  INCIDENT_INTENT_CACHE_MAX_ENTRIES,
);

export function resetIncidentIntentCacheForTests(): void {
  incidentIntentCache.clear();
}

export function detectIncidentIntentFallback(prompt: string): boolean {
  if (!INVESTIGATE_REGEX.test(prompt)) return false;

  const investigateMatches = [...prompt.matchAll(new RegExp(INVESTIGATE_REGEX.source, "gi"))];
  const signalMatches = [...prompt.matchAll(new RegExp(INCIDENT_SIGNAL_REGEX.source, "gi"))];
  return investigateMatches.some((investigateMatch) =>
    signalMatches.some((signalMatch) => {
      const investigateIndex = investigateMatch.index ?? 0;
      const signalIndex = signalMatch.index ?? 0;
      return Math.abs(investigateIndex - signalIndex) <= INCIDENT_SIGNAL_WINDOW_CHARS;
    }),
  );
}

export async function detectIncidentIntent(params: IncidentIntentDetectionParams): Promise<boolean> {
  return (await detectIncidentIntentDetailed(params)).isIncident;
}

function detectIncidentIntentDetailed(params: IncidentIntentDetectionParams): Promise<IncidentIntentDetectionResult> {
  const cached = incidentIntentCache.get(params.prompt);
  if (cached) return cached;

  const pending = runIncidentIntentDetection(params).catch((error) => {
    incidentIntentCache.delete(params.prompt);
    throw error;
  });
  incidentIntentCache.set(params.prompt, pending, INCIDENT_INTENT_CACHE_TTL_MS);
  return pending;
}

async function runIncidentIntentDetection(
  params: IncidentIntentDetectionParams,
): Promise<IncidentIntentDetectionResult> {
  if (!params.env.ARCANIST_OPENAI_API_KEY) {
    return buildFallbackResult(params.prompt, "OpenAI API key unavailable");
  }

  const startedAt = Date.now();
  try {
    const raw = await queryPlatformStructuredOutput(
      params.env,
      {
        model: INCIDENT_INTENT_MODEL,
        reasoningEffort: GPT54_MINI_SIDECAR_REASONING_EFFORT,
        tool: incidentIntentTool,
        systemPrompt: buildIncidentIntentSystemPrompt(),
        userPrompt: params.prompt,
        maxTokens: INCIDENT_INTENT_MAX_TOKENS,
        timeoutMs: INCIDENT_INTENT_TIMEOUT_MS,
        fetchImpl: tracedFetch,
        spanName: "openai.incidentIntent",
        strictErrors: true,
        retry: { maxAttempts: INCIDENT_INTENT_MAX_ATTEMPTS },
      },
      {
        subsystem: "incident_analyzer",
        callType: "incident_intent",
        phase: "session_create",
        sourceId: `incident_intent:${startedAt}`,
        waitUntil: params.waitUntil,
      },
      { logger: params.logger },
    );
    const result = parseIncidentIntentOutput(raw);
    params.logger.info(
      {
        event: "llm_call.completed",
        callType: "incident_intent",
        outcome: "success",
        provider: INCIDENT_INTENT_PROVIDER,
        model: INCIDENT_INTENT_MODEL,
        toolName: INCIDENT_INTENT_TOOL_NAME,
        confidence: result.confidence,
        attempts: INCIDENT_INTENT_MAX_ATTEMPTS,
        maxAttempts: INCIDENT_INTENT_MAX_ATTEMPTS,
        timeoutMs: INCIDENT_INTENT_TIMEOUT_MS,
        durationMs: Date.now() - startedAt,
      },
      "Incident intent classification completed",
    );
    return result;
  } catch (error) {
    emitIncidentIntentFallbackObservability({
      env: params.env,
      logger: params.logger,
      error,
      durationMs: Date.now() - startedAt,
      waitUntil: params.waitUntil,
    });
    return buildFallbackResult(params.prompt, String(error));
  }
}

function buildIncidentIntentSystemPrompt(): string {
  return [
    "Classify whether the user is asking Cycloid to investigate an operational incident.",
    "Return isIncident=true for prompts that ask to investigate, debug, triage, root-cause, or respond to a customer-impacting issue, outage, alert, SEV/P0-P9, production problem, or broken customer account.",
    "Return isIncident=false for docs, runbook edits, generic bug fixes, implementation requests, or questions that merely mention incident-related words without asking for incident investigation.",
    "The distance between incident words and investigation words is irrelevant; use the whole prompt.",
  ].join("\n");
}

function parseIncidentIntentOutput(raw: Record<string, unknown> | null): IncidentIntentDetectionResult {
  if (
    !raw ||
    typeof raw.isIncident !== "boolean" ||
    typeof raw.confidence !== "number" ||
    !Number.isFinite(raw.confidence) ||
    typeof raw.reasoning !== "string"
  ) {
    throw new Error("Incident intent model returned invalid structured output");
  }

  return {
    isIncident: raw.isIncident,
    confidence: Math.min(1, Math.max(0, raw.confidence)),
    reasoning: raw.reasoning,
    source: "llm",
  };
}

function buildFallbackResult(prompt: string, reasoning: string): IncidentIntentDetectionResult {
  return {
    isIncident: detectIncidentIntentFallback(prompt),
    confidence: 0,
    reasoning,
    source: "fallback",
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

function categorizeIncidentIntentFallback(error: unknown): string {
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

function emitIncidentIntentFallbackObservability(params: {
  env: Pick<Env, "DD_API_KEY" | "DD_SITE" | "WORKER_ENV">;
  logger: Logger;
  error: unknown;
  durationMs: number;
  waitUntil?: WaitUntil;
}): void {
  const structuredError = params.error instanceof StructuredOutputError ? params.error : null;
  const failureCategory = categorizeIncidentIntentFallback(params.error);
  const event = {
    event: "llm_call.completed",
    action: INCIDENT_INTENT_FALLBACK_METRIC,
    metric: INCIDENT_INTENT_FALLBACK_METRIC,
    count: 1,
    callType: "incident_intent",
    outcome: "failure",
    fallback: "deterministic",
    provider: INCIDENT_INTENT_PROVIDER,
    model: INCIDENT_INTENT_MODEL,
    failureCategory,
    failureKind: structuredError?.failureKind ?? null,
    status: structuredError?.status ?? null,
    attempts: structuredError?.attempts ?? INCIDENT_INTENT_MAX_ATTEMPTS,
    maxAttempts: structuredError?.maxAttempts ?? INCIDENT_INTENT_MAX_ATTEMPTS,
    durationMs: structuredError?.durationMs ?? params.durationMs,
    timeoutMs: INCIDENT_INTENT_TIMEOUT_MS,
    requestId: structuredError?.requestID ?? null,
    toolName: structuredError?.toolName ?? INCIDENT_INTENT_TOOL_NAME,
    timestamp: new Date().toISOString(),
  };

  params.logger.warn({ ...event, error: String(params.error) }, "Incident intent model failed");

  const exportPromise = postStructuredEventToDd(params.env, event).catch((exportError) => {
    params.logger.warn(
      {
        metric: `${INCIDENT_INTENT_FALLBACK_METRIC}.export_failed`,
        provider: INCIDENT_INTENT_PROVIDER,
        model: INCIDENT_INTENT_MODEL,
        exportError: String(exportError),
      },
      "Incident intent fallback observability export failed",
    );
  });

  if (params.waitUntil) {
    params.waitUntil(exportPromise);
    return;
  }

  void exportPromise;
}
