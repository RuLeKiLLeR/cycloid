import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { TERRAFORM_IN_AUTOMATION_ENV, TERRAFORM_PLAN_TOKEN_ENV } from "../../../../shared/constants/sandbox-env.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  createDynamicToolFailure as failure,
  createDynamicToolTextSuccess as success,
  DYNAMIC_TOOL_ERROR_CODES,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const TERRAFORM_DYNAMIC_TOOL_NAMESPACE = "terraform";
export const TERRAFORM_PLAN_DYNAMIC_TOOL_NAME = "plan";

const TERRAFORM_PLAN_TIMEOUT_MS = 120_000;
const TERRAFORM_TERMINATION_GRACE_MS = 5_000;
const TERRAFORM_HCP_RUN_LOOKUP_TIMEOUT_MS = 5_000;
const TERRAFORM_OUTPUT_MAX_CHARS = 64 * 1024;
const DEFAULT_TERRAFORM_BINARY = "/app/bridge-tools/terraform";
const TERRAFORM_CLI_CONFIG_FILE_ENV = "TF_CLI_CONFIG_FILE";
const TERRAFORM_HCP_RUN_API_URL = "https://app.terraform.io/api/v2/runs";
const TERRAFORM_SUBPROCESS_ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

type TerraformPlanInput = {
  directory?: string;
};

type TerraformCommandPhase = "init" | "plan";

type TerraformCommandResult = {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
};

