#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenAIResponsesUsage } from "../apps/control-plane-worker/src/openai-gateway/cost";
import { computeOpenAIResponsesCostUsdMicros } from "../apps/control-plane-worker/src/openai-gateway/cost";
import { assessPlanNecessity, PLAN_NECESSITY_MODEL } from "../apps/control-plane-worker/src/services/plan-necessity";
import type { StructuredOutputFetch } from "../shared/llm/structured-output";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DATASET_PATH = resolve(ROOT_DIR, "evals/plan-necessity/dataset.jsonl");
const DEFAULT_RUNS_DIR = resolve(ROOT_DIR, "evals/plan-necessity/runs");
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MIN_ACCURACY = 0.85;
const DEFAULT_MIN_RECALL_PLAN_NEEDED = 0.75;
const DEFAULT_MIN_RECALL_NO_PLAN = 0.75;
const DEFAULT_MAX_PROVIDER_FAILURE_RATE = 0.2;
const PLAN_NECESSITY_TRUNCATION_PROBE_VISIBLE_CHARS = 12_050;
const INCONCLUSIVE_EXIT_CODE = 2;

export type DatasetCase = {
  id: string;
  prompt: string;
  expected: boolean;
  note: string;
  source: string;
  postTruncationPrompt: string | null;
};

export type EvalOptions = {
  datasetPath: string;
  runsDir: string;
  repeat: number;
  filter: string | null;
  concurrency: number;
  minAccuracy: number;
  minRecallPlanNeeded: number;
  minRecallNoPlan: number;
  maxProviderFailureRate: number;
};

export type NullCause = "none" | "empty_prompt" | "provider_failure" | "provider_timeout" | "parse_failure";

export type Prediction = {
  id: string;
  repeat: number;
  expected: boolean;
  actual: boolean | null;
  effectiveActual: boolean;
  reason: string | null;
  latencyMs: number;
  nullCause: NullCause;
  httpStatus: number | null;
  usage: OpenAIResponsesUsage | null;
  costUsdMicros: number;
};

export type ClassMetrics = {
  precision: number | null;
  recall: number | null;
  f1: number | null;
};

export type Metrics = {
  total: number;
  answered: number;
  rawAccuracy: number | null;
  effectiveAccuracy: number;
  confusionMatrix: {
    truePositive: number;
    trueNegative: number;
    falsePositive: number;
    falseNegative: number;
  };
  planNeeded: ClassMetrics;
  noPlan: ClassMetrics;
  nulls: Record<NullCause, number>;
  nullRate: number;
  providerFailureRate: number;
  parseFailureRate: number;
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
  };
  tokens: {
    input: number;
    output: number;
    total: number;
    cachedInput: number;
    reasoningOutput: number;
  };
  costUsd: number;
  flipRate: number;
};

export type Disagreement = {
  id: string;
  repeat: number;
  expected: boolean;
  actual: boolean | null;
  effectiveActual: boolean;
  reason: string | null;
  nullCause: NullCause;
};

export type EvalReport = {
  generatedAt: string;
  model: string;
  options: EvalOptions;
  cases: Array<Pick<DatasetCase, "id" | "expected" | "note" | "source">>;
  predictions: Prediction[];
  metrics: Metrics;
  disagreements: Disagreement[];
};

export type GateResult = {
  ok: boolean;
  inconclusive: boolean;
  exitCode: number;
  failures: string[];
};

type CapturedFetch = {
  fetchImpl: StructuredOutputFetch;
  getLastCapture: () => {
    httpStatus: number | null;
    usage: OpenAIResponsesUsage | null;
    timeout: boolean;
    fetchError: boolean;
  };
};

