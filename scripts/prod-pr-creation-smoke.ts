#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { stringifyError } from "../shared/utils/errors.js";
import { sleep } from "../shared/utils/timing.js";

type CliArgs = {
  baseUrl: string;
  token: string;
  repoUrl: string;
  model?: string;
  runs: number;
  autoVerify: boolean;
  requireVerdict: boolean;
  continueOnFailure: boolean;
  jsonOut?: string;
  summaryOut?: string;
  timeoutMs: number;
  pollIntervalMs: number;
};

type StartSessionResponse = {
  sessionId: string;
  sessionUrl?: string;
};

type SessionStatusSnapshot = {
  phase: string;
  closeReason: string | null;
  prUrl: string | null;
  verificationState: string | null;
  verificationResult: string | null;
};

type EnqueuePromptResponse = {
  prompt?: {
    id?: string;
    promptId?: string;
  };
};

type SmokeRunRecord = {
  runIndex: number;
  sessionId: string | null;
  promptId: string | null;
  sessionUrl: string | null;
  prUrl: string | null;
  model: string | null;
  verificationState: string | null;
  verificationResult: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  verdict: "pass" | "fail";
  failureReason: string | null;
};

type SessionPayload = {
  phase?: string;
  closeReason?: string | null;
  prUrl?: string | null;
  verificationState?: string | null;
  verificationResult?: string | null;
};

const DEFAULT_BASE_URL = "https://app.trycycloid.com";
const DEFAULT_REPO_URL = "https://github.com/jeman-verification/verification-prod";
const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

function usage(exitCode = 2): never {
  console.error(`Usage:
  ARCANIST_TOKEN=<token> npm run smoke:prod:pr-creation -- \\
    --runs 3 \\
    --json-out tmp/prod-pr-smoke.json

Options:
  --base-url <url>          Cycloid API/UI base URL. Defaults to ARCANIST_API_URL or ${DEFAULT_BASE_URL}.
  --repo-url <url>          GitHub repo URL. Defaults to ${DEFAULT_REPO_URL}.
  --model <id>              Optional session-start model id.
  --auto-verify             Let the control plane schedule verification after PR creation.
  --require-verdict         Poll /view until verificationResult is present before passing.
  --runs <n>                Sequential session count. Default ${DEFAULT_RUNS}.
  --continue-on-failure     Keep running after the first failed session.
  --json-out <path>         Write JSON summary to this path.
  --summary-out <path>      Write markdown summary to this path.
  --timeout-ms <ms>         Per-session timeout. Default ${DEFAULT_TIMEOUT_MS}.
  --poll-interval-ms <ms>   Poll interval. Default ${DEFAULT_POLL_INTERVAL_MS}.
`);
  process.exit(exitCode);
}

function parsePositiveInt(raw: string | undefined, label: string, defaultValue: number): number {
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function readNext(argv: string[], index: number, label: string): string {
  const next = argv[index + 1];
  if (!next) throw new Error(`${label} requires a value`);
  return next;
}

function parseArgs(argv: string[]): CliArgs {
  let baseUrl = process.env.ARCANIST_API_URL?.trim() || DEFAULT_BASE_URL;
  let repoUrl = DEFAULT_REPO_URL;
  let model: string | undefined;
  let runs = DEFAULT_RUNS;
  let autoVerify = false;
  let requireVerdict = false;
  let continueOnFailure = false;
  let jsonOut: string | undefined;
  let summaryOut: string | undefined;
  let timeoutMs = parsePositiveInt(
    process.env.ARCANIST_VERIFY_TIMEOUT_MS,
    "ARCANIST_VERIFY_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
  );
  let pollIntervalMs = parsePositiveInt(
    process.env.ARCANIST_VERIFY_POLL_INTERVAL_MS,
    "ARCANIST_VERIFY_POLL_INTERVAL_MS",
    DEFAULT_POLL_INTERVAL_MS,
  );

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--base-url") {
      baseUrl = readNext(argv, index, "--base-url");
      index += 1;
      continue;
    }
    if (arg === "--repo-url") {
      repoUrl = readNext(argv, index, "--repo-url");
      index += 1;
      continue;
    }
    if (arg === "--runs") {
      runs = parsePositiveInt(readNext(argv, index, "--runs"), "--runs", DEFAULT_RUNS);
      index += 1;
      continue;
    }
    if (arg === "--model") {
      model = readNext(argv, index, "--model");
      index += 1;
      continue;
    }
    if (arg === "--auto-verify") {
      autoVerify = true;
      continue;
    }
    if (arg === "--require-verdict") {
      requireVerdict = true;
      continue;
    }
    if (arg === "--continue-on-failure") {
      continueOnFailure = true;
      continue;
    }
    if (arg === "--json-out") {
      jsonOut = readNext(argv, index, "--json-out");
      index += 1;
      continue;
    }
    if (arg === "--summary-out") {
      summaryOut = readNext(argv, index, "--summary-out");
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(readNext(argv, index, "--timeout-ms"), "--timeout-ms", DEFAULT_TIMEOUT_MS);
      index += 1;
      continue;
    }
    if (arg === "--poll-interval-ms") {
      pollIntervalMs = parsePositiveInt(
        readNext(argv, index, "--poll-interval-ms"),
        "--poll-interval-ms",
        DEFAULT_POLL_INTERVAL_MS,
      );
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const token = process.env.ARCANIST_TOKEN?.trim() || process.env.ARCANIST_ADMIN_TOKEN?.trim() || "";
  if (!token) throw new Error("Missing auth token. Set ARCANIST_TOKEN or ARCANIST_ADMIN_TOKEN.");

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    token,
    repoUrl,
    ...(model ? { model } : {}),
    runs,
    autoVerify,
    requireVerdict,
    continueOnFailure,
    jsonOut,
    summaryOut,
    timeoutMs,
    pollIntervalMs,
  };
}

