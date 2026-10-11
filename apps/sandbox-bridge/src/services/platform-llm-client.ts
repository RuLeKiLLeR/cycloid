import { hasTimeoutLikeCause, ProviderUserAbortError } from "../../../../shared/llm/errors.js";
import type {
  PlatformLlmCallType,
  PlatformLlmCapability,
  PlatformLlmFailureCategory,
  PlatformLlmFailureDetails,
  PlatformLlmPhase,
  PlatformLlmResponse,
} from "../../../../shared/llm/platform-llm-contract.js";
import { stringifyError } from "../../../../shared/utils/errors.js";

export type PlatformLlmClientProvider = "platform_llm_broker" | "openai";

export type BridgeStructuredOutputTool = {
  name: string;
};

interface BridgeStructuredOutputOptions {
  callType: PlatformLlmCallType;
  phase?: PlatformLlmPhase;
  input?: unknown;
  platformInput?: unknown;
  tool?: BridgeStructuredOutputTool;
  toolName?: string;
  systemPrompt?: string;
  userPrompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  retry?: unknown;
  signal?: AbortSignal;
}

export interface BridgeStructuredOutputClient {
  generateStructuredOutput(opts: BridgeStructuredOutputOptions): Promise<Record<string, unknown> | null>;
  getModel(): string;
  getProvider(): PlatformLlmClientProvider;
  getLastAttempts?(): number | undefined;
}

export class PlatformLlmBrokerError extends Error {
  readonly platformLlmCategory: PlatformLlmFailureCategory;
  readonly status: number;
  readonly attempts: number;
  readonly durationMs: number;
  readonly model?: string;
  readonly toolName: string;
  readonly details?: PlatformLlmFailureDetails;

  constructor(fields: {
    category: PlatformLlmFailureCategory;
    status: number;
    attempts: number;
    durationMs: number;
    model?: string;
    toolName: string;
    details?: PlatformLlmFailureDetails;
    message?: string;
    cause?: unknown;
  }) {
    super(fields.message ?? `PlatformLlmBrokerError ${fields.category} status=${fields.status}`);
    this.name = "PlatformLlmBrokerError";
    if (fields.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = fields.cause;
    }
    this.platformLlmCategory = fields.category;
    this.status = fields.status;
    this.attempts = fields.attempts;
    this.durationMs = fields.durationMs;
    this.model = fields.model;
    this.toolName = fields.toolName;
    this.details = fields.details;
  }
}

interface PlatformLlmBrokerClientOptions {
  controlPlaneUrl: string;
  sessionId: string;
  getAuthToken: () => string;
  capability: PlatformLlmCapability;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export type PlatformLlmFallbackCategory =
  | "timeout"
  | "rate_limited"
  | "provider_5xx"
  | "provider_4xx"
  | "output_shape"
  | "output_too_large"
  | "transport"
  | "unknown";

function normalizeControlPlaneUrl(raw: string): string {
  const withScheme = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", abort);
    }
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      return controller.signal;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof ProviderUserAbortError || (error instanceof Error && error.name === "AbortError");
}

function defaultFailureBody(
  callType: PlatformLlmCallType,
  category: PlatformLlmFailureCategory,
): PlatformLlmResponse<never> {
  return {
    ok: false,
    category,
    attempts: 0,
    durationMs: 0,
    toolName: `platform_llm_${callType}`,
  };
}

function platformFailureCategoryForTransportError(error: unknown): PlatformLlmFailureCategory {
  const category = platformLlmFallbackCategory(error);
  if (category === "timeout") return "provider_timeout";
  if (category === "provider_4xx") return "provider_error_nonretryable";
  if (category === "output_shape") return "output_shape";
  if (category === "output_too_large") return "output_too_large";
  if (category === "rate_limited") return "budget_exhausted";
  return "provider_error_retryable";
}

export function platformLlmFallbackCategory(error: unknown): PlatformLlmFallbackCategory {
  const platformCategory = (error as { platformLlmCategory?: unknown } | null)?.platformLlmCategory;
  if (typeof platformCategory === "string") {
    const status = (error as { status?: unknown } | null)?.status;
    if (platformCategory === "output_shape") return "output_shape";
    if (platformCategory === "output_too_large") return "output_too_large";
    if (hasTimeoutLikeCause(error) || status === 408) return "timeout";
    if (status === 429) return "rate_limited";
    if (typeof status === "number" && status >= 500) return "provider_5xx";
    if (platformCategory === "provider_timeout") return "timeout";
    if (platformCategory === "provider_error_retryable") return "transport";
    if (platformCategory === "provider_error_nonretryable") return "provider_4xx";
    if (platformCategory === "budget_exhausted") return "rate_limited";
    if (
      platformCategory === "capability_invalid" ||
      platformCategory === "capability_expired" ||
      platformCategory === "capability_consumed" ||
      platformCategory === "wrong_phase" ||
      platformCategory === "wrong_call_type" ||
      platformCategory === "input_too_large"
    ) {
      return "transport";
    }
    return "unknown";
  }

  return hasTimeoutLikeCause(error) ? "timeout" : "unknown";
}