export function parseDatasetJsonl(text: string): DatasetCase[] {
  const cases: DatasetCase[] = [];
  const ids = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on dataset line ${index + 1}: ${error instanceof Error ? error.message : error}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid dataset line ${index + 1}: expected an object`);
    }
    const record = parsed as Record<string, unknown>;
    const candidate = {
      id: record.id,
      prompt: record.prompt,
      expected: record.expected,
      note: record.note,
      source: record.source,
      postTruncationPrompt: record.postTruncationPrompt,
    };
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
      throw new Error(`Invalid dataset line ${index + 1}: id must be a non-empty string`);
    }
    if (ids.has(candidate.id)) {
      throw new Error(`Invalid dataset line ${index + 1}: duplicate id ${candidate.id}`);
    }
    if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) {
      throw new Error(`Invalid dataset line ${index + 1}: prompt must be a non-empty string`);
    }
    if (typeof candidate.expected !== "boolean") {
      throw new Error(`Invalid dataset line ${index + 1}: expected must be boolean`);
    }
    if (typeof candidate.note !== "string" || candidate.note.trim().length === 0) {
      throw new Error(`Invalid dataset line ${index + 1}: note must be a non-empty string`);
    }
    if (typeof candidate.source !== "string" || candidate.source.trim().length === 0) {
      throw new Error(`Invalid dataset line ${index + 1}: source must be a non-empty string`);
    }
    if (
      candidate.postTruncationPrompt !== undefined &&
      (typeof candidate.postTruncationPrompt !== "string" || candidate.postTruncationPrompt.trim().length === 0)
    ) {
      throw new Error(`Invalid dataset line ${index + 1}: postTruncationPrompt must be a non-empty string when set`);
    }
    ids.add(candidate.id);
    cases.push({
      id: candidate.id,
      prompt: candidate.prompt,
      expected: candidate.expected,
      note: candidate.note,
      source: candidate.source,
      postTruncationPrompt: candidate.postTruncationPrompt ?? null,
    });
  }

  if (cases.length === 0) {
    throw new Error("Dataset is empty");
  }
  return cases;
}

export function materializeEvalPrompt(testCase: DatasetCase): string {
  if (testCase.postTruncationPrompt === null) return testCase.prompt;

  const basePrompt = testCase.prompt.trimEnd();
  const paddingLength = Math.max(0, PLAN_NECESSITY_TRUNCATION_PROBE_VISIBLE_CHARS - basePrompt.length);
  const padding = " ".repeat(paddingLength);
  return `${basePrompt}${padding}\n${testCase.postTruncationPrompt}`;
}

export function computeMetrics(predictions: Prediction[]): Metrics {
  const total = predictions.length;
  const answered = predictions.filter((prediction) => prediction.actual !== null).length;
  const answeredCorrect = predictions.filter(
    (prediction) => prediction.actual !== null && prediction.actual === prediction.expected,
  ).length;
  const effectiveCorrect = predictions.filter(
    (prediction) => prediction.effectiveActual === prediction.expected,
  ).length;
  const truePositive = predictions.filter(
    (prediction) => prediction.expected && prediction.effectiveActual === true,
  ).length;
  const trueNegative = predictions.filter(
    (prediction) => !prediction.expected && prediction.effectiveActual === false,
  ).length;
  const falsePositive = predictions.filter(
    (prediction) => !prediction.expected && prediction.effectiveActual === true,
  ).length;
  const falseNegative = predictions.filter(
    (prediction) => prediction.expected && prediction.effectiveActual === false,
  ).length;
  const nulls = emptyNullCounts();
  for (const prediction of predictions) {
    nulls[prediction.nullCause] += 1;
  }

  return {
    total,
    answered,
    rawAccuracy: answered === 0 ? null : answeredCorrect / answered,
    effectiveAccuracy: total === 0 ? 0 : effectiveCorrect / total,
    confusionMatrix: { truePositive, trueNegative, falsePositive, falseNegative },
    planNeeded: classMetrics(truePositive, falsePositive, falseNegative),
    noPlan: classMetrics(trueNegative, falseNegative, falsePositive),
    nulls,
    nullRate: total === 0 ? 0 : (total - answered) / total,
    providerFailureRate: total === 0 ? 0 : (nulls.provider_failure + nulls.provider_timeout) / total,
    parseFailureRate: total === 0 ? 0 : nulls.parse_failure / total,
    latency: {
      p50Ms: percentile(
        predictions.map((prediction) => prediction.latencyMs),
        0.5,
      ),
      p95Ms: percentile(
        predictions.map((prediction) => prediction.latencyMs),
        0.95,
      ),
    },
    tokens: sumTokens(predictions),
    costUsd: predictions.reduce((sum, prediction) => sum + prediction.costUsdMicros, 0) / 1_000_000,
    flipRate: computeFlipRate(predictions),
  };
}

export function buildReport(fields: {
  generatedAt: string;
  options: EvalOptions;
  cases: DatasetCase[];
  predictions: Prediction[];
}): EvalReport {
  const metrics = computeMetrics(fields.predictions);
  return {
    generatedAt: fields.generatedAt,
    model: PLAN_NECESSITY_MODEL,
    options: fields.options,
    cases: fields.cases.map((testCase) => ({
      id: testCase.id,
      expected: testCase.expected,
      note: testCase.note,
      source: testCase.source,
    })),
    predictions: fields.predictions,
    metrics,
    disagreements: fields.predictions
      .filter((prediction) => prediction.expected !== prediction.effectiveActual)
      .map((prediction) => ({
        id: prediction.id,
        repeat: prediction.repeat,
        expected: prediction.expected,
        actual: prediction.actual,
        effectiveActual: prediction.effectiveActual,
        reason: prediction.reason,
        nullCause: prediction.nullCause,
      })),
  };
}

export function evaluateGate(metrics: Metrics, options: EvalOptions): GateResult {
  const failures: string[] = [];
  if (metrics.providerFailureRate > options.maxProviderFailureRate) {
    failures.push(
      `provider failure rate ${formatPercent(metrics.providerFailureRate)} exceeds ${formatPercent(
        options.maxProviderFailureRate,
      )}`,
    );
    return { ok: false, inconclusive: true, exitCode: INCONCLUSIVE_EXIT_CODE, failures };
  }
  if (metrics.effectiveAccuracy < options.minAccuracy) {
    failures.push(
      `effective accuracy ${formatPercent(metrics.effectiveAccuracy)} is below ${formatPercent(options.minAccuracy)}`,
    );
  }
  if (metrics.planNeeded.recall !== null && metrics.planNeeded.recall < options.minRecallPlanNeeded) {
    failures.push(
      `plan-needed recall ${formatMetric(metrics.planNeeded.recall)} is below ${formatPercent(
        options.minRecallPlanNeeded,
      )}`,
    );
  }
  if (metrics.noPlan.recall !== null && metrics.noPlan.recall < options.minRecallNoPlan) {
    failures.push(
      `no-plan recall ${formatMetric(metrics.noPlan.recall)} is below ${formatPercent(options.minRecallNoPlan)}`,
    );
  }
  return { ok: failures.length === 0, inconclusive: false, exitCode: failures.length === 0 ? 0 : 1, failures };
}

export function renderSummary(report: EvalReport, gate: GateResult): string {
  const metrics = report.metrics;
  const lines = [
    "",
    "Plan necessity eval summary",
    `Cases: ${metrics.total} predictions across ${report.cases.length} dataset rows`,
    `Accuracy: raw ${formatMetric(metrics.rawAccuracy)}, effective ${formatPercent(metrics.effectiveAccuracy)}`,
    `Precision/recall/F1 plan-needed: ${formatMetric(metrics.planNeeded.precision)} / ${formatMetric(
      metrics.planNeeded.recall,
    )} / ${formatMetric(metrics.planNeeded.f1)}`,
    `Precision/recall/F1 no-plan: ${formatMetric(metrics.noPlan.precision)} / ${formatMetric(
      metrics.noPlan.recall,
    )} / ${formatMetric(metrics.noPlan.f1)}`,
    `Confusion matrix: TP ${metrics.confusionMatrix.truePositive}, FP ${metrics.confusionMatrix.falsePositive}, TN ${metrics.confusionMatrix.trueNegative}, FN ${metrics.confusionMatrix.falseNegative}`,
    `Nulls: total ${metrics.total - metrics.answered} (${formatPercent(metrics.nullRate)}), provider ${
      metrics.nulls.provider_failure
    }, timeout ${metrics.nulls.provider_timeout}, parse ${metrics.nulls.parse_failure}, empty ${
      metrics.nulls.empty_prompt
    }`,
    `Latency: p50 ${formatMs(metrics.latency.p50Ms)}, p95 ${formatMs(metrics.latency.p95Ms)}`,
    `Tokens: input ${metrics.tokens.input}, output ${metrics.tokens.output}, total ${metrics.tokens.total}, cached input ${metrics.tokens.cachedInput}, reasoning output ${metrics.tokens.reasoningOutput}`,
    `Cost: $${metrics.costUsd.toFixed(6)}`,
    `Flip rate: ${formatPercent(metrics.flipRate)}`,
    `Disagreements: ${report.disagreements.length}`,
    `Report: ${report.generatedAt}`,
    gate.ok ? "Gate: pass" : `Gate: ${gate.inconclusive ? "inconclusive" : "fail"} (${gate.failures.join("; ")})`,
  ];
  if (report.disagreements.length > 0) {
    lines.push("", "Disagreement list:");
    for (const disagreement of report.disagreements) {
      lines.push(
        `- ${disagreement.id}#${disagreement.repeat}: expected ${disagreement.expected}, actual ${String(
          disagreement.actual,
        )}, effective ${disagreement.effectiveActual}, nullCause ${disagreement.nullCause}, reason ${
          disagreement.reason ?? "(none)"
        }`,
      );
    }
  }
  return lines.join("\n");
}

export function parseArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {
    datasetPath: DEFAULT_DATASET_PATH,
    runsDir: DEFAULT_RUNS_DIR,
    repeat: 1,
    filter: null,
    concurrency: DEFAULT_CONCURRENCY,
    minAccuracy: DEFAULT_MIN_ACCURACY,
    minRecallPlanNeeded: DEFAULT_MIN_RECALL_PLAN_NEEDED,
    minRecallNoPlan: DEFAULT_MIN_RECALL_NO_PLAN,
    maxProviderFailureRate: DEFAULT_MAX_PROVIDER_FAILURE_RATE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--dataset":
        options.datasetPath = resolve(next());
        break;
      case "--runs-dir":
        options.runsDir = resolve(next());
        break;
      case "--repeat":
        options.repeat = parsePositiveInteger(next(), "--repeat");
        break;
      case "--filter":
        options.filter = next();
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInteger(next(), "--concurrency");
        break;
      case "--min-accuracy":
        options.minAccuracy = parseThreshold(next(), "--min-accuracy");
        break;
      case "--min-recall-plan-needed":
        options.minRecallPlanNeeded = parseThreshold(next(), "--min-recall-plan-needed");
        break;
      case "--min-recall-no-plan":
        options.minRecallNoPlan = parseThreshold(next(), "--min-recall-no-plan");
        break;
      case "--max-provider-failure-rate":
        options.maxProviderFailureRate = parseThreshold(next(), "--max-provider-failure-rate");
        break;
      default:
        throw new Error(`Unknown argument ${arg}`);
    }
  }

  return options;
}

export async function runEval(
  options: EvalOptions,
): Promise<{ report: EvalReport; reportPath: string; gate: GateResult }> {
  const apiKey = process.env.ARCANIST_OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === "CHANGE_ME") {
    throw new Error("ARCANIST_OPENAI_API_KEY must be set to run the live plan necessity eval");
  }

  const allCases = parseDatasetJsonl(await readFile(options.datasetPath, "utf8"));
  const filteredCases =
    options.filter === null
      ? allCases
      : allCases.filter(
          (testCase) =>
            testCase.id.includes(options.filter ?? "") ||
            testCase.prompt.includes(options.filter ?? "") ||
            testCase.source.includes(options.filter ?? ""),
        );
  if (filteredCases.length === 0) {
    throw new Error(`No dataset cases matched filter ${options.filter}`);
  }

  const jobs = filteredCases.flatMap((testCase) =>
    Array.from({ length: options.repeat }, (_, repeatIndex) => ({ testCase, repeat: repeatIndex + 1 })),
  );
  const predictions = await mapWithConcurrency(jobs, options.concurrency, async (job) =>
    runCase({ apiKey, testCase: job.testCase, repeat: job.repeat }),
  );
  const generatedAt = new Date().toISOString();
  const report = buildReport({ generatedAt, options, cases: filteredCases, predictions });
  const gate = evaluateGate(report.metrics, options);
  const reportPath = resolve(options.runsDir, `${generatedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath, gate };
}

