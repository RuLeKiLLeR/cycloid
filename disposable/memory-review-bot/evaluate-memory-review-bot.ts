/* eslint-disable no-console */

import { access } from "node:fs/promises";

import { MEMORY_REVIEW_BOT_DEFAULT_MODEL } from "../../apps/control-plane-worker/src/memory-review-bot/types";
import { DEFAULT_MEMORY_REVIEW_BOT_TUNING_FIXTURE_DIR, loadMemoryReviewBotFixtures } from "./eval-loader";
import {
  createMemoryReviewBotOracleBaselineReviewer,
  createProductionMemoryReviewBotReviewer,
  type MemoryReviewBotEvalResult,
  runMemoryReviewBotFixtures,
} from "./eval-runner";
import type { MemoryReviewLabels } from "./eval-schema";

type RunMode = "tuning" | "verify";
type ReviewerMode = "oracle" | "production";

interface CliOptions {
  mode: RunMode;
  reviewer: ReviewerMode;
  fixturesPath: string;
  privateFixturesPath: string | null;
  apiKey: string | null;
  model: string | null;
  promptVersion: string | null;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const readFlag = (name: string): string | null => {
    const index = args.indexOf(name);
    return index >= 0 ? (args[index + 1] ?? null) : null;
  };
  const mode = readFlag("--mode") ?? "tuning";
  if (mode !== "tuning" && mode !== "verify") {
    throw new Error("--mode must be tuning or verify");
  }
  const reviewer = readFlag("--reviewer") ?? "oracle";
  if (reviewer !== "oracle" && reviewer !== "production") {
    throw new Error("--reviewer must be oracle or production");
  }
  return {
    mode,
    reviewer,
    fixturesPath: readFlag("--fixtures") ?? DEFAULT_MEMORY_REVIEW_BOT_TUNING_FIXTURE_DIR,
    privateFixturesPath: readFlag("--private-fixtures") ?? process.env.MEMORY_REVIEW_BOT_VERIFY_FIXTURE_PATH ?? null,
    apiKey: readFlag("--api-key") ?? process.env.ARCANIST_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null,
    model: readFlag("--model"),
    promptVersion: readFlag("--prompt-version"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  requireProductionReviewerForVerify(options);
  const fixturePath = options.mode === "verify" ? await requirePrivateFixturePath(options) : options.fixturesPath;
  const fixtures = await loadMemoryReviewBotFixtures(fixturePath);
  const reviewer =
    options.reviewer === "production"
      ? createProductionMemoryReviewBotReviewer({
          apiKey: requireApiKey(options),
          model: options.model ?? MEMORY_REVIEW_BOT_DEFAULT_MODEL,
          promptVersion: options.promptVersion ?? undefined,
        })
      : createMemoryReviewBotOracleBaselineReviewer(fixtures);
  const results = await runMemoryReviewBotFixtures(fixtures, reviewer);

  if (options.mode === "verify") {
    printVerifyReport(results);
  } else {
    printTuningReport(results);
  }

  if (results.some((result) => !result.passed)) {
    process.exitCode = 1;
  }
}

function requireProductionReviewerForVerify(options: CliOptions): void {
  if (options.mode === "verify" && options.reviewer !== "production") {
    throw new Error("Verify mode requires --reviewer production. Refusing to run the oracle baseline as a gate.");
  }
}

async function requirePrivateFixturePath(options: CliOptions): Promise<string> {
  if (!options.privateFixturesPath) {
    throw new Error(
      "Verify mode requires --private-fixtures or MEMORY_REVIEW_BOT_VERIFY_FIXTURE_PATH. Refusing to run against visible fixtures.",
    );
  }
  await access(options.privateFixturesPath);
  return options.privateFixturesPath;
}

function requireApiKey(options: CliOptions): string {
  if (!options.apiKey) {
    throw new Error(
      "Production reviewer mode requires --api-key, ARCANIST_OPENAI_API_KEY, or OPENAI_API_KEY. Refusing to use the oracle baseline.",
    );
  }
  return options.apiKey;
}

function printTuningReport(results: MemoryReviewBotEvalResult[]): void {
  const passed = results.filter((result) => result.passed).length;
  console.log("# Memory Review Bot Tuning Report");
  console.log(`fixtures=${results.length} passed=${passed} failed=${results.length - passed}`);
  console.log("");

  for (const result of results) {
    console.log(`## ${result.fixture_id}`);
    console.log(`source=${result.fixture_source}`);
    console.log(`reviewer_prompt_version=${result.metadata.prompt_version}`);
    console.log(`model=${result.metadata.model}`);
    console.log(`confidence=${result.actual.confidence}`);
    console.log(`token_usage=${formatTokenUsage(result.metadata.token_usage)}`);
    console.log(`cost_usd=${result.metadata.cost_usd ?? "n/a"}`);
    console.log(`failed_scorers=${result.failed_scorers.join(",") || "none"}`);
    console.log(`expected_prompt_outcome=${result.expected.prompt_outcome}`);
    console.log(`actual_prompt_outcome=${result.actual.prompt_outcome}`);
    console.log(`expected_evidence_refs=${result.expected.evidence_ids.join(",") || "none"}`);
    console.log("expected_memory_labels:");
    printMemoryLabels(result.expected.memory_results);
    console.log("actual_memory_labels:");
    printMemoryLabels(result.actual.memory_results);
    console.log("");
  }
}

function printVerifyReport(results: MemoryReviewBotEvalResult[]): void {
  const passed = results.filter((result) => result.passed).length;
  const failedScorers = [
    ...new Set(results.flatMap((result) => result.failed_scorers).sort((a, b) => a.localeCompare(b))),
  ];
  const failedFixtureIds = results.filter((result) => !result.passed).map((result) => result.fixture_id);
  console.log("# Memory Review Bot Verify Gate");
  console.log(`fixtures=${results.length}`);
  console.log(`aggregate_score=${passed}/${results.length}`);
  console.log(`failed_scorers=${failedScorers.join(",") || "none"}`);
  console.log(`fixture_ids=${results.map((result) => result.fixture_id).join(",") || "none"}`);
  console.log(`failed_fixture_ids=${failedFixtureIds.join(",") || "none"}`);
}

function printMemoryLabels(results: MemoryReviewLabels[]): void {
  if (results.length === 0) {
    console.log("- none");
    return;
  }
  for (const result of results) {
    console.log(
      [
        `- ${result.memory_id}`,
        `relevance=${result.relevance}`,
        `usefulness=${result.usefulness}`,
        `effect=${result.effect}`,
        `lifecycle=${result.lifecycle_state}`,
        `root_causes=${result.root_causes.join("|") || "none"}`,
        `evidence_refs=${result.evidence_ids.join("|") || "none"}`,
      ].join(" "),
    );
  }
}

function formatTokenUsage(tokenUsage: MemoryReviewBotEvalResult["metadata"]["token_usage"]): string {
  if (!tokenUsage) return "n/a";
  return `${tokenUsage.input_tokens}/${tokenUsage.output_tokens}/${tokenUsage.total_tokens}`;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (readModeForError() === "verify") {
    console.error(`Verify mode failed closed: ${sanitizeVerifyErrorMessage(message)}`);
  } else {
    console.error(error instanceof Error ? error.stack || error.message : message);
  }
  process.exit(1);
});

function readModeForError(): RunMode {
  const args = process.argv.slice(2);
  const index = args.indexOf("--mode");
  return args[index + 1] === "verify" ? "verify" : "tuning";
}

function sanitizeVerifyErrorMessage(message: string): string {
  const args = process.argv.slice(2);
  const privateFlagIndex = args.indexOf("--private-fixtures");
  const privatePaths = [
    privateFlagIndex >= 0 ? (args[privateFlagIndex + 1] ?? "") : "",
    process.env.MEMORY_REVIEW_BOT_VERIFY_FIXTURE_PATH ?? "",
  ].filter((value) => value.length > 0);
  return privatePaths.reduce(
    (sanitized, privatePath) => sanitized.replaceAll(privatePath, "<private-fixture-path>"),
    message,
  );
}