type TerraformCommandFailureDetails = TerraformCommandResult & {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

type TerraformFailureSummary = {
  errorSummary?: string;
  planSummary?: string;
  policySummary?: string;
  runTaskSummary?: string;
  runUrl?: string;
};

type TerraformRunStatusClassification = "success" | "failure" | "inconclusive";

type TerraformRunLookupResult =
  | {
      status: string;
      unavailableReason?: never;
      errorCode?: never;
    }
  | {
      status?: never;
      unavailableReason: "request_failed" | "invalid_response" | "http_error";
      errorCode?: DynamicToolErrorCode;
    };

class TerraformToolError extends Error {
  constructor(
    message: string,
    readonly code: DynamicToolErrorCode,
  ) {
    super(message);
    this.name = "TerraformToolError";
  }
}

class TerraformCommandFailedError extends TerraformToolError {
  constructor(
    readonly phase: TerraformCommandPhase,
    readonly details: TerraformCommandFailureDetails,
    readonly terraformBinary: string,
    readonly args: string[],
  ) {
    super(
      truncate(buildTerraformCommandFailureMessage(phase, details, terraformBinary, args)),
      classifyTerraformCloudAuthFailure(details) ?? "execution_failed",
    );
    this.name = "TerraformToolError";
  }
}

function truncate(text: string): string {
  if (text.length <= TERRAFORM_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, TERRAFORM_OUTPUT_MAX_CHARS)}\n...[truncated]`;
}

function collectBoundedOutput(existing: string, decoded: string): string {
  if (existing.length >= TERRAFORM_OUTPUT_MAX_CHARS) return existing;
  const remaining = TERRAFORM_OUTPUT_MAX_CHARS - existing.length;
  return `${existing}${decoded.length <= remaining ? decoded : decoded.slice(0, remaining)}`;
}

function sanitizeTerraformCommandArg(arg: string): string {
  if (arg.startsWith("-chdir=")) return "-chdir=<directory>";
  if (arg.length > 200) return `<arg length=${arg.length}>`;
  return arg;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function classifyTerraformCloudAuthFailure(
  details: Pick<TerraformCommandResult, "stdout" | "stderr">,
): DynamicToolErrorCode | null {
  const lines = `${details.stdout}\n${details.stderr}`
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);

  for (const line of lines) {
    if (
      !/\b(?:app\.terraform\.io|terraform cloud|hcp terraform|terraform enterprise|tfe|remote backend|cloud backend)\b/i.test(
        line,
      )
    ) {
      continue;
    }

    if (
      /\b(?:token|credential|credentials|authentication|authorization|oauth)\b.{0,80}\bexpired\b/i.test(line) ||
      /\bexpired\b.{0,80}\b(?:token|credential|credentials|authentication|authorization|oauth)\b/i.test(line)
    ) {
      return DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED;
    }

    if (
      /\b(?:401|403|unauthorized|forbidden|not authorized|permission denied|invalid token|invalid api token|invalid credentials|authentication failed|authorization failed)\b/i.test(
        line,
      )
    ) {
      return DYNAMIC_TOOL_ERROR_CODES.INVALID_CREDENTIAL;
    }
  }

  return null;
}

function isSafeTerraformRunUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "app.terraform.io" &&
      /^\/app\/[^/]+\/[^/]+\/runs\/[^/\s?#]+$/.test(url.pathname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function sanitizeTerraformSummaryText(text: string): string | null {
  const normalized = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 300) return null;
  if (
    /(secret|token|password|credential|private[_ -]?key|api[_ -]?key|client[_ -]?secret|access[_ -]?key)/i.test(
      normalized,
    )
  ) {
    return null;
  }
  return normalized
    .replace(/https?:\/\/\S+/gi, (candidate) => (isSafeTerraformRunUrl(candidate) ? candidate : "<url>"))
    .replace(/(^|[\s(])(?:[A-Za-z]:\\|\/|\.\/|\.\.\/)\S*/g, "$1<path>");
}

function extractTerraformCurrentRunUrl(lines: string[]): string | undefined {
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index] !== "To view this run in a browser, visit:") continue;
    const runUrl = lines[index + 1];
    if (runUrl && isSafeTerraformRunUrl(runUrl)) return runUrl;
  }
  return undefined;
}

function extractTerraformFailureSummary(details: TerraformCommandFailureDetails): TerraformFailureSummary | null {
  if (
    details.stdoutBytes > Buffer.byteLength(details.stdout, "utf8") ||
    details.stderrBytes > Buffer.byteLength(details.stderr, "utf8")
  ) {
    return null;
  }

  const lines = `${details.stdout}\n${details.stderr}`
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);

  if (lines.length === 0) return null;

  const summary: TerraformFailureSummary = { runUrl: extractTerraformCurrentRunUrl(lines) };
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];

    if (!summary.planSummary && /^Plan:\s+\d+\s+to add,\s+\d+\s+to change,\s+\d+\s+to destroy\.$/.test(line)) {
      summary.planSummary = line;
    }

    if (!summary.errorSummary) {
      const errorMatch = line.match(/^(?:[|│╷╵╶╴]+\s*)?Error:\s+(.+)$/);
      if (errorMatch) {
        const safeSummary = sanitizeTerraformSummaryText(errorMatch[1]);
        if (safeSummary) summary.errorSummary = safeSummary;
      }
    }

    if (!summary.policySummary) {
      if (/^Sentinel Result:\s*(true|false)$/i.test(line)) {
        summary.policySummary = line;
        continue;
      }
      const policyMatch = line.match(
        /^(?:policy check|policy evaluation|policy override|organization policy check).+$/i,
      );
      if (policyMatch) {
        const safeSummary = sanitizeTerraformSummaryText(policyMatch[0]);
        if (safeSummary) summary.policySummary = safeSummary;
      }
    }

    if (!summary.runTaskSummary) {
      const runTaskMatch = line.match(/^.*run task.*failed.*$/i);
      if (runTaskMatch) {
        const safeSummary = sanitizeTerraformSummaryText(runTaskMatch[0]);
        if (safeSummary) summary.runTaskSummary = safeSummary;
      }
    }
  }

  return Object.values(summary).some(Boolean) ? summary : null;
}

function parseTerraformRunId(runUrl: string | undefined): string | null {
  if (!runUrl || !isSafeTerraformRunUrl(runUrl)) return null;
  const match = new URL(runUrl).pathname.match(/^\/app\/[^/]+\/[^/]+\/runs\/([^/\s?#]+)$/);
  return match?.[1] ?? null;
}

function classifyTerraformRunStatus(status: string | null | undefined): TerraformRunStatusClassification {
  const normalizedStatus = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (["planned_and_finished", "planned_and_saved", "policy_checked"].includes(normalizedStatus)) return "success";
  if (["errored", "discarded", "canceled", "force_canceled", "policy_soft_failed"].includes(normalizedStatus)) {
    return "failure";
  }
  return "inconclusive";
}

export function shouldUseTerraformRemoteRunOverride(
  details: Pick<TerraformCommandFailureDetails, "code" | "signal">,
): boolean {
  return details.signal === null && details.code === 1;
}

async function lookupTerraformRunStatus(params: {
  fetchImpl: typeof fetch;
  runId: string;
  signal?: AbortSignal;
  token: string;
}): Promise<TerraformRunLookupResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TERRAFORM_HCP_RUN_LOOKUP_TIMEOUT_MS);
  const abort = () => controller.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await params.fetchImpl(`${TERRAFORM_HCP_RUN_API_URL}/${encodeURIComponent(params.runId)}`, {
      headers: {
        accept: "application/vnd.api+json",
        authorization: `Bearer ${params.token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        unavailableReason: "http_error",
        ...(response.status === 401 || response.status === 403
          ? { errorCode: DYNAMIC_TOOL_ERROR_CODES.INVALID_CREDENTIAL }
          : {}),
      };
    }
    const body = (await response.json().catch(() => null)) as { data?: { attributes?: { status?: unknown } } } | null;
    const status = body?.data?.attributes?.status;
    if (typeof status === "string" && /^[a-z_]+$/i.test(status.trim())) {
      return { status: status.trim().toLowerCase() };
    }
    return { unavailableReason: "invalid_response" };
  } catch {
    return { unavailableReason: "request_failed" };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener("abort", abort);
  }
}

