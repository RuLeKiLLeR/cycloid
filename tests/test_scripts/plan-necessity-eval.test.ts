import { describe, expect, it } from "vitest";

import {
  buildReport,
  classifyNullCause,
  computeMetrics,
  type EvalOptions,
  evaluateGate,
  extractOpenAIUsage,
  materializeEvalPrompt,
  parseArgs,
  parseDatasetJsonl,
  type Prediction,
  renderSummary,
} from "../../scripts/plan-necessity-eval";

const options: EvalOptions = {
  datasetPath: "dataset.jsonl",
  runsDir: "runs",
  repeat: 1,
  filter: null,
  concurrency: 5,
  minAccuracy: 0.85,
  minRecallPlanNeeded: 0.75,
  minRecallNoPlan: 0.75,
  maxProviderFailureRate: 0.2,
};

function prediction(fields: Partial<Prediction> & Pick<Prediction, "id" | "expected" | "actual">): Prediction {
  return {
    repeat: 1,
    effectiveActual: fields.actual ?? false,
    reason: fields.actual === null ? null : "because",
    latencyMs: 10,
    nullCause: fields.actual === null ? "parse_failure" : "none",
    httpStatus: 200,
    usage: null,
    costUsdMicros: 0,
    ...fields,
  };
}

describe("plan necessity eval dataset parsing", () => {
  it("parses valid jsonl and preserves labels", () => {
    const cases = parseDatasetJsonl(
      [
        JSON.stringify({ id: "a", prompt: "Plan this feature", expected: true, note: "broad", source: "synthetic" }),
        JSON.stringify({
          id: "b",
          prompt: "Fix typo",
          expected: false,
          note: "small",
          source: "synthetic",
          postTruncationPrompt: "Ignored tail",
        }),
      ].join("\n"),
    );

    expect(cases).toEqual([
      {
        id: "a",
        prompt: "Plan this feature",
        expected: true,
        note: "broad",
        source: "synthetic",
        postTruncationPrompt: null,
      },
      {
        id: "b",
        prompt: "Fix typo",
        expected: false,
        note: "small",
        source: "synthetic",
        postTruncationPrompt: "Ignored tail",
      },
    ]);
  });

  it("fails fast with line numbers for malformed lines", () => {
    expect(() => parseDatasetJsonl('{"id":"ok","prompt":"x","expected":false,"note":"n","source":"s"}\n{')).toThrow(
      "line 2",
    );
  });

  it("rejects duplicate ids and missing fields", () => {
    expect(() =>
      parseDatasetJsonl(
        [
          JSON.stringify({ id: "dup", prompt: "x", expected: true, note: "n", source: "s" }),
          JSON.stringify({ id: "dup", prompt: "y", expected: false, note: "n", source: "s" }),
        ].join("\n"),
      ),
    ).toThrow("duplicate id dup");

    expect(() => parseDatasetJsonl(JSON.stringify({ id: "x", prompt: "x", expected: "yes" }))).toThrow(
      "expected must be boolean",
    );
  });

  it("expands truncation probe tails beyond the classifier cutoff", () => {
    const prompt = materializeEvalPrompt({
      id: "truncation",
      prompt: "visible instruction",
      expected: false,
      note: "n",
      source: "truncation-probe",
      postTruncationPrompt: "hidden instruction",
    });

    expect(prompt.slice(0, 12_000)).not.toContain("hidden instruction");
    expect(prompt).toContain("hidden instruction");
    expect(prompt.length).toBeGreaterThan(12_000);
  });
});

describe("plan necessity eval metrics", () => {
  it("computes effective accuracy, class metrics, null split, latency, tokens, cost, and flip rate", () => {
    const predictions = [
      prediction({ id: "a", expected: true, actual: true, latencyMs: 10 }),
      prediction({ id: "b", expected: false, actual: false, latencyMs: 20 }),
      prediction({ id: "c", expected: false, actual: true, latencyMs: 30 }),
      prediction({ id: "d", expected: true, actual: null, latencyMs: 40, nullCause: "provider_timeout" }),
      prediction({
        id: "a",
        repeat: 2,
        expected: true,
        actual: false,
        latencyMs: 50,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 10 },
          output_tokens_details: { reasoning_tokens: 5 },
        },
        costUsdMicros: 12,
      }),
    ];

    const metrics = computeMetrics(predictions);

    expect(metrics.total).toBe(5);
    expect(metrics.answered).toBe(4);
    expect(metrics.rawAccuracy).toBe(0.5);
    expect(metrics.effectiveAccuracy).toBe(0.4);
    expect(metrics.confusionMatrix).toEqual({ truePositive: 1, trueNegative: 1, falsePositive: 1, falseNegative: 2 });
    expect(metrics.planNeeded.recall).toBeCloseTo(1 / 3);
    expect(metrics.noPlan.precision).toBeCloseTo(1 / 3);
    expect(metrics.nulls.provider_timeout).toBe(1);
    expect(metrics.providerFailureRate).toBe(0.2);
    expect(metrics.latency).toEqual({ p50Ms: 30, p95Ms: 50 });
    expect(metrics.tokens).toEqual({ input: 100, output: 20, total: 120, cachedInput: 10, reasoningOutput: 5 });
    expect(metrics.costUsd).toBe(0.000012);
    expect(metrics.flipRate).toBe(0.25);
  });

  it("builds reports with effective disagreements", () => {
    const report = buildReport({
      generatedAt: "2026-07-09T00:00:00.000Z",
      options,
      cases: [{ id: "a", prompt: "x", expected: true, note: "n", source: "s", postTruncationPrompt: null }],
      predictions: [prediction({ id: "a", expected: true, actual: null, nullCause: "parse_failure" })],
    });

    expect(report.cases).toEqual([{ id: "a", expected: true, note: "n", source: "s" }]);
    expect(report.disagreements).toEqual([
      {
        id: "a",
        repeat: 1,
        expected: true,
        actual: null,
        effectiveActual: false,
        reason: null,
        nullCause: "parse_failure",
      },
    ]);
  });
});

