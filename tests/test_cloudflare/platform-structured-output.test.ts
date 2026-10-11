import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Logger } from "../../apps/control-plane-worker/src/logger";
import { queryPlatformStructuredOutput } from "../../apps/control-plane-worker/src/services/platform-structured-output";
import { OpenAIServiceTier } from "../../shared/enums/openai-service-tier";
import type { StructuredOutputTool } from "../../shared/llm/structured-output";

const TOOL: StructuredOutputTool = {
  name: "test_tool",
  description: "Return a test value",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" } },
    required: ["value"],
  },
};

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function response(body: Record<string, unknown>, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_test",
      ...(init?.headers ?? {}),
    },
  });
}

describe("platform structured output wrapper", () => {
  it("emits usage and pricing metadata on success", async () => {
    const events: Record<string, unknown>[] = [];
    const logger = createMockLogger();
    const result = await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      {
        model: "gpt-5.4-mini",
        reasoningEffort: "low",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        timeoutMs: 1_000,
        strictErrors: true,
      },
      {
        subsystem: "test_subsystem",
        callType: "test_call",
        phase: "background",
        sourceId: "test-source",
        businessId: "biz-1",
      },
      {
        logger,
        emitUsageEvent: async (_eventId, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response({
            output_text: JSON.stringify({ value: "ok" }),
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens_details: { reasoning_tokens: 3 },
            },
          }),
      },
    );

    expect(result).toEqual({ value: "ok" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "platform_llm.usage_event",
      version: 1,
      subsystem: "test_subsystem",
      callType: "test_call",
      phase: "background",
      sourceId: "test-source",
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      requestId: "req_test",
      outcome: "success",
      businessId: "biz-1",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedInputTokens: 40,
        reasoningOutputTokens: 3,
      },
      costUsdMicros: 93,
    });
    expect(logger.info).toHaveBeenCalledWith(events[0], "Platform LLM usage event");
  });

  it("emits canonical standard tiers and standard pricing when flex is not requested", async () => {
    const events: Record<string, unknown>[] = [];
    await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      {
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        strictErrors: true,
      },
      { subsystem: "s", callType: "c", phase: "background", sourceId: "src" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_id, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response({
            output_text: JSON.stringify({ value: "ok" }),
            usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
          }),
      },
    );

    expect(events[0]).toMatchObject({
      requestedServiceTier: "standard",
      serviceTier: "standard",
      costUsdMicros: 93,
    });
  });

  it("records flex requested+actual tiers and flex pricing when the provider serves flex", async () => {
    const events: Record<string, unknown>[] = [];
    let requestBody: Record<string, unknown> = {};
    await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      {
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        serviceTier: OpenAIServiceTier.Flex,
        strictErrors: true,
      },
      { subsystem: "s", callType: "c", phase: "background", sourceId: "src" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_id, event) => {
          events.push(event);
        },
        fetchImpl: async (_url, init) => {
          requestBody = JSON.parse(String((init as RequestInit).body));
          return response({
            service_tier: "flex",
            output_text: JSON.stringify({ value: "ok" }),
            usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
          });
        },
      },
    );

    expect(requestBody.service_tier).toBe("flex");
    expect(events[0]).toMatchObject({
      requestedServiceTier: "flex",
      serviceTier: "flex",
      // Flat 50% off the standard 93 micros for this usage.
      costUsdMicros: 47,
    });
  });

  it("prices by the actual returned tier when the provider degrades flex to default", async () => {
    const events: Record<string, unknown>[] = [];
    await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      {
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        serviceTier: OpenAIServiceTier.Flex,
        strictErrors: true,
      },
      { subsystem: "s", callType: "c", phase: "background", sourceId: "src" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_id, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response({
            service_tier: "default",
            output_text: JSON.stringify({ value: "ok" }),
            usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 40 } },
          }),
      },
    );

    expect(events[0]).toMatchObject({
      requestedServiceTier: "flex",
      // Asked flex, got default: priced and attributed at standard.
      serviceTier: "standard",
      costUsdMicros: 93,
    });
  });

  it("emits a success event when provider usage is absent", async () => {
    const events: Record<string, unknown>[] = [];
    const result = await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      {
        model: "gpt-5.4-mini",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        strictErrors: true,
      },
      { subsystem: "test", callType: "no_usage", phase: "background", sourceId: "source" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_eventId, event) => {
          events.push(event);
        },
        fetchImpl: async () => response({ output_text: JSON.stringify({ value: "ok" }) }),
      },
    );

    expect(result).toEqual({ value: "ok" });
    expect(events[0]).toMatchObject({ outcome: "success", usage: null, costUsdMicros: null });
  });

  it("emits Baseten usage and pricing metadata with null service tiers", async () => {
    const events: Record<string, unknown>[] = [];
    const result = await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test", ARCANIST_BASETEN_API_KEY: "bt-test" },
      {
        provider: "baseten",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        strictErrors: true,
      },
      { subsystem: "test", callType: "baseten", phase: "background", sourceId: "source" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_eventId, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response(
            {
              choices: [{ message: { content: JSON.stringify({ value: "ok" }) } }],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            },
            { headers: { "x-request-id": "req_baseten" } },
          ),
      },
    );

    expect(result).toEqual({ value: "ok" });
    expect(events[0]).toMatchObject({
      provider: "baseten",
      requestedServiceTier: null,
      serviceTier: null,
      reasoningEffort: null,
      requestId: "req_baseten",
      outcome: "success",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      },
      costUsdMicros: 150,
      pricingUnavailableReason: null,
    });
  });

  it("emits Baseten pricing-unavailable metadata for dedicated deployment URLs", async () => {
    const events: Record<string, unknown>[] = [];
    await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test", ARCANIST_BASETEN_API_KEY: "bt-test" },
      {
        provider: "baseten",
        baseUrl: "https://model-abc.api.baseten.co/environments/production/predict",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        strictErrors: true,
      },
      { subsystem: "test", callType: "baseten_dedicated", phase: "background", sourceId: "source" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_eventId, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response({
            choices: [{ message: { content: JSON.stringify({ value: "ok" }) } }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
      },
    );

    expect(events[0]).toMatchObject({
      provider: "baseten",
      costUsdMicros: null,
      pricing: null,
      pricingUnavailableReason: "dedicated_deployment_gpu_minute",
    });
  });

  it("emits Baseten cost metadata using cached-token pricing", async () => {
    const events: Record<string, unknown>[] = [];
    await queryPlatformStructuredOutput(
      { ARCANIST_OPENAI_API_KEY: "sk-test", ARCANIST_BASETEN_API_KEY: "bt-test" },
      {
        provider: "baseten",
        model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        strictErrors: true,
      },
      { subsystem: "test", callType: "baseten_cached", phase: "background", sourceId: "source" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_eventId, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response({
            choices: [{ message: { content: JSON.stringify({ value: "ok" }) } }],
            usage: {
              prompt_tokens: 1_000_000,
              completion_tokens: 100_000,
              total_tokens: 1_100_000,
              prompt_tokens_details: { cached_tokens: 250_000 },
            },
          }),
      },
    );

    expect(events[0]).toMatchObject({
      provider: "baseten",
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
        cachedInputTokens: 250_000,
      },
      costUsdMicros: 1_300_000,
      pricingUnavailableReason: null,
    });
  });

  it("emits Anthropic usage and pricing metadata with cache creation tokens", async () => {
    const events: Record<string, unknown>[] = [];
    const result = await queryPlatformStructuredOutput(
      {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        ARCANIST_BASETEN_API_KEY: "bt-test",
        ARCANIST_ANTHROPIC_API_KEY: "sk-ant",
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        tool: TOOL,
        systemPrompt: "system",
        userPrompt: "user",
        maxTokens: 50,
        strictErrors: true,
      },
      { subsystem: "test", callType: "anthropic", phase: "background", sourceId: "source" },
      {
        logger: createMockLogger(),
        emitUsageEvent: async (_eventId, event) => {
          events.push(event);
        },
        fetchImpl: async () =>
          response(
            {
              stop_reason: "tool_use",
              content: [{ type: "tool_use", name: "test_tool", input: { value: "ok" } }],
              usage: {
                input_tokens: 100,
                output_tokens: 10,
                cache_read_input_tokens: 30,
                cache_creation_input_tokens: 20,
              },
            },
            { headers: { "request-id": "req_anthropic" } },
          ),
      },
    );

    expect(result).toEqual({ value: "ok" });
    expect(events[0]).toMatchObject({
      provider: "anthropic",
      requestedServiceTier: null,
      serviceTier: null,
      requestId: "req_anthropic",
      outcome: "success",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 160,
        cachedInputTokens: 30,
        cacheCreationInputTokens: 20,
        reasoningOutputTokens: null,
      },
      costUsdMicros: 534,
      pricingUnavailableReason: null,
    });
  });

  it("emits provider failure metadata and rethrows provider errors", async () => {
    const events: Record<string, unknown>[] = [];
    await expect(
      queryPlatformStructuredOutput(
        { ARCANIST_OPENAI_API_KEY: "sk-test" },
        {
          model: "gpt-5.4-mini",
          tool: TOOL,
          systemPrompt: "system",
          userPrompt: "user",
          maxTokens: 50,
          strictErrors: true,
        },
        { subsystem: "test", callType: "provider_error", phase: "background", sourceId: "source" },
        {
          logger: createMockLogger(),
          emitUsageEvent: async (_eventId, event) => {
            events.push(event);
          },
          fetchImpl: async () =>
            response(
              { error: { message: "provider unavailable" } },
              { status: 500, headers: { "x-request-id": "req_500" } },
            ),
        },
      ),
    ).rejects.toThrow("StructuredOutputError");

    expect(events[0]).toMatchObject({
      outcome: "failure",
      failureCategory: "provider",
      status: 500,
      requestId: "req_500",
      usage: null,
    });
  });

  it("emits usage and pricing metadata when structured output parsing fails", async () => {
    const events: Record<string, unknown>[] = [];
    await expect(
      queryPlatformStructuredOutput(
        { ARCANIST_OPENAI_API_KEY: "sk-test" },
        {
          model: "gpt-5.4-mini",
          tool: TOOL,
          systemPrompt: "system",
          userPrompt: "user",
          maxTokens: 50,
          strictErrors: true,
        },
        { subsystem: "test", callType: "bad_output", phase: "background", sourceId: "source" },
        {
          logger: createMockLogger(),
          emitUsageEvent: async (_eventId, event) => {
            events.push(event);
          },
          fetchImpl: async () =>
            response({
              output_text: "[not-an-object]",
              usage: {
                input_tokens: 100,
                output_tokens: 10,
                total_tokens: 110,
                input_tokens_details: { cached_tokens: 40 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            }),
        },
      ),
    ).rejects.toThrow("StructuredOutputError");

    expect(events[0]).toMatchObject({
      outcome: "failure",
      failureCategory: "output_shape",
      requestId: "req_test",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cachedInputTokens: 40,
        reasoningOutputTokens: 3,
      },
      costUsdMicros: 93,
    });
  });

  it("emits a failure event before provider calls when the API key is missing", async () => {
    const events: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn();
    await expect(
      queryPlatformStructuredOutput(
        { ARCANIST_OPENAI_API_KEY: "" },
        {
          model: "gpt-5.4-mini",
          tool: TOOL,
          systemPrompt: "system",
          userPrompt: "user",
          maxTokens: 50,
          strictErrors: true,
        },
        { subsystem: "test", callType: "missing_key", phase: "background", sourceId: "source" },
        {
          logger: createMockLogger(),
          fetchImpl,
          emitUsageEvent: async (_eventId, event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow("API key is missing");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      outcome: "failure",
      failureCategory: "missing_api_key",
      attempts: 0,
      usage: null,
    });
  });

  it("treats CHANGE_ME platform key placeholders as missing", async () => {
    const events: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn();
    await expect(
      queryPlatformStructuredOutput(
        { ARCANIST_OPENAI_API_KEY: "CHANGE_ME" },
        {
          model: "gpt-5.4-mini",
          tool: TOOL,
          systemPrompt: "system",
          userPrompt: "user",
          maxTokens: 50,
          strictErrors: true,
        },
        { subsystem: "test", callType: "placeholder_key", phase: "background", sourceId: "source" },
        {
          logger: createMockLogger(),
          fetchImpl,
          emitUsageEvent: async (_eventId, event) => {
            events.push(event);
          },
        },
      ),
    ).rejects.toThrow("API key is missing");

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      provider: "openai",
      outcome: "failure",
      failureCategory: "missing_api_key",
      attempts: 0,
    });
  });

  it("fails closed before Baseten calls when the provider key is absent or a placeholder", async () => {
    for (const env of [
      { ARCANIST_OPENAI_API_KEY: "sk-test" },
      { ARCANIST_OPENAI_API_KEY: "sk-test", ARCANIST_BASETEN_API_KEY: "CHANGE_ME" },
    ]) {
      const events: Record<string, unknown>[] = [];
      const fetchImpl = vi.fn();
      await expect(
        queryPlatformStructuredOutput(
          env,
          {
            provider: "baseten",
            model: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
            tool: TOOL,
            systemPrompt: "system",
            userPrompt: "user",
            maxTokens: 50,
            strictErrors: true,
          },
          { subsystem: "test", callType: "missing_baseten_key", phase: "background", sourceId: "source" },
          {
            logger: createMockLogger(),
            fetchImpl,
            emitUsageEvent: async (_eventId, event) => {
              events.push(event);
            },
          },
        ),
      ).rejects.toThrow("API key is missing");

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({
        provider: "baseten",
        outcome: "failure",
        failureCategory: "missing_api_key",
        attempts: 0,
        requestedServiceTier: null,
        serviceTier: null,
      });
    }
  });

  it("fails closed before Anthropic calls when the provider key is absent or a placeholder", async () => {
    for (const env of [
      { ARCANIST_OPENAI_API_KEY: "sk-test", ARCANIST_BASETEN_API_KEY: "bt-test" },
      {
        ARCANIST_OPENAI_API_KEY: "sk-test",
        ARCANIST_BASETEN_API_KEY: "bt-test",
        ARCANIST_ANTHROPIC_API_KEY: "CHANGE_ME",
      },
    ]) {
      const events: Record<string, unknown>[] = [];
      const fetchImpl = vi.fn();
      await expect(
        queryPlatformStructuredOutput(
          env,
          {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            tool: TOOL,
            systemPrompt: "system",
            userPrompt: "user",
            maxTokens: 50,
            strictErrors: true,
          },
          { subsystem: "test", callType: "missing_anthropic_key", phase: "background", sourceId: "source" },
          {
            logger: createMockLogger(),
            fetchImpl,
            emitUsageEvent: async (_eventId, event) => {
              events.push(event);
            },
          },
        ),
      ).rejects.toThrow("API key is missing");

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({
        provider: "anthropic",
        outcome: "failure",
        failureCategory: "missing_api_key",
        attempts: 0,
        requestedServiceTier: null,
        serviceTier: null,
      });
    }
  });
});

