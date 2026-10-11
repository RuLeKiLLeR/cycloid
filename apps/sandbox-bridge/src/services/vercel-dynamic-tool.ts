import { VERCEL_ACCESS_TOKEN_ENV, VERCEL_TEAM_ID_ENV } from "../../../../shared/constants/sandbox-env.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import { isCancellationError } from "./cancellation.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  createDynamicToolFailure as dynamicToolFailureResult,
  createDynamicToolJsonSuccess as successResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const VERCEL_DYNAMIC_TOOL_NAMESPACE = "vercel";
export const VERCEL_GET_DEPLOYMENT_FOR_REF_DYNAMIC_TOOL_NAME = "get_deployment_for_ref";
export const VERCEL_GET_PREVIEW_URL_DYNAMIC_TOOL_NAME = "get_preview_url";

const VERCEL_API_BASE_URL = "https://api.vercel.com";
const VERCEL_TIMEOUT_MS = 15_000;
const VERCEL_DEPLOYMENT_INPUT_FIELDS = ["projectId", "gitRef", "gitSha"] as const;

type VercelDeploymentApiResponse = {
  uid?: unknown;
  name?: unknown;
  url?: unknown;
  state?: unknown;
  readyState?: unknown;
  createdAt?: unknown;
  buildingAt?: unknown;
  ready?: unknown;
  alias?: unknown;
  target?: unknown;
  meta?: Record<string, unknown> | null;
};

type VercelDeploymentsListResponse = {
  deployments?: VercelDeploymentApiResponse[] | null;
};

type VercelDeploymentSummary = {
  deploymentId: string;
  projectId: string;
  name: string | null;
  status: string;
  previewUrl: string | null;
  deploymentUrl: string | null;
  target: string | null;
  gitRef: string | null;
  gitSha: string | null;
  createdAt: number | null;
  readyAt: number | null;
};

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  if (error.code === DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT || error.code === DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND) {
    return error.code;
  }
  if (error.status === 400) return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
  if (error.status === 401) return DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED;
  if (error.status === 403) return DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING;
  if (error.status === 404) return DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND;
  if (error.status === 429) return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED;
  return DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_ERROR;
}

function credentialsFromEnv(env: NodeJS.ProcessEnv | Record<string, string>): {
  accessToken: string;
  teamId: string | null;
} | null {
  const accessToken = env[VERCEL_ACCESS_TOKEN_ENV]?.trim();
  if (!accessToken) return null;
  const teamId = env[VERCEL_TEAM_ID_ENV]?.trim() || null;
  return { accessToken, teamId };
}

function vercelApiUrl(path: string, query?: URLSearchParams, teamId?: string | null): string {
  const params = new URLSearchParams(query);
  if (teamId) params.set("teamId", teamId);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return `${VERCEL_API_BASE_URL}${path}${suffix}`;
}

