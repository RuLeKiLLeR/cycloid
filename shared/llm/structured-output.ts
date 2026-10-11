import type { ReasoningEffort } from "../constants/models.js";
import type { OpenAIServiceTier } from "../enums/openai-service-tier.js";
import { normalizeBaseUrl } from "../utils/url.js";
import {
  createProviderAttemptSignal,
  getProviderRetryAttemptCount,
  type ProviderRetryDependencies,
  withProviderRetry,
} from "./retry.mjs";

export type StructuredOutputProvider = "openai" | "baseten" | "anthropic";
export type StructuredOutputReasoningEffort = Extract<ReasoningEffort, "low" | "medium" | "high" | "xhigh">;

// OpenAI Responses API service tier. Omitting the field resolves to the account default
// (today "default"/standard for us); "flex" bills at Batch rates with higher/variable latency.
export type StructuredOutputServiceTier = OpenAIServiceTier;

export type StructuredOutputFailureKind = "transport" | "provider" | "output_shape";

export type StructuredOutputTool = {
  name: string;
  description: string;
  strict?: boolean;
  input_schema: { type: "object"; [key: string]: unknown };
};

export type StructuredOutputRetryResult = {
  attempts: number;
  maxAttempts: number;
};

export type StructuredOutputRetryOptions = {
  maxAttempts: number;
  onResult?: (result: StructuredOutputRetryResult) => void;
};

export type StructuredOutputUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  reasoningOutputTokens: number | null;
};

export type StructuredOutputMetadata = {
  provider: StructuredOutputProvider;
  model: string;
  toolName: string;
  requestID?: string;
  attempts: number;
  maxAttempts: number;
  durationMs: number;
  usage: StructuredOutputUsage | null;
  // The service tier the provider actually used, parsed from the response body. Can differ from
  // the requested tier when the provider degrades flex to default under capacity pressure. null
  // when the response omits it (e.g. when no tier was requested).
  serviceTier: string | null;
};

export type StructuredOutputQueryResult = {
  output: Record<string, unknown> | null;
  metadata: StructuredOutputMetadata;
};

export type StructuredOutputFetch = (
  input: string | URL | Request,
  init?: RequestInit,
  spanName?: string,
) => Promise<Response>;

export type StructuredOutputRetryDependencies = ProviderRetryDependencies;

export type StructuredOutputOptions = {
  apiKey: string;
  model: string;
  tool: StructuredOutputTool;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  reasoningEffort?: StructuredOutputReasoningEffort;
  // Requested OpenAI service tier. Undefined omits the field (provider account default). Use
  // "flex" for latency-tolerant background calls (Batch-rate billing). Callers that send "flex"
  // must set retry.maxAttempts >= 2 so a flex 429 (resource_unavailable) is absorbed.
  serviceTier?: StructuredOutputServiceTier;
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: StructuredOutputRetryOptions;
  fetchImpl?: StructuredOutputFetch;
  spanName?: string;
  strictErrors?: boolean;
  returnMetadata?: boolean;
  retryDependencies?: StructuredOutputRetryDependencies;
};

export type BasetenStructuredOutputOptions = Omit<StructuredOutputOptions, "reasoningEffort" | "serviceTier"> & {
  baseUrl?: string;
};

export type AnthropicStructuredOutputOptions = Omit<StructuredOutputOptions, "reasoningEffort" | "serviceTier">;

export type StructuredOutputErrorFields = {
  provider: StructuredOutputProvider;
  model: string;
  toolName: string;
  status?: number;
  requestID?: string;
  usage?: StructuredOutputUsage | null;
  attempts: number;
  maxAttempts: number;
  durationMs: number;
  failureKind: StructuredOutputFailureKind;
};

type HeaderGetter = {
  get(name: string): string | null;
};

type InternalErrorFields = {
  status?: number;
  requestID?: string;
  headers?: HeaderGetter;
  usage?: StructuredOutputUsage | null;
  failureKind: StructuredOutputFailureKind;
};