describe("platform structured output guardrail", () => {
  it("keeps production structured-output calls behind the platform wrapper", () => {
    const root = join(process.cwd(), "apps/control-plane-worker/src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const rel = relative(process.cwd(), file);
      if (rel.endsWith("services/platform-structured-output.ts")) continue;
      const text = readFileSync(file, "utf8");
      // Match the identifier itself, not just the direct-call form `queryOpenAIStructuredOutput(`.
      // The fallback form `(deps.fn ?? queryOpenAIStructuredOutput)(...)` puts a `)` after the
      // identifier and previously slipped past the substring check.
      if (/\bquery(?:OpenAI|Baseten|Anthropic)StructuredOutput\b/.test(text)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("flags the nullish-fallback bypass form, not just direct calls", () => {
    const direct = "const raw = await queryOpenAIStructuredOutput({ apiKey });";
    const fallback = "const raw = await (deps.queryStructuredOutput ?? queryBasetenStructuredOutput)({ apiKey });";
    const anthropicFallback =
      "const raw = await (deps.queryStructuredOutput ?? queryAnthropicStructuredOutput)({ apiKey });";
    const matcher = /\bquery(?:OpenAI|Baseten|Anthropic)StructuredOutput\b/;
    expect(matcher.test(direct)).toBe(true);
    expect(matcher.test(fallback)).toBe(true);
    expect(matcher.test(anthropicFallback)).toBe(true);
  });
});

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return listSourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}
