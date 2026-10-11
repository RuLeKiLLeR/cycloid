#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { stringifyError } from "../shared/utils/errors.js";
import { sleep } from "../shared/utils/timing.js";

type CliArgs = {
  baseUrl: string;
  repoOwner: string;
  repoName: string;
  token: string;
  ownerUserId?: string;
  model?: string;
  reasoningEffort?: string;
  jsonOut?: string;
  timeoutMs: number;
  pollIntervalMs: number;
};

type PromptRecord = {
  id?: string;
  promptId?: string;
  status?: string;
  error?: string | null;
};

type SessionExport = {
  prompts?: PromptRecord[];
};

type CreatedSession = {
  sessionId: string;
  sessionUrl?: string;
  session?: {
    model?: string | null;
    reasoningEffort?: string | null;
  };
};

type SessionStatusResponse = {
  session?: {
    status?: string | null;
    closeReason?: string | null;
    prUrl?: string | null;
  };
};

type VerificationReport = {
  sessionId: string;
  sessionUrl: string;
  repo: string;
  model: string | null;
  reasoningEffort: string | null;
  promptStatus: "completed";
  prUrl: string;
  timings: Record<string, string | number>;
};

const DEFAULT_BASE_URL = "https://qa.app.trycycloid.com";
const DEFAULT_REPO_OWNER = "jeman-verification";
const DEFAULT_REPO_NAME = "verification-prod";
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_REASONING_EFFORT = "low";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const API_REQUEST_MAX_ATTEMPTS = 3;
const API_REQUEST_RETRY_DELAYS_MS = [500, 1_000] as const;
const GITHUB_PR_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i;
const ALLOWED_REMOTE_ORIGINS = new Set(["https://app.trycycloid.com", "https://qa.app.trycycloid.com"]);

export class TransientApiRequestError extends Error {
  readonly transient = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientApiRequestError";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isTransientApiRequestError(error: unknown): error is TransientApiRequestError {
  return error instanceof TransientApiRequestError || (error instanceof Error && "transient" in error);
}

function usage(exitCode = 2): never {
  console.error(`Usage:
  ARCANIST_TOKEN=<token> npm run verify:e2b-session -- \\
    --base-url https://qa.app.trycycloid.com \\
    --repo-owner <owner> \\
    --repo-name <repo>

Options:
  --base-url <url>          Cycloid API/UI base URL. Defaults to ARCANIST_API_URL or ${DEFAULT_BASE_URL}.
  --repo-owner <owner>      GitHub owner for the smoke repo. Defaults to ${DEFAULT_REPO_OWNER}.
  --repo-name <repo>        GitHub repo name for the smoke repo. Defaults to ${DEFAULT_REPO_NAME}.
  --owner-user-id <id>      Optional numeric owner user id for admin-token runs.
  --model <model>           Session model. Defaults to ${DEFAULT_MODEL}.
  --reasoning-effort <effort>
                            Reasoning effort for the session model. Defaults to ${DEFAULT_REASONING_EFFORT}.
  --json-out <path>         Write the verification report JSON to this path.
  --timeout-ms <ms>         Prompt and PR timeout. Default ${DEFAULT_TIMEOUT_MS}.
  --poll-interval-ms <ms>   Poll interval. Default ${DEFAULT_POLL_INTERVAL_MS}.
`);
  process.exit(exitCode);
}

