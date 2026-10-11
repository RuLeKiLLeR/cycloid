#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { stringifyError } from "../shared/utils/errors.js";

type RepoSpec = {
  label: string;
  owner: string;
  name: string;
};

type MatrixArgs = {
  baseUrl?: string;
  model?: string;
  jsonOut?: string;
  runs: number;
  repos: RepoSpec[];
};

type MatrixRun = {
  label: string;
  repo: string;
  run: number;
  ok: boolean;
  report?: unknown;
  error?: string;
};

const DEFAULT_RUNS = 1;
const DEFAULT_JSON_OUT = "artifacts/e2b-baseline-matrix.json";
const VERIFY_SCRIPT = resolve("scripts/verify-e2b-session.ts");
const TSX_CLI = resolve("node_modules/tsx/dist/cli.mjs");

function usage(exitCode = 2): never {
  console.error(`Usage:
  ARCANIST_TOKEN=<token> E2B_API_KEY=<key> npm run baseline:e2b -- \\
    --repo small=owner/repo \\
    --repo medium=owner/repo \\
    --repo large=owner/repo

Options:
  --repo <label=owner/name>   Repo to verify. Pass exactly three for the standard baseline matrix.
  --runs <n>                  Number of runs per repo. Default ${DEFAULT_RUNS}.
  --base-url <url>            Passed through to verify:e2b-session.
  --model <model>             Passed through to verify:e2b-session.
  --json-out <path>           Matrix report path. Default ${DEFAULT_JSON_OUT}.
`);
  process.exit(exitCode);
}

function parsePositiveInt(raw: string, label: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseRepoSpec(raw: string): RepoSpec {
  const [labelPart, repoPart] = raw.includes("=") ? raw.split("=", 2) : ["repo", raw];
  const [owner, name] = repoPart.split("/", 2);
  if (!labelPart || !owner || !name) throw new Error(`Invalid repo spec: ${raw}`);
  return { label: labelPart, owner, name };
}

function parseArgs(argv: string[]): MatrixArgs {
  const args: MatrixArgs = {
    runs: DEFAULT_RUNS,
    repos: [],
    jsonOut: DEFAULT_JSON_OUT,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--repo" && next) {
      args.repos.push(parseRepoSpec(next));
      index += 1;
      continue;
    }
    if (arg === "--runs" && next) {
      args.runs = parsePositiveInt(next, "--runs");
      index += 1;
      continue;
    }
    if (arg === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--model" && next) {
      args.model = next;
      index += 1;
      continue;
    }
    if (arg === "--json-out" && next) {
      args.jsonOut = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  if (args.repos.length === 0) usage();
  return args;
}

function runVerifier(args: MatrixArgs, repo: RepoSpec, runIndex: number, tempDir: string): MatrixRun {
  const reportPath = join(tempDir, `${repo.label}-${runIndex}.json`);
  const verifierArgs = [
    TSX_CLI,
    VERIFY_SCRIPT,
    "--repo-owner",
    repo.owner,
    "--repo-name",
    repo.name,
    "--json-out",
    reportPath,
  ];
  if (args.baseUrl) verifierArgs.push("--base-url", args.baseUrl);
  if (args.model) verifierArgs.push("--model", args.model);

  const child = spawnSync(process.execPath, verifierArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);

  if (child.status !== 0) {
    return {
      label: repo.label,
      repo: `${repo.owner}/${repo.name}`,
      run: runIndex,
      ok: false,
      error: `verify-e2b-session exited with status ${child.status ?? "unknown"}`,
    };
  }

  return {
    label: repo.label,
    repo: `${repo.owner}/${repo.name}`,
    run: runIndex,
    ok: true,
    report: JSON.parse(readFileSync(reportPath, "utf8")) as unknown,
  };
}

function buildSummary(results: MatrixRun[]): Record<string, unknown> {
  return {
    createdAt: new Date().toISOString(),
    runCount: results.length,
    okCount: results.filter((result) => result.ok).length,
    failedCount: results.filter((result) => !result.ok).length,
    results,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const tempDir = mkdtempSync(join(tmpdir(), "cycloid-e2b-baseline-"));
  try {
    const results: MatrixRun[] = [];
    for (const repo of args.repos) {
      for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
        console.log(`\n[e2b-baseline] ${repo.label} ${repo.owner}/${repo.name} run ${runIndex}/${args.runs}`);
        results.push(runVerifier(args, repo, runIndex, tempDir));
      }
    }
    const summary = buildSummary(results);
    if (args.jsonOut) {
      mkdirSync(dirname(args.jsonOut), { recursive: true });
      writeFileSync(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`\n[e2b-baseline] wrote ${args.jsonOut}`);
    }
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(stringifyError(error));
  process.exit(1);
});