const OPENAI_RESPONSES_API_URL = "https://api.openai.com/v1/responses";
const BASETEN_MODEL_API_BASE_URL = "https://inference.baseten.co/v1";
const ANTHROPIC_MESSAGES_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ATTEMPT_TIMEOUT_MS = 600_000;
const ERROR_MESSAGE_MAX_LENGTH = 500;

export class StructuredOutputAbortError extends Error {
  constructor(message = "Structured output request aborted") {
    super(message);
    this.name = "StructuredOutputAbortError";
  }
}

class StructuredOutputInternalError extends Error {
  readonly status?: number;
  readonly requestID?: string;
  readonly headers?: HeaderGetter;
  readonly usage?: StructuredOutputUsage | null;
  readonly failureKind: StructuredOutputFailureKind;
  readonly cause?: unknown;

  constructor(message: string, fields: InternalErrorFields, cause?: unknown) {
    super(message);
    this.name = "StructuredOutputInternalError";
    this.cause = cause;
    this.status = fields.status;
    this.requestID = fields.requestID;
    this.headers = fields.headers;
    this.usage = fields.usage;
    this.failureKind = fields.failureKind;
  }
}

export class StructuredOutputError extends Error {
  readonly provider: StructuredOutputProvider;
  readonly model: string;
  readonly toolName: string;
  readonly status?: number;
  readonly requestID?: string;
  readonly usage?: StructuredOutputUsage | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly durationMs: number;
  readonly failureKind: StructuredOutputFailureKind;
  readonly cause?: unknown;

  constructor(fields: StructuredOutputErrorFields, originalError: unknown) {
    const summary = [
      `[${fields.provider}/${fields.model}] ${fields.toolName}`,
      fields.status !== undefined ? `status=${fields.status}` : null,
      fields.requestID ? `req=${fields.requestID}` : null,
      `attempts=${fields.attempts}`,
      `maxAttempts=${fields.maxAttempts}`,
      `duration=${fields.durationMs}ms`,
      `kind=${fields.failureKind}`,
    ]
      .filter(Boolean)
      .join(" ");

    super(`StructuredOutputError ${summary}`);
    this.name = "StructuredOutputError";
    this.cause = originalError;
    this.provider = fields.provider;
    this.model = fields.model;
    this.toolName = fields.toolName;
    this.status = fields.status;
    this.requestID = fields.requestID;
    this.usage = fields.usage;
    this.attempts = fields.attempts;
    this.maxAttempts = fields.maxAttempts;
    this.durationMs = fields.durationMs;
    this.failureKind = fields.failureKind;
  }
}

export function queryOpenAIStructuredOutput(
  opts: StructuredOutputOptions & { returnMetadata: true },
): Promise<StructuredOutputQueryResult>;
export function queryOpenAIStructuredOutput(opts: StructuredOutputOptions): Promise<Record<string, unknown> | null>;
export async function queryOpenAIStructuredOutput(
  opts: StructuredOutputOptions,
): Promise<Record<string, unknown> | null | StructuredOutputQueryResult> {
  if (opts.signal?.aborted) {
    throw new StructuredOutputAbortError();
  }

  const startedAt = Date.now();
  const throwStructuredErrors = Boolean(opts.retry || opts.strictErrors);
  const maxAttempts = opts.retry?.maxAttempts ?? 1;
  let attempts = 0;

  try {
    if (!opts.retry) {
      attempts = 1;
      const signal = createProviderAttemptSignal(opts.signal, opts.timeoutMs);
      const result = await runOpenAIRequest(opts, signal);
      return formatStructuredOutputResult("openai", opts, result, attempts, maxAttempts, Date.now() - startedAt);
    }

    const result = await withProviderRetry({
      op: async (attemptSignal) => runOpenAIRequest(opts, attemptSignal),
      maxAttempts: opts.retry.maxAttempts,
      perAttemptTimeoutMs: opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      callerSignal: opts.signal,
      sleep: opts.retryDependencies?.sleep,
      random: opts.retryDependencies?.random,
      abortErrorFactory: () => new StructuredOutputAbortError(),
    });

    attempts = result.attempts;
    opts.retry.onResult?.({ attempts, maxAttempts });
    return formatStructuredOutputResult("openai", opts, result.value, attempts, maxAttempts, Date.now() - startedAt);
  } catch (error) {
    if (error instanceof StructuredOutputAbortError) throw error;
    if (opts.signal?.aborted) throw new StructuredOutputAbortError();

    attempts = getProviderRetryAttemptCount(error, attempts);
    if (!throwStructuredErrors) return null;

    throw toStructuredOutputError(
      {
        provider: "openai",
        model: opts.model,
        toolName: opts.tool.name,
        attempts,
        maxAttempts,
        durationMs: Date.now() - startedAt,
      },
      error,
    );
  }
}

