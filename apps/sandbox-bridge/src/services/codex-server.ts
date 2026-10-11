import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnMode } from "../../../../shared/agent/constants.js";
import type { AgentRole } from "../../../../shared/agent/schema.js";
import { PINNED_CODEX_CLI_VERSION } from "../../../../shared/constants/codex-runtime.js";
import { extractModelId } from "../../../../shared/constants/models.js";
import { OpenAIServiceTier } from "../../../../shared/enums/openai-service-tier.js";
import { withProviderRetry } from "../../../../shared/llm/retry.mjs";
import type { ErrorCode } from "../../../../shared/types/sandbox.js";
import { stringifyError } from "../../../../shared/utils/errors.js";
import {
  buildSessionStaticBehavioralGuidance,
  CODEX_ERROR_INFO_NAMES,
  type CodexErrorInfo,
  mapCodexErrorInfo,
  RUNTIME_EVIDENCE_DIR,
  type SessionErrorCodexInfo,
} from "../constants/bridge.js";
import type { BridgeLogger } from "../logger.js";
import { classifyError, normalizeBridgeLocalErrorCode } from "../utils/classify.js";
import { type AgentChildEnvResult, buildAgentChildEnv } from "../utils/sanitized-env.js";
import { estimateTokens } from "../utils/tokens.js";
import {
  adaptCodexDynamicToolResultForImageFeedback,
  buildCodexSyntheticImageFeedbackInput,
  type CodexSyntheticImageFeedback,
  defaultCodexImageFeedbackCapability,
  filterCodexDesktopDynamicToolSpecsForImageFeedback,
} from "./codex-image-feedback.js";
import { getCodexProtocolCoverage } from "./codex-protocol-coverage.js";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
  type FirstPartyDynamicToolSpec,
  getAvailableFirstPartyDynamicToolNames,
  redactFirstPartyDynamicToolInputForPersistence,
  serializeFirstPartyDynamicToolContentItemsForPersistence,
} from "./first-party-dynamic-tools.js";
import type { Memory } from "./memory-ranking.js";

const MCP_TOOL_RESULT_IMAGE_DIR_NAME = "mcp-tool-results";
const MAX_MCP_TOOL_RESULT_IMAGE_BYTES = 10 * 1024 * 1024;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const TURN_REQUEST_TIMEOUT_MS = 300_000;
const CODEX_SETUP_MAX_ATTEMPTS = 3;
// Keep one provider-native tool result large enough for useful test logs and
// source excerpts while preventing pathological commands (for example an
// accidentally repo-wide `rg`) from consuming the rest of the model context.
// Codex applies this in its context manager before the result is sent back to
// the model. Its native formatter preserves the head and tail and inserts an
// explicit omission marker; the app-server output stream remains complete.
export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 12_000;
// Codex sandbox mode for Cycloid sessions: full write + network access. The mode is
// a per-thread setting, so it must be supplied both when a thread is created
// (`thread/start`) and when one is resumed after a sandbox respawn (`thread/resume`).
// `thread/resume` previously omitted it, so the restored thread fell back to Codex's
// default `read-only` mode and the agent refused to edit/commit. (`turn/start` takes a
// different, structured `sandboxPolicy` field, not this string, so the thread-level
// `sandbox` is the correct place to set it.) Both call sites read this constant so they
// cannot drift. Typed against the Codex `SandboxMode` enum so a typo can't silently
// compile to an invalid value and degrade the agent back to read-only -- the params bag
// passed to `transport.request` is `unknown`, so this annotation is the only guard.
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
const CODEX_SANDBOX_MODE: CodexSandboxMode = "danger-full-access";
export type CodexTurnSandboxPolicy = { type: "readOnly"; networkAccess: false } | { type: "dangerFullAccess" };
const STDERR_DIAGNOSTIC_LINE_LIMIT = 50;
const STDERR_DIAGNOSTIC_SUMMARY_MAX_LENGTH = 500;
const CODEX_RECONNECT_PROGRESS_REGEX = /^Reconnecting\.\.\. \d+\/\d+$/;

export type CodexStdioStream = "stdout" | "stderr";

export type CodexStdioLineEvent = {
  stream: CodexStdioStream;
  line: string;
  truncated: boolean;
  looksLikeError: boolean;
};

export type CodexStdioCapEvent = {
  capBytes: number;
  droppedFromStream: CodexStdioStream;
};

export type CreateCodexWithStdioOptions = {
  agentRole: AgentRole;
  adoptedExternalPr?: boolean;
  signal?: AbortSignal;
  hostname?: string;
  port?: number;
  timeout?: number;
  cwd?: string;
  config?: { logLevel?: string; model?: string; [k: string]: unknown };
  useOpenAIFlexServiceTier?: boolean;
  getRepoMemories?: () => Memory[];
  getMemoryRefById?: () => ReadonlyMap<string, import("../../../../shared/events/bridge.js").MemoryRef>;
  onStdioLine?: (event: CodexStdioLineEvent) => void;
  onStdioCap?: (event: CodexStdioCapEvent) => void;
  spawn?: typeof spawn;
  stdioLineMaxBytes?: number;
  stdioSessionMaxBytes?: number;
  log?: { warn: (fields: Record<string, unknown>, msg: string) => void };
};

export type CodexServerHandle = { url: string; close: () => void; pid?: number };

export type CreateCodexWithStdioResult = {
  server: CodexServerHandle;
  client: CodexBridgeClient;
  mcpStatus: Record<string, McpRuntimeStatus>;
};

type PromptPart = {
  type: string;
  text?: string;
  path?: string;
  url?: string;
  mime?: string;
  filename?: string;
  [key: string]: unknown;
};

type McpResultImage = {
  data: string;
  mime: string;
};

type PromptAsyncOptions = {
  signal?: AbortSignal;
  path: { id: string };
  promptLog?: BridgeLogger;
  body: {
    parts?: PromptPart[];
    model?: string | { modelID?: string };
    agent?: string;
    system?: string;
    variant?: string;
    summary?: string;
    sandboxPolicy: CodexTurnSandboxPolicy;
  };
};

export function codexTurnSandboxPolicyForTurnMode(turnMode: TurnMode): CodexTurnSandboxPolicy {
  switch (turnMode) {
    case "plan":
      return { type: "readOnly", networkAccess: false };
    case "execute":
      return { type: "dangerFullAccess" };
  }
}

type SessionRecord = {
  id: string;
  codexThreadId: string | null;
  loaded: boolean;
  activeAbort: AbortController | null;
  activeTurnId: string | null;
  activeTurnStartParams: CodexTurnStartParams | null;
  activeInput: Array<Record<string, unknown>> | null;
  pendingSyntheticImageFeedback: CodexSyntheticImageFeedback[];
  currentModel: string | undefined;
  currentAgentRole: AgentRole;
  currentAgentProfile: string | undefined;
  currentMessageId: string;
  promptLog: BridgeLogger | null;
  messageCounter: number;
  interruptedTurnIds: Set<string>;
  observedApplyPatchCallIds: Set<string>;
  turnItems: Map<string, RuntimeTurnItemState>;
};

type DynamicToolSpec = FirstPartyDynamicToolSpec;

type CodexTurnStartParams = {
  threadId: string;
  input: Array<Record<string, unknown>>;
  cwd: string;
  approvalPolicy: "never";
  sandboxPolicy: CodexTurnSandboxPolicy;
  model?: string;
  effort?: string;
  summary?: string;
};

type RuntimeTurnItemState =
  | {
      type: "text";
      messageID: string;
      text: string;
      role: "assistant";
    }
  | {
      type: "reasoning";
      messageID: string;
      text: string;
      role: "assistant";
      content: string[];
      summary: string[];
    }
  | {
      type: "tool";
      messageID: string;
      tool: string;
      input: Record<string, unknown>;
      status: string;
      output?: string;
      error?: string;
    }
  | {
      type: "patch";
      messageID: string;
      files: string[];
    };

type QueuedEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

type BridgeLocalTransportError = Error & {
  errorCode?: string;
  wasIntentionalClose?: boolean;
};

type SessionErrorResolution = {
  errorCode: ErrorCode | null;
  codexErrorInfo?: SessionErrorCodexInfo;
  additionalDetails?: string;
};
type BridgeLocalMcpServer = {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

type BridgeRemoteMcpServer = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  enabled?: boolean;
  oauth?: false | Record<string, string>;
  timeout?: number;
};

type BridgeMcpServer = BridgeLocalMcpServer | BridgeRemoteMcpServer;

type CodexMcpServerConfig = {
  command?: string;
  args?: string[];
  url?: string;
  env_vars?: string[];
  env_http_headers?: Record<string, string>;
  http_headers?: Record<string, string>;
  enabled?: boolean;
  startup_timeout_ms?: number;
};

type CodexAppConfig = {
  enabled?: boolean;
};

type CodexRuntimeConfig = {
  model_provider: "openai";
  tool_output_token_limit: number;
  openai_base_url?: string;
  service_tier?: OpenAIServiceTier.Flex;
  web_search?: "disabled";
  hooks?: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> }>
  >;
  apps?: Record<string, CodexAppConfig>;
  mcp_servers?: Record<string, CodexMcpServerConfig>;
  project_doc_fallback_filenames?: string[];
  project_doc_max_bytes?: number;
  project_root_markers?: string[];
};

type PendingProtocolRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
};

type StderrDiagnosticLine = {
  line: string;
  score: number;
  index: number;
};

type SpawnLike = typeof spawn;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeApplyPatchInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { patch: value };
  if (isRecord(value)) return value;
  return {};
}

function getCallId(record: Record<string, unknown>): string | undefined {
  return asString(record.callID) ?? asString(record.callId) ?? asString(record.call_id) ?? asString(record.id);
}

function dataUrlImage(value: string): McpResultImage | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) return null;
  return { mime: match[1], data: match[2] };
}

function extractDataUrl(obj: unknown): McpResultImage | null {
  if (!isRecord(obj)) return null;

  if (typeof obj.url === "string") {
    const directUrl = dataUrlImage(obj.url);
    if (directUrl) return directUrl;
  }

  if (isRecord(obj.image_url) && typeof obj.image_url.url === "string") {
    return dataUrlImage(obj.image_url.url);
  }

  return null;
}

function extractMimeType(obj: unknown, fields: string[] = ["mimeType", "mime_type"]): string | undefined {
  if (!isRecord(obj)) return undefined;

  for (const field of fields) {
    const value = obj[field];
    if (typeof value === "string") return value;
  }

  return undefined;
}

function imageFromContentPart(part: unknown): McpResultImage[] {
  if (!isRecord(part)) return [];

  const dataUrl = extractDataUrl(part);
  if (dataUrl) return [dataUrl];

  const mime = extractMimeType(part);
  if (typeof part.data === "string" && mime) return [{ mime, data: part.data }];

  if (isRecord(part.source) && typeof part.source.data === "string") {
    const sourceMime = extractMimeType(part.source, ["media_type", "mimeType", "mime_type"]);
    if (sourceMime) return [{ mime: sourceMime, data: part.source.data }];
  }

  return [];
}

function extractMcpResultImages(result: unknown): McpResultImage[] {
  if (!isRecord(result)) return [];
  if (Array.isArray(result.content)) return result.content.flatMap(imageFromContentPart);
  return imageFromContentPart(result);
}

