import { LAUNCHDARKLY_ACCESS_TOKEN_ENV } from "../../../../shared/constants/sandbox-env.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asNonEmptyString, asRecord, unknownFields } from "../utils/dynamic-tool-helpers.js";
import type { DynamicToolErrorCode } from "./dynamic-tool-results.js";
import {
  buildDynamicToolErrorResult as buildSharedDynamicToolErrorResult,
  createDynamicToolJsonSuccess as dynamicToolSuccessResult,
  DYNAMIC_TOOL_ERROR_CODES,
  DynamicToolError,
  mapDynamicToolErrorCode as mapSharedDynamicToolErrorCode,
  truncateWithMarker,
} from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolExecuteContext,
  FirstPartyDynamicToolSpec,
} from "./first-party-dynamic-tools.js";

export const LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE = "launchdarkly";
export const LAUNCHDARKLY_LIST_FEATURE_FLAGS_DYNAMIC_TOOL_NAME = "list_feature_flags";
export const LAUNCHDARKLY_GET_FEATURE_FLAG_DYNAMIC_TOOL_NAME = "get_feature_flag";
export const LAUNCHDARKLY_PATCH_FEATURE_FLAG_DYNAMIC_TOOL_NAME = "patch_feature_flag";

const LAUNCHDARKLY_API_BASE_URL = "https://app.launchdarkly.com/api/v2";
const LAUNCHDARKLY_TIMEOUT_MS = 15_000;
const LAUNCHDARKLY_LIST_FLAGS_LIMIT_DEFAULT = 20;
const LAUNCHDARKLY_LIST_FLAGS_LIMIT_MAX = 50;
const LAUNCHDARKLY_PATCH_OPERATION_MAX = 4;
const LAUNCHDARKLY_ERROR_MESSAGE_MAX_CHARS = 512;
const LAUNCHDARKLY_LIST_FEATURE_FLAGS_INPUT_FIELDS = [
  "projectKey",
  "environmentKey",
  "search",
  "tag",
  "limit",
  "offset",
  "includeEnvironmentDetails",
] as const;
const LAUNCHDARKLY_GET_FEATURE_FLAG_INPUT_FIELDS = [
  "projectKey",
  "featureFlagKey",
  "environmentKey",
  "includeEvaluation",
] as const;
const LAUNCHDARKLY_PATCH_FEATURE_FLAG_INPUT_FIELDS = [
  "projectKey",
  "featureFlagKey",
  "environmentKey",
  "operations",
] as const;
const LAUNCHDARKLY_PATCH_OPERATION_INPUT_FIELDS = ["kind", "variationId"] as const;

type LaunchDarklyCredentials = {
  accessToken: string;
};

type LaunchDarklyListFeatureFlagsInput = {
  projectKey: string;
  environmentKey: string | null;
  search: string | null;
  tag: string | null;
  limit: number;
  offset: number;
  includeEnvironmentDetails: boolean;
};

type LaunchDarklyGetFeatureFlagInput = {
  projectKey: string;
  featureFlagKey: string;
  environmentKey: string | null;
  includeEvaluation: boolean;
};

type LaunchDarklyPatchOperation =
  | { kind: "turn_on" }
  | { kind: "turn_off" }
  | { kind: "set_fallthrough_variation"; variationId: string }
  | { kind: "set_off_variation"; variationId: string };

type LaunchDarklyPatchFeatureFlagInput = {
  projectKey: string;
  featureFlagKey: string;
  environmentKey: string;
  operations: LaunchDarklyPatchOperation[];
};

type LaunchDarklyApiVariation = {
  _id?: unknown;
  value?: unknown;
  name?: unknown;
  description?: unknown;
};

type LaunchDarklyApiFlag = {
  key?: unknown;
  name?: unknown;
  kind?: unknown;
  description?: unknown;
  temporary?: unknown;
  archived?: unknown;
  tags?: unknown;
  variations?: unknown;
  environments?: unknown;
};

type LaunchDarklyListFeatureFlagsResponse = {
  items?: unknown;
  totalCount?: unknown;
};