async function apiRequest(args: CliArgs, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${args.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
      authorization: `Bearer ${args.token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

export function normalizeCloseReason(session: SessionPayload): string | null {
  return typeof session.closeReason === "string" ? session.closeReason : null;
}

export function sessionPhaseOf(session: SessionPayload): string {
  return String(session.phase ?? "");
}

export function isTerminalSessionPhase(phase: string): boolean {
  return (
    phase === "completed" || phase === "blocked" || phase === "failed" || phase === "stopped" || phase === "archived"
  );
}

export function escapeMarkdownTableCell(value: unknown): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function buildPrompt(runIndex: number, timestamp: string): string {
  return [
    `Prod PR smoke test run #${runIndex} (${timestamp})`,
    "",
    "Add a single line to README.md at the top of the file that says:",
    `"Prod PR smoke test checkpoint ${runIndex} at ${timestamp}".`,
    "Do not capture screenshots unless explicitly needed; missing browser evidence must not block the PR.",
  ].join("\n");
}

export function buildStartSessionBody(args: Pick<CliArgs, "repoUrl" | "model" | "autoVerify">, runIndex: number) {
  return {
    repoUrl: args.repoUrl,
    title: `Prod PR smoke test #${runIndex}`,
    ...(args.model ? { model: args.model } : {}),
    ...(args.autoVerify ? { autoVerify: true } : {}),
  };
}

async function startSession(args: CliArgs, runIndex: number): Promise<StartSessionResponse> {
  const response = await apiRequest(args, "/api/sessions", {
    method: "POST",
    body: JSON.stringify(buildStartSessionBody(args, runIndex)),
  });
  return response.json() as Promise<StartSessionResponse>;
}

async function enqueuePrompt(args: CliArgs, sessionId: string, prompt: string): Promise<string> {
  const response = await apiRequest(args, `/api/sessions/${sessionId}/prompts`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  const payload = (await response.json()) as EnqueuePromptResponse;
  const promptId = payload.prompt?.promptId ?? payload.prompt?.id;
  if (!promptId) throw new Error(`Prompt enqueue for session ${sessionId} did not return a prompt id`);
  return promptId;
}

async function pollSessionUntilDone(args: CliArgs, sessionId: string): Promise<SessionStatusSnapshot> {
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    const response = await apiRequest(
      args,
      args.requireVerdict ? `/api/sessions/${sessionId}/view` : `/api/sessions/${sessionId}`,
    );
    const payload = (await response.json()) as {
      session?: SessionPayload;
    };
    const session = payload.session ?? {};
    const phase = sessionPhaseOf(session);
    const closeReason = normalizeCloseReason(session);
    const prUrl = session.prUrl ?? null;
    const verificationState = typeof session.verificationState === "string" ? session.verificationState : null;
    const verificationResult = typeof session.verificationResult === "string" ? session.verificationResult : null;
    if (args.requireVerdict) {
      if (verificationResult !== null || closeReason !== null || (isTerminalSessionPhase(phase) && !prUrl)) {
        return { phase, closeReason, prUrl, verificationState, verificationResult };
      }
    } else if (prUrl || isTerminalSessionPhase(phase) || closeReason !== null) {
      return { phase, closeReason, prUrl, verificationState, verificationResult };
    }
    await sleep(args.pollIntervalMs);
  }
  throw new Error(`Session ${sessionId} did not reach terminal state within ${args.timeoutMs}ms`);
}