function buildTerraformRemotePlanSuccessMessage(summary: TerraformFailureSummary, runStatus: string): string {
  return [
    "Terraform plan succeeded in HCP Terraform.",
    `HCP Terraform run URL: ${summary.runUrl}`,
    `Remote run status: ${runStatus}`,
    ...(summary.planSummary ? [`Plan summary: ${summary.planSummary}`] : []),
  ].join("\n\n");
}

function buildTerraformRemotePlanFailureMessage(summary: TerraformFailureSummary, runStatus: string): string {
  return [
    "Terraform plan failed in HCP Terraform.",
    `HCP Terraform run URL: ${summary.runUrl}`,
    `Remote run status: ${runStatus}`,
    ...(summary.planSummary ? [`Plan summary produced before failure: ${summary.planSummary}`] : []),
    ...(summary.policySummary ? [`Policy summary: ${summary.policySummary}`] : []),
    ...(summary.runTaskSummary ? [`Run task summary: ${summary.runTaskSummary}`] : []),
    ...(summary.errorSummary ? [`Error summary: ${summary.errorSummary}`] : []),
    "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values.",
  ].join("\n\n");
}

function buildTerraformRemotePlanLookupFallbackMessage(
  baseMessage: string,
  lookupResult: TerraformRunLookupResult,
): string {
  const sections = [baseMessage];
  if (lookupResult.status) {
    sections.push(`HCP Terraform run status was inconclusive for local exit override: ${lookupResult.status}`);
  } else {
    sections.push(`HCP Terraform run status lookup unavailable: ${lookupResult.unavailableReason}`);
  }
  return sections.join("\n\n");
}

