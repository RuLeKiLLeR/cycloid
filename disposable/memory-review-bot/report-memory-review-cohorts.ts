/* eslint-disable no-console */

import { readFile } from "node:fs/promises";

import {
  buildMemoryReviewCohortQueryPlan,
  buildMemoryReviewCohortReport,
  type LifecycleStateRow,
  type MemoryReviewCohortFilters,
  type MemoryReviewCohortQueryRows,
  type ReviewSummaryRow,
  type RootCauseRow,
  type SummaryRow,
} from "./cohorts.js";

interface CliOptions extends MemoryReviewCohortFilters {
  accountId: string | null;
  databaseId: string | null;
  envName: string;
  compact: boolean;
}

interface D1ApiQueryResult {
  success?: boolean;
  results?: unknown[];
  error?: string;
}

interface D1ApiResponse {
  success?: boolean;
  result?: D1ApiQueryResult[];
  errors?: Array<{ code?: number; message?: string }>;
}

const WRANGLER_TOML = new URL("../../apps/control-plane-worker/wrangler.toml", import.meta.url);

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? null;
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN or CF_API_TOKEN is required.");
  if (!options.accountId) throw new Error("--account-id or CLOUDFLARE_ACCOUNT_ID is required.");
  if (!options.databaseId) {
    throw new Error("--database-id, CLOUDFLARE_D1_DATABASE_ID, or a matching wrangler.toml D1 database is required.");
  }

  const plan = buildMemoryReviewCohortQueryPlan(options);
  const results = await queryD1Batch({
    accountId: options.accountId,
    databaseId: options.databaseId,
    apiToken,
    batch: plan.queries.map((query) => ({ sql: query.sql, params: query.params })),
  });
  const rows = rowsByQueryName(
    plan.queries.map((query) => query.name),
    results,
  );
  const report = buildMemoryReviewCohortReport(options, rows);
  console.log(JSON.stringify(report, null, options.compact ? 0 : 2));
}

async function parseArgs(args: string[]): Promise<CliOptions> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const envName = readFlag(args, "--env") ?? "production";
  const repo = readFlag(args, "--repo");
  const repoParts = repo ? splitRepo(repo) : { repoOwner: null, repoName: null };
  return {
    businessId: readFlag(args, "--business-id"),
    repoOwner: repoParts.repoOwner,
    repoName: repoParts.repoName,
    accountId: readFlag(args, "--account-id") ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? null,
    databaseId:
      readFlag(args, "--database-id") ??
      process.env.CLOUDFLARE_D1_DATABASE_ID ??
      process.env.D1_DATABASE_ID ??
      (await readWranglerDatabaseId(envName)),
    envName,
    compact: args.includes("--compact"),
  };
}

async function queryD1Batch(input: {
  accountId: string;
  databaseId: string;
  apiToken: string;
  batch: Array<{ sql: string; params: string[] }>;
}): Promise<D1ApiQueryResult[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch: input.batch }),
    },
  );
  const payload = (await response.json().catch(() => null)) as D1ApiResponse | null;
  if (!response.ok || !payload?.success) {
    const detail = formatCloudflareErrors(payload?.errors);
    throw new Error(`D1 cohort query failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const results = payload.result;
  if (!Array.isArray(results)) throw new Error("D1 cohort query returned no result array.");
  const failed = results.find((result) => result.success === false);
  if (failed) throw new Error(`D1 cohort query batch item failed${failed.error ? `: ${failed.error}` : ""}`);
  return results;
}

function rowsByQueryName(
  names: MemoryReviewCohortQueryRowsKey[],
  results: D1ApiQueryResult[],
): MemoryReviewCohortQueryRows {
  const rows: MemoryReviewCohortQueryRows = {
    summary: [],
    review: [],
    root_causes: [],
    lifecycle_states: [],
  };
  names.forEach((name, index) => {
    const resultRows = Array.isArray(results[index]?.results) ? results[index].results : [];
    if (name === "summary") rows.summary = resultRows as SummaryRow[];
    if (name === "review") rows.review = resultRows as ReviewSummaryRow[];
    if (name === "root_causes") rows.root_causes = resultRows as RootCauseRow[];
    if (name === "lifecycle_states") rows.lifecycle_states = resultRows as LifecycleStateRow[];
  });
  return rows;
}

type MemoryReviewCohortQueryRowsKey = keyof MemoryReviewCohortQueryRows;

async function readWranglerDatabaseId(envName: string): Promise<string | null> {
  const toml = await readFile(WRANGLER_TOML, "utf8").catch(() => "");
  if (!toml) return null;
  const header = envName === "production" ? "[[d1_databases]]" : `[[env.${envName}.d1_databases]]`;
  const headerIndex = toml.indexOf(header);
  if (headerIndex < 0) return null;
  const section = toml.slice(headerIndex, nextSectionIndex(toml, headerIndex + header.length));
  return section.match(/database_id\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

function nextSectionIndex(content: string, fromIndex: number): number {
  const next = content.slice(fromIndex).search(/\n\[/);
  return next >= 0 ? fromIndex + next : content.length;
}

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function splitRepo(repo: string): { repoOwner: string; repoName: string } {
  const [repoOwner, repoName] = repo.split("/");
  if (!repoOwner || !repoName) throw new Error("--repo must be in owner/name form.");
  return { repoOwner, repoName };
}

function formatCloudflareErrors(errors: D1ApiResponse["errors"]): string | null {
  if (!errors || errors.length === 0) return null;
  return errors
    .map((error) => [error.code, error.message].filter((value) => value !== undefined && value !== "").join(" "))
    .filter(Boolean)
    .join("; ");
}

function printHelp(): void {
  console.log(`Usage: npx tsx disposable/memory-review-bot/report-memory-review-cohorts.ts [options]

Options:
  --business-id <id>      Scope company memories and recall telemetry by business_id.
  --repo <owner/name>     Include repo_memories and repo-scoped company memories for one repo.
  --env <name>            Read database_id from wrangler.toml for production or an env (default: production).
  --account-id <id>       Cloudflare account id. Defaults to CLOUDFLARE_ACCOUNT_ID or CF_ACCOUNT_ID.
  --database-id <id>      D1 database id. Defaults to CLOUDFLARE_D1_DATABASE_ID, D1_DATABASE_ID, or wrangler.toml.
  --compact              Print compact JSON instead of pretty JSON.
  --help                 Show this help.

Requires CLOUDFLARE_API_TOKEN or CF_API_TOKEN.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