async function runOne(args: CliArgs, runIndex: number): Promise<SmokeRunRecord> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const record: SmokeRunRecord = {
    runIndex,
    sessionId: null,
    promptId: null,
    sessionUrl: null,
    prUrl: null,
    model: args.model ?? null,
    verificationState: null,
    verificationResult: null,
    startedAt,
    endedAt: null,
    durationMs: null,
    verdict: "fail",
    failureReason: null,
  };

  try {
    const prompt = buildPrompt(runIndex, startedAt);
    const started = await startSession(args, runIndex);
    record.sessionId = started.sessionId;
    record.sessionUrl = started.sessionUrl ?? `${args.baseUrl}/sessions/${started.sessionId}`;
    record.promptId = await enqueuePrompt(args, started.sessionId, prompt);

    const snapshot = await pollSessionUntilDone(args, started.sessionId);
    record.prUrl = snapshot.prUrl;
    record.verificationState = snapshot.verificationState;
    record.verificationResult = snapshot.verificationResult;
    if (!snapshot.prUrl && snapshot.closeReason !== null) {
      throw new Error(`Session closed without a PR (closeReason=${snapshot.closeReason || "<empty>"})`);
    }
    if (!snapshot.prUrl) throw new Error(`Session ended without a PR URL (phase=${snapshot.phase || "unknown"})`);
    if (args.requireVerdict && !snapshot.verificationResult) {
      throw new Error(
        `Session produced a PR but no verification verdict (verificationState=${snapshot.verificationState ?? "unknown"})`,
      );
    }
    record.verdict = "pass";
  } catch (error) {
    record.failureReason = stringifyError(error);
  } finally {
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.now() - startMs;
  }

  return record;
}

function renderMarkdown(args: CliArgs, records: SmokeRunRecord[]): string {
  const lines: string[] = [];
  lines.push("# Prod PR smoke test");
  lines.push("");
  lines.push(`- API: \`${args.baseUrl}\``);
  lines.push(`- Repo: \`${args.repoUrl}\``);
  if (args.model) lines.push(`- Model: \`${args.model}\``);
  if (args.autoVerify) lines.push("- Auto-verify: enabled");
  if (args.requireVerdict) lines.push("- Verdict required: yes");
  lines.push(`- Runs: ${records.length}`);
  lines.push(`- Passed: ${records.filter((record) => record.verdict === "pass").length} / ${records.length}`);
  lines.push("- PR close: handled by the prod control plane for this smoke repo");
  lines.push("");
  lines.push("| # | verdict | session | PR | verification | duration (s) | failure |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const record of records) {
    lines.push(
      [
        record.runIndex,
        record.verdict,
        record.sessionUrl ?? record.sessionId ?? "-",
        record.prUrl ?? "-",
        record.verificationResult ?? record.verificationState ?? "-",
        record.durationMs !== null ? (record.durationMs / 1000).toFixed(1) : "-",
        record.failureReason ?? "",
      ]
        .map((value) => `| ${escapeMarkdownTableCell(value)} `)
        .join("") + "|",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const records: SmokeRunRecord[] = [];

  console.log(`Running prod PR smoke test against ${args.baseUrl} (${args.runs} run(s))`);
  for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
    console.log(`\n--- Run ${runIndex}/${args.runs} ---`);
    const record = await runOne(args, runIndex);
    records.push(record);
    console.log(
      `Run ${runIndex}: ${record.verdict}` +
        (record.sessionUrl ? ` | session=${record.sessionUrl}` : "") +
        (record.prUrl ? ` | PR=${record.prUrl}` : "") +
        (record.failureReason ? ` | error=${record.failureReason}` : ""),
    );
    if (record.verdict === "fail" && !args.continueOnFailure) break;
  }

  const markdown = renderMarkdown(args, records);
  const json = JSON.stringify({ createdAt: new Date().toISOString(), runs: records }, null, 2);
  if (args.summaryOut) {
    mkdirSync(dirname(args.summaryOut), { recursive: true });
    writeFileSync(args.summaryOut, `${markdown}\n`);
  }
  if (args.jsonOut) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    writeFileSync(args.jsonOut, `${json}\n`);
  }

  console.log("");
  console.log(markdown);
  if (records.some((record) => record.verdict === "fail")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(stringifyError(error));
    process.exit(1);
  });
}