type LaunchDarklyEnvironmentSummary = {
  key: string;
  on: boolean | null;
  archived: boolean | null;
  offVariationIndex: number | null;
  fallthrough:
    | { kind: "variation"; variationIndex: number }
    | { kind: "rollout"; weightedVariations: Array<{ variationIndex: number | null; weight: number | null }> }
    | null;
  ruleCount: number | null;
  targetCount: number | null;
  contextTargetCount: number | null;
  prerequisiteCount: number | null;
};

function launchDarklyCredentialsFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string>,
): LaunchDarklyCredentials | null {
  const accessToken = env[LAUNCHDARKLY_ACCESS_TOKEN_ENV]?.trim();
  if (!accessToken) return null;
  return { accessToken };
}

function hasLaunchDarklyCredentials(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  return launchDarklyCredentialsFromEnv(env) !== null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function launchDarklyApiUrl(path: string, query?: URLSearchParams): string {
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${LAUNCHDARKLY_API_BASE_URL}${path}${suffix}`;
}

function extractLaunchDarklyErrorMessage(body: string, status: number): string {
  if (!body.trim()) return `LaunchDarkly API request failed (${status}).`;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nestedErrors = Array.isArray(parsed.errors)
      ? parsed.errors
          .map((entry) => (typeof entry === "string" ? entry : asNonEmptyString(asRecord(entry)?.message)))
          .filter((entry): entry is string => Boolean(entry))
      : [];
    const message =
      asNonEmptyString(parsed.message) ??
      asNonEmptyString(parsed.error) ??
      (nestedErrors.length > 0 ? nestedErrors.join("; ") : null);
    return message
      ? truncateWithMarker(message, LAUNCHDARKLY_ERROR_MESSAGE_MAX_CHARS)
      : `LaunchDarkly API request failed (${status}).`;
  } catch {
    return truncateWithMarker(body.trim(), LAUNCHDARKLY_ERROR_MESSAGE_MAX_CHARS);
  }
}

async function launchDarklyApiRequest<T>(params: {
  credentials: LaunchDarklyCredentials;
  path: string;
  method?: "GET" | "PATCH";
  query?: URLSearchParams;
  body?: Record<string, unknown>;
  semanticPatch?: boolean;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const method = params.method ?? "GET";
  const response = await params.fetchImpl(launchDarklyApiUrl(params.path, params.query), {
    method,
    headers: {
      authorization: params.credentials.accessToken,
      accept: "application/json",
      ...(params.body
        ? {
            "content-type": params.semanticPatch
              ? "application/json; domain-model=launchdarkly.semanticpatch"
              : "application/json",
          }
        : {}),
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
    signal: createTimeoutAwareSignal(params.signal, LAUNCHDARKLY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new DynamicToolError(
      extractLaunchDarklyErrorMessage(await response.text(), response.status),
      "upstream_http_error",
      response.status,
    );
  }

  return (await response.json()) as T;
}

function mapDynamicToolErrorCode(error: DynamicToolError): DynamicToolErrorCode {
  return mapSharedDynamicToolErrorCode(error, {
    passthrough: [
      DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      DYNAMIC_TOOL_ERROR_CODES.NOT_CONNECTED,
      DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
    ],
    statusCodes: {
      400: DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      401: DYNAMIC_TOOL_ERROR_CODES.TOKEN_EXPIRED,
      403: DYNAMIC_TOOL_ERROR_CODES.SCOPE_MISSING,
      404: DYNAMIC_TOOL_ERROR_CODES.NOT_FOUND,
      422: DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT,
      429: DYNAMIC_TOOL_ERROR_CODES.UPSTREAM_RATE_LIMITED,
    },
  });
}

function launchDarklyToolErrorResult(
  error: unknown,
  cancelledMessage: string,
  failurePrefix: string,
): FirstPartyDynamicToolCallResult {
  return buildSharedDynamicToolErrorResult({
    error,
    cancelledMessage,
    mapErrorCode: mapDynamicToolErrorCode,
    unexpectedMessage: (unexpected) => `${failurePrefix}: ${stringifyError(unexpected)}`,
  });
}

function requireListFeatureFlagsInput(args: unknown): LaunchDarklyListFeatureFlagsInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("LaunchDarkly list_feature_flags requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, LAUNCHDARKLY_LIST_FEATURE_FLAGS_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `LaunchDarkly list_feature_flags received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const projectKey = asNonEmptyString(input.projectKey);
  if (!projectKey) {
    throw new DynamicToolError("LaunchDarkly list_feature_flags requires a non-empty 'projectKey'.", "invalid_input");
  }

  const environmentKey = input.environmentKey === undefined ? null : (asNonEmptyString(input.environmentKey) ?? null);
  if (input.environmentKey !== undefined && !environmentKey) {
    throw new DynamicToolError(
      "LaunchDarkly list_feature_flags requires 'environmentKey' to be a non-empty string when provided.",
      "invalid_input",
    );
  }

  const search = input.search === undefined ? null : (asNonEmptyString(input.search) ?? null);
  if (input.search !== undefined && !search) {
    throw new DynamicToolError(
      "LaunchDarkly list_feature_flags requires 'search' to be a non-empty string when provided.",
      "invalid_input",
    );
  }

  const tag = input.tag === undefined ? null : (asNonEmptyString(input.tag) ?? null);
  if (input.tag !== undefined && !tag) {
    throw new DynamicToolError(
      "LaunchDarkly list_feature_flags requires 'tag' to be a non-empty string when provided.",
      "invalid_input",
    );
  }

  const limit = input.limit === undefined ? LAUNCHDARKLY_LIST_FLAGS_LIMIT_DEFAULT : asInteger(input.limit);
  if (limit === null || limit < 1 || limit > LAUNCHDARKLY_LIST_FLAGS_LIMIT_MAX) {
    throw new DynamicToolError(
      `LaunchDarkly list_feature_flags requires 'limit' to be an integer between 1 and ${LAUNCHDARKLY_LIST_FLAGS_LIMIT_MAX}.`,
      "invalid_input",
    );
  }

  const offset = input.offset === undefined ? 0 : asInteger(input.offset);
  if (offset === null || offset < 0) {
    throw new DynamicToolError(
      "LaunchDarkly list_feature_flags requires 'offset' to be a non-negative integer.",
      "invalid_input",
    );
  }

  const includeEnvironmentDetails = input.includeEnvironmentDetails === true;
  if (includeEnvironmentDetails && !environmentKey) {
    throw new DynamicToolError(
      "LaunchDarkly list_feature_flags requires 'environmentKey' when 'includeEnvironmentDetails' is true.",
      "invalid_input",
    );
  }

  return {
    projectKey,
    environmentKey,
    search,
    tag,
    limit,
    offset,
    includeEnvironmentDetails,
  };
}

function requireGetFeatureFlagInput(args: unknown): LaunchDarklyGetFeatureFlagInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("LaunchDarkly get_feature_flag requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, LAUNCHDARKLY_GET_FEATURE_FLAG_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `LaunchDarkly get_feature_flag received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const projectKey = asNonEmptyString(input.projectKey);
  if (!projectKey) {
    throw new DynamicToolError("LaunchDarkly get_feature_flag requires a non-empty 'projectKey'.", "invalid_input");
  }

  const featureFlagKey = asNonEmptyString(input.featureFlagKey);
  if (!featureFlagKey) {
    throw new DynamicToolError("LaunchDarkly get_feature_flag requires a non-empty 'featureFlagKey'.", "invalid_input");
  }

  const environmentKey = input.environmentKey === undefined ? null : (asNonEmptyString(input.environmentKey) ?? null);
  if (input.environmentKey !== undefined && !environmentKey) {
    throw new DynamicToolError(
      "LaunchDarkly get_feature_flag requires 'environmentKey' to be a non-empty string when provided.",
      "invalid_input",
    );
  }

  return {
    projectKey,
    featureFlagKey,
    environmentKey,
    includeEvaluation: input.includeEvaluation === true,
  };
}

function normalizePatchOperation(value: unknown, index: number): LaunchDarklyPatchOperation {
  const input = asRecord(value);
  if (!input) {
    throw new DynamicToolError(
      `LaunchDarkly patch_feature_flag requires operation ${index + 1} to be an object.`,
      "invalid_input",
    );
  }
  const extras = unknownFields(input, LAUNCHDARKLY_PATCH_OPERATION_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `LaunchDarkly patch_feature_flag operation ${index + 1} received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const kind = asNonEmptyString(input.kind);
  if (!kind) {
    throw new DynamicToolError(
      `LaunchDarkly patch_feature_flag requires operation ${index + 1} to include a non-empty 'kind'.`,
      "invalid_input",
    );
  }

  if (kind === "turn_on" || kind === "turn_off") {
    if (input.variationId !== undefined) {
      throw new DynamicToolError(
        `LaunchDarkly patch_feature_flag operation '${kind}' does not accept 'variationId'.`,
        "invalid_input",
      );
    }
    return { kind };
  }

  if (kind === "set_fallthrough_variation" || kind === "set_off_variation") {
    const variationId = asNonEmptyString(input.variationId);
    if (!variationId) {
      throw new DynamicToolError(
        `LaunchDarkly patch_feature_flag operation '${kind}' requires a non-empty 'variationId'.`,
        "invalid_input",
      );
    }
    return { kind, variationId };
  }

  throw new DynamicToolError(
    `LaunchDarkly patch_feature_flag received unsupported operation kind '${kind}'.`,
    "invalid_input",
  );
}

function requirePatchFeatureFlagInput(args: unknown): LaunchDarklyPatchFeatureFlagInput {
  const input = asRecord(args);
  if (!input) {
    throw new DynamicToolError("LaunchDarkly patch_feature_flag requires an object input.", "invalid_input");
  }
  const extras = unknownFields(input, LAUNCHDARKLY_PATCH_FEATURE_FLAG_INPUT_FIELDS);
  if (extras.length > 0) {
    throw new DynamicToolError(
      `LaunchDarkly patch_feature_flag received unsupported fields: ${extras.join(", ")}.`,
      "invalid_input",
    );
  }

  const projectKey = asNonEmptyString(input.projectKey);
  if (!projectKey) {
    throw new DynamicToolError("LaunchDarkly patch_feature_flag requires a non-empty 'projectKey'.", "invalid_input");
  }

  const featureFlagKey = asNonEmptyString(input.featureFlagKey);
  if (!featureFlagKey) {
    throw new DynamicToolError(
      "LaunchDarkly patch_feature_flag requires a non-empty 'featureFlagKey'.",
      "invalid_input",
    );
  }

  const environmentKey = asNonEmptyString(input.environmentKey);
  if (!environmentKey) {
    throw new DynamicToolError(
      "LaunchDarkly patch_feature_flag requires a non-empty 'environmentKey'.",
      "invalid_input",
    );
  }

  if (!Array.isArray(input.operations)) {
    throw new DynamicToolError(
      "LaunchDarkly patch_feature_flag requires 'operations' to be an array of operation objects.",
      "invalid_input",
    );
  }
  if (input.operations.length < 1 || input.operations.length > LAUNCHDARKLY_PATCH_OPERATION_MAX) {
    throw new DynamicToolError(
      `LaunchDarkly patch_feature_flag requires between 1 and ${LAUNCHDARKLY_PATCH_OPERATION_MAX} operations.`,
      "invalid_input",
    );
  }

  const operations = input.operations.map((operation, index) => normalizePatchOperation(operation, index));
  const kinds = operations.map((operation) => operation.kind);
  if (kinds.includes("turn_on") && kinds.includes("turn_off")) {
    throw new DynamicToolError(
      "LaunchDarkly patch_feature_flag cannot combine 'turn_on' and 'turn_off' in one request.",
      "invalid_input",
    );
  }
  for (const uniqueKind of new Set(kinds)) {
    if (kinds.filter((kind) => kind === uniqueKind).length > 1) {
      throw new DynamicToolError(
        `LaunchDarkly patch_feature_flag can include '${uniqueKind}' at most once per request.`,
        "invalid_input",
      );
    }
  }

  return {
    projectKey,
    featureFlagKey,
    environmentKey,
    operations,
  };
}

function summarizeVariations(value: unknown): Array<{
  id: string | null;
  index: number;
  name: string | null;
  description: string | null;
  value: unknown;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const variation = (asRecord(entry) ?? {}) as LaunchDarklyApiVariation;
    return {
      id: asNonEmptyString(variation._id) ?? null,
      index,
      name: asNonEmptyString(variation.name) ?? null,
      description: asNonEmptyString(variation.description) ?? null,
      value: variation.value ?? null,
    };
  });
}

function summarizeFallthrough(value: unknown): LaunchDarklyEnvironmentSummary["fallthrough"] {
  const input = asRecord(value);
  if (!input) return null;

  const variationIndex = asInteger(input.variation);
  if (variationIndex !== null) {
    return { kind: "variation", variationIndex };
  }

  const rollout = asRecord(input.rollout);
  const weightedVariations = Array.isArray(rollout?.variations)
    ? rollout.variations.map((entry) => {
        const variation = asRecord(entry);
        return {
          variationIndex: asInteger(variation?.variation),
          weight: asInteger(variation?.weight),
        };
      })
    : [];
  return weightedVariations.length > 0 ? { kind: "rollout", weightedVariations } : null;
}

function countTargetValues(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  return value.reduce((count, entry) => {
    const values = Array.isArray(asRecord(entry)?.values) ? (asRecord(entry)?.values as unknown[]) : [];
    return count + values.length;
  }, 0);
}

function summarizeEnvironmentConfiguration(
  environmentsValue: unknown,
  environmentKey: string | null,
): LaunchDarklyEnvironmentSummary | null {
  if (!environmentKey) return null;
  const environments = asRecord(environmentsValue);
  const environment = asRecord(environments?.[environmentKey]);
  if (!environment) return null;

  return {
    key: environmentKey,
    on: typeof environment.on === "boolean" ? environment.on : null,
    archived: typeof environment.archived === "boolean" ? environment.archived : null,
    offVariationIndex: asInteger(environment.offVariation),
    fallthrough: summarizeFallthrough(environment.fallthrough),
    ruleCount: Array.isArray(environment.rules) ? environment.rules.length : null,
    targetCount: countTargetValues(environment.targets),
    contextTargetCount: countTargetValues(environment.contextTargets),
    prerequisiteCount: Array.isArray(environment.prerequisites) ? environment.prerequisites.length : null,
  };
}

function summarizeFlag(
  projectKey: string,
  flagValue: unknown,
  environmentKey: string | null,
  fallbackFlagKey: string | null = null,
): Record<string, unknown> {
  const flag = (asRecord(flagValue) ?? {}) as LaunchDarklyApiFlag;
  return {
    projectKey,
    key: asNonEmptyString(flag.key) ?? fallbackFlagKey ?? null,
    name: asNonEmptyString(flag.name) ?? null,
    kind: asNonEmptyString(flag.kind) ?? null,
    description: asNonEmptyString(flag.description) ?? null,
    temporary: typeof flag.temporary === "boolean" ? flag.temporary : null,
    archived: typeof flag.archived === "boolean" ? flag.archived : null,
    tags: asStringArray(flag.tags),
    variations: summarizeVariations(flag.variations),
    environment: summarizeEnvironmentConfiguration(flag.environments, environmentKey),
  };
}

function buildListFeatureFlagsQuery(input: LaunchDarklyListFeatureFlagsInput): URLSearchParams {
  const query = new URLSearchParams();
  query.set("limit", String(input.limit));
  if (input.offset > 0) query.set("offset", String(input.offset));
  if (input.environmentKey) query.set("env", input.environmentKey);
  if (input.tag) query.set("tag", input.tag);
  if (input.search) query.set("filter", `query:${input.search}`);
  if (input.includeEnvironmentDetails) query.set("summary", "0");
  return query;
}

function buildGetFeatureFlagQuery(input: LaunchDarklyGetFeatureFlagInput): URLSearchParams {
  const query = new URLSearchParams();
  if (input.environmentKey) query.set("env", input.environmentKey);
  if (input.includeEvaluation) query.set("expand", "evaluation");
  return query;
}

function semanticPatchInstructionForOperation(operation: LaunchDarklyPatchOperation): Record<string, unknown> {
  switch (operation.kind) {
    case "turn_on":
      return { kind: "turnFlagOn" };
    case "turn_off":
      return { kind: "turnFlagOff" };
    case "set_fallthrough_variation":
      return { kind: "updateFallthroughVariationOrRollout", variationId: operation.variationId };
    case "set_off_variation":
      return { kind: "updateOffVariation", variationId: operation.variationId };
  }
}

export function buildLaunchDarklyListFeatureFlagsDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!hasLaunchDarklyCredentials(env)) return [];
  return [
    {
      namespace: LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
      name: LAUNCHDARKLY_LIST_FEATURE_FLAGS_DYNAMIC_TOOL_NAME,
      description:
        "List LaunchDarkly feature flags for a project, optionally filtered to one environment and summarized for agent flag inspection.",
      inputSchema: {
        type: "object",
        properties: {
          projectKey: { type: "string", description: "LaunchDarkly project key." },
          environmentKey: {
            type: "string",
            description: "Optional LaunchDarkly environment key to include environment-specific flag state.",
          },
          search: {
            type: "string",
            description: "Optional case-insensitive search string for matching flag keys or names.",
          },
          tag: { type: "string", description: "Optional tag filter." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: LAUNCHDARKLY_LIST_FLAGS_LIMIT_MAX,
            description: "Maximum number of flags to return.",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description: "Pagination offset for large projects.",
          },
          includeEnvironmentDetails: {
            type: "boolean",
            description: "When true, includes additional environment rule and target detail. Requires environmentKey.",
          },
        },
        required: ["projectKey"],
        additionalProperties: false,
      },
    },
  ];
}

export function buildLaunchDarklyGetFeatureFlagDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!hasLaunchDarklyCredentials(env)) return [];
  return [
    {
      namespace: LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
      name: LAUNCHDARKLY_GET_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
      description:
        "Read a LaunchDarkly feature flag by key, including its variations and optional environment-specific targeting state.",
      inputSchema: {
        type: "object",
        properties: {
          projectKey: { type: "string", description: "LaunchDarkly project key." },
          featureFlagKey: { type: "string", description: "Feature flag key." },
          environmentKey: {
            type: "string",
            description: "Optional LaunchDarkly environment key to narrow the returned environment state.",
          },
          includeEvaluation: {
            type: "boolean",
            description: "When true, request LaunchDarkly evaluation metadata in the environment response.",
          },
        },
        required: ["projectKey", "featureFlagKey"],
        additionalProperties: false,
      },
    },
  ];
}

export function buildLaunchDarklyPatchFeatureFlagDynamicToolSpec(
  env: NodeJS.ProcessEnv | Record<string, string>,
): FirstPartyDynamicToolSpec[] {
  if (!hasLaunchDarklyCredentials(env)) return [];
  return [
    {
      namespace: LAUNCHDARKLY_DYNAMIC_TOOL_NAMESPACE,
      name: LAUNCHDARKLY_PATCH_FEATURE_FLAG_DYNAMIC_TOOL_NAME,
      description:
        "Apply a narrow LaunchDarkly semantic patch to a flag environment: turn a flag on or off, or update the fallthrough/off variation.",
      inputSchema: {
        type: "object",
        properties: {
          projectKey: { type: "string", description: "LaunchDarkly project key." },
          featureFlagKey: { type: "string", description: "Feature flag key." },
          environmentKey: { type: "string", description: "LaunchDarkly environment key to mutate." },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: LAUNCHDARKLY_PATCH_OPERATION_MAX,
            description:
              "Semantic patch operations to apply. Each operation must include kind; variationId is required only for set_fallthrough_variation and set_off_variation.",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["turn_on", "turn_off", "set_fallthrough_variation", "set_off_variation"],
                  description:
                    "Patch operation kind. Use turn_on or turn_off to toggle serving, or set_fallthrough_variation / set_off_variation with variationId.",
                },
                variationId: {
                  type: "string",
                  description:
                    "LaunchDarkly variation ID from get_feature_flag. Required for set_fallthrough_variation and set_off_variation; omit for turn_on and turn_off.",
                },
              },
              required: ["kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["projectKey", "featureFlagKey", "environmentKey", "operations"],
        additionalProperties: false,
      },
    },
  ];
}

export function redactLaunchDarklyDynamicToolInputForPersistence(
  args: unknown,
): Record<string, unknown> | null | undefined {
  const input = asRecord(args);
  if (!input) return undefined;
  const operations = Array.isArray(input.operations)
    ? input.operations
        .map((operation) => asNonEmptyString(asRecord(operation)?.kind))
        .filter((kind): kind is string => Boolean(kind))
    : [];
  return {
    ...(typeof input.projectKey === "string" ? { projectKey: input.projectKey } : {}),
    ...(typeof input.featureFlagKey === "string" ? { featureFlagKey: input.featureFlagKey } : {}),
    ...(typeof input.environmentKey === "string" ? { environmentKey: input.environmentKey } : {}),
    ...(typeof input.search === "string" ? { searchLength: input.search.length } : {}),
    ...(typeof input.tag === "string" ? { tag: input.tag } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.offset === "number" ? { offset: input.offset } : {}),
    ...(typeof input.includeEnvironmentDetails === "boolean"
      ? { includeEnvironmentDetails: input.includeEnvironmentDetails }
      : {}),
    ...(typeof input.includeEvaluation === "boolean" ? { includeEvaluation: input.includeEvaluation } : {}),
    ...(operations.length > 0 ? { operationKinds: operations } : {}),
  };
}

export async function executeLaunchDarklyListFeatureFlagsDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = launchDarklyCredentialsFromEnv(context.env);
  if (!credentials) {
    return {
      success: false,
      errorCode: "not_connected",
      contentItems: [{ type: "inputText", text: "LaunchDarkly access token is not configured for this session." }],
    };
  }

  try {
    const input = requireListFeatureFlagsInput(args);
    const response = await launchDarklyApiRequest<LaunchDarklyListFeatureFlagsResponse>({
      credentials,
      path: `/flags/${encodeURIComponent(input.projectKey)}`,
      query: buildListFeatureFlagsQuery(input),
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    const items = Array.isArray(response.items)
      ? response.items.map((flag) => summarizeFlag(input.projectKey, flag, input.environmentKey)).filter(Boolean)
      : [];
    return dynamicToolSuccessResult({
      projectKey: input.projectKey,
      environmentKey: input.environmentKey,
      totalCount: asInteger(response.totalCount),
      returnedCount: items.length,
      items,
    });
  } catch (error) {
    return launchDarklyToolErrorResult(
      error,
      "LaunchDarkly list_feature_flags was cancelled.",
      "LaunchDarkly list_feature_flags failed",
    );
  }
}

export async function executeLaunchDarklyGetFeatureFlagDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = launchDarklyCredentialsFromEnv(context.env);
  if (!credentials) {
    return {
      success: false,
      errorCode: "not_connected",
      contentItems: [{ type: "inputText", text: "LaunchDarkly access token is not configured for this session." }],
    };
  }

  try {
    const input = requireGetFeatureFlagInput(args);
    const response = await launchDarklyApiRequest<LaunchDarklyApiFlag>({
      credentials,
      path: `/flags/${encodeURIComponent(input.projectKey)}/${encodeURIComponent(input.featureFlagKey)}`,
      query: buildGetFeatureFlagQuery(input),
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return dynamicToolSuccessResult(
      summarizeFlag(input.projectKey, response, input.environmentKey, input.featureFlagKey),
    );
  } catch (error) {
    return launchDarklyToolErrorResult(
      error,
      "LaunchDarkly get_feature_flag was cancelled.",
      "LaunchDarkly get_feature_flag failed",
    );
  }
}

export async function executeLaunchDarklyPatchFeatureFlagDynamicToolCall(
  args: unknown,
  context: FirstPartyDynamicToolExecuteContext,
): Promise<FirstPartyDynamicToolCallResult> {
  const credentials = launchDarklyCredentialsFromEnv(context.env);
  if (!credentials) {
    return {
      success: false,
      errorCode: "not_connected",
      contentItems: [{ type: "inputText", text: "LaunchDarkly access token is not configured for this session." }],
    };
  }

  try {
    const input = requirePatchFeatureFlagInput(args);
    const response = await launchDarklyApiRequest<LaunchDarklyApiFlag>({
      credentials,
      path: `/flags/${encodeURIComponent(input.projectKey)}/${encodeURIComponent(input.featureFlagKey)}`,
      method: "PATCH",
      body: {
        environmentKey: input.environmentKey,
        instructions: input.operations.map(semanticPatchInstructionForOperation),
      },
      semanticPatch: true,
      fetchImpl: context.fetchImpl ?? fetch,
      signal: context.signal,
    });
    return dynamicToolSuccessResult({
      projectKey: input.projectKey,
      featureFlagKey: input.featureFlagKey,
      environmentKey: input.environmentKey,
      appliedOperations: input.operations.map((operation) => operation.kind),
      flag: summarizeFlag(input.projectKey, response, input.environmentKey, input.featureFlagKey),
    });
  } catch (error) {
    return launchDarklyToolErrorResult(
      error,
      "LaunchDarkly patch_feature_flag was cancelled.",
      "LaunchDarkly patch_feature_flag failed",
    );
  }
}
