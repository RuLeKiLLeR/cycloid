import { describe, expect, it, vi } from "vitest";

import { OpenAIServiceTier } from "../../shared/enums/openai-service-tier";
import {
  queryAnthropicStructuredOutput,
  queryBasetenStructuredOutput,
  queryOpenAIStructuredOutput,
  StructuredOutputAbortError,
  StructuredOutputError,
  type StructuredOutputTool,
} from "../../shared/llm/structured-output";

const TOOL: StructuredOutputTool = {
  name: "rank_items",
  description: "Rank items",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      rankings: {
        type: "array",
        items: { type: "object" },
      },
    },
    required: ["rankings"],
  },
};

function response(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("structured output helpers", () => {
  it("sends OpenAI responses request shape and parses output_text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        200,
        {
          output_text: JSON.stringify({ rankings: [{ id: "a" }] }),
        },
        { "x-request-id": "req_openai" },
      ),
    );

    const result = await queryOpenAIStructuredOutput({
      apiKey: "sk-openai",
      model: "gpt-5.4",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl,
      spanName: "openai.test",
      strictErrors: true,
    });

    expect(result).toEqual({ rankings: [{ id: "a" }] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-openai",
        }),
      }),
      "openai.test",
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body).toMatchObject({
      model: "gpt-5.4",
      instructions: "system",
      input: "user",
      max_output_tokens: 200,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "rank_items",
          strict: true,
        },
      },
    });
    expect(body.text.format.schema.additionalProperties).toBe(false);
  });

  it("includes service_tier in the request body when set and omits it otherwise", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { output_text: JSON.stringify({ rankings: [] }) }));

    await queryOpenAIStructuredOutput({
      apiKey: "sk-openai",
      model: "gpt-5.4-mini",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      serviceTier: OpenAIServiceTier.Flex,
      fetchImpl,
      strictErrors: true,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).service_tier).toBe("flex");

    const fetchNoTier = vi.fn().mockResolvedValue(response(200, { output_text: JSON.stringify({ rankings: [] }) }));
    await queryOpenAIStructuredOutput({
      apiKey: "sk-openai",
      model: "gpt-5.4-mini",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl: fetchNoTier,
      strictErrors: true,
    });
    expect(JSON.parse(String(fetchNoTier.mock.calls[0][1].body))).not.toHaveProperty("service_tier");
  });

  it("surfaces the actual returned service_tier on metadata when the provider degrades flex", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        service_tier: "default",
        output_text: JSON.stringify({ rankings: [] }),
      }),
    );

    const result = await queryOpenAIStructuredOutput({
      apiKey: "sk-openai",
      model: "gpt-5.4-mini",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      serviceTier: OpenAIServiceTier.Flex,
      fetchImpl,
      returnMetadata: true,
    });
    expect(result.metadata.serviceTier).toBe("default");
  });

  it("reports a null metadata service_tier when the response omits it", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { output_text: JSON.stringify({ rankings: [] }) }));

    const result = await queryOpenAIStructuredOutput({
      apiKey: "sk-openai",
      model: "gpt-5.4-mini",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl,
      returnMetadata: true,
    });
    expect(result.metadata.serviceTier).toBeNull();
  });

  it("parses OpenAI nested output content text", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ rankings: [] }),
              },
            ],
          },
        ],
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).resolves.toEqual({ rankings: [] });
  });

  it("parses OpenAI direct output text parts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        output: [
          {
            type: "output_text",
            text: JSON.stringify({ rankings: [{ id: "a" }] }),
          },
        ],
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).resolves.toEqual({ rankings: [{ id: "a" }] });
  });

  it("passes reasoning effort to the OpenAI responses request when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        output_text: JSON.stringify({ rankings: [] }),
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).resolves.toEqual({ rankings: [] });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("returns null for missing OpenAI tool output without strict errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        content: [{ type: "text", text: "no tool" }],
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for structured-output refusals even with strict errors enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        output: [
          {
            content: [
              {
                type: "refusal",
                refusal: "I can't help with that request.",
              },
            ],
          },
        ],
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for bare refusal parts even when message fields are omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        output: [
          {
            content: [
              {
                type: "refusal",
              },
            ],
          },
        ],
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).resolves.toBeNull();
  });

  it("returns null for incomplete structured-output responses even with strict errors enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        status: "incomplete",
        incomplete_details: {
          reason: "max_output_tokens",
        },
        output: [],
      }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).resolves.toBeNull();
  });

  it("rejects non-object structured output when strict errors are enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        200,
        {
          output_text: JSON.stringify([{ id: "not-object" }]),
        },
        { "x-request-id": "req_shape" },
      ),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputError",
      provider: "openai",
      requestID: "req_shape",
      status: 200,
      attempts: 1,
      failureKind: "output_shape",
    });
  });

  it("retries HTTP 429 and honors retry-after-ms", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onResult = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(429, { error: { message: "rate limit" } }, { "retry-after-ms": "800" }))
      .mockResolvedValueOnce(
        response(200, {
          output_text: JSON.stringify({ rankings: [] }),
        }),
      );

    const result = await queryOpenAIStructuredOutput({
      apiKey: "sk-openai",
      model: "gpt-5.4",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl,
      retry: { maxAttempts: 3, onResult },
      retryDependencies: { sleep, random: () => 0.5 },
    });

    expect(result).toEqual({ rankings: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith({ attempts: 2, maxAttempts: 3 });
    expect(sleep).toHaveBeenCalledWith(800, expect.any(AbortSignal));
  });

  it("does not retry normal 4xx provider errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(401, { error: { message: "bad key" } }));

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        retry: { maxAttempts: 3 },
        retryDependencies: { sleep: vi.fn(), random: () => 0.5 },
      }),
    ).rejects.toMatchObject({
      provider: "openai",
      status: 401,
      attempts: 1,
      maxAttempts: 3,
      failureKind: "provider",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses per-attempt timeout signals", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason ?? new DOMException("timeout", "TimeoutError"));
            },
            { once: true },
          );
        }),
    );

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        timeoutMs: 1,
        retry: { maxAttempts: 1 },
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it("retries per-attempt timeout errors up to maxAttempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onResult = vi.fn();
    let attempts = 0;
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      attempts += 1;
      if (attempts >= 3) {
        return Promise.resolve(
          response(200, {
            output_text: JSON.stringify({ rankings: [{ id: "recovered" }] }),
          }),
        );
      }

      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(init.signal?.reason ?? new DOMException("timeout", "TimeoutError"));
          },
          { once: true },
        );
      });
    });

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        timeoutMs: 1,
        retry: { maxAttempts: 3, onResult },
        retryDependencies: { sleep, random: () => 0.5 },
      }),
    ).resolves.toEqual({ rankings: [{ id: "recovered" }] });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith({ attempts: 3, maxAttempts: 3 });
  });

  it("does not start a request when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    await expect(
      queryOpenAIStructuredOutput({
        apiKey: "sk-openai",
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        signal: controller.signal,
        retry: { maxAttempts: 3 },
      }),
    ).rejects.toBeInstanceOf(StructuredOutputAbortError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends Baseten chat completions request shape and parses message content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        200,
        {
          choices: [{ message: { content: JSON.stringify({ rankings: [{ id: "b" }] }) } }],
          usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
        },
        { "x-request-id": "req_baseten" },
      ),
    );

    const result = await queryBasetenStructuredOutput({
      apiKey: "bt-test",
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl,
      spanName: "baseten.test",
      strictErrors: true,
      returnMetadata: true,
    });

    expect(result.output).toEqual({ rankings: [{ id: "b" }] });
    expect(result.metadata).toMatchObject({
      provider: "baseten",
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      requestID: "req_baseten",
      serviceTier: null,
      usage: {
        inputTokens: 120,
        outputTokens: 12,
        totalTokens: 132,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://inference.baseten.co/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer bt-test",
        }),
      }),
      "baseten.test",
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body).toMatchObject({
      model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 200,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "rank_items",
          strict: true,
        },
      },
    });
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it("uses an overridden Baseten base URL without double slashes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, {
        choices: [{ message: { content: JSON.stringify({ rankings: [] }) } }],
      }),
    );

    await queryBasetenStructuredOutput({
      apiKey: "bt-test",
      baseUrl: "https://model-abc.api.baseten.co/environments/production/predict/",
      model: "ignored-for-dedicated-deployment",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl,
      strictErrors: true,
    });

    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://model-abc.api.baseten.co/environments/production/predict/chat/completions",
    );
  });

  it("returns null for empty Baseten structured-output responses even with strict errors enabled", async () => {
    const emptyChoicesFetch = vi.fn().mockResolvedValue(
      response(200, {
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 },
      }),
    );

    await expect(
      queryBasetenStructuredOutput({
        apiKey: "bt-test",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: emptyChoicesFetch,
        strictErrors: true,
      }),
    ).resolves.toBeNull();

    const contentFilterFetch = vi.fn().mockResolvedValue(
      response(200, {
        choices: [{ finish_reason: "content_filter", message: { content: "" } }],
        usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 },
      }),
    );

    await expect(
      queryBasetenStructuredOutput({
        apiKey: "bt-test",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: contentFilterFetch,
        strictErrors: true,
      }),
    ).resolves.toBeNull();
  });

  it("rejects malformed Baseten output with usage attached", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        200,
        {
          choices: [{ message: { content: "[1,2,3]" } }],
          usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 },
        },
        { "request-id": "req_bad_baseten" },
      ),
    );

    await expect(
      queryBasetenStructuredOutput({
        apiKey: "bt-test",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        strictErrors: true,
      }),
    ).rejects.toMatchObject({
      name: "StructuredOutputError",
      provider: "baseten",
      requestID: "req_bad_baseten",
      status: 200,
      failureKind: "output_shape",
      usage: {
        inputTokens: 120,
        outputTokens: 12,
        totalTokens: 132,
      },
    });
  });

  it("retries transient Baseten provider errors and reports exhausted attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(500, { error: { message: "temporarily unavailable" } }))
      .mockResolvedValueOnce(
        response(200, {
          choices: [{ message: { content: JSON.stringify({ rankings: [] }) } }],
        }),
      );

    await expect(
      queryBasetenStructuredOutput({
        apiKey: "bt-test",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        retry: { maxAttempts: 2 },
        retryDependencies: { sleep, random: () => 0.5 },
      }),
    ).resolves.toEqual({ rankings: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const exhaustedFetch = vi.fn().mockResolvedValue(response(500, { error: { message: "still down" } }));
    await expect(
      queryBasetenStructuredOutput({
        apiKey: "bt-test",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: exhaustedFetch,
        retry: { maxAttempts: 2 },
        retryDependencies: { sleep, random: () => 0.5 },
      }),
    ).rejects.toMatchObject({
      provider: "baseten",
      status: 500,
      attempts: 2,
      maxAttempts: 2,
      failureKind: "provider",
    });
  });

  it("sends Anthropic messages request shape and parses the matching tool_use input", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(
        200,
        {
          id: "msg_1",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "ignored" },
            { type: "tool_use", name: "other_tool", input: { rankings: [{ id: "wrong" }] } },
            { type: "tool_use", name: "rank_items", input: { rankings: [{ id: "c" }] } },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
        { "request-id": "req_anthropic" },
      ),
    );

    const result = await queryAnthropicStructuredOutput({
      apiKey: "sk-ant",
      model: "claude-sonnet-4-6",
      tool: TOOL,
      systemPrompt: "system",
      userPrompt: "user",
      maxTokens: 200,
      fetchImpl,
      spanName: "anthropic.test",
      strictErrors: true,
      returnMetadata: true,
    });

    expect(result.output).toEqual({ rankings: [{ id: "c" }] });
    expect(result.metadata).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      requestID: "req_anthropic",
      serviceTier: null,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 160,
        cachedInputTokens: 30,
        cacheCreationInputTokens: 10,
        reasoningOutputTokens: null,
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "sk-ant",
          "anthropic-version": "2023-06-01",
        }),
      }),
      "anthropic.test",
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body).toMatchObject({
      model: "claude-sonnet-4-6",
      system: "system",
      messages: [{ role: "user", content: "user" }],
      max_tokens: 200,
      tools: [
        {
          name: "rank_items",
          description: "Rank items",
        },
      ],
      tool_choice: { type: "tool", name: "rank_items" },
    });
    expect(body.tools[0].input_schema.additionalProperties).toBe(false);
  });

  it("classifies Anthropic refusal and max_tokens stop reasons distinctly", async () => {
    await expect(
      queryAnthropicStructuredOutput({
        apiKey: "sk-ant",
        model: "claude-sonnet-4-6",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: vi.fn().mockResolvedValue(
          response(200, {
            stop_reason: "refusal",
            content: [],
            usage: { input_tokens: 10, output_tokens: 1 },
          }),
        ),
        strictErrors: true,
      }),
    ).rejects.toMatchObject({
      provider: "anthropic",
      failureKind: "output_shape",
      usage: { inputTokens: 10, outputTokens: 1 },
    });

    await expect(
      queryAnthropicStructuredOutput({
        apiKey: "sk-ant",
        model: "claude-sonnet-4-6",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: vi.fn().mockResolvedValue(
          response(200, {
            stop_reason: "max_tokens",
            content: [],
            usage: { input_tokens: 10, output_tokens: 200 },
          }),
        ),
        strictErrors: true,
      }),
    ).rejects.toMatchObject({
      provider: "anthropic",
      failureKind: "provider",
      usage: { inputTokens: 10, outputTokens: 200 },
    });
  });

  it("rejects Anthropic responses without a matching tool_use block", async () => {
    await expect(
      queryAnthropicStructuredOutput({
        apiKey: "sk-ant",
        model: "claude-sonnet-4-6",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: vi.fn().mockResolvedValue(
          response(200, {
            stop_reason: "tool_use",
            content: [{ type: "tool_use", name: "wrong_tool", input: { rankings: [] } }],
          }),
        ),
        strictErrors: true,
      }),
    ).rejects.toMatchObject({
      provider: "anthropic",
      failureKind: "output_shape",
    });
  });

  it("retries transient Anthropic provider errors and reports exhausted attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(529, { error: { message: "overloaded" } }))
      .mockResolvedValueOnce(
        response(200, {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "rank_items", input: { rankings: [] } }],
        }),
      );

    await expect(
      queryAnthropicStructuredOutput({
        apiKey: "sk-ant",
        model: "claude-sonnet-4-6",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl,
        retry: { maxAttempts: 2 },
        retryDependencies: { sleep, random: () => 0.5 },
      }),
    ).resolves.toEqual({ rankings: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const exhaustedFetch = vi.fn().mockResolvedValue(response(529, { error: { message: "still overloaded" } }));
    await expect(
      queryAnthropicStructuredOutput({
        apiKey: "sk-ant",
        model: "claude-sonnet-4-6",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 200,
        fetchImpl: exhaustedFetch,
        retry: { maxAttempts: 2 },
        retryDependencies: { sleep, random: () => 0.5 },
      }),
    ).rejects.toMatchObject({
      provider: "anthropic",
      status: 529,
      attempts: 2,
      maxAttempts: 2,
      failureKind: "provider",
    });
  });
});