async function runCase(fields: { apiKey: string; testCase: DatasetCase; repeat: number }): Promise<Prediction> {
  const startedAt = Date.now();
  const prompt = materializeEvalPrompt(fields.testCase);
  if (!prompt.trim()) {
    return {
      id: fields.testCase.id,
      repeat: fields.repeat,
      expected: fields.testCase.expected,
      actual: null,
      effectiveActual: false,
      reason: null,
      latencyMs: 0,
      nullCause: "empty_prompt",
      httpStatus: null,
      usage: null,
      costUsdMicros: 0,
    };
  }

  const capture = createCapturedFetch();
  const result = await assessPlanNecessity(
    { ARCANIST_OPENAI_API_KEY: fields.apiKey },
    prompt,
    { sessionId: "plan-necessity-eval", promptId: `${fields.testCase.id}#${fields.repeat}` },
    { fetchImpl: capture.fetchImpl },
  );
  const lastCapture = capture.getLastCapture();
  const latencyMs = Date.now() - startedAt;
  const actual = result?.planNeeded ?? null;
  return {
    id: fields.testCase.id,
    repeat: fields.repeat,
    expected: fields.testCase.expected,
    actual,
    effectiveActual: actual ?? false,
    reason: result?.reason ?? null,
    latencyMs,
    nullCause: classifyNullCause(result, lastCapture),
    httpStatus: lastCapture.httpStatus,
    usage: lastCapture.usage,
    costUsdMicros: computeCostUsdMicros(lastCapture.usage),
  };
}