function isScreenshotMcpTool(server: unknown, tool: unknown): boolean {
  const value = `${typeof server === "string" ? server : ""}.${typeof tool === "string" ? tool : ""}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return /(?:^|[._-])(?:agent-browser|browser|playwright|screenshot|snapshot)(?:$|[._-])/.test(value);
}

function sanitizeEvidenceSegment(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || fallback;
}

export type McpRuntimeStatus = { status: string; error?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateDiagnostic(value: string, maxLength = STDERR_DIAGNOSTIC_SUMMARY_MAX_LENGTH): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function scoreStderrDiagnosticLine(line: string): number {
  const normalized = collapseWhitespace(line);
  if (!normalized) return 0;
  if (
    normalized.includes("Project-local config, hooks, and exec policies are disabled") ||
    normalized.includes("To load project-local config, hooks, and exec policies")
  ) {
    return 0;
  }

  let score = 1;
  if (/\b401\b|unauthorized|forbidden|authentication/i.test(normalized)) score += 100;
  if (/failed to connect|responses_websocket|websocket/i.test(normalized)) score += 80;
  if (/timed?\s*out|timeout|refused|reset|unavailable|bad gateway|internal server error/i.test(normalized)) {
    score += 60;
  }
  if (/\b(error|exception|failed|invalid|denied)\b/i.test(normalized)) score += 20;
  return score;
}

function resolveSessionErrorCode(
  message: string,
  options: {
    bridgeLocalErrorCode?: string;
    wasIntentionalClose?: boolean;
    codexErrorInfo?: CodexErrorInfo | null;
  },
): ErrorCode | null {
  if (options.bridgeLocalErrorCode === "shutdown" && options.wasIntentionalClose === true) {
    return null;
  }
  if (typeof options.bridgeLocalErrorCode === "string") {
    const normalized = normalizeBridgeLocalErrorCode(options.bridgeLocalErrorCode, message, {
      wasIntentionalClose: options.wasIntentionalClose === true,
    });
    if (normalized) return normalized;
  }
  if (options.codexErrorInfo) {
    const mapped = mapCodexErrorInfo(options.codexErrorInfo);
    if (mapped) return mapped;
  }

  const classified = classifyError(message);
  return classified === "unknown" ? null : classified;
}

function parseHttpStatusCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function asCodexErrorInfo(value: unknown): CodexErrorInfo | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  if (!CODEX_ERROR_INFO_NAMES.includes(value.name as CodexErrorInfo["name"])) return null;
  const httpStatusCode = parseHttpStatusCode(value.httpStatusCode ?? value.http_status_code);
  return {
    name: value.name as CodexErrorInfo["name"],
    ...(httpStatusCode !== undefined ? { httpStatusCode } : {}),
  };
}

function asCodexAdditionalDetails(value: unknown): string | undefined {
  if (typeof value === "string") return truncateDiagnostic(value);
  if (typeof value === "number" || typeof value === "boolean") return truncateDiagnostic(String(value));
  if (Array.isArray(value) || isRecord(value)) return truncateDiagnostic(JSON.stringify(value));
  return undefined;
}

function toSessionErrorCodexInfo(info: CodexErrorInfo): SessionErrorCodexInfo {
  return {
    name: info.name,
    ...(typeof info.httpStatusCode === "number" ? { httpStatusCode: info.httpStatusCode } : {}),
  };
}

function resolveSessionError(params: {
  message: string;
  bridgeLocalErrorCode?: string;
  wasIntentionalClose?: boolean;
  codexErrorInfo?: unknown;
  additionalDetails?: unknown;
}): SessionErrorResolution {
  const codexErrorInfo = asCodexErrorInfo(params.codexErrorInfo);
  const additionalDetails = asCodexAdditionalDetails(params.additionalDetails);
  return {
    errorCode: resolveSessionErrorCode(params.message, {
      bridgeLocalErrorCode: params.bridgeLocalErrorCode,
      wasIntentionalClose: params.wasIntentionalClose,
      codexErrorInfo,
    }),
    ...(codexErrorInfo ? { codexErrorInfo: toSessionErrorCodexInfo(codexErrorInfo) } : {}),
    ...(additionalDetails ? { additionalDetails } : {}),
  };
}

function isCodexReconnectProgressNotification(params: Record<string, unknown>): boolean {
  const nestedError = isRecord(params.error) ? params.error : null;
  const message =
    typeof nestedError?.message === "string"
      ? nestedError.message
      : typeof params.message === "string"
        ? params.message
        : "";
  return CODEX_RECONNECT_PROGRESS_REGEX.test(message);
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function isBridgeOauth(value: unknown): value is BridgeRemoteMcpServer["oauth"] {
  return value === false || isStringRecord(value);
}

function asBridgeMcpServer(value: unknown): BridgeMcpServer | null {
  if (!isPlainObject(value) || typeof value.type !== "string") return null;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const timeout = typeof value.timeout === "number" && Number.isFinite(value.timeout) ? value.timeout : undefined;
  if (
    value.type === "local" &&
    Array.isArray(value.command) &&
    value.command.every((part) => typeof part === "string")
  ) {
    return {
      type: "local",
      command: value.command,
      ...(isStringRecord(value.environment) ? { environment: value.environment } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }
  if (value.type === "remote" && typeof value.url === "string") {
    return {
      type: "remote",
      url: value.url,
      ...(isStringRecord(value.headers) ? { headers: value.headers } : {}),
      ...(isStringRecord(value.env_http_headers) ? { env_http_headers: value.env_http_headers } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(isBridgeOauth(value.oauth) ? { oauth: value.oauth } : {}),
    };
  }
  return null;
}

function envVarNameForValue(
  headerName: string,
  value: string,
  env: NodeJS.ProcessEnv | Record<string, string>,
): string | null {
  const candidates =
    headerName === "DD_API_KEY"
      ? ["DD_API_KEY"]
      : headerName === "DD_APPLICATION_KEY"
        ? ["DD_APPLICATION_KEY", "DD_APP_KEY"]
        : headerName === "Authorization"
          ? ["AUTHORIZATION", "Authorization"]
          : [headerName];
  for (const candidate of candidates) {
    if (env[candidate] === value) return candidate;
  }
  return null;
}

type CodexRuntimeConfigWarn = (message: string, fields: Record<string, unknown>) => void;

const defaultWarn: CodexRuntimeConfigWarn = (message, fields) => {
  // eslint-disable-next-line no-console
  console.warn(`[buildCodexRuntimeConfig] ${message}`, fields);
};

const SECRET_BEARING_REMOTE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "private-token",
]);

function convertRemoteHeaders(
  serverName: string,
  headers: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv | Record<string, string>,
  warn: CodexRuntimeConfigWarn,
): Pick<CodexMcpServerConfig, "env_http_headers" | "http_headers"> {
  if (!headers) return {};
  const envHttpHeaders: Record<string, string> = {};
  const staticHeaders: Record<string, string> = {};
  for (const [headerName, value] of Object.entries(headers)) {
    const envVarName = envVarNameForValue(headerName, value, env);
    if (envVarName) {
      envHttpHeaders[headerName] = envVarName;
    } else if (looksLikeSecretHeader(headerName, value)) {
      throw new Error(`Remote MCP header '${headerName}' for '${serverName}' must be provided via env indirection`);
    } else {
      warn("Remote MCP header has no matching env var; embedding raw value in http_headers", {
        serverName,
        headerName,
      });
      staticHeaders[headerName] = value;
    }
  }
  return {
    ...(Object.keys(envHttpHeaders).length > 0 ? { env_http_headers: envHttpHeaders } : {}),
    ...(Object.keys(staticHeaders).length > 0 ? { http_headers: staticHeaders } : {}),
  };
}

function looksLikeSecretHeader(headerName: string, value: string): boolean {
  const normalizedName = headerName.trim().toLowerCase();
  if (SECRET_BEARING_REMOTE_HEADER_NAMES.has(normalizedName)) {
    return true;
  }
  const trimmedValue = value.trim();
  return /^bearer\s+/i.test(trimmedValue);
}

const DISABLED_CODEX_APP_CONFIG: Record<string, CodexAppConfig> = {
  _default: { enabled: false },
  // Codex keeps GitHub enabled even when apps._default.enabled=false.
  connector_76869538009648d5b282a4bb21c3d157: { enabled: false },
};

type CodexAuthKeyClass = "raw_openai" | "gateway_session" | "managed_virtual" | "stored_auth" | "missing";

type CodexAuthDecision = {
  apiKey?: string;
  keyClass: CodexAuthKeyClass;
  source: "session_api_key" | "session_auth_json" | "stored_auth";
  usesStoredAuth: boolean;
};

function createCodexAuthConfigError(reason: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { errorCode: "config_error", reason });
  return error;
}

function classifyOpenAIKey(apiKey: string): CodexAuthKeyClass {
  if (apiKey.startsWith("arc-gw-")) return "gateway_session";
  if (apiKey.startsWith("arc-vk-")) return "managed_virtual";
  if (apiKey.startsWith("sk-")) return "raw_openai";
  return "missing";
}

function resolveOpenAIGatewayBaseUrl(env: NodeJS.ProcessEnv | Record<string, string>): string | undefined {
  if (env.ARCANIST_OPENAI_GATEWAY_ENABLED !== "1") return undefined;

  const apiKey = asString(env.OPENAI_API_KEY) ?? asString(env.CODEX_API_KEY);
  if (!apiKey?.startsWith("arc-vk-") && !apiKey?.startsWith("arc-gw-")) {
    throw createCodexAuthConfigError(
      "gateway_key_invalid_prefix",
      "ARCANIST_OPENAI_GATEWAY_ENABLED requires a Cycloid OpenAI gateway API key",
    );
  }

  const controlPlaneUrl = asString(env.CONTROL_PLANE_URL) ?? asString(process.env.CONTROL_PLANE_URL);
  if (!controlPlaneUrl) {
    throw createCodexAuthConfigError(
      "gateway_control_plane_url_missing",
      "CONTROL_PLANE_URL is required when ARCANIST_OPENAI_GATEWAY_ENABLED=1",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(controlPlaneUrl);
  } catch {
    throw createCodexAuthConfigError(
      "gateway_control_plane_url_missing",
      "CONTROL_PLANE_URL must be a valid URL when ARCANIST_OPENAI_GATEWAY_ENABLED=1",
    );
  }

  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/openai`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function validateSessionAuthJson(value: string): void {
  try {
    const parsed = JSON.parse(value);
    if (!isPlainObject(parsed)) {
      throw new Error("not an object");
    }
  } catch {
    throw createCodexAuthConfigError("codex_auth_json_invalid", "Codex session auth.json is not valid JSON");
  }
}

function prepareCodexAuth(
  source: NodeJS.ProcessEnv | Record<string, string>,
  codexHome: string,
  log?: CreateCodexWithStdioOptions["log"],
): CodexAuthDecision {
  mkdirSync(codexHome, { recursive: true });
  const authJsonPath = join(codexHome, "auth.json");
  const apiKey = asString(source.OPENAI_API_KEY) ?? asString(source.CODEX_API_KEY);
  const sessionAuthJson = asString(source.ARCANIST_CODEX_AUTH_JSON);
  const hasStoredAuth = existsSync(authJsonPath);
  const gatewayEnabled = source.ARCANIST_OPENAI_GATEWAY_ENABLED === "1";

  if (sessionAuthJson) {
    validateSessionAuthJson(sessionAuthJson);
    rmSync(authJsonPath, { force: true });
    writeFileSync(authJsonPath, sessionAuthJson, { encoding: "utf8", mode: 0o600 });
    chmodSync(authJsonPath, 0o600);
    if (hasStoredAuth) {
      log?.warn(
        {
          event: "codex_auth_source",
          reason: "stored_auth_ignored_for_session_key",
          keyClass: "stored_auth",
          authSource: "session_auth_json",
        },
        "Stored Codex auth ignored because this session supplied auth.json",
      );
    }
    return { source: "session_auth_json", keyClass: "stored_auth", usesStoredAuth: true };
  }

  if (apiKey) {
    if (hasStoredAuth) {
      rmSync(authJsonPath, { force: true });
      log?.warn(
        {
          event: "codex_auth_source",
          reason: "stored_auth_ignored_for_session_key",
          keyClass: classifyOpenAIKey(apiKey),
          authSource: "session_api_key",
        },
        "Stored Codex auth ignored because this session supplied an OpenAI key",
      );
    }
    return { source: "session_api_key", apiKey, keyClass: classifyOpenAIKey(apiKey), usesStoredAuth: false };
  }

  if (hasStoredAuth && !gatewayEnabled) {
    log?.warn(
      {
        event: "codex_auth_source",
        reason: "stored_auth_used_as_resume_fallback",
        keyClass: "stored_auth",
        authSource: "stored_auth",
      },
      "Using stored Codex auth as resume fallback",
    );
    return { source: "stored_auth", keyClass: "stored_auth", usesStoredAuth: true };
  }

  throw createCodexAuthConfigError("openai_credential_missing", "No OpenAI credential configured for Codex runtime");
}

export function buildCodexRuntimeConfig(
  config: CreateCodexWithStdioOptions["config"] | undefined,
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
  warn: CodexRuntimeConfigWarn = defaultWarn,
): CodexRuntimeConfig {
  const runtimeConfig: CodexRuntimeConfig = {
    model_provider: "openai",
    tool_output_token_limit: CODEX_TOOL_OUTPUT_TOKEN_LIMIT,
    web_search: "disabled",
    apps: DISABLED_CODEX_APP_CONFIG,
  };
  const openaiBaseUrl = resolveOpenAIGatewayBaseUrl(env);
  if (openaiBaseUrl) {
    runtimeConfig.openai_base_url = openaiBaseUrl;
  }
  const hookCommand = resolveMemoryHookCommand(env);
  if (hookCommand) {
    runtimeConfig.hooks = buildManagedMemoryHooks(hookCommand);
  }
  const projectDocFallbackFilenames = asStringArray(config?.project_doc_fallback_filenames);
  if (projectDocFallbackFilenames?.length) {
    runtimeConfig.project_doc_fallback_filenames = projectDocFallbackFilenames;
  }
  const projectRootMarkers = asStringArray(config?.project_root_markers);
  if (projectRootMarkers?.length) {
    runtimeConfig.project_root_markers = projectRootMarkers;
  }
  if (typeof config?.project_doc_max_bytes === "number") {
    if (Number.isInteger(config.project_doc_max_bytes) && config.project_doc_max_bytes >= 0) {
      runtimeConfig.project_doc_max_bytes = config.project_doc_max_bytes;
    } else {
      warn("Ignoring invalid project_doc_max_bytes; expected a non-negative integer", {
        value: config.project_doc_max_bytes,
      });
    }
  }

  const rawMcp = isPlainObject(config?.mcp) ? config.mcp : null;
  if (!rawMcp) return runtimeConfig;

  const mcpServers: Record<string, CodexMcpServerConfig> = {};
  for (const [name, rawServer] of Object.entries(rawMcp)) {
    const server = asBridgeMcpServer(rawServer);
    if (!server) continue;
    if (server.type === "local") {
      const [command, ...args] = server.command;
      if (!command) continue;
      const envVars = server.environment ? Object.keys(server.environment).sort() : undefined;
      mcpServers[name] = {
        command,
        ...(args.length > 0 ? { args } : {}),
        ...(envVars && envVars.length > 0 ? { env_vars: envVars } : {}),
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        ...(server.timeout !== undefined ? { startup_timeout_ms: server.timeout } : {}),
      };
    } else {
      if (server.oauth !== undefined && server.oauth !== false) {
        warn("Remote MCP oauth config dropped; Codex mcp_servers schema does not propagate it", {
          serverName: name,
        });
      }
      const convertedHeaders = convertRemoteHeaders(name, server.headers, env, warn);
      const envHttpHeaders = {
        ...(server.env_http_headers ?? {}),
        ...(convertedHeaders.env_http_headers ?? {}),
      };
      mcpServers[name] = {
        url: server.url,
        ...(Object.keys(envHttpHeaders).length > 0 ? { env_http_headers: envHttpHeaders } : {}),
        ...(convertedHeaders.http_headers ? { http_headers: convertedHeaders.http_headers } : {}),
        ...(server.enabled !== undefined ? { enabled: server.enabled } : {}),
        ...(server.timeout !== undefined ? { startup_timeout_ms: server.timeout } : {}),
      };
    }
  }

  if (Object.keys(mcpServers).length > 0) runtimeConfig.mcp_servers = mcpServers;
  return runtimeConfig;
}

class AsyncEventStream implements AsyncIterable<QueuedEvent> {
  private queue: QueuedEvent[] = [];
  private waiters: Array<(value: IteratorResult<QueuedEvent>) => void> = [];
  private closed = false;

  push(event: QueuedEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter({ done: true, value: undefined });
  }

  return(_value?: unknown): Promise<IteratorResult<QueuedEvent>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<QueuedEvent> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<QueuedEvent>>((resolve) => this.waiters.push(resolve));
      },
      return: () => this.return(),
    };
  }
}