function parsePositiveInt(raw: string | undefined, label: string, defaultValue: number): number {
  if (!raw) return defaultValue;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function withoutProviderPrefix(model: string): string {
  const separatorIndex = Math.max(model.lastIndexOf("/"), model.lastIndexOf(":"));
  return separatorIndex >= 0 ? model.slice(separatorIndex + 1) : model;
}

function defaultReasoningEffortForModel(model: string | undefined): string | undefined {
  const modelId = model ? withoutProviderPrefix(model) : undefined;
  return modelId?.startsWith("claude-") ? undefined : DEFAULT_REASONING_EFFORT;
}

function normalizeBaseUrl(rawBaseUrl: string): string {
  const normalized = rawBaseUrl.replace(/\/$/, "");
  const url = new URL(normalized);
  const isLoopback =
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (ALLOWED_REMOTE_ORIGINS.has(url.origin) || isLoopback) {
    return normalized;
  }
  throw new Error(`Unsupported base URL: ${normalized}`);
}

function parseArgs(argv: string[]): CliArgs {
  let baseUrl = process.env.ARCANIST_API_URL?.trim() || DEFAULT_BASE_URL;
  let repoOwner = DEFAULT_REPO_OWNER;
  let repoName = DEFAULT_REPO_NAME;
  let ownerUserId: string | undefined;
  let model: string | undefined = DEFAULT_MODEL;
  let reasoningEffort: string | undefined = defaultReasoningEffortForModel(model);
  let reasoningEffortExplicit = false;
  let jsonOut: string | undefined;
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
    const next = argv[index + 1];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--base-url" && next) {
      baseUrl = next;
      index += 1;
      continue;
    }
    if (arg === "--repo-owner" && next) {
      repoOwner = next;
      index += 1;
      continue;
    }
    if (arg === "--repo-name" && next) {
      repoName = next;
      index += 1;
      continue;
    }
    if (arg === "--owner-user-id" && next) {
      if (!/^\d+$/.test(next) || Number(next) <= 0) {
        throw new Error("--owner-user-id must be a positive integer");
      }
      ownerUserId = next;
      index += 1;
      continue;
    }
    if (arg === "--model" && next) {
      model = next;
      if (!reasoningEffortExplicit) {
        reasoningEffort = defaultReasoningEffortForModel(model);
      }
      index += 1;
      continue;
    }
    if (arg === "--reasoning-effort" && next) {
      reasoningEffort = next;
      reasoningEffortExplicit = true;
      index += 1;
      continue;
    }
    if (arg === "--json-out" && next) {
      jsonOut = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      timeoutMs = parsePositiveInt(next, "--timeout-ms", DEFAULT_TIMEOUT_MS);
      index += 1;
      continue;
    }
    if (arg === "--poll-interval-ms" && next) {
      pollIntervalMs = parsePositiveInt(next, "--poll-interval-ms", DEFAULT_POLL_INTERVAL_MS);
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  const token = process.env.ARCANIST_TOKEN?.trim() || process.env.ARCANIST_ADMIN_TOKEN?.trim() || "";
  if (!token) {
    throw new Error("Missing auth token. Set ARCANIST_TOKEN or ARCANIST_ADMIN_TOKEN.");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    repoOwner,
    repoName,
    token,
    ownerUserId,
    model,
    reasoningEffort,
    jsonOut,
    timeoutMs,
    pollIntervalMs,
  };
}

export async function apiRequest(args: CliArgs, path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const retryGet = method === "GET";
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= API_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${args.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${args.token}`,
        },
      });
    } catch (error) {
      if (!retryGet) {
        throw error;
      }
      lastNetworkError = error;
      if (attempt === API_REQUEST_MAX_ATTEMPTS) {
        throw new TransientApiRequestError(
          `${method} ${path} failed after ${API_REQUEST_MAX_ATTEMPTS} attempts: ${stringifyError(error)}`,
          { cause: error },
        );
      }
      await sleep(API_REQUEST_RETRY_DELAYS_MS[attempt - 1] ?? API_REQUEST_RETRY_DELAYS_MS.at(-1) ?? 1_000);
      continue;
    }

    if (response.ok) {
      return response;
    }

    const message = `${method} ${path} failed: ${response.status} ${await response.text()}`;
    if (!retryGet || !isRetryableStatus(response.status)) {
      throw new Error(message);
    }
    if (attempt === API_REQUEST_MAX_ATTEMPTS) {
      throw new TransientApiRequestError(message);
    }

    await sleep(API_REQUEST_RETRY_DELAYS_MS[attempt - 1] ?? API_REQUEST_RETRY_DELAYS_MS.at(-1) ?? 1_000);
  }

  throw new TransientApiRequestError(
    `${method} ${path} failed after ${API_REQUEST_MAX_ATTEMPTS} attempts: ${stringifyError(lastNetworkError)}`,
    { cause: lastNetworkError },
  );
}

async function createSession(args: CliArgs): Promise<CreatedSession> {
  const repoUrl = `https://github.com/${args.repoOwner}/${args.repoName}`;
  const response = await apiRequest(args, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      context: { repoUrl },
      autoVerify: false,
      ...(args.ownerUserId ? { ownerUserId: args.ownerUserId } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    }),
  });
  return response.json() as Promise<CreatedSession>;
}