function createCapturedFetch(): CapturedFetch {
  let httpStatus: number | null = null;
  let usage: OpenAIResponsesUsage | null = null;
  let timeout = false;
  let fetchError = false;

  return {
    fetchImpl: async (input, init) => {
      try {
        const response = await fetch(input, init);
        httpStatus = response.status;
        try {
          const body: unknown = await response.clone().json();
          usage = extractOpenAIUsage(body);
        } catch {
          usage = null;
        }
        return response;
      } catch (error) {
        fetchError = true;
        timeout = error instanceof Error && error.name === "AbortError";
        throw error;
      }
    },
    getLastCapture: () => ({ httpStatus, usage, timeout, fetchError }),
  };
}

export function classifyNullCause(
  result: { planNeeded: boolean; reason: string } | null,
  capture: ReturnType<CapturedFetch["getLastCapture"]>,
): NullCause {
  if (result !== null) return "none";
  if (capture.timeout) return "provider_timeout";
  if (capture.fetchError || capture.httpStatus === null) return "provider_failure";
  if (capture.httpStatus === 429 || (capture.httpStatus >= 400 && capture.httpStatus !== 400)) {
    return "provider_failure";
  }
  return "parse_failure";
}

export function extractOpenAIUsage(body: unknown): OpenAIResponsesUsage | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const record = usage as Record<string, unknown>;
  if (
    !isFiniteNumber(record.input_tokens) &&
    !isFiniteNumber(record.prompt_tokens) &&
    !isFiniteNumber(record.output_tokens) &&
    !isFiniteNumber(record.completion_tokens)
  ) {
    return null;
  }
  return usage as OpenAIResponsesUsage;
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function computeCostUsdMicros(usage: OpenAIResponsesUsage | null): number {
  if (usage === null) return 0;
  return computeOpenAIResponsesCostUsdMicros({ model: PLAN_NECESSITY_MODEL, usage }).costUsdMicros;
}