export class PlatformLlmBrokerClient implements BridgeStructuredOutputClient {
  private readonly controlPlaneUrl: string;
  private readonly sessionId: string;
  private readonly getAuthToken: () => string;
  private readonly capability: PlatformLlmCapability;
  private readonly fetchImpl: typeof fetch;
  private readonly signal?: AbortSignal;
  private lastModel = "platform-broker";
  private lastAttempts: number | undefined;

  constructor(options: PlatformLlmBrokerClientOptions) {
    this.controlPlaneUrl = normalizeControlPlaneUrl(options.controlPlaneUrl);
    this.sessionId = options.sessionId;
    this.getAuthToken = options.getAuthToken;
    this.capability = options.capability;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.signal = options.signal;
  }

  getModel(): string {
    return this.lastModel;
  }

  getProvider(): PlatformLlmClientProvider {
    return "platform_llm_broker";
  }

  getLastAttempts(): number | undefined {
    return this.lastAttempts;
  }

  async generateStructuredOutput(opts: BridgeStructuredOutputOptions): Promise<Record<string, unknown> | null> {
    const callType = opts.callType;
    const input = opts.platformInput ?? opts.input;
    const toolName = opts.tool?.name ?? opts.toolName ?? `platform_llm_${callType}`;
    if (!callType || callType !== this.capability.callType) {
      throw new PlatformLlmBrokerError({
        category: "wrong_call_type",
        status: 409,
        attempts: 0,
        durationMs: 0,
        toolName,
      });
    }

    // Callers may omit phase to inherit the one authorized by the capability.
    // If they provide a phase explicitly, it must match the capability.
    const phase = opts.phase ?? this.capability.phase;
    if (phase !== this.capability.phase) {
      throw new PlatformLlmBrokerError({
        category: "wrong_phase",
        status: 409,
        attempts: 0,
        durationMs: 0,
        toolName,
      });
    }

    const requestSignal = combineSignals([this.signal, opts.signal]);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(phase), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.getAuthToken()}`,
          "content-type": "application/json",
          "x-platform-llm-capability": this.capability.token,
        },
        body: JSON.stringify({
          callType,
          phase: this.capability.phase,
          input,
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal?.aborted) {
        if (isAbortError(error)) throw error;
        const abortError = new ProviderUserAbortError();
        (abortError as Error & { cause?: unknown }).cause = error;
        throw abortError;
      }
      if (isAbortError(error)) throw error;
      throw new PlatformLlmBrokerError({
        category: platformFailureCategoryForTransportError(error),
        status: 0,
        attempts: 0,
        durationMs: Date.now() - startedAt,
        model: this.lastModel,
        toolName,
        message: stringifyError(error),
        cause: error,
      });
    }

    const envelope = await this.parseResponse(response, callType, toolName);
    if (!envelope.ok) {
      throw new PlatformLlmBrokerError({
        category: envelope.category,
        status: response.status,
        attempts: envelope.attempts,
        durationMs: envelope.durationMs,
        model: envelope.model,
        toolName: envelope.toolName,
        details: envelope.details,
      });
    }

    this.lastModel = envelope.model;
    this.lastAttempts = envelope.attempts;
    return envelope.data;
  }

  private endpoint(phase: PlatformLlmPhase): string {
    const path = phase === "post_execution" ? "post-execution" : "prompt-preparation";
    return `${this.controlPlaneUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/platform-llm/${path}`;
  }

  private async parseResponse(
    response: Response,
    callType: PlatformLlmCallType,
    fallbackToolName: string,
  ): Promise<PlatformLlmResponse<Record<string, unknown>>> {
    try {
      const parsed = (await response.json()) as PlatformLlmResponse<Record<string, unknown>>;
      if (parsed && typeof parsed === "object" && "ok" in parsed) {
        return parsed.ok
          ? parsed
          : {
              ...parsed,
              toolName: parsed.toolName || fallbackToolName,
            };
      }
    } catch {
      // Fall through to a typed broker failure below.
    }
    return {
      ...defaultFailureBody(callType, response.status >= 500 ? "provider_error_retryable" : "capability_invalid"),
      toolName: fallbackToolName,
    };
  }
}

export function findPlatformLlmCapability(
  capabilities: PlatformLlmCapability[] | undefined,
  callType: PlatformLlmCallType,
  phase?: PlatformLlmPhase,
): PlatformLlmCapability | undefined {
  return capabilities?.find(
    (capability) => capability.callType === callType && (phase === undefined || capability.phase === phase),
  );
}