async function resolveTerraformPlanRemoteResult(
  error: unknown,
  token: string,
  context: Pick<FirstPartyDynamicToolExecuteContext, "fetchImpl" | "signal">,
): Promise<FirstPartyDynamicToolCallResult | null> {
  if (!(error instanceof TerraformCommandFailedError) || error.phase !== "plan") return null;
  if (!shouldUseTerraformRemoteRunOverride(error.details)) return null;
  const summary = extractTerraformFailureSummary(error.details);
  const runId = parseTerraformRunId(summary?.runUrl);
  if (!summary?.runUrl || !runId) return null;

  const lookupResult = await lookupTerraformRunStatus({
    fetchImpl: context.fetchImpl ?? fetch,
    runId,
    signal: context.signal,
    token,
  });
  const runStatus = lookupResult.status;
  switch (classifyTerraformRunStatus(runStatus)) {
    case "success":
      return success(truncate(buildTerraformRemotePlanSuccessMessage(summary, runStatus ?? "unknown")));
    case "failure":
      return failure(
        DYNAMIC_TOOL_ERROR_CODES.EXECUTION_FAILED,
        truncate(buildTerraformRemotePlanFailureMessage(summary, runStatus ?? "unknown")),
      );
    default:
      if (lookupResult.errorCode) {
        throw new TerraformToolError(
          truncate(buildTerraformRemotePlanLookupFallbackMessage(error.message, lookupResult)),
          lookupResult.errorCode,
        );
      }
      throw new TerraformToolError(
        truncate(buildTerraformRemotePlanLookupFallbackMessage(error.message, lookupResult)),
        DYNAMIC_TOOL_ERROR_CODES.EXECUTION_FAILED,
      );
  }
}

function hasTerraformPlanCredentials(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return Boolean(env[TERRAFORM_PLAN_TOKEN_ENV]?.trim());
}

function requireTerraformPlanToken(env: NodeJS.ProcessEnv | Record<string, string>): string {
  const token = env[TERRAFORM_PLAN_TOKEN_ENV]?.trim();
  if (!token) {
    throw new TerraformToolError(
      "Terraform Cloud plan credentials are not connected for this session.",
      "not_connected",
    );
  }
  return token;
}

function resolveWorkingDirectory(cwd: string, input: TerraformPlanInput): string {
  const rawDirectory = input.directory?.trim() || ".";
  if (rawDirectory.includes("\0")) {
    throw new TerraformToolError("Terraform plan directory is invalid.", "invalid_input");
  }
  const resolved = resolve(cwd, rawDirectory);
  const rel = relative(cwd, resolved);
  if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || rel === "") {
    if (rel === "") return resolved;
    throw new TerraformToolError("Terraform plan directory must stay inside the repository.", "invalid_input");
  }
  return resolved;
}

function asTerraformPlanInput(args: unknown): TerraformPlanInput {
  const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const directory = input.directory;
  if (directory !== undefined && typeof directory !== "string") {
    throw new TerraformToolError("Terraform plan directory must be a string.", "invalid_input");
  }
  return { ...(directory !== undefined ? { directory } : {}) };
}