describe("plan necessity eval gates and cli", () => {
  it("passes, fails, and marks provider-heavy runs inconclusive", () => {
    const passingMetrics = computeMetrics([
      prediction({ id: "a", expected: true, actual: true }),
      prediction({ id: "b", expected: false, actual: false }),
    ]);
    expect(evaluateGate(passingMetrics, options)).toMatchObject({ ok: true, inconclusive: false, exitCode: 0 });

    const failingMetrics = computeMetrics([
      prediction({ id: "a", expected: true, actual: false }),
      prediction({ id: "b", expected: false, actual: false }),
    ]);
    expect(evaluateGate(failingMetrics, options)).toMatchObject({ ok: false, inconclusive: false, exitCode: 1 });

    const inconclusiveMetrics = computeMetrics([
      prediction({ id: "a", expected: true, actual: null, nullCause: "provider_failure" }),
      prediction({ id: "b", expected: false, actual: false }),
    ]);
    expect(evaluateGate(inconclusiveMetrics, options)).toMatchObject({ ok: false, inconclusive: true, exitCode: 2 });
  });

  it("skips recall gates for absent classes", () => {
    const noPlanOnly = computeMetrics([
      prediction({ id: "a", expected: false, actual: false }),
      prediction({ id: "b", expected: false, actual: false }),
    ]);
    expect(noPlanOnly.planNeeded.recall).toBeNull();
    expect(evaluateGate(noPlanOnly, options)).toMatchObject({ ok: true, exitCode: 0 });

    const planNeededOnly = computeMetrics([
      prediction({ id: "a", expected: true, actual: true }),
      prediction({ id: "b", expected: true, actual: true }),
    ]);
    expect(planNeededOnly.noPlan.recall).toBeNull();
    expect(evaluateGate(planNeededOnly, options)).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("classifies auth-like 4xx nulls as provider failures", () => {
    expect(classifyNullCause(null, { httpStatus: 401, usage: null, timeout: false, fetchError: false })).toBe(
      "provider_failure",
    );
    expect(classifyNullCause(null, { httpStatus: 403, usage: null, timeout: false, fetchError: false })).toBe(
      "provider_failure",
    );
    expect(classifyNullCause(null, { httpStatus: 400, usage: null, timeout: false, fetchError: false })).toBe(
      "parse_failure",
    );
  });

  it("validates captured OpenAI usage before costing", () => {
    expect(extractOpenAIUsage({ usage: {} })).toBeNull();
    expect(extractOpenAIUsage({ usage: { input_tokens: "10" } })).toBeNull();
    expect(extractOpenAIUsage({ usage: { input_tokens: 10, output_tokens: 2 } })).toEqual({
      input_tokens: 10,
      output_tokens: 2,
    });
  });

  it("parses cli flags", () => {
    expect(
      parseArgs([
        "--dataset",
        "custom.jsonl",
        "--runs-dir",
        "tmp-runs",
        "--repeat",
        "3",
        "--filter",
        "multi",
        "--concurrency",
        "2",
        "--min-accuracy",
        "0.9",
        "--min-recall-plan-needed",
        "0.8",
        "--min-recall-no-plan",
        "0.7",
        "--max-provider-failure-rate",
        "0.1",
      ]),
    ).toMatchObject({
      repeat: 3,
      filter: "multi",
      concurrency: 2,
      minAccuracy: 0.9,
      minRecallPlanNeeded: 0.8,
      minRecallNoPlan: 0.7,
      maxProviderFailureRate: 0.1,
    });
  });

  it("renders a summary with the gate result and disagreements", () => {
    const report = buildReport({
      generatedAt: "2026-07-09T00:00:00.000Z",
      options,
      cases: [{ id: "a", prompt: "x", expected: true, note: "n", source: "s", postTruncationPrompt: null }],
      predictions: [prediction({ id: "a", expected: true, actual: false })],
    });
    const summary = renderSummary(report, evaluateGate(report.metrics, options));

    expect(summary).toContain("Plan necessity eval summary");
    expect(summary).toContain("Gate: fail");
    expect(summary).toContain("a#1");
  });
});