export function queryBasetenStructuredOutput(
  opts: BasetenStructuredOutputOptions & { returnMetadata: true },
): Promise<StructuredOutputQueryResult>;
export function queryBasetenStructuredOutput(
  opts: BasetenStructuredOutputOptions,
): Promise<Record<string, unknown> | null>;
export async function queryBasetenStructuredOutput(
  opts: BasetenStructuredOutputOptions,
): Promise<Record<string, unknown> | null | StructuredOutputQueryResult> {
  if (opts.signal?.aborted) {
    throw new StructuredOutputAbortError();
  }

  const startedAt = Date.now();
  const throwStructuredErrors = Boolean(opts.retry || opts.strictErrors);
  const maxAttempts = opts.retry?.maxAttempts ?? 1;
  let attempts = 0;

  try {
    if (!opts.retry) {
      attempts = 1;
      const signal = createProviderAttemptSignal(opts.signal, opts.timeoutMs);
      const result = await runBasetenRequest(opts, signal);
      return formatStructuredOutputResult("baseten", opts, result, attempts, maxAttempts, Date.now() - startedAt);
    }

    const result = await withProviderRetry({
      op: async (attemptSignal) => runBasetenRequest(opts, attemptSignal),
      maxAttempts: opts.retry.maxAttempts,
      perAttemptTimeoutMs: opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      callerSignal: opts.signal,
      sleep: opts.retryDependencies?.sleep,
      random: opts.retryDependencies?.random,
      abortErrorFactory: () => new StructuredOutputAbortError(),
    });

    attempts = result.attempts;
    opts.retry.onResult?.({ attempts, maxAttempts });
    return formatStructuredOutputResult("baseten", opts, result.value, attempts, maxAttempts, Date.now() - startedAt);
  } catch (error) {
    if (error instanceof StructuredOutputAbortError) throw error;
    if (opts.signal?.aborted) throw new StructuredOutputAbortError();

    attempts = getProviderRetryAttemptCount(error, attempts);
    if (!throwStructuredErrors) return null;

    throw toStructuredOutputError(
      {
        provider: "baseten",
        model: opts.model,
        toolName: opts.tool.name,
        attempts,
        maxAttempts,
        durationMs: Date.now() - startedAt,
      },
      error,
    );
  }
}

export function queryAnthropicStructuredOutput(
  opts: AnthropicStructuredOutputOptions & { returnMetadata: true },
): Promise<StructuredOutputQueryResult>;
export function queryAnthropicStructuredOutput(
  opts: AnthropicStructuredOutputOptions,
): Promise<Record<string, unknown> | null>;
export async function queryAnthropicStructuredOutput(
  opts: AnthropicStructuredOutputOptions,
): Promise<Record<string, unknown> | null | StructuredOutputQueryResult> {
  if (opts.signal?.aborted) {
    throw new StructuredOutputAbortError();
  }

  const startedAt = Date.now();
  const throwStructuredErrors = Boolean(opts.retry || opts.strictErrors);
  const maxAttempts = opts.retry?.maxAttempts ?? 1;
  let attempts = 0;

  try {
    if (!opts.retry) {
      attempts = 1;
      const signal = createProviderAttemptSignal(opts.signal, opts.timeoutMs);
      const result = await runAnthropicRequest(opts, signal);
      return formatStructuredOutputResult("anthropic", opts, result, attempts, maxAttempts, Date.now() - startedAt);
    }

    const result = await withProviderRetry({
      op: async (attemptSignal) => runAnthropicRequest(opts, attemptSignal),
      maxAttempts: opts.retry.maxAttempts,
      perAttemptTimeoutMs: opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      callerSignal: opts.signal,
      sleep: opts.retryDependencies?.sleep,
      random: opts.retryDependencies?.random,
      abortErrorFactory: () => new StructuredOutputAbortError(),
    });

    attempts = result.attempts;
    opts.retry.onResult?.({ attempts, maxAttempts });
    return formatStructuredOutputResult("anthropic", opts, result.value, attempts, maxAttempts, Date.now() - startedAt);
  } catch (error) {
    if (error instanceof StructuredOutputAbortError) throw error;
    if (opts.signal?.aborted) throw new StructuredOutputAbortError();

    attempts = getProviderRetryAttemptCount(error, attempts);
    if (!throwStructuredErrors) return null;

    throw toStructuredOutputError(
      {
        provider: "anthropic",
        model: opts.model,
        toolName: opts.tool.name,
        attempts,
        maxAttempts,
        durationMs: Date.now() - startedAt,
      },
      error,
    );
  }
}