export function buildTerraformPlanDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!hasTerraformPlanCredentials(env)) return [];
  return [
    {
      namespace: TERRAFORM_DYNAMIC_TOOL_NAMESPACE,
      name: TERRAFORM_PLAN_DYNAMIC_TOOL_NAME,
      description:
        "Run a local Terraform init and read-only plan when Terraform Cloud is connected. The Terraform Cloud token is scoped to the bridge-owned Terraform invocation and is not exposed to the agent shell.",
      inputSchema: {
        type: "object",
        properties: {
          directory: {
            type: "string",
            description: "Repository-relative directory containing Terraform configuration. Defaults to the repo root.",
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

export function redactTerraformPlanDynamicToolInput(args: unknown): Record<string, unknown> {
  const input = asTerraformPlanInput(args);
  return { ...(input.directory ? { directory: input.directory } : {}) };
}

export function buildTerraformPlanSubprocessEnv(
  bridgeEnv: NodeJS.ProcessEnv | Record<string, string>,
  terraformCliConfigPath?: string,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of TERRAFORM_SUBPROCESS_ENV_PASSTHROUGH) {
    const value = bridgeEnv[key] ?? process.env[key];
    if (value) childEnv[key] = value;
  }
  childEnv[TERRAFORM_IN_AUTOMATION_ENV] = bridgeEnv[TERRAFORM_IN_AUTOMATION_ENV] ?? "1";
  // Intentionally replace any inherited Terraform CLI config so only the bridge-owned
  // credentials file participates in this Terraform Cloud plan invocation.
  if (terraformCliConfigPath) childEnv[TERRAFORM_CLI_CONFIG_FILE_ENV] = terraformCliConfigPath;
  return childEnv;
}

export function buildTerraformPlanCommandArgs(workingDirectory: string): [string[], string[]] {
  return [
    [`-chdir=${workingDirectory}`, "init", "-no-color", "-input=false"],
    [`-chdir=${workingDirectory}`, "plan", "-no-color", "-input=false", "-refresh=false"],
  ];
}

export function buildTerraformCliConfigText(token: string): string {
  return `credentials "app.terraform.io" {\n  token = ${JSON.stringify(token)}\n}\n`;
}

async function writeTerraformCliConfig(token: string, directory: string): Promise<string> {
  const cliConfigPath = join(directory, "terraformrc");
  await writeFile(cliConfigPath, buildTerraformCliConfigText(token), "utf8");
  await chmod(cliConfigPath, 0o600);
  return cliConfigPath;
}

export function buildTerraformCommandFailureMessage(
  phase: TerraformCommandPhase,
  details: TerraformCommandFailureDetails,
  terraformBinary: string,
  args: string[],
): string {
  const message = details.error?.message ?? "Terraform command failed.";
  const hasTerraformOutput = details.stdoutBytes > 0 || details.stderrBytes > 0;
  const failureSummary = hasTerraformOutput ? extractTerraformFailureSummary(details) : null;
  const sections = [
    `Terraform ${phase} failed.`,
    `Command: ${terraformBinary} ${args.map(sanitizeTerraformCommandArg).join(" ")}`,
    ...(details.code !== null ? [`Exit code: ${details.code}`] : []),
    ...(details.signal ? [`Signal: ${details.signal}`] : []),
    `Stdout bytes: ${details.stdoutBytes}`,
    `Stderr bytes: ${details.stderrBytes}`,
    ...(failureSummary?.runUrl ? [`HCP Terraform run URL: ${failureSummary.runUrl}`] : []),
    ...(failureSummary?.planSummary ? [`Plan summary produced before failure: ${failureSummary.planSummary}`] : []),
    ...(failureSummary?.policySummary ? [`Policy summary: ${failureSummary.policySummary}`] : []),
    ...(failureSummary?.runTaskSummary ? [`Run task summary: ${failureSummary.runTaskSummary}`] : []),
    ...(failureSummary?.errorSummary ? [`Error summary: ${failureSummary.errorSummary}`] : []),
    hasTerraformOutput
      ? "Raw Terraform diagnostics were redacted because plan output may contain sensitive provider values."
      : `Error:\n${message}`,
  ];
  return sections.join("\n\n");
}

export async function runTerraformCommand(
  phase: TerraformCommandPhase,
  terraformBinary: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout: number;
    terminationGraceMs?: number;
    signal?: AbortSignal;
  },
): Promise<TerraformCommandResult> {
  return new Promise<TerraformCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(terraformBinary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    let closeSeen = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let stdoutEnded = false;
    let stderrEnded = false;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      rejectPromise(error);
    };

    const resolveOnce = (result: TerraformCommandResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      resolvePromise(result);
    };

    const maybeFinish = () => {
      if (settled) return;
      // Ensure we have process exit info and both output streams have fully ended.
      if (!closeSeen || !stdoutEnded || !stderrEnded) return;
      // If the process ends mid-UTF8 sequence, StringDecoder.end() would emit replacement chars.
      // Since this output is diagnostic (and already bounded), drop replacement chars instead of
      // propagating them to callers.
      const flushedStdout = stdoutDecoder.end().replace(/\uFFFD/g, "");
      const flushedStderr = stderrDecoder.end().replace(/\uFFFD/g, "");
      stdout = collectBoundedOutput(stdout, flushedStdout);
      stderr = collectBoundedOutput(stderr, flushedStderr);
      const result = { stdout, stderr, stdoutBytes, stderrBytes };
      if (closeCode === 0 && closeSignal === null) {
        resolveOnce(result);
      } else {
        rejectOnce(
          new TerraformCommandFailedError(
            phase,
            { ...result, code: closeCode, signal: closeSignal },
            terraformBinary,
            args,
          ),
        );
      }
    };

    const terminate = () => {
      child.kill("SIGTERM");
      killTimeout ??= setTimeout(() => {
        child.kill("SIGKILL");
      }, options.terminationGraceMs ?? TERRAFORM_TERMINATION_GRACE_MS);
    };

    const abort = () => {
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    timeout = setTimeout(() => {
      terminate();
    }, options.timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdout = collectBoundedOutput(stdout, stdoutDecoder.write(chunk));
    });
    child.stdout?.on("end", () => {
      stdoutEnded = true;
      maybeFinish();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = collectBoundedOutput(stderr, stderrDecoder.write(chunk));
    });
    child.stderr?.on("end", () => {
      stderrEnded = true;
      maybeFinish();
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", abort);
      rejectOnce(error);
    });
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      closeSeen = true;
      closeCode = code;
      closeSignal = signal;
      maybeFinish();
    });
  }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw error;
    }
    if (error instanceof TerraformToolError) throw error;
    throw new TerraformToolError(
      truncate(
        buildTerraformCommandFailureMessage(
          phase,
          { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, code: null, signal: null, error: error as Error },
          terraformBinary,
          args,
        ),
      ),
      DYNAMIC_TOOL_ERROR_CODES.EXECUTION_FAILED,
    );
  });
}

