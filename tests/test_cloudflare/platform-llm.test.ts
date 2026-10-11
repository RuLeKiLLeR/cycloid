import { beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: sentry.captureException,
}));

import { PLATFORM_LLM_CALL_CONFIG } from "../../apps/control-plane-worker/src/constants/platform-llm";
import { executePlatformLlmCall } from "../../apps/control-plane-worker/src/services/platform-llm";
import type { Env } from "../../apps/control-plane-worker/src/types";
import { OpenAIServiceTier } from "../../shared/enums/openai-service-tier";
import type { PlatformLlmCallPlan } from "../../shared/llm/platform-llm-contract";
import type { StructuredOutputFetch } from "../../shared/llm/structured-output";

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    REPOS_CACHE: {} as KVNamespace,
    RATE_LIMITS: {} as KVNamespace,
    DERIVED_MODELS: {} as KVNamespace,
    ARCANIST_OPENAI_API_KEY: "sk-oai-test",
    ...overrides,
  };
}

function createPlan(overrides: Partial<PlatformLlmCallPlan> = {}): PlatformLlmCallPlan {
  const config = PLATFORM_LLM_CALL_CONFIG.pr_template_fill;
  return {
    sessionId: "s-1",
    sandboxId: "sandbox-1",
    promptId: "p-1",
    callType: "pr_template_fill",
    phase: "post_execution",
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    serviceTier: config.serviceTier,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    toolName: config.toolName,
    maxOutputBytes: config.maxOutputBytes,
    ...overrides,
  };
}

function createConfiguredPlan(callType: keyof typeof PLATFORM_LLM_CALL_CONFIG): PlatformLlmCallPlan {
  const config = PLATFORM_LLM_CALL_CONFIG[callType];
  return createPlan({
    callType,
    phase: config.phase,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    serviceTier: config.serviceTier,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts,
    toolName: config.toolName,
    maxOutputBytes: config.maxOutputBytes,
  });
}