async function runOpenAIRequest(
  opts: StructuredOutputOptions,
  signal: AbortSignal | undefined,
): Promise<{
  output: Record<string, unknown> | null;
  requestID?: string;
  usage: StructuredOutputUsage | null;
  serviceTier: string | null;
}> {
  const response = await fetchWithSpan(opts, OPENAI_RESPONSES_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model: opts.model,
      instructions: opts.systemPrompt,
      input: opts.userPrompt,
      max_output_tokens: opts.maxTokens,
      ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
      ...(opts.serviceTier ? { service_tier: opts.serviceTier } : {}),
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: opts.tool.name,
          strict: opts.tool.strict ?? true,
          schema: ensureStrictSchema(opts.tool.input_schema),
        },
      },
    }),
  });

  const requestID = getOpenAIRequestID(response.headers);
  const rawText = await readResponseText(response);

  if (!response.ok) {
    throw buildOpenAIHttpError(response.status, rawText, requestID, response.headers);
  }

  const body = parseResponseJson(rawText, "OpenAI response body was not valid JSON", {
    status: response.status,
    requestID,
    failureKind: "output_shape",
  });
  const usage = parseOpenAIUsage(body);
  return {
    output: parseOpenAIStructuredOutput(body, requestID, response.status, usage),
    requestID,
    usage,
    serviceTier: parseOpenAIServiceTier(body),
  };
}