function emptyNullCounts(): Record<NullCause, number> {
  return {
    none: 0,
    empty_prompt: 0,
    provider_failure: 0,
    provider_timeout: 0,
    parse_failure: 0,
  };
}

function classMetrics(trueCount: number, falsePositive: number, falseNegative: number): ClassMetrics {
  const precisionDenominator = trueCount + falsePositive;
  const recallDenominator = trueCount + falseNegative;
  const precision = precisionDenominator === 0 ? null : trueCount / precisionDenominator;
  const recall = recallDenominator === 0 ? null : trueCount / recallDenominator;
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * quantile) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function sumTokens(predictions: Prediction[]): Metrics["tokens"] {
  return predictions.reduce(
    (sum, prediction) => {
      const usage = prediction.usage;
      if (usage === null) return sum;
      return {
        input: sum.input + (usage.input_tokens ?? usage.prompt_tokens ?? 0),
        output: sum.output + (usage.output_tokens ?? usage.completion_tokens ?? 0),
        total:
          sum.total +
          ((usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? 0)),
        cachedInput:
          sum.cachedInput +
          (usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0),
        reasoningOutput:
          sum.reasoningOutput +
          (usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0),
      };
    },
    { input: 0, output: 0, total: 0, cachedInput: 0, reasoningOutput: 0 },
  );
}

function computeFlipRate(predictions: Prediction[]): number {
  const byCase = new Map<string, Set<boolean>>();
  for (const prediction of predictions) {
    const bucket = byCase.get(prediction.id) ?? new Set<boolean>();
    bucket.add(prediction.effectiveActual);
    byCase.set(prediction.id, bucket);
  }
  if (byCase.size === 0) return 0;
  return [...byCase.values()].filter((values) => values.size > 1).length / byCase.size;
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: TInput[],
  concurrency: number,
  worker: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(inputs.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= inputs.length) return;
        results[index] = await worker(inputs[index]);
      }
    }),
  );
  return results;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseThreshold(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between 0 and 1`);
  }
  return parsed;
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : formatPercent(value);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runEval(parseArgs(process.argv.slice(2)))
    .then(({ report, reportPath, gate }) => {
      // eslint-disable-next-line no-console
      console.log(renderSummary({ ...report, generatedAt: reportPath }, gate));
      process.exitCode = gate.exitCode;
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