function terraformToolErrorResult(error: unknown): FirstPartyDynamicToolCallResult {
  if (error instanceof TerraformToolError) return failure(error.code, error.message);
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return failure(
      DYNAMIC_TOOL_ERROR_CODES.MISSING_BINARY,
      `Terraform is not installed for the bridge-owned plan runner. Configure ARCANIST_TERRAFORM_BINARY or install Terraform at ${DEFAULT_TERRAFORM_BINARY}.`,
    );
  }
  const message = stringifyError(error);
  return failure(DYNAMIC_TOOL_ERROR_CODES.EXECUTION_FAILED, truncate(message));
}

export async function executeTerraformPlanDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  let terraformCliConfigDirectory: string | undefined;
  try {
    const input = asTerraformPlanInput(args);
    const cwd = resolve(context.cwd ?? process.cwd());
    const workingDirectory = resolveWorkingDirectory(cwd, input);
    const token = requireTerraformPlanToken(context.env);
    const terraformBinary = context.env.ARCANIST_TERRAFORM_BINARY?.trim() || DEFAULT_TERRAFORM_BINARY;
    terraformCliConfigDirectory = await mkdtemp(join(tmpdir(), "cycloid-terraform-"));
    const terraformCliConfigPath = await writeTerraformCliConfig(token, terraformCliConfigDirectory);
    const childEnv = buildTerraformPlanSubprocessEnv(context.env, terraformCliConfigPath);
    const [initArgs, planArgs] = buildTerraformPlanCommandArgs(workingDirectory);

    await runTerraformCommand("init", terraformBinary, initArgs, {
      cwd,
      env: childEnv,
      timeout: TERRAFORM_PLAN_TIMEOUT_MS,
      signal: context.signal,
    });
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await runTerraformCommand("plan", terraformBinary, planArgs, {
        cwd,
        env: childEnv,
        timeout: TERRAFORM_PLAN_TIMEOUT_MS,
        signal: context.signal,
      }));
    } catch (error) {
      const remoteResult = await resolveTerraformPlanRemoteResult(error, token, context);
      if (remoteResult) return remoteResult;
      throw error;
    }
    return success(truncate([stdout, stderr].filter(Boolean).join("\n")));
  } catch (error) {
    return terraformToolErrorResult(error);
  } finally {
    if (terraformCliConfigDirectory) {
      await rm(terraformCliConfigDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