function openaiToolResponse(input: Record<string, unknown>, status = 200): Response {
  if (status !== 200) {
    return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "try later" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify(input),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const noSleep = { sleep: () => Promise.resolve(), random: () => 0.5 };
const OLD_PLATFORM_LLM_MAX_OUTPUT_BYTES = 64 * 1024;
const platformInput = {
  headings: ["Description"],
  narrative: "Updated docs.",
  taskPrompt: "Update docs",
  diffSummary: "1 file changed",
  diffSizeBand: "small" as const,
  instructions: null,
  factPlacement: "body" as const,
  commands: [],
};

function prTemplateFillOutput(heading: string, text: string) {
  return {
    sections: [{ index: 0, heading, kind: "prose", text, factRefs: null, emptyReason: null }],
  };
}

describe("platform LLM service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns provider tool output data on success", async () => {
    const fetchImpl = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValue(openaiToolResponse(prTemplateFillOutput("Description", "Updated docs.")));

    const result = await executePlatformLlmCall(createEnv(), createPlan(), platformInput, undefined, {
      fetchImpl,
      retryDependencies: noSleep,
    });

    expect(result.status).toBe(200);
    expect(result.response).toMatchObject({
      ok: true,
      data: prTemplateFillOutput("Description", "Updated docs."),
      attempts: 1,
      model: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.model,
      toolName: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.toolName,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.reasoning).toEqual({ effort: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.reasoningEffort });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it.each([
    {
      callType: "pr_template_fill" as const,
      input: platformInput,
      output: prTemplateFillOutput("Description", "Updated docs."),
      expectedServiceTier: OpenAIServiceTier.Flex,
      expectedProviderServiceTier: "flex",
    },
    {
      callType: "review_loop_triage" as const,
      input: {
        repo: "acme/repo",
        prNumber: 42,
        headSha: "deadbeef",
        items: [
          {
            sourceId: "check-run-failure:9",
            kind: "ci_failure" as const,
            authorLogin: "github-actions[bot]",
            authorType: "Bot",
            location: null,
            body: "unit tests failed",
            diffHunk: null,
          },
        ],
      },
      output: {
        actionItems: [{ instruction: "Fix tests.", sourceIds: ["check-run-failure:9"] }],
        droppedItems: [],
        conflicts: [],
      },
      expectedServiceTier: OpenAIServiceTier.Auto,
      expectedProviderServiceTier: "auto",
    },
  ])(
    "forwards the configured service tier into the $callType provider request",
    async ({ callType, input, output, expectedServiceTier, expectedProviderServiceTier }) => {
      const fetchImpl = vi.fn<StructuredOutputFetch>().mockResolvedValue(openaiToolResponse(output));

      await executePlatformLlmCall(createEnv(), createConfiguredPlan(callType), input, undefined, {
        fetchImpl,
        retryDependencies: noSleep,
      });

      expect(PLATFORM_LLM_CALL_CONFIG[callType].serviceTier).toBe(expectedServiceTier);
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}"));
      expect(body.service_tier).toBe(expectedProviderServiceTier);
    },
  );

  it("fails closed when the configured provider key is missing", async () => {
    const previousEnv = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_API_KEY;

    let result: Awaited<ReturnType<typeof executePlatformLlmCall>> | undefined;
    try {
      result = await executePlatformLlmCall(createEnv({ ARCANIST_OPENAI_API_KEY: "" }), createPlan(), {
        prompt: "test",
      });
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    if (!result) throw new Error("Expected platform LLM result");
    expect(result.status).toBe(503);
    expect(result.response).toMatchObject({
      ok: false,
      category: "provider_error_nonretryable",
      attempts: 0,
    });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("retries transient provider failures before returning success", async () => {
    const fetchImpl = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValueOnce(openaiToolResponse({}, 500))
      .mockResolvedValueOnce(openaiToolResponse(prTemplateFillOutput("Description", "Updated docs.")));

    const result = await executePlatformLlmCall(createEnv(), createPlan(), platformInput, undefined, {
      fetchImpl,
      retryDependencies: noSleep,
    });

    expect(result.status).toBe(200);
    expect(result.response).toMatchObject({
      ok: true,
      attempts: 2,
      data: prTemplateFillOutput("Description", "Updated docs."),
    });
  });

  it("reports retryable provider failure after retries are exhausted", async () => {
    const fetchImpl = vi.fn<StructuredOutputFetch>().mockResolvedValue(openaiToolResponse({}, 500));

    const result = await executePlatformLlmCall(createEnv(), createPlan(), platformInput, undefined, {
      fetchImpl,
      retryDependencies: noSleep,
    });

    expect(result.status).toBe(503);
    expect(result.response).toMatchObject({
      ok: false,
      category: "provider_error_retryable",
      attempts: 3,
    });
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ name: "StructuredOutputError" }), {
      tags: expect.objectContaining({
        component: "llm_provider",
        operation: "platform_llm",
        provider: "openai",
        model: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.model,
        callType: "pr_template_fill",
        phase: "post_execution",
        toolName: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.toolName,
        failureCategory: "provider_error_retryable",
        failureKind: "provider",
        status: "500",
        sessionId: "s-1",
        promptId: "p-1",
        sandboxId: "sandbox-1",
      }),
    });
  });

  it("classifies malformed provider output as output_shape and oversized output distinctly", async () => {
    const malformedFetch = vi.fn<StructuredOutputFetch>().mockResolvedValue(
      new Response(JSON.stringify({ content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const malformed = await executePlatformLlmCall(createEnv(), createPlan(), platformInput, undefined, {
      fetchImpl: malformedFetch,
      retryDependencies: noSleep,
    });
    expect(malformed.response).toMatchObject({ ok: false, category: "output_shape" });

    const oversizedFetch = vi.fn<StructuredOutputFetch>().mockResolvedValue(
      openaiToolResponse({
        ...prTemplateFillOutput("Description", "Updated docs."),
        text: "x".repeat(100),
      }),
    );
    const oversized = await executePlatformLlmCall(
      createEnv(),
      createPlan({ maxOutputBytes: 10 }),
      platformInput,
      undefined,
      {
        fetchImpl: oversizedFetch,
        retryDependencies: noSleep,
      },
    );
    expect(oversized.response).toMatchObject({
      ok: false,
      category: "output_too_large",
      details: expect.objectContaining({ maxOutputBytes: 10 }),
    });
  });

  it("returns pr_template_fill sections on success", async () => {
    const prTemplateFillInput = {
      headings: ["Description", "Testing"],
      narrative: "Did the thing.",
      taskPrompt: "Do the thing.",
      diffSummary: "1 file changed",
      diffSizeBand: "small" as const,
      instructions: null,
      factPlacement: "body" as const,
      commands: [{ label: "Lint", command: "eslint x", status: "passed" as const }],
    };

    const fetchImpl = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValue(openaiToolResponse(prTemplateFillOutput("Description", "Did the thing.")));

    const result = await executePlatformLlmCall(
      createEnv(),
      createConfiguredPlan("pr_template_fill"),
      prTemplateFillInput,
      undefined,
      { fetchImpl, retryDependencies: noSleep },
    );

    expect(result.status).toBe(200);
    expect(result.response).toMatchObject({
      ok: true,
      data: prTemplateFillOutput("Description", "Did the thing."),
      attempts: 1,
      model: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.model,
      toolName: PLATFORM_LLM_CALL_CONFIG.pr_template_fill.toolName,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("classifies malformed pr_template_fill output as output_shape and oversized output distinctly", async () => {
    const prTemplateFillInput = {
      headings: ["Description"],
      narrative: "Did the thing.",
      taskPrompt: "Do the thing.",
      diffSummary: "1 file changed",
      diffSizeBand: "small" as const,
      instructions: null,
      factPlacement: "body" as const,
      commands: [],
    };

    const malformedFetch = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValue(openaiToolResponse({ sections: "not-an-array" }));

    const malformed = await executePlatformLlmCall(
      createEnv(),
      createConfiguredPlan("pr_template_fill"),
      prTemplateFillInput,
      undefined,
      { fetchImpl: malformedFetch, retryDependencies: noSleep },
    );
    expect(malformed.response).toMatchObject({ ok: false, category: "output_shape" });

    const oversizedFetch = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValue(openaiToolResponse(prTemplateFillOutput("Description", "x".repeat(100))));
    const oversized = await executePlatformLlmCall(
      createEnv(),
      { ...createConfiguredPlan("pr_template_fill"), maxOutputBytes: 10 },
      prTemplateFillInput,
      undefined,
      { fetchImpl: oversizedFetch, retryDependencies: noSleep },
    );
    expect(oversized.response).toMatchObject({
      ok: false,
      category: "output_too_large",
      details: expect.objectContaining({ maxOutputBytes: 10 }),
    });
  });

  it("returns review_loop_triage action items on success", async () => {
    const triageInput = {
      repo: "acme/repo",
      prNumber: 42,
      headSha: "deadbeef",
      items: [
        {
          sourceId: "issue-comment:5001",
          kind: "comment" as const,
          authorLogin: "cycloid[bot]",
          authorType: "Bot",
          location: null,
          body: "## Cycloid QA\n\n**Verdict:** INCONCLUSIVE",
          diffHunk: null,
        },
        {
          sourceId: "check-run-failure:9",
          kind: "ci_failure" as const,
          authorLogin: "github-actions[bot]",
          authorType: "Bot",
          location: null,
          body: "unit tests failed",
          diffHunk: null,
        },
      ],
    };
    const triageOutput = {
      actionItems: [
        { instruction: "Fix the failing unit tests.", sourceIds: ["check-run-failure:9"] },
        { instruction: "Address the verification blockers.", sourceIds: ["issue-comment:5001"] },
      ],
      droppedItems: [],
      conflicts: [],
    };

    const fetchImpl = vi.fn<StructuredOutputFetch>().mockResolvedValue(openaiToolResponse(triageOutput));

    const result = await executePlatformLlmCall(
      createEnv(),
      createConfiguredPlan("review_loop_triage"),
      triageInput,
      undefined,
      { fetchImpl, retryDependencies: noSleep },
    );

    expect(result.status).toBe(200);
    expect(result.response).toMatchObject({
      ok: true,
      data: triageOutput,
      attempts: 1,
      model: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.model,
      toolName: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.toolName,
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.reasoning).toEqual({ effort: PLATFORM_LLM_CALL_CONFIG.review_loop_triage.reasoningEffort });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("classifies malformed review_loop_triage output as output_shape", async () => {
    const triageInput = {
      repo: "acme/repo",
      prNumber: 42,
      headSha: "deadbeef",
      items: [
        {
          sourceId: "issue-comment:5001",
          kind: "comment" as const,
          authorLogin: "cursor[bot]",
          authorType: "Bot",
          location: "src/app.ts:10",
          body: "Fix this",
          diffHunk: null,
        },
      ],
    };

    // droppedItems missing entirely → strict output validators reject the shape.
    const fetchImpl = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValue(openaiToolResponse({ actionItems: [{ instruction: "Fix this", sourceIds: 5 }] }));

    const result = await executePlatformLlmCall(
      createEnv(),
      createConfiguredPlan("review_loop_triage"),
      triageInput,
      undefined,
      { fetchImpl, retryDependencies: noSleep },
    );

    expect(result.response).toMatchObject({ ok: false, category: "output_shape" });
  });

  it("rejects an empty review_loop_triage worklist as invalid input", async () => {
    const fetchImpl = vi.fn<StructuredOutputFetch>();

    const result = await executePlatformLlmCall(
      createEnv(),
      createConfiguredPlan("review_loop_triage"),
      { repo: "acme/repo", prNumber: 42, headSha: "deadbeef", items: [] },
      undefined,
      { fetchImpl, retryDependencies: noSleep },
    );

    expect(result.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a pr_template_fill response near the old output byte ceiling", async () => {
    const text = "x".repeat(OLD_PLATFORM_LLM_MAX_OUTPUT_BYTES + 1);
    const fetchImpl = vi
      .fn<StructuredOutputFetch>()
      .mockResolvedValue(openaiToolResponse(prTemplateFillOutput("Description", text)));

    const result = await executePlatformLlmCall(createEnv(), createPlan(), platformInput, undefined, {
      fetchImpl,
      retryDependencies: noSleep,
    });

    expect(result.status).toBe(200);
    expect(result.response).toMatchObject({
      ok: true,
      data: prTemplateFillOutput("Description", text),
    });
  });
});
