import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQueryOpenAIStructuredOutput = vi.fn();
const mockPostStructuredEventToDd = vi.fn().mockResolvedValue(undefined);

vi.mock("../../shared/llm/structured-output", async () => {
  const actual = await vi.importActual<typeof import("../../shared/llm/structured-output")>(
    "../../shared/llm/structured-output",
  );
  return {
    ...actual,
    queryOpenAIStructuredOutput: (...args: unknown[]) => mockQueryOpenAIStructuredOutput(...args),
  };
});

vi.mock("../../apps/control-plane-worker/src/observability/events-exporter", () => ({
  postStructuredEventToDd: (...args: unknown[]) => mockPostStructuredEventToDd(...args),
}));

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

function env() {
  return {
    ARCANIST_OPENAI_API_KEY: "test-openai-key",
  };
}

describe("incident intent detection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
    mod.resetIncidentIntentCacheForTests();
  });

  it("uses the LLM result for wide-gap customer-impacting incident prompts", async () => {
    const { detectIncidentIntent } = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
    mockQueryOpenAIStructuredOutput.mockResolvedValueOnce({
      isIncident: true,
      confidence: 0.94,
      reasoning: "Customer-impacting incident with an explicit investigation request.",
    });

    await expect(
      detectIncidentIntent({
        env: env(),
        logger,
        prompt:
          "customer-impacting incident: customer at Meridian Logistics reports auto-matching is broken for their account. Please investigate.",
      }),
    ).resolves.toBe(true);

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledOnce();
    expect(mockQueryOpenAIStructuredOutput.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.4-mini",
      timeoutMs: 5000,
      spanName: "openai.incidentIntent",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "llm_call.completed",
        callType: "incident_intent",
        outcome: "success",
        model: "gpt-5.4-mini",
        toolName: "detect_incident_intent",
        confidence: 0.94,
      }),
      "Incident intent classification completed",
    );
  });

  it.each([
    "Meridian is blocked by 500s in production, can you triage the customer impact?",
    "PagerDuty alert for checkout error rate. Please debug and root cause.",
    "P1: Acme cannot create invoices after the deploy; investigate the account failure.",
  ])("classifies realistic incident phrasing: %s", async (prompt) => {
    const { detectIncidentIntent } = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
    mockQueryOpenAIStructuredOutput.mockResolvedValueOnce({
      isIncident: true,
      confidence: 0.9,
      reasoning: "Operational incident investigation request.",
    });

    await expect(detectIncidentIntent({ env: env(), logger, prompt })).resolves.toBe(true);
  });

  it("caches by exact prompt text", async () => {
    const { detectIncidentIntent } = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
    const prompt = "prod outage: checkout is down, please investigate";
    mockQueryOpenAIStructuredOutput.mockResolvedValueOnce({
      isIncident: true,
      confidence: 0.88,
      reasoning: "Production outage investigation.",
    });

    await expect(detectIncidentIntent({ env: env(), logger, prompt })).resolves.toBe(true);
    await expect(detectIncidentIntent({ env: env(), logger, prompt })).resolves.toBe(true);

    expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledOnce();
  });

  it("expires cached prompt classifications over time", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { detectIncidentIntent } = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
      const prompt = "prod outage: checkout is down, please investigate";
      mockQueryOpenAIStructuredOutput.mockResolvedValue({
        isIncident: true,
        confidence: 0.88,
        reasoning: "Production outage investigation.",
      });

      await expect(detectIncidentIntent({ env: env(), logger, prompt })).resolves.toBe(true);
      vi.setSystemTime(10 * 60 * 1000 + 1_001);
      await expect(detectIncidentIntent({ env: env(), logger, prompt })).resolves.toBe(true);

      expect(mockQueryOpenAIStructuredOutput).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the existing regex on LLM errors", async () => {
    const { detectIncidentIntent } = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
    mockQueryOpenAIStructuredOutput.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      detectIncidentIntent({
        env: env(),
        logger,
        prompt: "please investigate the prod incident",
      }),
    ).resolves.toBe(true);
    expect(mockPostStructuredEventToDd).toHaveBeenCalledOnce();
  });

  it("preserves the old regex wide-gap miss in the fallback path", async () => {
    const { detectIncidentIntent } = await import("../../apps/control-plane-worker/src/incident-analyzer/intent");
    mockQueryOpenAIStructuredOutput.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      detectIncidentIntent({
        env: env(),
        logger,
        prompt:
          "customer-impacting incident: customer at Meridian Logistics reports auto-matching is broken for their account. Please investigate.",
      }),
    ).resolves.toBe(false);
  });
});