async function enqueuePrompt(args: CliArgs, sessionId: string, prompt: string): Promise<string> {
  const response = await apiRequest(args, `/api/sessions/${sessionId}/prompts`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  const payload = (await response.json()) as { prompt?: { id?: string; promptId?: string } };
  const promptId = payload.prompt?.id ?? payload.prompt?.promptId;
  if (!promptId) {
    throw new Error(`Prompt enqueue for session ${sessionId} did not return a prompt id`);
  }
  return promptId;
}

async function fetchExport(args: CliArgs, sessionId: string): Promise<SessionExport> {
  const response = await apiRequest(args, `/api/sessions/${sessionId}/export`);
  return response.json() as Promise<SessionExport>;
}

async function fetchSessionStatus(args: CliArgs, sessionId: string): Promise<SessionStatusResponse> {
  const response = await apiRequest(args, `/api/sessions/${sessionId}`);
  return response.json() as Promise<SessionStatusResponse>;
}

async function stopSession(args: CliArgs, sessionId: string): Promise<void> {
  await apiRequest(args, `/api/sessions/${sessionId}/stop`, { method: "POST" });
}

function promptIdOf(prompt: PromptRecord): string | undefined {
  return prompt.id ?? prompt.promptId;
}

function isPromptRunning(status: string | undefined): boolean {
  return !status || status === "queued" || status === "processing";
}

async function fetchPrompt(args: CliArgs, sessionId: string, promptId: string): Promise<PromptRecord | undefined> {
  const exportData = await fetchExport(args, sessionId);
  return exportData.prompts?.find((candidate) => promptIdOf(candidate) === promptId);
}

function assertGithubPrUrl(prUrl: string): void {
  if (!GITHUB_PR_URL_REGEX.test(prUrl)) {
    throw new Error(`Session produced a non-GitHub PR URL: ${prUrl}`);
  }
}

export async function waitForPromptAndPr(
  args: CliArgs,
  sessionId: string,
  promptId: string,
): Promise<{ prUrl: string }> {
  const deadline = Date.now() + args.timeoutMs;
  let completedPrompt: PromptRecord | undefined;
  let lastTransientError: TransientApiRequestError | undefined;
  while (Date.now() < deadline) {
    let prompt: PromptRecord | undefined;
    let status: SessionStatusResponse;
    try {
      [prompt, status] = await Promise.all([
        fetchPrompt(args, sessionId, promptId),
        fetchSessionStatus(args, sessionId),
      ]);
      lastTransientError = undefined;
    } catch (error) {
      if (isTransientApiRequestError(error)) {
        lastTransientError = error;
        await sleep(args.pollIntervalMs);
        continue;
      }
      throw error;
    }
    if (prompt && !isPromptRunning(prompt.status)) {
      if (prompt.status !== "completed") {
        throw new Error(`Prompt ${promptId} did not complete successfully: ${prompt.status} ${prompt.error ?? ""}`);
      }
      completedPrompt = prompt;
    }

    const prUrl = status.session?.prUrl?.trim();
    if (prUrl && completedPrompt) {
      assertGithubPrUrl(prUrl);
      return { prUrl };
    }

    const closeReason = status.session?.closeReason;
    if (closeReason) {
      const prUrlNote = prUrl ? ` (prUrl=${prUrl} was present but prompt had not completed)` : "";
      throw new Error(`Session closed before verification succeeded (closeReason=${closeReason})${prUrlNote}`);
    }

    await sleep(args.pollIntervalMs);
  }
  if (lastTransientError) {
    throw lastTransientError;
  }
  throw new Error(`Timed out waiting for prompt ${promptId} and PR URL in session ${sessionId}`);
}

function durationMs(start: number, end: number): number {
  return Math.max(0, end - start);
}

// Kept fully prescriptive so the agent does ~1 turn (no exploration): names the
// exact file, the exact line text and position, and the exact commit action.
// The verifier still requires a PR URL, but Cycloid's post-exec publish path
// owns push and PR creation. Keep the "no screenshots" guard so missing browser
// evidence never blocks the PR. Exported for the prompt-contract test.
export function buildReadmeSmokePrompt(timestamp: string): string {
  return [
    `Prod PR smoke test run (${timestamp})`,
    "",
    `Insert exactly one new line as the first line of README.md: "Prod PR smoke test checkpoint at ${timestamp}".`,
    "Do not change anything else in the file or the repo.",
    "Then commit that change. Do not push the branch or open a pull request yourself; Cycloid will publish the committed change automatically. That is the entire task; do not explore the repo first.",
    "Do not capture screenshots unless explicitly needed; missing browser evidence must not block the PR.",
  ].join("\n");
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv);
  let sessionId: string | undefined;
  const smokeTimestamp = new Date().toISOString();
  const timings: Record<string, number> = {
    scriptStartedAt: Date.now(),
  };
  try {
    const created = await createSession(args);
    sessionId = created.sessionId;
    timings.sessionCreatedAt = Date.now();
    const sessionUrl = created.sessionUrl ?? `${args.baseUrl}/sessions/${created.sessionId}`;
    console.log(`Created Prod PR smoke test session ${created.sessionId}`);
    console.log(`Session URL: ${sessionUrl}`);

    timings.promptEnqueuedStartedAt = Date.now();
    const promptId = await enqueuePrompt(args, created.sessionId, buildReadmeSmokePrompt(smokeTimestamp));
    timings.promptEnqueuedAt = Date.now();
    console.log(`Enqueued prompt ${promptId}`);

    const result = await waitForPromptAndPr(args, created.sessionId, promptId);
    timings.prDetectedAt = Date.now();

    const report: VerificationReport = {
      sessionId: created.sessionId,
      sessionUrl,
      repo: `${args.repoOwner}/${args.repoName}`,
      model: created.session?.model ?? args.model ?? null,
      reasoningEffort: created.session?.reasoningEffort ?? args.reasoningEffort ?? null,
      promptStatus: "completed",
      prUrl: result.prUrl,
      timings: {
        ...Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, new Date(value).toISOString()])),
        createSessionMs: durationMs(timings.scriptStartedAt, timings.sessionCreatedAt),
        promptToPrMs: durationMs(timings.promptEnqueuedAt, timings.prDetectedAt),
        totalMs: durationMs(timings.scriptStartedAt, timings.prDetectedAt),
      },
    };

    console.log("");
    console.log("Prod PR smoke test passed");
    console.log(JSON.stringify(report, null, 2));
    if (args.jsonOut) {
      mkdirSync(dirname(args.jsonOut), { recursive: true });
      writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`Wrote verification report to ${args.jsonOut}`);
    }
  } finally {
    if (sessionId) {
      await stopSession(args, sessionId).catch((error) => {
        console.warn(`Best-effort final stop failed: ${stringifyError(error)}`);
      });
    }
  }
}

// Only run when invoked as a script, not when imported (e.g. by the
// prompt-contract test importing buildReadmeSmokePrompt).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(stringifyError(error));
    process.exit(1);
  });
}