async function runBasetenRequest(
  opts: BasetenStructuredOutputOptions,
  signal: AbortSignal | undefined,
): Promise<{
  output: Record<string, unknown> | null;
  requestID?: string;
  usage: StructuredOutputUsage | null;
  serviceTier: string | null;
}> {
  const response = await fetchWithSpan(
    opts,
    `${normalizeBaseUrl(opts.baseUrl ?? BASETEN_MODEL_API_BASE_URL)}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.systemPrompt },
          { role: "user", content: opts.userPrompt },
        ],
        max_tokens: opts.maxTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: opts.tool.name,
            strict: opts.tool.strict ?? true,
            schema: ensureStrictSchema(opts.tool.input_schema),
          },
        },
      }),
    },
  );

  const requestID = getBasetenRequestID(response.headers);
  const rawText = await readResponseText(response);

  if (!response.ok) {
    throw buildProviderHttpError("Baseten", response.status, rawText, requestID, response.headers);
  }

  const body = parseResponseJson(rawText, "Baseten response body was not valid JSON", {
    status: response.status,
    requestID,
    failureKind: "output_shape",
  });
  const usage = parseChatCompletionsUsage(body);
  return {
    output: parseBasetenStructuredOutput(body, requestID, response.status, usage),
    requestID,
    usage,
    serviceTier: null,
  };
}

async function runAnthropicRequest(
  opts: AnthropicStructuredOutputOptions,
  signal: AbortSignal | undefined,
): Promise<{
  output: Record<string, unknown> | null;
  requestID?: string;
  usage: StructuredOutputUsage | null;
  serviceTier: string | null;
}> {
  const response = await fetchWithSpan(opts, ANTHROPIC_MESSAGES_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({
      model: opts.model,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userPrompt }],
      max_tokens: opts.maxTokens,
      tools: [
        {
          name: opts.tool.name,
          description: opts.tool.description,
          input_schema: ensureStrictSchema(opts.tool.input_schema),
        },
      ],
      tool_choice: { type: "tool", name: opts.tool.name },
    }),
  });

  const requestID = getAnthropicRequestID(response.headers);
  const rawText = await readResponseText(response);

  if (!response.ok) {
    throw buildProviderHttpError("Anthropic", response.status, rawText, requestID, response.headers);
  }

  const body = parseResponseJson(rawText, "Anthropic response body was not valid JSON", {
    status: response.status,
    requestID,
    failureKind: "output_shape",
  });
  const usage = parseAnthropicUsage(body);
  return {
    output: parseAnthropicStructuredOutput(body, opts.tool.name, requestID, response.status, usage),
    requestID,
    usage,
    serviceTier: null,
  };
}

function parseOpenAIServiceTier(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const serviceTier = (body as { service_tier?: unknown }).service_tier;
  return typeof serviceTier === "string" && serviceTier.length > 0 ? serviceTier : null;
}

function formatStructuredOutputResult(
  provider: StructuredOutputProvider,
  opts: Pick<StructuredOutputOptions, "returnMetadata" | "model" | "tool">,
  result: {
    output: Record<string, unknown> | null;
    requestID?: string;
    usage: StructuredOutputUsage | null;
    serviceTier: string | null;
  },
  attempts: number,
  maxAttempts: number,
  durationMs: number,
): Record<string, unknown> | null | StructuredOutputQueryResult {
  if (!opts.returnMetadata) return result.output;
  return {
    output: result.output,
    metadata: {
      provider,
      model: opts.model,
      toolName: opts.tool.name,
      requestID: result.requestID,
      attempts,
      maxAttempts,
      durationMs,
      usage: result.usage,
      serviceTier: result.serviceTier,
    },
  };
}

function fetchWithSpan(
  opts: Pick<StructuredOutputOptions, "fetchImpl" | "spanName">,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return fetchImpl(url, init, opts.spanName);
}

function ensureStrictSchema(schema: StructuredOutputTool["input_schema"]): StructuredOutputTool["input_schema"] {
  if (schema.type !== "object" || Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
    return schema;
  }
  return { ...schema, additionalProperties: false };
}

function parseOpenAIStructuredOutput(
  body: unknown,
  requestID: string | undefined,
  status: number,
  usage: StructuredOutputUsage | null,
): Record<string, unknown> | null {
  const extraction = extractOpenAIOutputText(body);
  if (extraction.kind === "empty") {
    return null;
  }

  if (extraction.kind === "missing") {
    throw new StructuredOutputInternalError("OpenAI response missing structured output text", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }

  const parsed = parseResponseJson(extraction.outputText, "OpenAI structured output was not valid JSON", {
    status,
    requestID,
    usage,
    failureKind: "output_shape",
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StructuredOutputInternalError("OpenAI structured output was not an object", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }

  return parsed as Record<string, unknown>;
}

type OutputTextExtraction = { kind: "output"; outputText: string } | { kind: "empty" } | { kind: "missing" };

function extractOpenAIOutputText(body: unknown): OutputTextExtraction {
  if (!body || typeof body !== "object") return { kind: "missing" };
  const outputText = (body as { output_text?: unknown }).output_text;
  if (typeof outputText === "string" && outputText.trim().length > 0) {
    return { kind: "output", outputText };
  }

  if (hasOpenAIRefusal(body) || hasOpenAIIncompleteDetails(body)) {
    return { kind: "empty" };
  }

  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return { kind: "missing" };

  for (const item of output) {
    const directText = extractOpenAITextPart(item);
    if (directText) {
      return { kind: "output", outputText: directText };
    }

    if (hasOpenAIRefusal(item)) {
      return { kind: "empty" };
    }

    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const candidateText = extractOpenAITextPart(part);
      if (candidateText) {
        return { kind: "output", outputText: candidateText };
      }
      if (hasOpenAIRefusal(part)) {
        return { kind: "empty" };
      }
    }
  }

  return { kind: "missing" };
}

function extractOpenAITextPart(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { type?: unknown; text?: unknown };
  if (
    (candidate.type === "output_text" || candidate.type === "text") &&
    typeof candidate.text === "string" &&
    candidate.text.trim().length > 0
  ) {
    return candidate.text;
  }
  return undefined;
}

function hasOpenAIIncompleteDetails(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return Boolean((body as { incomplete_details?: unknown }).incomplete_details);
}

function hasOpenAIRefusal(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;

  const candidate = body as { type?: unknown; refusal?: unknown; text?: unknown };
  if (candidate.type === "refusal") {
    return true;
  }

  const refusal = (body as { refusal?: unknown }).refusal;
  if (typeof refusal === "string" && refusal.trim().length > 0) {
    return true;
  }

  return false;
}

function parseOpenAIUsage(body: unknown): StructuredOutputUsage | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const inputDetails =
    record.input_tokens_details && typeof record.input_tokens_details === "object"
      ? (record.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    record.output_tokens_details && typeof record.output_tokens_details === "object"
      ? (record.output_tokens_details as Record<string, unknown>)
      : {};
  return {
    inputTokens: nullableTokenCount(record.input_tokens),
    outputTokens: nullableTokenCount(record.output_tokens),
    totalTokens: nullableTokenCount(record.total_tokens),
    cachedInputTokens: nullableTokenCount(inputDetails.cached_tokens),
    cacheCreationInputTokens: null,
    reasoningOutputTokens: nullableTokenCount(outputDetails.reasoning_tokens),
  };
}

function parseChatCompletionsUsage(body: unknown): StructuredOutputUsage | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const promptDetails =
    record.prompt_tokens_details && typeof record.prompt_tokens_details === "object"
      ? (record.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    record.completion_tokens_details && typeof record.completion_tokens_details === "object"
      ? (record.completion_tokens_details as Record<string, unknown>)
      : {};
  return {
    inputTokens: nullableTokenCount(record.prompt_tokens),
    outputTokens: nullableTokenCount(record.completion_tokens),
    totalTokens: nullableTokenCount(record.total_tokens),
    cachedInputTokens: nullableTokenCount(promptDetails.cached_tokens),
    cacheCreationInputTokens: null,
    reasoningOutputTokens: nullableTokenCount(completionDetails.reasoning_tokens),
  };
}

function parseAnthropicUsage(body: unknown): StructuredOutputUsage | null {
  if (!body || typeof body !== "object") return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = nullableTokenCount(record.input_tokens);
  const outputTokens = nullableTokenCount(record.output_tokens);
  const cacheReadInputTokens = nullableTokenCount(record.cache_read_input_tokens);
  const cacheCreationInputTokens = nullableTokenCount(record.cache_creation_input_tokens);
  const totalTokens =
    inputTokens !== null && outputTokens !== null
      ? inputTokens + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) + outputTokens
      : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: cacheReadInputTokens,
    cacheCreationInputTokens,
    reasoningOutputTokens: null,
  };
}

function parseBasetenStructuredOutput(
  body: unknown,
  requestID: string | undefined,
  status: number,
  usage: StructuredOutputUsage | null,
): Record<string, unknown> | null {
  const extraction = extractChatCompletionsMessageContent(body);
  if (extraction.kind === "empty") {
    return null;
  }

  if (extraction.kind === "missing") {
    throw new StructuredOutputInternalError("Baseten response missing structured output content", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }

  const parsed = parseResponseJson(extraction.outputText, "Baseten structured output was not valid JSON", {
    status,
    requestID,
    usage,
    failureKind: "output_shape",
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StructuredOutputInternalError("Baseten structured output was not an object", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }

  return parsed as Record<string, unknown>;
}

function extractChatCompletionsMessageContent(body: unknown): OutputTextExtraction {
  if (!body || typeof body !== "object") return { kind: "missing" };
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return { kind: "missing" };
  if (choices.length === 0) return { kind: "empty" };
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const finishReason = (choice as { finish_reason?: unknown }).finish_reason;
    if (finishReason === "content_filter") return { kind: "empty" };
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.trim().length > 0) return { kind: "output", outputText: content };
  }
  return { kind: "missing" };
}

function parseAnthropicStructuredOutput(
  body: unknown,
  toolName: string,
  requestID: string | undefined,
  status: number,
  usage: StructuredOutputUsage | null,
): Record<string, unknown> | null {
  if (!body || typeof body !== "object") {
    throw new StructuredOutputInternalError("Anthropic response body was not an object", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }

  const stopReason = (body as { stop_reason?: unknown }).stop_reason;
  if (stopReason === "refusal") {
    throw new StructuredOutputInternalError("Anthropic response refused structured output", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }
  if (stopReason === "max_tokens") {
    throw new StructuredOutputInternalError("Anthropic response hit max_tokens before structured output completed", {
      requestID,
      status,
      usage,
      failureKind: "provider",
    });
  }

  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new StructuredOutputInternalError("Anthropic response missing content blocks", {
      requestID,
      status,
      usage,
      failureKind: "output_shape",
    });
  }

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; name?: unknown; input?: unknown };
    if (candidate.type !== "tool_use" || candidate.name !== toolName) continue;
    if (!candidate.input || typeof candidate.input !== "object" || Array.isArray(candidate.input)) {
      throw new StructuredOutputInternalError("Anthropic tool_use input was not an object", {
        requestID,
        status,
        usage,
        failureKind: "output_shape",
      });
    }
    return candidate.input as Record<string, unknown>;
  }

  throw new StructuredOutputInternalError("Anthropic response missing matching tool_use block", {
    requestID,
    status,
    usage,
    failureKind: "output_shape",
  });
}

function nullableTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function parseResponseJson(rawText: string, message: string, fields: InternalErrorFields): unknown {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new StructuredOutputInternalError(message, fields, error);
  }
}

function buildOpenAIHttpError(
  status: number,
  rawText: string,
  requestID: string | undefined,
  headers: Headers,
): StructuredOutputInternalError {
  return buildProviderHttpError("OpenAI", status, rawText, requestID, headers);
}

function buildProviderHttpError(
  providerName: string,
  status: number,
  rawText: string,
  requestID: string | undefined,
  headers: Headers,
): StructuredOutputInternalError {
  const parsed = tryParseJsonObject(rawText);
  const errorObject = parsed?.error;
  const message =
    errorObject && typeof errorObject === "object" && typeof (errorObject as { message?: unknown }).message === "string"
      ? (errorObject as { message: string }).message
      : rawText || `${providerName} API error: ${status}`;
  return new StructuredOutputInternalError(sanitizeErrorMessage(message), {
    status,
    requestID,
    headers,
    failureKind: "provider",
  });
}

function tryParseJsonObject(rawText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readResponseText(response: Response): Promise<string> {
  return response.text().catch(() => "");
}

function getOpenAIRequestID(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("openai-request-id") ?? undefined;
}

function getBasetenRequestID(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

function getAnthropicRequestID(headers: Headers): string | undefined {
  return headers.get("request-id") ?? headers.get("x-request-id") ?? undefined;
}

function toStructuredOutputError(
  fields: {
    provider: StructuredOutputProvider;
    model: string;
    toolName: string;
    attempts: number;
    maxAttempts: number;
    durationMs: number;
  },
  error: unknown,
): StructuredOutputError {
  if (error instanceof StructuredOutputInternalError) {
    return new StructuredOutputError(
      {
        ...fields,
        status: error.status,
        requestID: error.requestID,
        usage: error.usage,
        failureKind: error.failureKind,
      },
      error,
    );
  }

  return new StructuredOutputError(
    {
      ...fields,
      failureKind: "transport",
    },
    error,
  );
}

function sanitizeErrorMessage(message: string): string {
  const sanitized = (message ?? "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (sanitized.length <= ERROR_MESSAGE_MAX_LENGTH) return sanitized;
  return sanitized.slice(0, Math.max(0, ERROR_MESSAGE_MAX_LENGTH - 3)).trimEnd() + "...";
}
