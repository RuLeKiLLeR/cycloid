import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAIModel } from "../../shared/constants/models";

const mockPostStructuredEventToDd = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

import { resolveRepoFromTextContext } from "../../apps/control-plane-worker/src/services/repo-resolver";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

describe("resolveRepoFromTextContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPostStructuredEventToDd.mockReset();
    mockPostStructuredEventToDd.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to deterministic repo resolution when the model call fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "api_error", message: "overloaded" } }), {
        status: 500,
        headers: { "Content-Type": "application/json", "x-request-id": "req-test" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    const waitUntil = vi.fn();
    const result = await resolveRepoFromTextContext({
      env: {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        DD_API_KEY: "dd-test",
        DD_SITE: "datadoghq.com",
        WORKER_ENV: "test",
      },
      context: {
        source: "slack",
        triggerText: "Can you look into this?",
      },
      candidates: [{ repoOwner: "trycycloid", repoName: "cycloid" }],
      logger,
      waitUntil,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      status: "unknown",
      confidence: 0,
      reason: "No deterministic repository match was found.",
      llmFailure: "provider_5xx",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "llm_call.completed",
        action: "repo_resolution.model_fallback",
        metric: "repo_resolution.model_fallback",
        count: 1,
        callType: "repo_resolution",
        outcome: "failure",
        fallback: "deterministic",
        provider: "openai",
        model: expect.any(String),
        failureCategory: "provider_5xx",
        failureKind: "provider",
        status: 500,
        attempts: 3,
        maxAttempts: 3,
        durationMs: expect.any(Number),
        requestId: "req-test",
        error: expect.stringContaining("StructuredOutputError"),
      }),
      "Repo resolution model failed",
    );
    expect(mockPostStructuredEventToDd).toHaveBeenCalledWith(
      expect.objectContaining({ DD_API_KEY: "dd-test", DD_SITE: "datadoghq.com", WORKER_ENV: "test" }),
      expect.objectContaining({
        event: "llm_call.completed",
        metric: "repo_resolution.model_fallback",
        count: 1,
        callType: "repo_resolution",
        outcome: "failure",
        provider: "openai",
        model: expect.any(String),
        failureCategory: "provider_5xx",
        failureKind: "provider",
        status: 500,
        attempts: 3,
        maxAttempts: 3,
        requestId: "req-test",
      }),
    );
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0][0];
  });

  it("surfaces llmFailure=rate_limited when the model keeps returning 429", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "x-request-id": "req-rate" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    const result = await resolveRepoFromTextContext({
      env: {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        DD_API_KEY: "dd-test",
        DD_SITE: "datadoghq.com",
        WORKER_ENV: "test",
      },
      context: { source: "slack", triggerText: "Hey look at something" },
      candidates: [{ repoOwner: "trycycloid", repoName: "cycloid" }],
      logger,
    });

    expect(result).toEqual({
      status: "unknown",
      confidence: 0,
      reason: "No deterministic repository match was found.",
      llmFailure: "rate_limited",
    });
  });

  it("surfaces llmFailure=auth when the model returns 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json", "x-request-id": "req-auth" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    const result = await resolveRepoFromTextContext({
      env: {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        DD_API_KEY: "dd-test",
        DD_SITE: "datadoghq.com",
        WORKER_ENV: "test",
      },
      context: { source: "slack", triggerText: "Hey look at something" },
      candidates: [{ repoOwner: "trycycloid", repoName: "cycloid" }],
      logger,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "unknown",
      confidence: 0,
      reason: "No deterministic repository match was found.",
      llmFailure: "auth",
    });
  });

  it("uses the fast Linear resolver model and retry budget in linear mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: "api_error", message: "overloaded" } }), {
        status: 500,
        headers: { "Content-Type": "application/json", "x-request-id": "req-linear" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    const result = await resolveRepoFromTextContext({
      env: {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        DD_API_KEY: "dd-test",
        DD_SITE: "datadoghq.com",
        WORKER_ENV: "test",
      },
      context: { source: "linear", triggerText: "Investigate the ambiguous Linear issue" },
      candidates: [{ repoOwner: "trycycloid", repoName: "cycloid" }],
      logger,
      mode: "linear",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestBody.model).toBe(OpenAIModel.GPT54Mini);
    expect(requestBody.reasoning).toEqual({ effort: "low" });
    expect(result).toEqual({
      status: "unknown",
      confidence: 0,
      reason: "No deterministic repository match was found.",
      llmFailure: "provider_5xx",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: OpenAIModel.GPT54Mini,
        mode: "linear",
        attempts: 3,
        maxAttempts: 3,
        requestId: "req-linear",
      }),
      "Repo resolution model failed",
    );
  });

  it("retries a transient provider failure before using the model match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json", "x-request-id": "req-rate-limited" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              status: "matched",
              repoOwner: "trycycloid",
              repoName: "cycloid",
              confidence: 0.91,
              reason: "The task is about Cycloid repo inference.",
              candidates: [],
            }),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json", "request-id": "req-success" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    const result = await resolveRepoFromTextContext({
      env: {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        DD_API_KEY: "dd-test",
        DD_SITE: "datadoghq.com",
        WORKER_ENV: "test",
      },
      context: {
        source: "slack",
        triggerText: "Inspect Slack repo inference",
      },
      candidates: [{ repoOwner: "trycycloid", repoName: "cycloid" }],
      logger,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      status: "matched",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      confidence: 0.91,
      reason: "The task is about Cycloid repo inference.",
    });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), "Repo resolution model failed");
    expect(mockPostStructuredEventToDd).not.toHaveBeenCalled();
  });

  it("does not emit LLM completion telemetry for deterministic matches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const logger = createLogger();
    const result = await resolveRepoFromTextContext({
      env: {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        DD_API_KEY: "dd-test",
        DD_SITE: "datadoghq.com",
        WORKER_ENV: "test",
      },
      context: {
        source: "slack",
        triggerText: "Please check trycycloid/cycloid for this.",
      },
      candidates: [{ repoOwner: "trycycloid", repoName: "cycloid" }],
      logger,
    });

    expect(result).toEqual({
      status: "matched",
      repoOwner: "trycycloid",
      repoName: "cycloid",
      confidence: 1,
      reason: "The context explicitly mentioned this repository.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "llm_call.completed" }),
      expect.any(String),
    );
  });
});