export function resolveCodexPathOverride(source: NodeJS.ProcessEnv | Record<string, string>): string | undefined {
  const configured = source.CODEX_CLI_PATH || source.CODEX_PATH || process.env.CODEX_CLI_PATH || process.env.CODEX_PATH;
  if (configured) return configured;
  const runtimeProvider = source.ARCANIST_RUNTIME_PROVIDER || process.env.ARCANIST_RUNTIME_PROVIDER;
  // Probe the standard image paths for any managed runtime provider. The control
  // plane now sets ARCANIST_RUNTIME_PROVIDER honestly ("e2b" | "freestyle"), so a
  // freestyle session must hit this probe too — its base snapshot must ship the
  // codex CLI at one of these paths (or set CODEX_CLI_PATH/CODEX_PATH above). The
  // bridge cannot import control-plane code, so the known-provider set is mirrored
  // here as literals (kept in lockstep with SandboxRuntimeProvider).
  if (runtimeProvider === "e2b" || runtimeProvider === "freestyle") {
    for (const candidate of ["/usr/bin/codex", "/usr/local/bin/codex"]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// Single source of truth for the bridge-generated CODEX_HOME path. Used by
// `resolveCodexHome` to construct the path and by `isBridgeOwnedCodexHome` to
// recognize it, so the two cannot drift out of sync.
const BRIDGE_CODEX_HOME_PREFIX = process.env.ARCANIST_CODEX_HOME_PREFIX || "/tmp/codex-home-";

export function resolveCodexHome(source: NodeJS.ProcessEnv | Record<string, string>): string {
  return (
    source.CODEX_HOME ||
    process.env.CODEX_HOME ||
    `${BRIDGE_CODEX_HOME_PREFIX}${source.SESSION_ID || process.env.SESSION_ID || randomUUID()}`
  );
}

export type BuildCodexEnvResult = {
  env: Record<string, string>;
  diagnostics: Omit<AgentChildEnvResult, "env">;
};

/**
 * Build the sanitized env Codex's app-server child (and, transitively, every
 * bash tool it spawns) inherits. Fail-closed allowlist via `buildAgentChildEnv`;
 * the model provider key is the only secret reinjected by default, plus any
 * trusted integration credential the session's MCP config references
 * (`preserveNames`). `source` should be the UNSANITIZED bridge env so the auth
 * decision can read the stored OpenAI key.
 */
export function buildCodexEnv(
  source: NodeJS.ProcessEnv | Record<string, string>,
  apiKey?: string,
  codexHome = resolveCodexHome(source),
  opts: { preserveNames?: Iterable<string>; trustedPreserveNames?: Iterable<string>; useStoredAuth?: boolean } = {},
): BuildCodexEnvResult {
  mkdirSync(codexHome, { recursive: true });
  const hasStoredAuth = existsSync(join(codexHome, "auth.json"));
  const forceManagedGatewayEnvKey = source.ARCANIST_OPENAI_GATEWAY_ENABLED === "1";
  const useStoredAuth = opts.useStoredAuth ?? (hasStoredAuth && !apiKey && !forceManagedGatewayEnvKey);
  const providerKeys = !useStoredAuth && apiKey ? { OPENAI_API_KEY: apiKey, CODEX_API_KEY: apiKey } : undefined;

  const { env, ...diagnostics } = buildAgentChildEnv(source, {
    providerKeys,
    preserveNames: opts.preserveNames,
    trustedPreserveNames: opts.trustedPreserveNames,
  });
  env.CODEX_HOME = codexHome;
  env.CODEX_NO_LOGIN = "1";
  return { env, diagnostics };
}

/**
 * Collect env-var NAMES a built Codex runtime config references through MCP
 * server `env_vars` and `env_http_headers` (header → env-name). These feed
 * `buildCodexEnv`'s `preserveNames` so a customer MCP server that needs its
 * own integration token still finds it in the sanitized child env.
 */
export function extractMcpReferencedEnvNames(config: CodexRuntimeConfig): Set<string> {
  const names = new Set<string>();
  for (const server of Object.values(config.mcp_servers ?? {})) {
    if (server.enabled === false) continue;
    for (const name of server.env_vars ?? []) names.add(name);
    for (const name of Object.values(server.env_http_headers ?? {})) names.add(name);
  }
  return names;
}

function asManagedMcpEnvNames(config: CreateCodexWithStdioOptions["config"] | undefined): string[] {
  const raw = config?.managed_mcp_env_names;
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string" && name.length > 0) : [];
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteTomlKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoteTomlString(value);
}

function serializeTomlStringArray(values: string[]): string {
  return `[${values.map((value) => quoteTomlString(value)).join(", ")}]`;
}

function buildCodexRuntimeConfigToml(config: CodexRuntimeConfig): string {
  const lines: string[] = [];
  lines.push(`model_provider = ${quoteTomlString(config.model_provider)}`);
  lines.push(`tool_output_token_limit = ${config.tool_output_token_limit}`);
  if (config.openai_base_url) lines.push(`openai_base_url = ${quoteTomlString(config.openai_base_url)}`);
  if (config.service_tier === OpenAIServiceTier.Flex) {
    lines.push(`service_tier = ${quoteTomlString(OpenAIServiceTier.Flex)}`);
  }
  if (config.web_search) lines.push(`web_search = ${quoteTomlString(config.web_search)}`);
  if (config.project_doc_fallback_filenames?.length) {
    lines.push(`project_doc_fallback_filenames = ${serializeTomlStringArray(config.project_doc_fallback_filenames)}`);
  }
  if (config.project_root_markers?.length) {
    lines.push(`project_root_markers = ${serializeTomlStringArray(config.project_root_markers)}`);
  }
  if (typeof config.project_doc_max_bytes === "number") {
    lines.push(`project_doc_max_bytes = ${config.project_doc_max_bytes}`);
  }

  for (const [eventName, entries] of Object.entries(config.hooks ?? {})) {
    for (const entry of entries) {
      lines.push("", `[[hooks.${quoteTomlKeySegment(eventName)}]]`);
      if (entry.matcher) lines.push(`matcher = ${quoteTomlString(entry.matcher)}`);
      for (const hook of entry.hooks) {
        lines.push(`[[hooks.${quoteTomlKeySegment(eventName)}.hooks]]`);
        lines.push(`type = ${quoteTomlString(hook.type)}`);
        lines.push(`command = ${quoteTomlString(hook.command)}`);
        if (typeof hook.timeout === "number") lines.push(`timeout = ${hook.timeout}`);
      }
    }
  }

  for (const [name, app] of Object.entries(config.apps ?? {})) {
    lines.push("", `[apps.${quoteTomlKeySegment(name)}]`);
    if (typeof app.enabled === "boolean") lines.push(`enabled = ${app.enabled}`);
  }

  for (const [name, server] of Object.entries(config.mcp_servers ?? {})) {
    const header = `[mcp_servers.${quoteTomlKeySegment(name)}]`;
    lines.push("", header);
    if (server.command) lines.push(`command = ${quoteTomlString(server.command)}`);
    if (server.args?.length) lines.push(`args = ${serializeTomlStringArray(server.args)}`);
    if (server.url) lines.push(`url = ${quoteTomlString(server.url)}`);
    if (server.env_vars?.length) lines.push(`env_vars = ${serializeTomlStringArray(server.env_vars)}`);
    if (typeof server.enabled === "boolean") lines.push(`enabled = ${server.enabled}`);
    if (typeof server.startup_timeout_ms === "number") lines.push(`startup_timeout_ms = ${server.startup_timeout_ms}`);
    if (server.env_http_headers && Object.keys(server.env_http_headers).length > 0) {
      lines.push(`[mcp_servers.${quoteTomlKeySegment(name)}.env_http_headers]`);
      for (const [headerName, envVarName] of Object.entries(server.env_http_headers)) {
        lines.push(`${quoteTomlKeySegment(headerName)} = ${quoteTomlString(envVarName)}`);
      }
    }
    if (server.http_headers && Object.keys(server.http_headers).length > 0) {
      lines.push(`[mcp_servers.${quoteTomlKeySegment(name)}.http_headers]`);
      for (const [headerName, value] of Object.entries(server.http_headers)) {
        lines.push(`${quoteTomlKeySegment(headerName)} = ${quoteTomlString(value)}`);
      }
    }
  }

  lines.push("");
  return lines.join("\n");
}

// Match bridge-generated CODEX_HOME paths only: `${BRIDGE_CODEX_HOME_PREFIX}<id>`.
// Local developer Codex homes (`~/.codex`) and any other operator-supplied
// CODEX_HOME must never be overwritten by the bridge. The pattern is derived
// from `BRIDGE_CODEX_HOME_PREFIX` (shared with `resolveCodexHome`) so a future
// prefix change updates both call sites at once instead of silently dropping
// the AGENTS.md write.
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const BRIDGE_CODEX_HOME_PATTERN = new RegExp(`^${escapeForRegex(BRIDGE_CODEX_HOME_PREFIX)}[^/]+/?$`);

function isBridgeOwnedCodexHome(codexHome: string): boolean {
  return BRIDGE_CODEX_HOME_PATTERN.test(codexHome);
}

function writeRuntimeConfig(
  env: Record<string, string>,
  config: CodexRuntimeConfig,
  agentRole: AgentRole,
  adoptedExternalPr: boolean,
  cwd?: string,
  // Unsanitized env for tool-availability guidance: the sanitized child `env`
  // no longer carries integration tokens, so deriving tool names from it would
  // drop integration-backed tools from the AGENTS.md guidance (B3).
  toolEnv: NodeJS.ProcessEnv | Record<string, string> = env,
): boolean {
  const codexHome = env.CODEX_HOME;
  if (!codexHome) return false;
  mkdirSync(codexHome, { recursive: true });
  // Remove legacy managed hook files so stale definitions do not coexist with inline config.toml hooks.
  rmSync(join(codexHome, "hooks.json"), { force: true });
  if (cwd) {
    rmSync(join(cwd, ".codex", "hooks.json"), { force: true });
  }
  writeFileSync(join(codexHome, "config.toml"), buildCodexRuntimeConfigToml(config));

  // Write durable Cycloid behavioral rules to `${CODEX_HOME}/AGENTS.md` so
  // Codex loads them into `config.user_instructions` (via `load_global_instructions`)
  // at session start. This re-injects after every auto-compaction and stabilizes
  // the per-prompt prefix for caching. Guard to bridge-owned CODEX_HOMEs only so
  // we never overwrite a developer's local `~/.codex/AGENTS.md`.
  if (isBridgeOwnedCodexHome(codexHome)) {
    const dynamicToolEnv = { ...toolEnv, ARCANIST_AGENT_ROLE: agentRole };
    writeFileSync(
      join(codexHome, "AGENTS.md"),
      buildSessionStaticBehavioralGuidance({
        agentRole,
        adoptedExternalPr,
        dynamicToolNames: getAvailableFirstPartyDynamicToolNames(dynamicToolEnv, { agentRole }),
      }),
      { mode: 0o600 },
    );
    return true;
  }
  return false;
}

/**
 * Single source of truth for whether Codex managed memory hooks are active:
 * disabled hard by `ARCANIST_CODEX_MEMORY_HOOKS=0`, otherwise enabled when
 * hooks are explicitly on or the memory tools are enabled. Exported so
 * telemetry (e.g. the `memory_activation.prompt_start` log) reads the same
 * predicate instead of re-deriving the env logic and drifting.
 */
export function areCodexMemoryHooksEnabled(env: NodeJS.ProcessEnv | Record<string, string>): boolean {
  if (env.ARCANIST_CODEX_MEMORY_HOOKS === "0") return false;
  return env.ARCANIST_CODEX_MEMORY_HOOKS === "1" || env.ARCANIST_MEMORY_TOOLS_ENABLED === "1";
}

function resolveMemoryHookCommand(env: NodeJS.ProcessEnv | Record<string, string>): string | null {
  if (!areCodexMemoryHooksEnabled(env)) return null;
  const entrypoint = env.ARCANIST_BRIDGE_BUNDLE_PATH || process.argv[1];
  if (!entrypoint) return null;
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(entrypoint)} --memory-hook`;
}

function buildManagedMemoryHooks(command: string): NonNullable<CodexRuntimeConfig["hooks"]> {
  const hook = { type: "command" as const, command, timeout: 5 };
  return {
    UserPromptSubmit: [{ hooks: [hook] }],
    PreToolUse: [{ matcher: "*", hooks: [hook] }],
    PostToolUse: [{ matcher: "*", hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
  };
}

function createTypedError(message: string, errorCode: string): Error & { errorCode: string } {
  const error = new Error(message) as Error & { errorCode: string };
  error.errorCode = errorCode;
  return error;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("errorCode" in error)) return undefined;
  const errorCode = (error as { errorCode?: unknown }).errorCode;
  return typeof errorCode === "string" ? errorCode : undefined;
}

function getSystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isTransientCodexSetupError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (getErrorCode(error) === "timeout") return true;
  return ["EPIPE", "ECONNRESET", "ETIMEDOUT"].includes(getSystemErrorCode(error) ?? "");
}

class CodexAppServerTransport {
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly codexPath: string;
  private readonly spawnImpl: SpawnLike;
  private readonly onStdioLine?: (event: CodexStdioLineEvent) => void;
  private readonly onStdioCap?: (event: CodexStdioCapEvent) => void;
  private readonly stdioLineMaxBytes: number;
  private readonly stdioSessionMaxBytes: number;
  private readonly pending = new Map<string | number, PendingProtocolRequest>();
  private readonly signal?: AbortSignal;
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private stderrBytesForwarded = 0;
  private stdoutBytesForwarded = 0;
  private readonly stderrDiagnostics: StderrDiagnosticLine[] = [];
  private stderrDiagnosticCounter = 0;
  private closed = false;
  private closeNotified = false;
  private lastCloseWasIntentional = false;
  onNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;
  onClosed: ((error: BridgeLocalTransportError) => void) | null = null;
  onServerRequest:
    ((request: { id: string | number; method: string; params: Record<string, unknown> }) => Promise<unknown>) | null =
    null;

  constructor(options: {
    cwd: string;
    env: Record<string, string>;
    codexPath: string;
    spawn?: SpawnLike;
    signal?: AbortSignal;
    onStdioLine?: (event: CodexStdioLineEvent) => void;
    onStdioCap?: (event: CodexStdioCapEvent) => void;
    stdioLineMaxBytes?: number;
    stdioSessionMaxBytes?: number;
  }) {
    this.cwd = options.cwd;
    this.env = options.env;
    this.codexPath = options.codexPath;
    this.spawnImpl = options.spawn ?? spawn;
    this.signal = options.signal;
    this.onStdioLine = options.onStdioLine;
    this.onStdioCap = options.onStdioCap;
    this.stdioLineMaxBytes = options.stdioLineMaxBytes ?? 32 * 1024;
    this.stdioSessionMaxBytes = options.stdioSessionMaxBytes ?? 512 * 1024;
    this.child = this.spawnImpl(this.codexPath, ["app-server"], {
      cwd: this.cwd,
      env: this.env,
      stdio: "pipe",
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      const typedError =
        error instanceof Error
          ? Object.assign(error, { errorCode: "runtime_error" })
          : createTypedError(String(error), "runtime_error");
      this.closed = true;
      this.lastCloseWasIntentional = false;
      this.rejectAllPending(typedError);
      this.notifyClosed(Object.assign(typedError, { wasIntentionalClose: false }));
    });
    this.child.on("exit", (code, signal) => {
      const wasAlreadyClosed = this.closed;
      const reason = wasAlreadyClosed
        ? "Codex app-server closed"
        : `Codex app-server exited unexpectedly (code=${String(code)} signal=${String(signal)})`;
      const typedError = createTypedError(reason, wasAlreadyClosed ? "shutdown" : "runtime_error");
      this.closed = true;
      const wasIntentional = wasAlreadyClosed && this.lastCloseWasIntentional;
      this.lastCloseWasIntentional = wasIntentional;
      this.rejectAllPending(typedError);
      this.notifyClosed(Object.assign(typedError, { wasIntentionalClose: wasIntentional }));
    });
    this.signal?.addEventListener("abort", () => {
      this.close();
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async initialize(timeoutMs: number): Promise<void> {
    await withProviderRetry({
      maxAttempts: CODEX_SETUP_MAX_ATTEMPTS,
      op: () =>
        this.request(
          "initialize",
          {
            clientInfo: { name: "cycloid-bridge", title: "Cycloid Bridge", version: "0.0.0" },
            capabilities: { experimentalApi: true },
          },
          timeoutMs,
        ),
      isTransient: isTransientCodexSetupError,
    });
    this.notify("initialized");
  }

  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        Object.assign(createTypedError("Codex app-server is closed", "shutdown"), {
          wasIntentionalClose: this.lastCloseWasIntentional,
        }),
      );
    }
    const id = this.nextId++;
    const payload = {
      id,
      method,
      params,
    };
    const line = `${JSON.stringify(payload)}\n`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(createTypedError(`Codex app-server request timed out: ${method}`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout, method });
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  close(error?: BridgeLocalTransportError, wasIntentionalClose = true): void {
    if (this.closed) return;
    this.closed = true;
    this.lastCloseWasIntentional = wasIntentionalClose;
    const closeError = error ?? createTypedError("Codex app-server closed", "shutdown");
    this.notifyClosed(Object.assign(closeError, { wasIntentionalClose }));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child.exitCode === null && !this.child.killed) {
        this.child.kill("SIGKILL");
      }
    }, 2_000).unref();
  }

  private rejectAllPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }

  private notifyClosed(error: BridgeLocalTransportError): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onClosed?.(error);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const error = createTypedError(
          `Malformed Codex app-server NDJSON line: ${line.slice(0, 200)}`,
          "protocol_error",
        );
        this.rejectAllPending(error);
        this.close(error, false);
        return;
      }
      this.handleProtocolMessage(parsed);
    }
  }

  private handleStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      this.recordStderrDiagnostic(line);
      this.forwardStdioLine("stderr", line);
    }
  }

  private recordStderrDiagnostic(line: string): void {
    const normalized = truncateDiagnostic(line);
    if (!normalized) return;
    const score = scoreStderrDiagnosticLine(normalized);
    if (score <= 0) return;
    this.stderrDiagnosticCounter += 1;
    this.stderrDiagnostics.push({ line: normalized, score, index: this.stderrDiagnosticCounter });
    if (this.stderrDiagnostics.length > STDERR_DIAGNOSTIC_LINE_LIMIT) {
      this.stderrDiagnostics.splice(0, this.stderrDiagnostics.length - STDERR_DIAGNOSTIC_LINE_LIMIT);
    }
  }

  private getBestStderrDiagnostic(): string | null {
    const best = this.stderrDiagnostics.reduce<StderrDiagnosticLine | null>((selected, candidate) => {
      if (!selected) return candidate;
      if (candidate.score !== selected.score) return candidate.score > selected.score ? candidate : selected;
      return candidate.index > selected.index ? candidate : selected;
    }, null);
    return best?.line ?? null;
  }

  private enrichGenericAppServerErrorMessage(message: string | null | undefined): string {
    const normalized = truncateDiagnostic(message ?? "");
    const diagnostic = this.getBestStderrDiagnostic();
    if (!diagnostic) return normalized || "Codex app-server error";
    if (normalized && normalized !== "Codex app-server error") return normalized;
    if (normalized.includes(diagnostic)) return normalized;
    return `Codex app-server error: ${diagnostic}`;
  }

  private forwardStdioLine(stream: CodexStdioStream, line: string): void {
    const bytes = Buffer.byteLength(line);
    if (stream === "stderr") {
      if (this.stderrBytesForwarded >= this.stdioSessionMaxBytes) return;
      this.stderrBytesForwarded += bytes;
      if (this.stderrBytesForwarded > this.stdioSessionMaxBytes) {
        this.onStdioCap?.({
          capBytes: this.stdioSessionMaxBytes,
          droppedFromStream: stream,
        });
      }
    } else {
      if (this.stdoutBytesForwarded >= this.stdioSessionMaxBytes) return;
      this.stdoutBytesForwarded += bytes;
      if (this.stdoutBytesForwarded > this.stdioSessionMaxBytes) {
        this.onStdioCap?.({
          capBytes: this.stdioSessionMaxBytes,
          droppedFromStream: stream,
        });
      }
    }
    const lineBytes = Buffer.byteLength(line);
    const truncated = lineBytes > this.stdioLineMaxBytes;
    const forwarded = truncated ? `${line.slice(0, this.stdioLineMaxBytes)}…` : line;
    this.onStdioLine?.({
      stream,
      line: forwarded,
      truncated,
      looksLikeError: stream === "stderr",
    });
  }

  private handleProtocolMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if (typeof message.method === "string" && message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }
    if (typeof message.method === "string") {
      const params = isRecord(message.params) ? { ...message.params } : {};
      if (message.method === "error") {
        params.message = this.enrichGenericAppServerErrorMessage(
          typeof params.message === "string" ? params.message : undefined,
        );
      }
      this.onNotification?.(message.method, params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id as string | number);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id as string | number);
    if (isRecord(message.error)) {
      const errorMessage =
        typeof message.error.message === "string"
          ? message.error.message
          : `Codex app-server request failed: ${pending.method}`;
      pending.reject(createTypedError(errorMessage, "runtime_error"));
      return;
    }
    pending.resolve((message as { result?: unknown }).result);
  }

  private async handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as string | number;
    const method = message.method as string;
    const params = isRecord(message.params) ? message.params : {};
    try {
      const result = this.onServerRequest ? await this.onServerRequest({ id, method, params }) : {};
      if (this.closed || this.child.stdin.writableEnded || this.child.stdin.destroyed) return;
      this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
    } catch (error) {
      const messageText = stringifyError(error);
      if (this.closed || this.child.stdin.writableEnded || this.child.stdin.destroyed) return;
      this.child.stdin.write(`${JSON.stringify({ id, error: { message: messageText } })}\n`);
    }
  }
}

export class CodexBridgeClient {
  private readonly transport: CodexAppServerTransport;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly streams = new Set<AsyncEventStream>();
  private readonly mcpServers = new Map<string, McpRuntimeStatus>();
  private readonly cwd: string;
  private readonly defaultModel: string | undefined;
  private readonly defaultReasoningEffort: string | undefined;
  private readonly toolOutputTokenLimit: number;
  private readonly agentRole: AgentRole;
  private readonly sessionStaticBehavioralGuidance: string;
  private readonly dynamicTools: DynamicToolSpec[];
  private readonly getRepoMemories: (() => Memory[]) | undefined;
  private readonly getMemoryRefById:
    (() => ReadonlyMap<string, import("../../../../shared/events/bridge.js").MemoryRef>) | undefined;
  private readonly uploadImageDir: string;
  private readonly mcpToolResultImageDir: string;
  private readonly materializedImagePaths = new Set<string>();
  private readonly pendingQuestionResponses = new Map<
    string,
    {
      sessionID: string;
      questionIds: string[];
      resolve: (value: unknown) => void;
    }
  >();

  readonly event = {
    subscribe: async (): Promise<{ stream: AsyncEventStream }> => {
      const stream = new AsyncEventStream();
      this.streams.add(stream);
      const originalReturn = stream.return.bind(stream);
      stream.return = async () => {
        this.streams.delete(stream);
        return originalReturn();
      };
      return { stream };
    },
  };

  readonly mcp = {
    status: async (_request?: unknown): Promise<{ data: Record<string, McpRuntimeStatus> }> => ({
      data: Object.fromEntries(this.mcpServers),
    }),
    add: async ({
      body,
    }: {
      body?: { name?: string; config?: unknown };
      signal?: AbortSignal;
    }): Promise<{ data: Record<string, McpRuntimeStatus> }> => {
      const name = body?.name;
      if (!name) return { data: {} };
      const status = {
        status: "failed",
        error: "Codex app-server MCP attach is startup-only; configure MCP servers before spawn",
      };
      return { data: { [name]: status } };
    },
    disconnect: async (request?: { path?: { name?: string } }): Promise<{ data: { ok: boolean } }> => {
      const name = request?.path?.name;
      if (name) this.mcpServers.delete(name);
      return { data: { ok: true } };
    },
  };

  readonly tool = {
    ids: async (_request?: unknown): Promise<{ data: string[] }> => ({ data: [] }),
    list: async (_request?: unknown): Promise<{ data: Array<{ id: string }> }> => ({ data: [] }),
  };

  readonly question = {
    reply: async ({ id, answer }: { id: string; answer: string }): Promise<{ data: { ok: boolean } }> => {
      const pending = this.pendingQuestionResponses.get(id);
      if (!pending) return { data: { ok: false } };
      const answers = Object.fromEntries(
        pending.questionIds.map((questionId, index) => [questionId, { answers: index === 0 ? [answer] : [] }]),
      );
      pending.resolve({ answers });
      this.pendingQuestionResponses.delete(id);
      return { data: { ok: true } };
    },
  };

  readonly session = {
    create: async (_request?: unknown): Promise<{ data: { id: string } }> => {
      const response = (await this.requestCodexSetup<{
        thread: { id: string };
      }>("thread/start", {
        model: this.defaultModel,
        modelProvider: "openai",
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: CODEX_SANDBOX_MODE,
        config: {},
        serviceName: "cycloid-bridge",
        sessionStartSource: "startup",
        threadSource: "user",
        ...(this.dynamicTools.length > 0 ? { dynamicTools: this.dynamicTools } : {}),
      })) as { thread: { id: string } };
      const id = response.thread.id;
      this.sessions.set(id, {
        id,
        codexThreadId: id,
        loaded: true,
        activeAbort: null,
        activeTurnId: null,
        activeTurnStartParams: null,
        activeInput: null,
        pendingSyntheticImageFeedback: [],
        currentModel: this.defaultModel,
        currentAgentRole: this.agentRole,
        currentAgentProfile: undefined,
        currentMessageId: `codex-message-${id}-0`,
        promptLog: null,
        messageCounter: 0,
        interruptedTurnIds: new Set(),
        observedApplyPatchCallIds: new Set(),
        turnItems: new Map(),
      });
      return { data: { id } };
    },
    get: async ({ path }: { path: { id: string } }): Promise<{ data?: { id: string } }> => {
      if (this.sessions.has(path.id)) return { data: { id: path.id } };
      try {
        await this.transport.request(
          "thread/read",
          { threadId: path.id, includeTurns: false },
          CONTROL_REQUEST_TIMEOUT_MS,
        );
        this.sessions.set(path.id, {
          id: path.id,
          codexThreadId: path.id,
          loaded: false,
          activeAbort: null,
          activeTurnId: null,
          activeTurnStartParams: null,
          activeInput: null,
          pendingSyntheticImageFeedback: [],
          currentModel: this.defaultModel,
          currentAgentRole: this.agentRole,
          currentAgentProfile: undefined,
          currentMessageId: `codex-message-${path.id}-0`,
          promptLog: null,
          messageCounter: 0,
          interruptedTurnIds: new Set(),
          observedApplyPatchCallIds: new Set(),
          turnItems: new Map(),
        });
        return { data: { id: path.id } };
      } catch {
        return {};
      }
    },
    abort: async ({ path }: { path: { id: string } }): Promise<{ data: { ok: boolean } }> => {
      const session = this.sessions.get(path.id);
      session?.activeAbort?.abort();
      if (session?.activeInput) {
        this.cleanupMaterializedImages(session.activeInput);
        session.activeInput = null;
      }
      if (session) {
        session.activeTurnStartParams = null;
      }
      if (session?.activeTurnId) {
        await this.transport
          .request("turn/interrupt", { threadId: path.id, turnId: session.activeTurnId }, CONTROL_REQUEST_TIMEOUT_MS)
          .catch(() => undefined);
      }
      this.resolvePendingQuestionsForSession(path.id);
      return { data: { ok: true } };
    },
    promptAsync: async (request: PromptAsyncOptions): Promise<{ data: { ok: boolean } }> => {
      const session = this.sessions.get(request.path.id);
      if (!session) throw new Error(`Codex thread ${request.path.id} was not created`);

      if (!session.loaded && session.codexThreadId) {
        await this.requestCodexSetup("thread/resume", {
          threadId: session.codexThreadId,
          cwd: this.cwd,
          sandbox: CODEX_SANDBOX_MODE,
        });
        session.loaded = true;
      }

      const abort = new AbortController();
      session.activeAbort = abort;
      const signal = request.signal ? AbortSignal.any([request.signal, abort.signal]) : abort.signal;
      // Pending image feedback is retryable turn input: remove a snapshot before
      // dispatch so feedback generated while turn/start is in flight is not
      // dropped, then put the snapshot back if Codex rejects the start.
      const pendingSyntheticImageFeedback = session.pendingSyntheticImageFeedback.splice(0);
      const input = this.buildPromptInput(request.body, pendingSyntheticImageFeedback);
      const model = this.extractModel(request.body?.model) ?? this.defaultModel;
      const reasoningEffort = this.normalizeReasoningEffort(request.body?.variant) ?? this.defaultReasoningEffort;
      const reasoningSummary = this.normalizeReasoningSummary(request.body?.summary);
      const sandboxPolicy = request.body?.sandboxPolicy;
      if (!sandboxPolicy) {
        throw new Error("Codex turn sandboxPolicy is required for every prompt");
      }
      const turnStartParams: CodexTurnStartParams = {
        threadId: session.codexThreadId ?? session.id,
        input,
        cwd: this.cwd,
        approvalPolicy: "never",
        // Codex app-server treats turn sandboxPolicy as sticky session config,
        // so every turn sends an explicit policy: plan turns lock down writes,
        // execute turns reset to full access even after a prior plan turn.
        sandboxPolicy,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        ...(reasoningSummary ? { summary: reasoningSummary } : {}),
      };
      session.currentModel = model;
      session.currentAgentRole = this.agentRole;
      session.currentAgentProfile = request.body.agent;
      session.messageCounter += 1;
      session.currentMessageId = `codex-message-${session.id}-${session.messageCounter}`;
      session.promptLog = request.promptLog ?? null;
      session.turnItems.clear();
      session.observedApplyPatchCallIds.clear();
      session.activeInput = input;
      session.activeTurnStartParams = turnStartParams;
      let abortHandled = false;
      const handleAbort = () => {
        if (abortHandled) return;
        abortHandled = true;
        void this.session.abort({ path: { id: session.id } });
      };
      signal.addEventListener("abort", handleAbort, { once: true });

      let result: { turn: { id: string } };
      try {
        request.promptLog?.info(
          { event: "codex.turn_sandbox_policy", sandboxPolicyType: sandboxPolicy.type },
          "Applying Codex per-turn sandbox policy",
        );
        result = (await this.transport.request<{
          turn: { id: string };
        }>("turn/start", turnStartParams, TURN_REQUEST_TIMEOUT_MS)) as { turn: { id: string } };
      } catch (error) {
        if (pendingSyntheticImageFeedback.length > 0) {
          session.pendingSyntheticImageFeedback.unshift(...pendingSyntheticImageFeedback);
        }
        if (sandboxPolicy.type === "readOnly") {
          request.promptLog?.warn(
            {
              event: "codex.sandbox_denied",
              blockSource: "codex_sandbox",
              sandboxPolicyType: sandboxPolicy.type,
              error: stringifyError(error),
            },
            "Codex read-only turn failed under per-turn sandbox policy",
          );
        }
        session.activeAbort = null;
        session.activeTurnStartParams = null;
        if (session.activeInput === input) {
          this.cleanupMaterializedImages(input);
          session.activeInput = null;
        }
        signal.removeEventListener("abort", handleAbort);
        throw error;
      }
      session.activeTurnId = result.turn.id;
      this.broadcast({ type: "session.status", properties: { sessionID: session.id, status: { type: "running" } } });
      if (signal.aborted) {
        await this.session.abort({ path: { id: session.id } });
      }
      signal.removeEventListener("abort", handleAbort);
      return { data: { ok: true } };
    },
  };

  constructor(options: {
    transport: CodexAppServerTransport;
    cwd: string;
    model?: string;
    reasoningEffort?: string;
    toolOutputTokenLimit?: number;
    agentRole: AgentRole;
    sessionStaticBehavioralGuidance?: string;
    mcpStatus?: Record<string, McpRuntimeStatus>;
    dynamicTools?: DynamicToolSpec[];
    getRepoMemories?: () => Memory[];
    getMemoryRefById?: () => ReadonlyMap<string, import("../../../../shared/events/bridge.js").MemoryRef>;
  }) {
    this.transport = options.transport;
    this.cwd = options.cwd;
    this.defaultModel = options.model;
    this.defaultReasoningEffort = this.normalizeReasoningEffort(options.reasoningEffort);
    this.toolOutputTokenLimit = options.toolOutputTokenLimit ?? CODEX_TOOL_OUTPUT_TOKEN_LIMIT;
    this.agentRole = options.agentRole;
    this.sessionStaticBehavioralGuidance = options.sessionStaticBehavioralGuidance ?? "";
    this.dynamicTools = options.dynamicTools ?? [];
    this.getRepoMemories = options.getRepoMemories;
    this.getMemoryRefById = options.getMemoryRefById;
    this.uploadImageDir = join(tmpdir(), "cycloid-codex-upload-images");
    this.mcpToolResultImageDir = join(RUNTIME_EVIDENCE_DIR, MCP_TOOL_RESULT_IMAGE_DIR_NAME);
    for (const [name, status] of Object.entries(options.mcpStatus ?? {})) {
      this.mcpServers.set(name, status);
    }
    this.transport.onNotification = (method, params) => this.handleProtocolNotification(method, params);
    this.transport.onClosed = (error) => this.handleTransportClosed(error);
    this.transport.onServerRequest = (request) => this.handleServerRequest(request);
  }

  close(): void {
    for (const session of this.sessions.values()) {
      session.activeAbort?.abort();
    }
    this.resolvePendingQuestionsForSession();
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    this.transport.close();
  }

  private async requestCodexSetup<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const result = await withProviderRetry({
      maxAttempts: CODEX_SETUP_MAX_ATTEMPTS,
      op: () => this.transport.request<T>(method, params, timeoutMs),
      isTransient: isTransientCodexSetupError,
    });
    return result.value;
  }

  private warnUnknownProtocolType(
    axis: "itemType" | "notification" | "serverRequest",
    type: string,
    sessionId?: string,
  ): void {
    // eslint-disable-next-line no-console
    console.warn("[CodexBridgeClient] Unknown Codex protocol type", {
      event: "codex_protocol.unknown_type",
      axis,
      type,
      CODEX_CLI_VERSION: PINNED_CODEX_CLI_VERSION,
      sessionId,
    });
  }

  private broadcastRawCodexNotification(
    sessionID: string | undefined,
    eventType: string,
    params: Record<string, unknown>,
  ): void {
    this.broadcast({
      type: "raw_agent_runtime",
      properties: {
        ...(sessionID ? { sessionID } : {}),
        eventType,
        ...params,
      },
    });
  }

  private broadcastRawCodexItem(sessionID: string, itemType: string, item: Record<string, unknown>): void {
    this.broadcast({
      type: "raw_agent_runtime",
      properties: {
        sessionID,
        itemType,
        item,
      },
    });
  }

  private isApplyPatchToolCall(item: Record<string, unknown>, priorState?: RuntimeTurnItemState): boolean {
    const toolName = asString(item.name);
    if (toolName !== undefined) return toolName === "apply_patch";
    return priorState?.type === "tool" && priorState.tool === "apply_patch";
  }

  private getApplyPatchErrorText(item: Record<string, unknown>): string | undefined {
    return stringifyToolPayload(item.error ?? item.output ?? item.result);
  }

  private emitCustomApplyPatchToolPart(params: {
    session: SessionRecord;
    itemId: string;
    callId: string;
    input: Record<string, unknown>;
    status: string;
    output?: string;
    error?: string;
  }): void {
    const state = {
      type: "tool",
      messageID: params.session.currentMessageId,
      tool: "apply_patch",
      input: params.input,
      status: params.status,
      ...(params.output !== undefined ? { output: params.output } : {}),
      ...(params.error !== undefined ? { error: params.error } : {}),
    } satisfies RuntimeTurnItemState;
    params.session.turnItems.set(`customToolCall:${params.callId}`, state);
    params.session.observedApplyPatchCallIds.add(params.callId);
    this.emitToolPart(params.session.id, state.messageID, {
      id: params.itemId,
      callID: params.callId,
      tool: "apply_patch",
      input: params.input,
      status: params.status,
      output: params.output,
      error: params.error,
    });
  }

  private handleCustomApplyPatchResponseItem(session: SessionRecord, item: Record<string, unknown>): boolean {
    const rawType = asString(item.type);
    if (rawType !== "custom_tool_call" && rawType !== "custom_tool_call_output") return false;

    if (rawType === "custom_tool_call") {
      if (asString(item.name) !== "apply_patch") return false;
      const callId = getCallId(item);
      const itemId = asString(item.id) ?? callId;
      if (!callId || !itemId) return false;
      this.emitCustomApplyPatchToolPart({
        session,
        itemId,
        callId,
        input: normalizeApplyPatchInput(item.input),
        status: this.mapToolStatus(asString(item.status) ?? "inProgress"),
      });
      return true;
    }

    const callId = getCallId(item);
    if (!callId) return false;
    const priorState = session.turnItems.get(`customToolCall:${callId}`);
    if (!this.isApplyPatchToolCall(item, priorState)) return false;
    const itemId = asString(item.id) ?? callId;
    const protocolStatus = asString(item.status) ?? (item.error ? "failed" : "completed");
    const status = this.mapToolStatus(protocolStatus);
    const output = status === "completed" ? stringifyToolPayload(item.output) : undefined;
    const error = status === "error" ? this.getApplyPatchErrorText(item) : undefined;
    this.emitCustomApplyPatchToolPart({
      session,
      itemId,
      callId,
      input: priorState?.type === "tool" ? priorState.input : {},
      status,
      output,
      error,
    });
    return true;
  }

  private handleRawResponseItem(params: Record<string, unknown>): boolean {
    const threadId = asString(params.threadId) ?? asString(params.thread_id);
    if (!threadId) return false;
    const session = this.sessions.get(threadId);
    if (!session) return false;
    const item =
      (isRecord(params.item) ? params.item : null) ??
      (isRecord(params.responseItem) ? params.responseItem : null) ??
      (isRecord(params.response_item) ? params.response_item : null);
    if (!item) return false;
    return this.handleCustomApplyPatchResponseItem(session, item);
  }

  private async restartActiveTurnWithSyntheticImageFeedback(
    session: SessionRecord,
    feedback: readonly CodexSyntheticImageFeedback[],
    observedTurnId: string | null,
  ): Promise<void> {
    if (feedback.length === 0) return;
    const activeInput = session.activeInput;
    const turnStartParams = session.activeTurnStartParams;
    const activeTurnId = session.activeTurnId ?? observedTurnId;
    if (!activeInput || !turnStartParams || !activeTurnId || session.activeAbort?.signal.aborted) {
      session.pendingSyntheticImageFeedback.push(...feedback);
      return;
    }

    session.promptLog?.info(
      {
        event: "desktop.codex_image_feedback_restart",
        backend: "codex",
        feedbackCount: feedback.length,
        priorTurnId: activeTurnId,
      },
      "Restarting active Codex turn with desktop image feedback",
    );

    try {
      session.interruptedTurnIds.add(activeTurnId);
      await this.transport.request(
        "turn/interrupt",
        { threadId: turnStartParams.threadId, turnId: activeTurnId },
        CONTROL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      session.interruptedTurnIds.delete(activeTurnId);
      session.pendingSyntheticImageFeedback.push(...feedback);
      session.promptLog?.warn(
        {
          event: "desktop.codex_image_feedback_restart_failed",
          backend: "codex",
          stage: "interrupt",
          error: stringifyError(error),
        },
        "Failed to interrupt Codex turn for desktop image feedback",
      );
      return;
    }

    const restartedInput = [...buildCodexSyntheticImageFeedbackInput(feedback), ...activeInput];
    const restartedParams: CodexTurnStartParams = { ...turnStartParams, input: restartedInput };
    session.activeInput = restartedInput;
    session.activeTurnStartParams = restartedParams;
    session.activeTurnId = null;
    session.turnItems.clear();
    session.observedApplyPatchCallIds.clear();

    try {
      const result = (await this.transport.request<{ turn: { id: string } }>(
        "turn/start",
        restartedParams,
        TURN_REQUEST_TIMEOUT_MS,
      )) as { turn: { id: string } };
      session.interruptedTurnIds.delete(result.turn.id);
      session.activeTurnId = result.turn.id;
      this.broadcast({ type: "session.status", properties: { sessionID: session.id, status: { type: "running" } } });
    } catch (error) {
      session.pendingSyntheticImageFeedback.unshift(...feedback);
      if (session.activeInput === restartedInput) {
        this.cleanupMaterializedImages(restartedInput);
        session.activeInput = null;
      }
      session.activeAbort = null;
      session.activeTurnId = null;
      session.activeTurnStartParams = null;
      session.promptLog?.warn(
        {
          event: "desktop.codex_image_feedback_restart_failed",
          backend: "codex",
          stage: "turn_start",
          error: stringifyError(error),
        },
        "Failed to restart Codex turn with desktop image feedback",
      );
      this.broadcast({
        type: "session.error",
        properties: {
          sessionID: session.id,
          error: { name: "CodexImageFeedbackRestartFailed", data: { message: stringifyError(error) } },
        },
      });
    }
  }

  private buildTextPrompt(body: PromptAsyncOptions["body"]): string {
    const sections: string[] = [];
    if (this.sessionStaticBehavioralGuidance.trim().length > 0) {
      sections.push(this.sessionStaticBehavioralGuidance);
    }
    if (body?.system) {
      sections.push(["# Per-Prompt System Context", body.system].join("\n\n"));
    }
    const textParts = body?.parts?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])) ?? [];
    sections.push(...textParts);
    return sections.filter((section) => section.trim().length > 0).join("\n\n");
  }

  private buildPromptInput(
    body: PromptAsyncOptions["body"],
    syntheticImageFeedback: readonly CodexSyntheticImageFeedback[] = [],
  ): Array<Record<string, unknown>> {
    const prompt = this.buildTextPrompt(body);
    const imagePaths = body?.parts?.flatMap((part) => this.materializeImagePart(part)) ?? [];
    const input: Array<Record<string, unknown>> = buildCodexSyntheticImageFeedbackInput(syntheticImageFeedback);
    if (prompt.length > 0) input.push({ type: "text", text: prompt, text_elements: [] });
    input.push(...imagePaths.map((path) => ({ type: "localImage", path })));
    return input;
  }

  private materializeImagePart(part: PromptPart): string[] {
    if (part.type !== "file" && part.type !== "image") return [];
    if (typeof part.url !== "string" || !part.url.startsWith("data:")) return [];

    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.url);
    if (!match) return [];

    const mime = typeof part.mime === "string" ? part.mime : match[1];
    mkdirSync(this.uploadImageDir, { recursive: true });
    const filename = typeof part.filename === "string" && part.filename.trim() ? part.filename.trim() : "upload";
    const sanitized = filename.replace(/[^A-Za-z0-9._-]/g, "_");
    const extension = this.imageExtensionForMime(mime);
    const basename = sanitized.toLowerCase().endsWith(`.${extension}`) ? sanitized : `${sanitized}.${extension}`;
    const path = join(this.uploadImageDir, `${randomUUID()}-${basename}`);
    writeFileSync(path, Buffer.from(match[2].replace(/\s/g, ""), "base64"));
    this.materializedImagePaths.add(path);
    return [path];
  }

  private cleanupMaterializedImages(input: Array<Record<string, unknown>>): void {
    for (const part of input) {
      if (part.type !== "localImage" || typeof part.path !== "string" || !this.materializedImagePaths.has(part.path)) {
        continue;
      }
      rmSync(part.path, { force: true });
      this.materializedImagePaths.delete(part.path);
    }
  }

  private materializeMcpToolResultImages(params: {
    id: string;
    server?: unknown;
    tool?: unknown;
    result?: unknown;
  }): string[] {
    if (!isScreenshotMcpTool(params.server, params.tool)) return [];
    const images = extractMcpResultImages(params.result);
    if (images.length === 0) return [];

    const server = sanitizeEvidenceSegment(params.server, "mcp");
    const tool = sanitizeEvidenceSegment(params.tool, "tool");
    const id = sanitizeEvidenceSegment(params.id, "result");
    const paths: string[] = [];

    for (const [index, image] of images.entries()) {
      if (!image.mime.startsWith("image/")) continue;
      const cleanedBase64 = image.data.replace(/\s/g, "");
      if (!/^[A-Za-z0-9+/=]+$/.test(cleanedBase64)) continue;
      const estimatedBytes = Math.ceil((cleanedBase64.length * 3) / 4);
      if (estimatedBytes <= 0 || estimatedBytes > MAX_MCP_TOOL_RESULT_IMAGE_BYTES) continue;

      try {
        mkdirSync(this.mcpToolResultImageDir, { recursive: true });
        const extension = this.imageExtensionForMime(image.mime);
        const path = join(this.mcpToolResultImageDir, `${server}-${tool}-${id}-${index + 1}.${extension}`);
        writeFileSync(path, Buffer.from(cleanedBase64, "base64"));
        paths.push(path);
      } catch {
        // Best-effort only.
      }
    }

    return paths;
  }

  private imageExtensionForMime(mime: string): string {
    switch (mime) {
      case "image/jpeg":
        return "jpg";
      case "image/gif":
        return "gif";
      case "image/webp":
        return "webp";
      case "image/png":
      default:
        return "png";
    }
  }

  private extractModel(raw: NonNullable<PromptAsyncOptions["body"]>["model"] | undefined): string | undefined {
    if (typeof raw === "string") return raw;
    if (!raw) return undefined;
    return raw.modelID;
  }

  private normalizeReasoningEffort(raw: string | undefined): string | undefined {
    if (!raw || raw === "none") return undefined;
    if (raw === "max") return "high";
    return raw;
  }

  private normalizeReasoningSummary(raw: string | undefined): string | undefined {
    if (raw !== "auto" && raw !== "concise" && raw !== "detailed") return undefined;
    return raw;
  }

  private handleProtocolNotification(method: string, params: Record<string, unknown>): void {
    const sessionId = asString(params.threadId) ?? asString(params.thread_id);
    const coverage = getCodexProtocolCoverage("notification", method);
    if (coverage?.bucket === "ignored") {
      return;
    }
    if (coverage?.bucket === "raw_fallback") {
      this.broadcastRawCodexNotification(sessionId, method, params);
      return;
    }
    if (!coverage) {
      this.warnUnknownProtocolType("notification", method, sessionId);
      this.broadcastRawCodexNotification(sessionId, method, params);
      return;
    }

    switch (method) {
      case "thread/started": {
        const thread = isRecord(params.thread) ? params.thread : null;
        const threadId = typeof thread?.id === "string" ? thread.id : null;
        if (!threadId) return;
        const session = this.sessions.get(threadId);
        if (session) {
          session.codexThreadId = threadId;
          session.loaded = true;
        }
        this.broadcast({
          type: "session.created",
          properties: { info: { id: threadId, codexThreadId: threadId } },
        });
        return;
      }
      case "turn/started": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        if (!threadId) return;
        const session = this.sessions.get(threadId);
        if (!session) return;
        const turn = isRecord(params.turn) ? params.turn : null;
        const turnId = typeof turn?.id === "string" ? turn.id : null;
        const alreadyBroadcastRunning = turnId !== null && session.activeTurnId === turnId;
        session.activeTurnId = turnId ?? session.activeTurnId;
        if (alreadyBroadcastRunning) return;
        this.broadcast({ type: "session.status", properties: { sessionID: session.id, status: { type: "running" } } });
        return;
      }
      case "thread/tokenUsage/updated": {
        this.emitUsage(params);
        return;
      }
      case "raw_response_item": {
        if (!this.handleRawResponseItem(params)) {
          this.broadcastRawCodexNotification(sessionId, method, params);
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        this.handleItemLifecycle(params);
        return;
      }
      case "item/agentMessage/delta": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!threadId || !itemId) return;
        const session = this.sessions.get(threadId);
        const state = session?.turnItems.get(itemId);
        if (!session || !state || state.type !== "text") return;
        state.text += delta;
        this.emitAssistantPart(session.id, state.messageID, { id: itemId, type: "text", text: state.text });
        return;
      }
      case "item/reasoning/textDelta": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        const contentIndex = typeof params.contentIndex === "number" ? params.contentIndex : 0;
        if (!threadId || !itemId) return;
        const session = this.sessions.get(threadId);
        const state = session?.turnItems.get(itemId);
        if (!session || !state || state.type !== "reasoning") return;
        state.content[contentIndex] = `${state.content[contentIndex] ?? ""}${delta}`;
        state.text = state.content.join("");
        this.emitAssistantPart(session.id, state.messageID, { id: itemId, type: "reasoning", text: state.text });
        return;
      }
      case "item/reasoning/summaryTextDelta": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        const summaryIndex = typeof params.summaryIndex === "number" ? params.summaryIndex : 0;
        if (!threadId || !itemId) return;
        const session = this.sessions.get(threadId);
        const state = session?.turnItems.get(itemId);
        if (!session || !state || state.type !== "reasoning") return;
        state.summary[summaryIndex] = `${state.summary[summaryIndex] ?? ""}${delta}`;
        // Backfill semantics: surface summary text only when a real reasoning content
        // stream has not produced anything (reasoning models like gpt-5/o-series emit
        // summaries only). Re-emit on every delta so the UI accumulates the full text
        // instead of only the first chunk.
        if (state.content.length === 0) {
          state.text = state.summary.join("");
          this.emitAssistantPart(session.id, state.messageID, { id: itemId, type: "reasoning", text: state.text });
        }
        return;
      }
      case "item/commandExecution/outputDelta": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!threadId || !itemId) return;
        const session = this.sessions.get(threadId);
        const state = session?.turnItems.get(itemId);
        if (!session || !state || state.type !== "tool") return;
        state.output = `${state.output ?? ""}${delta}`;
        this.emitToolPart(session.id, state.messageID, {
          id: itemId,
          tool: state.tool,
          input: state.input,
          status: state.status,
          output: state.output,
        });
        return;
      }
      case "item/fileChange/patchUpdated": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const changes = Array.isArray(params.changes) ? params.changes : [];
        if (!threadId || !itemId) return;
        const session = this.sessions.get(threadId);
        if (!session) return;
        const files = changes
          .map((change) => (isRecord(change) && typeof change.path === "string" ? change.path : null))
          .filter((path): path is string => path !== null);
        session.turnItems.set(`patch:${itemId}`, {
          type: "patch",
          messageID: session.currentMessageId,
          files,
        });
        this.broadcast({
          type: "message.part.updated",
          properties: {
            part: {
              id: itemId,
              messageID: session.currentMessageId,
              sessionID: session.id,
              type: "patch",
              files,
            },
          },
        });
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const name = typeof params.name === "string" ? params.name : null;
        if (!name) return;
        const status = typeof params.status === "string" ? params.status : "failed";
        const error = typeof params.error === "string" ? params.error : undefined;
        this.mcpServers.set(name, { status: status === "ready" ? "connected" : status, ...(error ? { error } : {}) });
        return;
      }
      case "hook/started":
      case "hook/completed": {
        const threadId =
          typeof params.threadId === "string"
            ? params.threadId
            : typeof params.thread_id === "string"
              ? params.thread_id
              : null;
        const session = threadId ? this.sessions.get(threadId) : [...this.sessions.values()].at(-1);
        if (!session) return;
        this.broadcast({
          type: method === "hook/started" ? "hook.started" : "hook.completed",
          properties: {
            ...params,
            sessionID: session.id,
          },
        });
        return;
      }
      case "turn/completed": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        if (!threadId) return;
        const session = this.sessions.get(threadId);
        if (!session) return;
        const turn = isRecord(params.turn) ? params.turn : null;
        const turnId = typeof turn?.id === "string" ? turn.id : null;
        if (turnId && session.interruptedTurnIds.delete(turnId)) {
          return;
        }
        session.activeAbort = null;
        session.activeTurnId = null;
        session.activeTurnStartParams = null;
        if (session.activeInput) {
          this.cleanupMaterializedImages(session.activeInput);
          session.activeInput = null;
        }
        const turnStatus = typeof turn?.status === "string" ? turn.status : "completed";
        if (turnStatus === "failed") {
          const error = isRecord(turn?.error) ? turn.error : null;
          const message =
            typeof error?.message === "string" ? error.message : "Codex app-server turn failed unexpectedly";
          const resolvedError = resolveSessionError({
            message,
            codexErrorInfo: error?.codexErrorInfo,
            additionalDetails: error?.additionalDetails,
          });
          this.broadcast({
            type: "session.error",
            properties: {
              sessionID: session.id,
              ...(resolvedError.errorCode ? { errorCode: resolvedError.errorCode } : {}),
              ...(resolvedError.codexErrorInfo ? { codexErrorInfo: resolvedError.codexErrorInfo } : {}),
              ...(resolvedError.additionalDetails ? { additionalDetails: resolvedError.additionalDetails } : {}),
              error: {
                name: "CodexTurnFailed",
                data: { message },
              },
            },
          });
        } else {
          this.broadcast({ type: "session.idle", properties: { sessionID: session.id } });
        }
        return;
      }
      case "error": {
        if (isCodexReconnectProgressNotification(params)) return;
        const nestedError = isRecord(params.error) ? params.error : null;
        const message =
          typeof nestedError?.message === "string"
            ? nestedError.message
            : typeof params.message === "string"
              ? params.message
              : "Codex app-server error";
        const resolvedError = resolveSessionError({
          message,
          codexErrorInfo: nestedError?.codexErrorInfo ?? params.codexErrorInfo,
          additionalDetails: nestedError?.additionalDetails ?? params.additionalDetails,
        });
        for (const session of this.sessions.values()) {
          this.broadcast({
            type: "session.error",
            properties: {
              sessionID: session.id,
              ...(resolvedError.errorCode ? { errorCode: resolvedError.errorCode } : {}),
              ...(resolvedError.codexErrorInfo ? { codexErrorInfo: resolvedError.codexErrorInfo } : {}),
              ...(resolvedError.additionalDetails ? { additionalDetails: resolvedError.additionalDetails } : {}),
              error: { name: "CodexStreamError", data: { message } },
            },
          });
        }
        return;
      }
      default:
        this.warnUnknownProtocolType("notification", method, sessionId);
        this.broadcastRawCodexNotification(sessionId, method, params);
        return;
    }
  }

  private handleItemLifecycle(params: Record<string, unknown>): void {
    const item = isRecord(params.item) ? params.item : null;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!item || !threadId) return;
    const session = this.sessions.get(threadId);
    if (!session) return;
    const itemId = typeof item.id === "string" ? item.id : null;
    const itemType = typeof item.type === "string" ? item.type : null;
    if (!itemId || !itemType) return;

    const coverage = getCodexProtocolCoverage("itemType", itemType);
    if (coverage?.bucket === "ignored") {
      return;
    }
    if (coverage?.bucket === "raw_fallback") {
      this.broadcastRawCodexItem(session.id, itemType, item);
      return;
    }
    if (!coverage) {
      this.warnUnknownProtocolType("itemType", itemType, session.id);
      this.broadcastRawCodexItem(session.id, itemType, item);
      return;
    }

    switch (itemType) {
      case "userMessage":
        this.broadcast({
          type: "message.updated",
          properties: { info: { id: itemId, sessionID: session.id, role: "user" } },
        });
        return;
      case "agentMessage": {
        const state =
          session.turnItems.get(itemId) ??
          ({
            type: "text",
            messageID: session.currentMessageId,
            text: typeof item.text === "string" ? item.text : "",
            role: "assistant",
          } satisfies RuntimeTurnItemState);
        session.turnItems.set(itemId, state);
        if (state.type === "text" && state.text) {
          this.emitAssistantPart(session.id, state.messageID, { id: itemId, type: "text", text: state.text });
        } else {
          this.broadcast({
            type: "message.updated",
            properties: { info: { id: session.currentMessageId, sessionID: session.id, role: "assistant" } },
          });
        }
        return;
      }
      case "reasoning": {
        const content = Array.isArray(item.content) ? item.content.filter((part) => typeof part === "string") : [];
        const summary = Array.isArray(item.summary) ? item.summary.filter((part) => typeof part === "string") : [];
        const state =
          session.turnItems.get(itemId) ??
          ({
            type: "reasoning",
            messageID: session.currentMessageId,
            text: content.join("") || summary.join(""),
            role: "assistant",
            content,
            summary,
          } satisfies RuntimeTurnItemState);
        session.turnItems.set(itemId, state);
        if (state.type === "reasoning" && state.text) {
          this.emitAssistantPart(session.id, state.messageID, { id: itemId, type: "reasoning", text: state.text });
        }
        return;
      }
      case "commandExecution": {
        const command = typeof item.command === "string" ? item.command : "";
        const previousState = session.turnItems.get(itemId);
        const aggregatedOutput =
          typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : previousState?.type === "tool"
              ? previousState.output
              : undefined;
        const protocolStatus = typeof item.status === "string" ? item.status : "inProgress";
        this.recordToolOutputBudgetTelemetry(session, "command", "bash", protocolStatus, aggregatedOutput);
        const state = {
          type: "tool",
          messageID: session.currentMessageId,
          tool: "bash",
          input: { command },
          status: this.mapToolStatus(protocolStatus),
          ...(aggregatedOutput ? { output: aggregatedOutput } : {}),
          ...(protocolStatus === "failed" ? { error: aggregatedOutput } : {}),
        } satisfies RuntimeTurnItemState;
        session.turnItems.set(itemId, state);
        this.emitToolPart(session.id, state.messageID, {
          id: itemId,
          tool: state.tool,
          input: state.input,
          status: state.status,
          output: state.output,
          error: state.error,
        });
        return;
      }
      case "fileChange": {
        const files = Array.isArray(item.changes)
          ? item.changes
              .map((change) => (isRecord(change) && typeof change.path === "string" ? change.path : null))
              .filter((path): path is string => path !== null)
          : [];
        const applyPatchCallId = getCallId(item) ?? itemId;
        session.turnItems.set(`patch:${itemId}`, {
          type: "patch",
          messageID: session.currentMessageId,
          files,
        });
        this.broadcast({
          type: "message.part.updated",
          properties: {
            part: {
              id: itemId,
              messageID: session.currentMessageId,
              sessionID: session.id,
              type: "patch",
              files,
            },
          },
        });
        if (!session.observedApplyPatchCallIds.has(applyPatchCallId)) {
          session.observedApplyPatchCallIds.add(applyPatchCallId);
          this.emitToolPart(session.id, session.currentMessageId, {
            id: `apply-${applyPatchCallId}`,
            callID: applyPatchCallId,
            tool: "apply_patch",
            input: { path: files.join(", ") },
            status: this.mapToolStatus(typeof item.status === "string" ? item.status : "inProgress"),
            output: files.join("\n"),
          });
        }
        return;
      }
      case "mcpToolCall": {
        this.materializeMcpToolResultImages({
          id: itemId,
          server: item.server,
          tool: item.tool,
          result: item.result,
        });
        const toolName = `${typeof item.server === "string" ? item.server : "mcp"}.${typeof item.tool === "string" ? item.tool : "tool"}`;
        const argumentsRecord = isRecord(item.arguments) ? item.arguments : {};
        const status = this.mapToolStatus(typeof item.status === "string" ? item.status : "inProgress");
        const resultText = item.result ? JSON.stringify(item.result) : undefined;
        const errorText =
          isRecord(item.error) && typeof item.error.message === "string" ? item.error.message : undefined;
        this.recordToolOutputBudgetTelemetry(
          session,
          "mcp",
          toolName,
          typeof item.status === "string" ? item.status : "inProgress",
          resultText ?? errorText,
        );
        const state = {
          type: "tool",
          messageID: session.currentMessageId,
          tool: toolName,
          input: argumentsRecord,
          status,
          ...(resultText ? { output: resultText } : {}),
          ...(errorText ? { error: errorText } : {}),
        } satisfies RuntimeTurnItemState;
        session.turnItems.set(itemId, state);
        this.emitToolPart(session.id, state.messageID, {
          id: itemId,
          tool: state.tool,
          input: state.input,
          status: state.status,
          output: state.output,
          error: state.error,
        });
        return;
      }
      case "dynamicToolCall": {
        const namespace = typeof item.namespace === "string" ? item.namespace : null;
        const tool = typeof item.tool === "string" ? item.tool : "tool";
        const toolName = namespace ? `${namespace}.${tool}` : tool;
        const rawArgumentsRecord = isRecord(item.arguments) ? item.arguments : {};
        const redactedArguments = namespace
          ? redactFirstPartyDynamicToolInputForPersistence(namespace, tool, rawArgumentsRecord)
          : undefined;
        const argumentsRecord = redactedArguments === undefined ? rawArgumentsRecord : (redactedArguments ?? {});
        const status = this.mapToolStatus(typeof item.status === "string" ? item.status : "inProgress");
        const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
        const output =
          contentItems.length > 0
            ? serializeFirstPartyDynamicToolContentItemsForPersistence(contentItems, item.success === true)
            : typeof item.success === "boolean"
              ? JSON.stringify({ success: item.success })
              : undefined;
        this.recordToolOutputBudgetTelemetry(
          session,
          "dynamic",
          toolName,
          typeof item.status === "string" ? item.status : "inProgress",
          output,
        );
        const state = {
          type: "tool",
          messageID: session.currentMessageId,
          tool: toolName,
          input: argumentsRecord,
          status,
          ...(output ? { output } : {}),
        } satisfies RuntimeTurnItemState;
        session.turnItems.set(itemId, state);
        this.emitToolPart(session.id, state.messageID, {
          id: itemId,
          tool: state.tool,
          input: state.input,
          status: state.status,
          output: state.output,
        });
        return;
      }
      case "customToolCall":
      case "custom_tool_call": {
        if (asString(item.name) !== "apply_patch") {
          this.broadcastRawCodexItem(session.id, itemType, item);
          return;
        }
        const callId = getCallId(item);
        if (!callId) {
          this.broadcastRawCodexItem(session.id, itemType, item);
          return;
        }
        this.emitCustomApplyPatchToolPart({
          session,
          itemId,
          callId,
          input: normalizeApplyPatchInput(item.input),
          status: this.mapToolStatus(asString(item.status) ?? "inProgress"),
        });
        return;
      }
      case "customToolCallOutput":
      case "custom_tool_call_output": {
        const callId = getCallId(item);
        if (!callId) {
          this.broadcastRawCodexItem(session.id, itemType, item);
          return;
        }
        const priorState = session.turnItems.get(`customToolCall:${callId}`);
        if (!this.isApplyPatchToolCall(item, priorState)) {
          this.broadcastRawCodexItem(session.id, itemType, item);
          return;
        }
        const status = this.mapToolStatus(asString(item.status) ?? (item.error ? "failed" : "completed"));
        this.emitCustomApplyPatchToolPart({
          session,
          itemId,
          callId,
          input: priorState?.type === "tool" ? priorState.input : {},
          status,
          output: status === "completed" ? stringifyToolPayload(item.output) : undefined,
          error: status === "error" ? this.getApplyPatchErrorText(item) : undefined,
        });
        return;
      }
      default:
        this.warnUnknownProtocolType("itemType", itemType, session.id);
        this.broadcastRawCodexItem(session.id, itemType, item);
        return;
    }
  }

  private mapToolStatus(status: string): string {
    switch (status) {
      case "completed":
        return "completed";
      case "failed":
      case "declined":
        return "error";
      case "inProgress":
      default:
        return "running";
    }
  }

  private emitUsage(params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    const last = tokenUsage && isRecord(tokenUsage.last) ? tokenUsage.last : null;
    if (!threadId || !last) return;
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.broadcast({
      type: "message.updated",
      properties: {
        info: {
          id: `usage-${Date.now()}`,
          sessionID: session.id,
          role: "assistant",
          model: session.currentModel,
          modelID: session.currentModel ? extractModelId(session.currentModel) : undefined,
          tokens: {
            input: typeof last.inputTokens === "number" ? last.inputTokens : 0,
            output: typeof last.outputTokens === "number" ? last.outputTokens : 0,
            cache: { read: typeof last.cachedInputTokens === "number" ? last.cachedInputTokens : 0, write: 0 },
          },
        },
      },
    });
  }

  private async handleServerRequest(request: {
    id: string | number;
    method: string;
    params: Record<string, unknown>;
  }): Promise<unknown> {
    const sessionId = asString(request.params.threadId) ?? asString(request.params.thread_id);
    const coverage = getCodexProtocolCoverage("serverRequest", request.method);
    if (!coverage) {
      this.warnUnknownProtocolType("serverRequest", request.method, sessionId);
      return {};
    }
    if (coverage.bucket === "ignored") {
      return {};
    }
    if (coverage.bucket === "raw_fallback") {
      this.broadcast({
        type: "raw_agent_runtime",
        properties: {
          ...(sessionId ? { sessionID: sessionId } : {}),
          requestMethod: request.method,
          requestParams: request.params,
        },
      });
      return {};
    }

    switch (request.method) {
      case "item/tool/requestUserInput": {
        const sessionID = typeof request.params.threadId === "string" ? request.params.threadId : null;
        const questions = Array.isArray(request.params.questions)
          ? request.params.questions
              .map((question) =>
                isRecord(question)
                  ? {
                      id: typeof question.id === "string" ? question.id : randomUUID(),
                      question: typeof question.question === "string" ? question.question : "",
                      header: typeof question.header === "string" ? question.header : "Question",
                      options: Array.isArray(question.options)
                        ? question.options
                            .map((option) =>
                              isRecord(option) &&
                              typeof option.label === "string" &&
                              typeof option.description === "string"
                                ? { label: option.label, description: option.description }
                                : null,
                            )
                            .filter((option): option is { label: string; description: string } => option !== null)
                        : [],
                    }
                  : null,
              )
              .filter(
                (
                  question,
                ): question is {
                  id: string;
                  question: string;
                  header: string;
                  options: Array<{ label: string; description: string }>;
                } => question !== null,
              )
          : [];
        if (!sessionID) return { answers: {} };
        if (questions.length === 0) {
          // No concrete questions survived parsing (empty/malformed input). Broadcasting
          // a blank question.asked would register a pending response that never resolves,
          // stalling the prompt on a human answer to a question that describes nothing.
          // Answer empty immediately instead.
          return { answers: {} };
        }
        this.broadcast({
          type: "question.asked",
          properties: {
            id: String(request.id),
            sessionID,
            questions: questions.map(({ question, header, options }) => ({ question, header, options })),
          },
        });
        return await new Promise<unknown>((resolve) => {
          this.pendingQuestionResponses.set(String(request.id), {
            sessionID,
            questionIds: questions.map((question) => question.id),
            resolve,
          });
        });
      }
      case "item/commandExecution/requestApproval":
        return { decision: "decline" };
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn", strictAutoReview: false };
      case "mcpServer/elicitation/request":
        return { action: "cancel", content: null, _meta: null };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: "denied" };
      case "item/tool/call": {
        const threadId = typeof request.params.threadId === "string" ? request.params.threadId : null;
        const namespace = typeof request.params.namespace === "string" ? request.params.namespace : "";
        const tool = typeof request.params.tool === "string" ? request.params.tool : "";
        const session = threadId ? this.sessions.get(threadId) : undefined;
        const sessionSignal = session?.activeAbort?.signal;
        const dynamicToolResult = await executeFirstPartyDynamicToolCall(namespace, tool, request.params.arguments, {
          env: process.env,
          agentRole: session?.currentAgentRole ?? this.agentRole,
          cwd: this.cwd,
          ...(session?.currentAgentProfile ? { agentProfile: session.currentAgentProfile } : {}),
          ...(session?.promptLog ? { promptLog: session.promptLog } : {}),
          ...(sessionSignal && !sessionSignal.aborted ? { signal: sessionSignal } : {}),
          ...(this.getRepoMemories ? { repoMemories: this.getRepoMemories() } : {}),
          ...(this.getMemoryRefById ? { memoryRefById: this.getMemoryRefById() } : {}),
          recordTelemetry: (eventName, fields) => {
            try {
              if (!session) return;
              this.broadcast({
                type: "memory.recall.telemetry",
                properties: {
                  sessionID: session.id,
                  messageId: session.currentMessageId,
                  eventName,
                  ...fields,
                  codexRequestId: String(request.id),
                  codexThreadId: threadId,
                  codexTurnId: typeof request.params.turnId === "string" ? request.params.turnId : undefined,
                  codexItemId: typeof request.params.itemId === "string" ? request.params.itemId : undefined,
                  codexNamespace: namespace,
                  codexTool: tool,
                },
              });
            } catch {
              // Telemetry must never fail a dynamic tool call.
            }
          },
        });
        const imageFeedback = adaptCodexDynamicToolResultForImageFeedback({
          result: dynamicToolResult,
          capability: defaultCodexImageFeedbackCapability(),
        });
        if (session && imageFeedback.syntheticImageFeedback.length > 0) {
          const turnId = typeof request.params.turnId === "string" ? request.params.turnId : null;
          await this.restartActiveTurnWithSyntheticImageFeedback(session, imageFeedback.syntheticImageFeedback, turnId);
        }
        if (session && imageFeedback.unsupportedReason) {
          session.promptLog?.warn(
            {
              event: "desktop.model_image_feedback_unsupported",
              backend: "codex",
              modelId: session.currentModel ? extractModelId(session.currentModel) : null,
              reason: imageFeedback.unsupportedReason,
              registrationBlocked: false,
            },
            "Codex desktop image feedback is unavailable",
          );
        }
        return imageFeedback.result;
      }
      default:
        return {};
    }
  }

  private resolvePendingQuestionsForSession(sessionID?: string): void {
    for (const [requestId, pending] of this.pendingQuestionResponses) {
      if (sessionID && pending.sessionID !== sessionID) continue;
      pending.resolve({ answers: {} });
      this.pendingQuestionResponses.delete(requestId);
    }
  }

  private handleTransportClosed(error: BridgeLocalTransportError): void {
    const message = error.message || "Codex app-server transport closed";
    const resolvedError = resolveSessionError({
      message,
      bridgeLocalErrorCode: error.errorCode,
      wasIntentionalClose: error.wasIntentionalClose,
    });
    for (const session of this.sessions.values()) {
      session.activeAbort = null;
      session.activeTurnId = null;
      session.activeTurnStartParams = null;
      if (session.activeInput) {
        this.cleanupMaterializedImages(session.activeInput);
        session.activeInput = null;
      }
      if (resolvedError.errorCode) {
        this.broadcast({
          type: "session.error",
          properties: {
            sessionID: session.id,
            errorCode: resolvedError.errorCode,
            ...(resolvedError.codexErrorInfo ? { codexErrorInfo: resolvedError.codexErrorInfo } : {}),
            ...(resolvedError.additionalDetails ? { additionalDetails: resolvedError.additionalDetails } : {}),
            error: { name: "CodexTransportClosed", data: { message } },
          },
        });
      }
      this.resolvePendingQuestionsForSession(session.id);
    }
    for (const stream of this.streams) stream.close();
    this.streams.clear();
  }

  private emitAssistantPart(
    sessionID: string,
    messageID: string,
    part: { id: string; type: "text" | "reasoning"; text: string },
  ): void {
    this.broadcast({
      type: "message.updated",
      properties: { info: { id: messageID, sessionID, role: "assistant" } },
    });
    this.broadcast({
      type: "message.part.updated",
      properties: {
        part: {
          ...part,
          messageID,
          sessionID,
        },
      },
    });
  }

  private emitToolPart(
    sessionID: string,
    messageID: string,
    part: {
      id: string;
      callID?: string;
      tool: string;
      input: Record<string, unknown>;
      status: string;
      output?: string;
      error?: string;
    },
  ): void {
    this.broadcast({
      type: "message.part.updated",
      properties: {
        part: {
          id: part.id,
          callID: part.callID ?? part.id,
          messageID,
          sessionID,
          type: "tool",
          tool: part.tool,
          state: {
            input: part.input,
            status: part.status,
            ...(part.output !== undefined ? { output: part.output } : {}),
            ...(part.error !== undefined ? { error: part.error } : {}),
          },
        },
      },
    });
  }

  /**
   * Codex deliberately keeps app-server output complete while applying
   * `tool_output_token_limit` only to the context-manager copy sent to the
   * model. Record both sides without logging command output or arguments.
   * Codex does not expose its tokenizer's exact post-truncation byte count, so
   * delivered sizes are explicitly estimates using the bridge's standard
   * four-characters-per-token estimator; the configured token cap is exact.
   */
  private recordToolOutputBudgetTelemetry(
    session: SessionRecord,
    toolType: "command" | "mcp" | "dynamic",
    tool: string,
    protocolStatus: string,
    output: string | undefined,
  ): void {
    if (!output || (protocolStatus !== "completed" && protocolStatus !== "failed")) return;
    const originalEstimatedTokens = estimateTokens(output);
    const estimatedDeliveredTokens = Math.min(originalEstimatedTokens, this.toolOutputTokenLimit);
    const truncated = originalEstimatedTokens > this.toolOutputTokenLimit;
    session.promptLog?.info(
      {
        event: "codex.tool_output_context_budget",
        provider: "codex",
        toolType,
        tool,
        originalChars: output.length,
        originalBytes: Buffer.byteLength(output, "utf8"),
        originalLines: output.split("\n").length,
        originalEstimatedTokens,
        deliveredEstimatedChars: Math.min(output.length, this.toolOutputTokenLimit * 4),
        deliveredEstimatedTokens: estimatedDeliveredTokens,
        configuredTokenLimit: this.toolOutputTokenLimit,
        truncated,
        truncationReason: truncated ? "provider_context_token_limit" : "within_limit",
        fullOutputStreamPreserved: true,
      },
      "Codex provider-native tool output context budget evaluated",
    );
  }

  private broadcast(event: QueuedEvent): void {
    for (const stream of this.streams) stream.push(event);
  }
}

/** Bridge-facing factory for the stdio-backed Codex app-server client. */
export async function createCodexWithStdio(options: CreateCodexWithStdioOptions): Promise<CreateCodexWithStdioResult> {
  if (options.signal?.aborted) throw new Error("Aborted");
  const codexHome = resolveCodexHome(process.env);
  const authDecision = prepareCodexAuth(process.env, codexHome, options.log);
  // Build the runtime config and dynamic-tool registry from the UNSANITIZED
  // bridge env: header value-matching and integration-tool availability both
  // depend on the integration tokens that the sanitized child env strips.
  const runtimeConfig = buildCodexRuntimeConfig(options.config, process.env);
  if (options.useOpenAIFlexServiceTier === true) {
    runtimeConfig.service_tier = OpenAIServiceTier.Flex;
  }
  const preserveNames = extractMcpReferencedEnvNames(runtimeConfig);
  const managedMcpEnvNames = asManagedMcpEnvNames(options.config);
  const { env, diagnostics } = buildCodexEnv(process.env, authDecision.apiKey, codexHome, {
    preserveNames,
    trustedPreserveNames: managedMcpEnvNames,
    useStoredAuth: authDecision.usesStoredAuth,
  });
  if (diagnostics.deniedPreserveNames.length > 0) {
    options.log?.warn(
      { event: "mcp_env_ref_denied", names: diagnostics.deniedPreserveNames },
      "MCP config references env vars not on the trusted integration-credential allowlist; withheld from the agent child env",
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const wroteManagedSessionStaticGuidance = writeRuntimeConfig(
    env,
    runtimeConfig,
    options.agentRole,
    options.adoptedExternalPr === true,
    cwd,
    process.env,
  );
  const codexPath = resolveCodexPathOverride(env) ?? "codex";
  const transport = new CodexAppServerTransport({
    cwd,
    env,
    codexPath,
    spawn: options.spawn,
    signal: options.signal,
    onStdioLine: options.onStdioLine,
    onStdioCap: options.onStdioCap,
    stdioLineMaxBytes: options.stdioLineMaxBytes,
    stdioSessionMaxBytes: options.stdioSessionMaxBytes,
  });
  const startupTimeoutMs = options.timeout ?? CONTROL_REQUEST_TIMEOUT_MS;
  await transport.initialize(startupTimeoutMs);
  if (authDecision.apiKey) {
    try {
      await transport.request("account/login/start", { type: "apiKey", apiKey: authDecision.apiKey }, startupTimeoutMs);
    } catch (err) {
      const error = createCodexAuthConfigError(
        "codex_app_server_auth_failed",
        `Codex app-server auth failed: ${stringifyError(err)}`,
      );
      throw error;
    }
  }
  const mcpList = (await transport.request<{ data?: Array<{ name?: string }> }>(
    "mcpServerStatus/list",
    { detail: "full" },
    startupTimeoutMs,
  )) as { data?: Array<{ name?: string }> };
  const mcpStatus = Object.fromEntries(
    (mcpList.data ?? [])
      .filter((server): server is { name: string } => typeof server.name === "string" && server.name.length > 0)
      .map((server) => [server.name, { status: "connected" }]),
  );
  const configModel = typeof options.config?.model === "string" ? options.config.model.split(/[/:]/).pop() : undefined;
  // Tool registry from the unsanitized bridge env (B3): integration tokens that
  // gate tool availability are stripped from the sanitized child `env`.
  const dynamicToolEnv = { ...process.env, ARCANIST_AGENT_ROLE: options.agentRole };
  const dynamicTools = filterCodexDesktopDynamicToolSpecsForImageFeedback({
    specs: buildAllDynamicToolSpecs(dynamicToolEnv, { agentRole: options.agentRole }),
    capability: defaultCodexImageFeedbackCapability(),
    modelId: configModel ?? null,
    emitUnsupported: (fields) => {
      options.log?.warn(fields, "Codex desktop image feedback is unavailable");
    },
  });
  const sessionStaticBehavioralGuidance = wroteManagedSessionStaticGuidance
    ? ""
    : buildSessionStaticBehavioralGuidance({
        agentRole: options.agentRole,
        adoptedExternalPr: options.adoptedExternalPr === true,
        dynamicToolNames: new Set(dynamicTools.map((tool) => `${tool.namespace}.${tool.name}`)),
      });
  const client = new CodexBridgeClient({
    transport,
    cwd: options.cwd ?? process.cwd(),
    model: configModel,
    toolOutputTokenLimit: runtimeConfig.tool_output_token_limit,
    agentRole: options.agentRole,
    mcpStatus,
    dynamicTools,
    getRepoMemories: options.getRepoMemories,
    getMemoryRefById: options.getMemoryRefById,
    sessionStaticBehavioralGuidance,
  });
  return {
    server: {
      url: "codex://app-server",
      close: () => client.close(),
      ...(transport.pid ? { pid: transport.pid } : {}),
    },
    client,
    mcpStatus,
  };
}