async function vercelApiRequest<T>(
  credentials: { accessToken: string; teamId: string | null },
  path: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  query?: URLSearchParams,
): Promise<T> {
  const response = await fetchImpl(vercelApiUrl(path, query, credentials.teamId), {
    method: "GET",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      accept: "application/json",
    },
    signal: createTimeoutAwareSignal(signal, VERCEL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new DynamicToolError(
      `Vercel API request failed (${response.status})`,
      "upstream_http_error",
      response.status,
    );
  }
  return (await response.json()) as T;
}

function requireDeploymentLookupInput(args: unknown): {
  projectId: string;
  gitRef: string | null;
  gitSha: string | null;
} {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("Vercel deployment lookup requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, VERCEL_DEPLOYMENT_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `Vercel deployment lookup received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }
  const projectId = asNonEmptyString(input.projectId);
  if (!projectId) {
    throw new DynamicToolError("Vercel deployment lookup requires a non-empty 'projectId'.", "invalid_input");
  }
  const gitRef = input.gitRef === undefined ? null : asNonEmptyString(input.gitRef);
  const gitSha = input.gitSha === undefined ? null : asNonEmptyString(input.gitSha);
  if (input.gitRef !== undefined && !gitRef) {
    throw new DynamicToolError(
      "Vercel deployment lookup requires 'gitRef' to be a non-empty string when provided.",
      "invalid_input",
    );
  }
  if (input.gitSha !== undefined && !gitSha) {
    throw new DynamicToolError(
      "Vercel deployment lookup requires 'gitSha' to be a non-empty string when provided.",
      "invalid_input",
    );
  }
  if (!gitRef && !gitSha) {
    throw new DynamicToolError("Vercel deployment lookup requires either 'gitRef' or 'gitSha'.", "invalid_input");
  }
  return { projectId, gitRef: gitRef ?? null, gitSha: gitSha ?? null };
}

function nullableTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function deploymentPreviewUrl(deployment: VercelDeploymentApiResponse): string | null {
  const aliases = Array.isArray(deployment.alias)
    ? deployment.alias.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
    : [];
  if (aliases.length > 0) {
    return `https://${aliases[0]}`;
  }
  const url = asNonEmptyString(deployment.url);
  return url ? `https://${url.replace(/^https?:\/\//, "")}` : null;
}

function summarizeDeployment(projectId: string, deployment: VercelDeploymentApiResponse): VercelDeploymentSummary {
  const meta = deployment.meta ?? {};
  const gitRef = asNonEmptyString(meta.githubCommitRef) ?? asNonEmptyString(meta.gitCommitRef);
  const gitSha = asNonEmptyString(meta.githubCommitSha) ?? asNonEmptyString(meta.gitCommitSha);
  const deploymentUrl = deploymentPreviewUrl(deployment);
  return {
    deploymentId: asNonEmptyString(deployment.uid) ?? "",
    projectId,
    name: asNonEmptyString(deployment.name) ?? null,
    status: asNonEmptyString(deployment.readyState) ?? asNonEmptyString(deployment.state) ?? "UNKNOWN",
    previewUrl: deploymentUrl,
    deploymentUrl,
    target: asNonEmptyString(deployment.target) ?? null,
    gitRef: gitRef ?? null,
    gitSha: gitSha ?? null,
    createdAt: nullableTimestamp(deployment.createdAt),
    readyAt: nullableTimestamp(deployment.ready),
  };
}

async function fetchDeploymentForRef(
  credentials: { accessToken: string; teamId: string | null },
  input: { projectId: string; gitRef: string | null; gitSha: string | null },
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<VercelDeploymentSummary> {
  const query = new URLSearchParams();
  query.set("projectId", input.projectId);
  query.set("limit", "1");
  if (input.gitSha) query.set("meta-githubCommitSha", input.gitSha);
  if (input.gitRef) query.set("meta-githubCommitRef", input.gitRef);

  const response = await vercelApiRequest<VercelDeploymentsListResponse>(
    credentials,
    "/v6/deployments",
    fetchImpl,
    signal,
    query,
  );
  const deployment = Array.isArray(response.deployments) ? response.deployments[0] : null;
  if (!deployment) {
    throw new DynamicToolError("No Vercel deployment matched the requested project and git ref.", "not_found", 404);
  }
  return summarizeDeployment(input.projectId, deployment);
}

export function buildVercelGetDeploymentForRefDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: VERCEL_DYNAMIC_TOOL_NAMESPACE,
      name: VERCEL_GET_DEPLOYMENT_FOR_REF_DYNAMIC_TOOL_NAME,
      description:
        "Resolve the latest Vercel deployment for a connected project and git branch or commit SHA, including deploy status and preview URL.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Vercel project ID (prj_...)." },
          gitRef: { type: "string", description: "Git branch name to match against deployment metadata." },
          gitSha: { type: "string", description: "Git commit SHA to match against deployment metadata." },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
    },
  ];
}

export function buildVercelGetPreviewUrlDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!credentialsFromEnv(env)) return [];
  return [
    {
      namespace: VERCEL_DYNAMIC_TOOL_NAMESPACE,
      name: VERCEL_GET_PREVIEW_URL_DYNAMIC_TOOL_NAME,
      description: "Return the live Vercel preview URL for a project and git branch or commit SHA.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Vercel project ID (prj_...)." },
          gitRef: { type: "string", description: "Git branch name to match against deployment metadata." },
          gitSha: { type: "string", description: "Git commit SHA to match against deployment metadata." },
        },
        required: ["projectId"],
        additionalProperties: false,
      },
    },
  ];
}

export function redactVercelDynamicToolInputForPersistence(args: unknown): Record<string, unknown> | null | undefined {
  const input = asRecord(args);
  if (!input) return undefined;
  return {
    ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
    ...(typeof input.gitRef === "string" ? { gitRef: input.gitRef } : {}),
    ...(typeof input.gitSha === "string" ? { gitShaLength: input.gitSha.length } : {}),
  };
}

export async function executeVercelGetDeploymentForRefDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Vercel credentials are not configured for this session.");
  }
  try {
    const input = requireDeploymentLookupInput(args);
    const deployment = await fetchDeploymentForRef(credentials, input, context.fetchImpl ?? fetch, context.signal);
    return successResult(deployment);
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Vercel deployment lookup was cancelled.");
    }
    const vercelError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(vercelError),
      `Vercel deployment lookup failed: ${vercelError.message}`,
    );
  }
}

export async function executeVercelGetPreviewUrlDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = credentialsFromEnv(context.env);
  if (!credentials) {
    return dynamicToolFailureResult("not_connected", "Vercel credentials are not configured for this session.");
  }
  try {
    const input = requireDeploymentLookupInput(args);
    const deployment = await fetchDeploymentForRef(credentials, input, context.fetchImpl ?? fetch, context.signal);
    if (!deployment.previewUrl) {
      return dynamicToolFailureResult("not_found", "Vercel deployment matched, but no preview URL is available yet.");
    }
    return successResult({
      projectId: deployment.projectId,
      gitRef: deployment.gitRef,
      gitSha: deployment.gitSha,
      status: deployment.status,
      previewUrl: deployment.previewUrl,
      deploymentId: deployment.deploymentId,
    });
  } catch (error) {
    if (isCancellationError(error)) {
      return dynamicToolFailureResult("cancelled", "Vercel preview URL lookup was cancelled.");
    }
    const vercelError =
      error instanceof DynamicToolError ? error : new DynamicToolError(stringifyError(error), "upstream_error");
    return dynamicToolFailureResult(
      mapDynamicToolErrorCode(vercelError),
      `Vercel preview URL lookup failed: ${vercelError.message}`,
    );
  }
}
