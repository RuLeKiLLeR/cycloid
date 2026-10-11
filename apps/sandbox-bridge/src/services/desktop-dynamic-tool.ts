import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentRole } from "../../../../shared/agent/schema.js";
import {
  DESKTOP_ACTION_PATH_ACTIONS,
  type DesktopActionPathAction,
  type DesktopActionPathPhase,
  type DesktopActionPathStatus,
  type DesktopActionScreenshotRef,
  type RegisterDesktopActionPathRowRequest,
} from "../../../../shared/types/desktop-action-path.js";
import { createTimeoutAwareSignal } from "../utils/abort-signal.js";
import { asRecord } from "../utils/dynamic-tool-helpers.js";
import { normalizeControlPlaneUrl } from "./dynamic-tool-http.js";
import { desktopScenarioImageRoot, validateDynamicToolImageContentItem } from "./dynamic-tool-image-results.js";
import { DYNAMIC_TOOL_ERROR_CODES, type DynamicToolErrorCode } from "./dynamic-tool-results.js";
import type {
  FirstPartyDynamicToolCallResult,
  FirstPartyDynamicToolContentItem,
  FirstPartyDynamicToolImageContentItem,
  FirstPartyDynamicToolSpec,
  FirstPartyDynamicToolTextContentItem,
} from "./first-party-dynamic-tools.js";

const execFileAsync = promisify(execFile);

export const DESKTOP_DYNAMIC_TOOL_NAMESPACE = "desktop";

export const DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME = "observe";
export const DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME = "screenshot";
export const DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME = "windows";
export const DESKTOP_CLICK_DYNAMIC_TOOL_NAME = "click";
export const DESKTOP_TYPE_DYNAMIC_TOOL_NAME = "type";
export const DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME = "hotkey";
export const DESKTOP_SCROLL_DYNAMIC_TOOL_NAME = "scroll";
export const DESKTOP_DRAG_DYNAMIC_TOOL_NAME = "drag";
export const DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME = "open_app";
export const DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME = "focus_window";
export const DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME = "record_start";
export const DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME = "record_stop";
export const DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME = "record_status";

const DEFAULT_DESKTOP_CLI_PATH = "/app/scripts/cycloid-desktop";
const MODEL_IMAGE_FEEDBACK_FAILED_CODE = "model_image_feedback_failed";
const DESKTOP_ACTION_PATH_REGISTER_TIMEOUT_MS = 10_000;
const DESKTOP_ACTION_SCREENSHOT_UPLOAD_TIMEOUT_MS = 10_000;
const DESKTOP_ACTION_SCREENSHOT_KIND = "desktop_action_screenshot";
const DESKTOP_ACTION_PATH_ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DESKTOP_ACTION_SCREENSHOT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_DESKTOP_ACTION_OUTBOX_DIR = "/tmp/cycloid-desktop-action-outbox";
const DESKTOP_ACTION_OUTBOX_VERSION = 1;
const DESKTOP_ACTION_PERSISTENCE_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;
const DESKTOP_ACTION_PATH_ACTION_SET = new Set<string>(DESKTOP_ACTION_PATH_ACTIONS);
const DEFAULT_DESKTOP_READY_WAIT_SECONDS = 8;
const DESKTOP_CLI_TIMEOUT_MARGIN_MS = 1_000;
export const DESKTOP_PROTOCOL_VERSION = "2";
const DESKTOP_COMPONENT_SHA256_RE = /^(?:[a-f0-9]{64}|unknown)$/;
const SAFE_DESKTOP_BUSY_RETRY_TOOLS = new Set([
  DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
  DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME,
  DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
  DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
  DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME,
  DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME,
]);
// The first desktop call races lazy supervisor/browser startup. Retry only
// failures that are plausibly transient; never replay a timed-out mutation.
const SAFE_TRANSIENT_RETRY_CODES = new Set(["desktop_busy", "focus_not_proven"]);

export const DESKTOP_TOOL_TIMEOUT_MS: Readonly<Record<string, number>> = {
  [DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME]: 5_000,
  [DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME]: 5_000,
  [DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME]: 5_000,
  [DESKTOP_CLICK_DYNAMIC_TOOL_NAME]: 8_000,
  [DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME]: 8_000,
  [DESKTOP_SCROLL_DYNAMIC_TOOL_NAME]: 8_000,
  [DESKTOP_DRAG_DYNAMIC_TOOL_NAME]: 8_000,
  [DESKTOP_TYPE_DYNAMIC_TOOL_NAME]: 15_000,
  [DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME]: 30_000,
  [DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME]: 8_000,
  [DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME]: 15_000,
  [DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME]: 45_000,
  [DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME]: 15_000,
};

const DESKTOP_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  [DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME]:
    "Observe the current sandbox desktop and return display/window metadata plus a model-visible screenshot.",
  [DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME]:
    "Capture a proof-candidate screenshot of the current sandbox desktop and return it as model-visible image feedback.",
  [DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME]: "List visible desktop windows and active-window metadata.",
  [DESKTOP_CLICK_DYNAMIC_TOOL_NAME]:
    "Click a display coordinate on the sandbox desktop and return post-action screenshot feedback.",
  [DESKTOP_TYPE_DYNAMIC_TOOL_NAME]:
    "Type text into the focused desktop window. The text is redacted from persisted inputs and results.",
  [DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME]:
    "Send a keyboard shortcut to the sandbox desktop and return post-action screenshot feedback.",
  [DESKTOP_SCROLL_DYNAMIC_TOOL_NAME]:
    "Scroll at a display coordinate on the sandbox desktop and return post-action screenshot feedback.",
  [DESKTOP_DRAG_DYNAMIC_TOOL_NAME]:
    "Drag between display coordinates on the sandbox desktop and return post-action screenshot feedback.",
  [DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME]:
    "Open an HTTP(S) URL in the sandbox Chromium browser (preferred) or launch an explicit app command, then return post-action screenshot feedback.",
  [DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME]:
    "Focus a desktop window by X11 window id or title and return post-action screenshot feedback.",
  [DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME]:
    "Start a short VP8 WebM desktop walkthrough recording after confirming no secrets will be captured.",
  [DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME]:
    "Stop the active desktop walkthrough recording and flush its private manifest.",
  [DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME]: "Read the current desktop recording state and private manifest paths.",
};

type DesktopToolResultWarning = { code: string; message: string };
type DesktopToolResultError = {
  code: string;
  message: string;
  retryable: boolean;
  safeToRetry?: boolean;
  recommendedNextTool?: string | null;
  expectedWindowId?: string | null;
  actualWindowId?: string | null;
};
type DesktopProtocolIdentity = {
  version: string;
  cliSha256: string;
  supervisorSha256: string;
  bridgeBundleSha256: string;
};
type DesktopRuntimeIdentity = {
  browserStatus: "ready" | "missing";
  browserSource: "configured" | "path";
  browserConfiguredPath: string | null;
  browserResolvedPath: string | null;
  browserSymlink: boolean;
  browserPlatformProtected: boolean;
  supervisorGeneration: string | null;
};
type DesktopScreenshot = {
  path: string;
  evidencePath?: string;
  width: number;
  height: number;
  bytes: number;
  encodedBytes: number;
  extension: ".webp" | ".png" | ".jpg" | ".jpeg";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  encodingMode: "lossless" | "q88" | "q80" | "legacy";
  encoder: "scrot-imlib2" | "ffmpeg-libwebp" | null;
  fallbackUsed: boolean;
  purpose: "action_feedback" | "observe" | "proof_candidate";
  captureMode?: "full_display";
  displayName?: string;
};
type DesktopRecentScreenshot = {
  actionId: string;
  path: string;
  capturedAtMs: number;
  purpose: "action_feedback" | "observe" | "proof_candidate";
};
const DESKTOP_READINESS_OUTCOMES = [
  "not_checked",
  "already_available",
  "wait_disabled",
  "ready_after_lazy_start",
  "ready_while_waiting",
  "supervisor_unavailable",
  "unavailable_after_wait",
] as const;
type DesktopReadinessOutcome = (typeof DESKTOP_READINESS_OUTCOMES)[number];
type DesktopReadiness = {
  lazyStartRequested: boolean;
  waitMs: number;
  outcome: DesktopReadinessOutcome;
  healthCheckMode: "full" | "lightweight" | "none" | null;
};
type DesktopCliStageTimings = {
  readinessMs: number;
  queueMs: number;
  commandMs: number;
  metadataMs: number;
  screenshotCaptureMs: number;
  screenshotEncodeMs?: number;
};
type DesktopToolResult = {
  ok: boolean;
  actionId: string;
  action: string;
  startedAtMs: number;
  completedAtMs: number;
  display: { width: number; height: number; scale: 1 };
  activeWindow: {
    id?: string | null;
    title: string | null;
    process: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  };
  pointer: { x: number; y: number } | null;
  screenshot: DesktopScreenshot | null;
  recentScreenshots: DesktopRecentScreenshot[];
  warning: DesktopToolResultWarning | null;
  error: DesktopToolResultError | null;
  desktopProtocol?: DesktopProtocolIdentity;
  desktopRuntime?: DesktopRuntimeIdentity;
  desktopReadiness?: DesktopReadiness;
  timings?: DesktopCliStageTimings;
  typedCharacterCount?: number | null;
  inputRedacted?: boolean;
};

type DesktopCliExecution = {
  result: DesktopToolResult;
  exitCode: number;
  timedOut: boolean;
  attemptCount: number;
  recoveryReason: string | null;
  cliDurationMs: number;
};

type DesktopActionPersistenceJob = {
  version: typeof DESKTOP_ACTION_OUTBOX_VERSION;
  scenarioId: string;
  execution: DesktopCliExecution;
  toolResult: DesktopToolResult;
};

type DesktopActionPersistenceResult = {
  success: boolean;
  retryable: boolean;
  failureCode: string | null;
  screenshotUploaded: boolean;
  uploadMs: number;
  registrationMs: number;
  totalMs: number;
};

let cachedBridgeBundleIdentity: { path: string | null; sha256: string } | null = null;
const desktopActionPersistenceInFlight = new Map<string, Promise<void>>();
const firstOpenAttemptSessions = new Set<string>();
const FIRST_OPEN_SESSION_SET_MAX = 10_000;

export function buildDesktopDynamicToolSpecs(): FirstPartyDynamicToolSpec[] {
  return Object.entries(DESKTOP_TOOL_DESCRIPTIONS).map(([name, description]) => ({
    namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    name,
    description,
    inputSchema: desktopToolInputSchema(name),
  }));
}

export function buildDesktopDynamicToolSpec(toolName: string): FirstPartyDynamicToolSpec[] {
  const description = DESKTOP_TOOL_DESCRIPTIONS[toolName];
  if (!description) return [];
  return [
    {
      namespace: DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      name: toolName,
      description,
      inputSchema: desktopToolInputSchema(toolName),
    },
  ];
}

export async function executeDesktopDynamicToolCall(
  args: unknown,
  context: {
    env: NodeJS.ProcessEnv | Record<string, string>;
    agentRole?: AgentRole;
    cwd?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    recordTelemetry?: (event: string, fields: Record<string, unknown>) => void;
  },
  toolName: string,
): Promise<FirstPartyDynamicToolCallResult> {
  const startedAt = Date.now();
  const input = asRecord(args) ?? {};
  const scenarioId = typeof input.scenarioId === "string" && input.scenarioId.length > 0 ? input.scenarioId : "default";
  const firstOpenAttempt = claimFirstOpenAttempt(toolName, context.env);
  const execution = await executeDesktopCli(toolName, input, context);
  const toolResult = execution.result;
  const contentItems: FirstPartyDynamicToolContentItem[] = [];
  const imageProcessingStartedAt = Date.now();
  const imageItems = await buildDesktopImageContentItems(
    toolResult,
    scenarioId,
    input.includeRecentScreenshots === true,
  );
  const imageReadValidationEncodeMs = Date.now() - imageProcessingStartedAt;
  const resultForText = imageItems.warning ? withModelImageFeedbackWarning(toolResult, imageItems.warning) : toolResult;

  contentItems.push({
    type: "inputText",
    text: JSON.stringify(resultForText),
  } satisfies FirstPartyDynamicToolTextContentItem);
  contentItems.push(...imageItems.items);

  const success = toolResult.ok && !execution.timedOut;
  const errorCode = success ? undefined : mapDesktopToolErrorCode(toolResult.error?.code, execution.timedOut);
  const baseTelemetryFields = desktopTelemetryBaseFields(context.env);

  const persistenceQueued = scheduleDesktopActionPathPersistence({
    context,
    execution,
    scenarioId,
    toolResult,
  });
  const modelVisibleTotalMs = Date.now() - startedAt;
  const cliTimings = toolResult.timings;

  context.recordTelemetry?.("desktop.tool_action", {
    ...baseTelemetryFields,
    action: toolName,
    actionId: toolResult.actionId,
    durationMs: modelVisibleTotalMs,
    modelVisibleTotalMs,
    cliTotalMs: execution.cliDurationMs,
    readinessMs: cliTimings?.readinessMs ?? toolResult.desktopReadiness?.waitMs ?? null,
    queueMs: cliTimings?.queueMs ?? null,
    commandMs: cliTimings?.commandMs ?? null,
    metadataMs: cliTimings?.metadataMs ?? null,
    screenshotCaptureMs: cliTimings?.screenshotCaptureMs ?? null,
    screenshotEncodeMs: cliTimings?.screenshotEncodeMs ?? null,
    screenshotEncodedBytes: toolResult.screenshot?.encodedBytes ?? toolResult.screenshot?.bytes ?? null,
    screenshotEncodingMode: toolResult.screenshot?.encodingMode ?? null,
    screenshotMimeType: toolResult.screenshot?.mimeType ?? null,
    screenshotWidth: toolResult.screenshot?.width ?? null,
    screenshotHeight: toolResult.screenshot?.height ?? null,
    screenshotEncoder: toolResult.screenshot?.encoder ?? null,
    screenshotFallbackUsed: toolResult.screenshot?.fallbackUsed ?? null,
    imageReadValidationEncodeMs,
    uploadMs: null,
    registrationMs: null,
    persistenceOffCriticalPath: true,
    persistenceQueued,
    success,
    failureCode: toolResult.error?.code ?? (execution.timedOut ? DYNAMIC_TOOL_ERROR_CODES.TIMED_OUT : null),
    errorCode: toolResult.error?.code ?? (execution.timedOut ? DYNAMIC_TOOL_ERROR_CODES.TIMED_OUT : null),
    safeToRetry: toolResult.error?.safeToRetry ?? toolResult.error?.retryable ?? null,
    recommendedNextTool: toolResult.error?.recommendedNextTool ?? null,
    screenshotPresent: Boolean(toolResult.screenshot),
    evidenceStaged: Boolean(toolResult.screenshot?.evidencePath),
    warningCode: toolResult.warning?.code ?? null,
    exitCode: execution.exitCode,
    attemptCount: execution.attemptCount,
    retryCount: Math.max(0, execution.attemptCount - 1),
    retryReason: execution.recoveryReason,
    recoveryReason: execution.recoveryReason,
    firstOpenAttempt,
    firstOpenSuccess: firstOpenAttempt ? success : null,
    desktopProtocolVersion: toolResult.desktopProtocol?.version ?? null,
    desktopCliSha256: toolResult.desktopProtocol?.cliSha256 ?? null,
    desktopSupervisorSha256: toolResult.desktopProtocol?.supervisorSha256 ?? null,
    bridgeBundleSha256: toolResult.desktopProtocol?.bridgeBundleSha256 ?? null,
    browserConfiguredPath: toolResult.desktopRuntime?.browserConfiguredPath ?? null,
    browserResolvedPath: toolResult.desktopRuntime?.browserResolvedPath ?? null,
    browserPlatformProtected: toolResult.desktopRuntime?.browserPlatformProtected ?? null,
    supervisorGeneration: toolResult.desktopRuntime?.supervisorGeneration ?? null,
    desktopLazyStartRequested: toolResult.desktopReadiness?.lazyStartRequested ?? null,
    desktopReadyWaitMs: toolResult.desktopReadiness?.waitMs ?? null,
    desktopReadinessOutcome: toolResult.desktopReadiness?.outcome ?? null,
    desktopHealthCheckMode: toolResult.desktopReadiness?.healthCheckMode ?? null,
  });
  context.recordTelemetry?.("desktop.model_image_feedback", {
    ...baseTelemetryFields,
    action: toolName,
    actionId: toolResult.actionId,
    imageCount: imageItems.items.length,
    totalBytes: imageItems.totalBytes,
    screenshotCaptureMs: cliTimings?.screenshotCaptureMs ?? null,
    screenshotEncodeMs: cliTimings?.screenshotEncodeMs ?? null,
    screenshotEncodedBytes: toolResult.screenshot?.encodedBytes ?? toolResult.screenshot?.bytes ?? null,
    screenshotEncodingMode: toolResult.screenshot?.encodingMode ?? null,
    screenshotMimeType: toolResult.screenshot?.mimeType ?? null,
    screenshotWidth: toolResult.screenshot?.width ?? null,
    screenshotHeight: toolResult.screenshot?.height ?? null,
    screenshotEncoder: toolResult.screenshot?.encoder ?? null,
    screenshotFallbackUsed: toolResult.screenshot?.fallbackUsed ?? null,
    success: imageItems.items.length > 0 || !toolResult.screenshot,
    failureCode: imageItems.warning?.code ?? null,
  });

  return {
    success,
    ...(errorCode ? { errorCode } : {}),
    contentItems,
  };
}

export type DesktopRuntimePreflightResult = {
  ok: boolean;
  errorCode: string | null;
  message: string | null;
  safeToRetry: boolean;
  browserConfiguredPath: string | null;
  browserResolvedPath: string | null;
  browserPlatformProtected: boolean;
  supervisorGeneration: string | null;
  desktopProtocolVersion: string | null;
  desktopCliSha256: string | null;
  desktopSupervisorSha256: string | null;
  bridgeBundleSha256: string | null;
};

/**
 * Cheap verification-operator preflight. It validates the baked browser path
 * and the bridge/CLI protocol without starting X11/VNC or capturing an image.
 */
export async function preflightDesktopRuntime(context: {
  env: NodeJS.ProcessEnv | Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
  recordTelemetry?: (event: string, fields: Record<string, unknown>) => void;
}): Promise<DesktopRuntimePreflightResult> {
  const execution = await executeDesktopCli("preflight", {}, context);
  const result = execution.result;
  const preflight: DesktopRuntimePreflightResult = {
    ok: result.ok && !execution.timedOut,
    errorCode: result.error?.code ?? (execution.timedOut ? "action_timeout" : null),
    message: result.error?.message ?? null,
    safeToRetry: result.error?.safeToRetry ?? result.error?.retryable ?? false,
    browserConfiguredPath: result.desktopRuntime?.browserConfiguredPath ?? null,
    browserResolvedPath: result.desktopRuntime?.browserResolvedPath ?? null,
    browserPlatformProtected: result.desktopRuntime?.browserPlatformProtected ?? false,
    supervisorGeneration: result.desktopRuntime?.supervisorGeneration ?? null,
    desktopProtocolVersion: result.desktopProtocol?.version ?? null,
    desktopCliSha256: result.desktopProtocol?.cliSha256 ?? null,
    desktopSupervisorSha256: result.desktopProtocol?.supervisorSha256 ?? null,
    bridgeBundleSha256: result.desktopProtocol?.bridgeBundleSha256 ?? null,
  };
  context.recordTelemetry?.("desktop.runtime_preflight", {
    ...desktopTelemetryBaseFields(context.env),
    ...preflight,
    durationMs: execution.cliDurationMs,
  });
  return preflight;
}

export function redactDesktopDynamicToolInputForPersistence(toolName: string, args: unknown): Record<string, unknown> {
  const input = asRecord(args) ?? {};
  if (toolName === DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME) {
    const command = typeof input.command === "string" ? input.command : "";
    const url = typeof input.url === "string" ? input.url : "";
    const sanitizedCommand = sanitizeOpenAppCommandForPersistence(command);
    const sanitizedUrl = sanitizeOpenAppCommandForPersistence(url);
    return {
      ...input,
      ...(command ? { command: sanitizedCommand, commandSanitized: command !== sanitizedCommand } : {}),
      ...(url ? { url: sanitizedUrl, urlSanitized: url !== sanitizedUrl } : {}),
    };
  }
  if (toolName !== DESKTOP_TYPE_DYNAMIC_TOOL_NAME) return { ...input };
  const text = typeof input.text === "string" ? input.text : "";
  return {
    ...input,
    text: "[redacted]",
    typedCharacterCount: text.length,
    inputRedacted: true,
  };
}

function sanitizeOpenAppCommandForPersistence(command: string): string {
  return command.replace(/\bhttps?:\/\/[^\s'"]+/giu, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      const safePath = `${url.origin}${url.pathname || "/"}`;
      return `${safePath} [url_sha256:${sha256Hex(rawUrl).slice(0, 12)}]`;
    } catch {
      return `[url_sha256:${sha256Hex(rawUrl).slice(0, 12)}]`;
    }
  });
}

async function executeDesktopCli(
  toolName: string,
  input: Record<string, unknown>,
  context: { env: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; signal?: AbortSignal },
): Promise<DesktopCliExecution> {
  const first = await executeDesktopCliOnce(toolName, input, context);
  const firstError = first.result.error;
  if (
    !firstError ||
    !SAFE_TRANSIENT_RETRY_CODES.has(firstError.code) ||
    firstError.safeToRetry !== true ||
    (firstError.code === "desktop_busy" && !SAFE_DESKTOP_BUSY_RETRY_TOOLS.has(toolName)) ||
    (firstError.code === "focus_not_proven" && toolName !== DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME) ||
    first.timedOut ||
    context.signal?.aborted
  ) {
    return { ...first, attemptCount: 1, recoveryReason: null };
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const recovered = await executeDesktopCliOnce(toolName, input, context);
  return {
    ...recovered,
    attemptCount: 2,
    recoveryReason: firstError.code,
    cliDurationMs: first.cliDurationMs + recovered.cliDurationMs,
  };
}

async function executeDesktopCliOnce(
  toolName: string,
  input: Record<string, unknown>,
  context: { env: NodeJS.ProcessEnv | Record<string, string>; cwd?: string; signal?: AbortSignal },
): Promise<Omit<DesktopCliExecution, "attemptCount" | "recoveryReason">> {
  const startedAt = Date.now();
  const cliPath = context.env.ARCANIST_DESKTOP_CLI_PATH || DEFAULT_DESKTOP_CLI_PATH;
  const bridgeBundleSha256 = bridgeBundleIdentity(context.env);
  const args = buildDesktopCliArgs(toolName, input, bridgeBundleSha256);
  const timeout = desktopToolTimeoutMs(toolName, context.env);
  try {
    const result = await execFileAsync(cliPath, args, {
      cwd: context.cwd,
      env: { ...process.env, ...context.env },
      timeout,
      signal: context.signal,
      maxBuffer: 1024 * 1024,
    });
    return {
      result: validateDesktopProtocol(parseDesktopCliStdout(result.stdout, toolName), bridgeBundleSha256),
      exitCode: 0,
      timedOut: false,
      cliDurationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const maybe = error as { stdout?: unknown; code?: unknown; signal?: unknown; killed?: unknown };
    const stdout = typeof maybe.stdout === "string" ? maybe.stdout : "";
    const parsed = validateDesktopProtocol(parseDesktopCliStdout(stdout, toolName), bridgeBundleSha256);
    const timedOut = maybe.signal === "SIGTERM" || maybe.killed === true;
    return {
      result: timedOut ? withTimeoutError(parsed, toolName) : parsed,
      exitCode: typeof maybe.code === "number" ? maybe.code : 1,
      timedOut,
      cliDurationMs: Date.now() - startedAt,
    };
  }
}

function parseDesktopCliStdout(stdout: string, toolName: string): DesktopToolResult {
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (isDesktopToolResult(parsed)) return normalizeDesktopToolResult(parsed);
  } catch {
    // Fall through to a typed bridge-side failure result.
  }
  const now = Date.now();
  return {
    ok: false,
    actionId: `${toolName}-${now}`,
    action: toolName,
    startedAtMs: now,
    completedAtMs: now,
    display: { width: 0, height: 0, scale: 1 },
    activeWindow: { id: null, title: null, process: null, bounds: null },
    pointer: null,
    screenshot: null,
    recentScreenshots: [],
    warning: null,
    error: {
      code: "invalid_cli_output",
      message: "Desktop CLI did not return valid DesktopToolResult JSON.",
      retryable: true,
    },
  };
}

function validateDesktopProtocol(result: DesktopToolResult, bridgeBundleSha256: string): DesktopToolResult {
  if (result.error?.code === "invalid_cli_output") return result;
  const identity = result.desktopProtocol;
  if (
    identity?.version === DESKTOP_PROTOCOL_VERSION &&
    DESKTOP_COMPONENT_SHA256_RE.test(identity.cliSha256) &&
    DESKTOP_COMPONENT_SHA256_RE.test(identity.supervisorSha256) &&
    identity.bridgeBundleSha256 === bridgeBundleSha256
  ) {
    return result;
  }
  const actualVersion = identity?.version ?? "missing";
  return {
    ...result,
    ok: false,
    error: {
      code: "desktop_protocol_mismatch",
      message: `Desktop bridge/CLI protocol mismatch (bridge=${DESKTOP_PROTOCOL_VERSION}, cli=${actualVersion}). Rebuild the sandbox template before retrying desktop tools.`,
      retryable: false,
      safeToRetry: false,
      recommendedNextTool: null,
      expectedWindowId: null,
      actualWindowId: null,
    },
  };
}

function bridgeBundleIdentity(env: NodeJS.ProcessEnv | Record<string, string>): string {
  const configured = stringEnv(env, "ARCANIST_BRIDGE_BUNDLE_SHA256");
  if (configured && /^[a-f0-9]{64}$/i.test(configured)) return configured.toLowerCase();
  const path = stringEnv(env, "ARCANIST_BRIDGE_BUNDLE_PATH") ?? process.argv[1] ?? null;
  if (cachedBridgeBundleIdentity?.path === path) return cachedBridgeBundleIdentity.sha256;
  if (!path) return "unknown";
  try {
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    cachedBridgeBundleIdentity = { path, sha256 };
    return sha256;
  } catch {
    cachedBridgeBundleIdentity = { path, sha256: "unknown" };
    return "unknown";
  }
}

function desktopToolTimeoutMs(toolName: string, env: NodeJS.ProcessEnv | Record<string, string>): number {
  const actionTimeoutMs = DESKTOP_TOOL_TIMEOUT_MS[toolName] ?? 8_000;
  const readyWaitSeconds = Number(env.ARCANIST_DESKTOP_READY_WAIT_SECONDS ?? DEFAULT_DESKTOP_READY_WAIT_SECONDS);
  const readyWaitMs = Number.isFinite(readyWaitSeconds) && readyWaitSeconds > 0 ? readyWaitSeconds * 1_000 : 0;
  return actionTimeoutMs + readyWaitMs + DESKTOP_CLI_TIMEOUT_MARGIN_MS;
}

function withTimeoutError(result: DesktopToolResult, toolName: string): DesktopToolResult {
  if (result.error?.code && result.error.code !== "invalid_cli_output") return result;
  return {
    ...result,
    ok: false,
    action: result.action || toolName,
    error: { code: "action_timeout", message: "Desktop dynamic tool timed out.", retryable: true },
  };
}

async function buildDesktopImageContentItems(
  result: DesktopToolResult,
  scenarioId: string,
  includeRecentScreenshots: boolean,
): Promise<{
  items: FirstPartyDynamicToolImageContentItem[];
  totalBytes: number;
  warning: DesktopToolResultWarning | null;
}> {
  if (!result.screenshot) return { items: [], totalBytes: 0, warning: null };

  let rootDir: string;
  try {
    rootDir = desktopScenarioImageRoot(scenarioId);
  } catch (error) {
    return {
      items: [],
      totalBytes: 0,
      warning: {
        code: MODEL_IMAGE_FEEDBACK_FAILED_CODE,
        message: error instanceof Error ? error.message : "Desktop screenshot root could not be validated.",
      },
    };
  }

  const current = await validateDynamicToolImageContentItem({
    imagePath: result.screenshot.path,
    rootDir,
    label: `${result.action} current screenshot`,
    detail: "high",
  });
  if (!current.ok) {
    return {
      items: [],
      totalBytes: 0,
      warning: { code: MODEL_IMAGE_FEEDBACK_FAILED_CODE, message: current.message },
    };
  }

  const items: FirstPartyDynamicToolImageContentItem[] = [current.item];
  let totalBytes = current.item.bytes;
  if (includeRecentScreenshots) {
    const recent = result.recentScreenshots[0];
    if (recent) {
      const image = await validateDynamicToolImageContentItem({
        imagePath: recent.path,
        rootDir,
        label: `${recent.actionId} previous desktop screenshot`,
        detail: "low",
      });
      if (image.ok) {
        items.push(image.item);
        totalBytes += image.item.bytes;
      }
    }
  }

  return { items, totalBytes, warning: null };
}

function withModelImageFeedbackWarning(
  result: DesktopToolResult,
  warning: DesktopToolResultWarning,
): DesktopToolResult {
  if (result.warning) {
    return {
      ...result,
      warning: {
        code: warning.code,
        message: `${warning.message} Existing desktop warning (${result.warning.code}): ${result.warning.message}`,
      },
    };
  }
  return { ...result, warning };
}

type DesktopActionPersistenceContext = {
  env: NodeJS.ProcessEnv | Record<string, string>;
  agentRole?: AgentRole;
  fetchImpl?: typeof fetch;
  recordTelemetry?: (event: string, fields: Record<string, unknown>) => void;
};

function scheduleDesktopActionPathPersistence(params: {
  context: DesktopActionPersistenceContext;
  execution: DesktopCliExecution;
  scenarioId: string;
  toolResult: DesktopToolResult;
}): boolean {
  const { context, execution, scenarioId, toolResult } = params;
  if (!isRegisterableDesktopAction(toolResult.action)) return false;
  if (!DESKTOP_ACTION_PATH_ACTION_ID_RE.test(toolResult.actionId)) {
    recordDesktopPersistenceRejected(context, toolResult, "invalid_action_id");
    return false;
  }
  const config = desktopActionPathCallbackConfig(context.env);
  if (!config) {
    recordDesktopPersistenceRejected(context, toolResult, "callback_not_configured");
    return false;
  }

  const job: DesktopActionPersistenceJob = {
    version: DESKTOP_ACTION_OUTBOX_VERSION,
    execution,
    scenarioId,
    toolResult,
  };
  const outboxPath = desktopActionOutboxPath(context.env, config.sessionId, toolResult.actionId);
  try {
    persistDesktopActionJob(outboxPath, job);
  } catch {
    recordDesktopPersistenceRejected(context, toolResult, "outbox_write_failed");
    return false;
  }

  runDesktopActionPersistenceJob(outboxPath, job, context, config);
  recoverDesktopActionPersistenceJobs(context, config, outboxPath);
  context.recordTelemetry?.("desktop.action_path_queued", {
    ...desktopTelemetryBaseFields(context.env),
    action: toolResult.action,
    actionId: toolResult.actionId,
    phase: desktopActionPathPhase(context),
    durable: true,
  });
  return true;
}

function recordDesktopPersistenceRejected(
  context: DesktopActionPersistenceContext,
  toolResult: DesktopToolResult,
  failureCode: string,
): void {
  context.recordTelemetry?.("desktop.action_path_register", {
    ...desktopTelemetryBaseFields(context.env),
    action: toolResult.action,
    actionId: toolResult.actionId,
    phase: desktopActionPathPhase(context),
    success: false,
    screenshotUploaded: false,
    failureCode,
  });
}

function desktopActionOutboxPath(
  env: NodeJS.ProcessEnv | Record<string, string>,
  sessionId: string,
  actionId: string,
): string {
  const root = stringEnv(env, "ARCANIST_DESKTOP_ACTION_OUTBOX_DIR") ?? DEFAULT_DESKTOP_ACTION_OUTBOX_DIR;
  const sessionDir = join(root, sha256Hex(sessionId));
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  return join(sessionDir, `${actionId}.json`);
}

function persistDesktopActionJob(path: string, job: DesktopActionPersistenceJob): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(job), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function recoverDesktopActionPersistenceJobs(
  context: DesktopActionPersistenceContext,
  config: { controlPlaneUrl: string; sessionId: string; sandboxAuthToken: string },
  currentPath: string,
): void {
  const sessionDir = join(currentPath, "..");
  let filenames: string[];
  try {
    filenames = readdirSync(sessionDir).filter((filename) => filename.endsWith(".json"));
  } catch {
    return;
  }
  for (const filename of filenames) {
    const path = join(sessionDir, filename);
    if (path === currentPath || desktopActionPersistenceInFlight.has(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const job = parseDesktopActionPersistenceJob(parsed);
      if (!job) {
        rmSync(path, { force: true });
        continue;
      }
      runDesktopActionPersistenceJob(path, job, context, config);
    } catch {
      rmSync(path, { force: true });
    }
  }
}

function parseDesktopActionPersistenceJob(value: unknown): DesktopActionPersistenceJob | null {
  const record = asRecord(value);
  if (!record || record.version !== DESKTOP_ACTION_OUTBOX_VERSION || typeof record.scenarioId !== "string") return null;
  const execution = asRecord(record.execution);
  if (!execution || !isDesktopToolResult(record.toolResult)) return null;
  if (
    typeof execution.exitCode !== "number" ||
    typeof execution.timedOut !== "boolean" ||
    typeof execution.attemptCount !== "number" ||
    (execution.recoveryReason !== null && typeof execution.recoveryReason !== "string") ||
    typeof execution.cliDurationMs !== "number"
  ) {
    return null;
  }
  return {
    version: DESKTOP_ACTION_OUTBOX_VERSION,
    scenarioId: record.scenarioId,
    toolResult: record.toolResult,
    execution: {
      result: record.toolResult,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      attemptCount: execution.attemptCount,
      recoveryReason: execution.recoveryReason,
      cliDurationMs: execution.cliDurationMs,
    },
  };
}

function runDesktopActionPersistenceJob(
  path: string,
  job: DesktopActionPersistenceJob,
  context: DesktopActionPersistenceContext,
  config: { controlPlaneUrl: string; sessionId: string; sandboxAuthToken: string },
): void {
  if (desktopActionPersistenceInFlight.has(path)) return;
  const task = (async () => {
    let result: DesktopActionPersistenceResult | null = null;
    for (let attempt = 0; attempt <= DESKTOP_ACTION_PERSISTENCE_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) await unrefDelay(DESKTOP_ACTION_PERSISTENCE_RETRY_DELAYS_MS[attempt - 1]);
      result = await registerDesktopActionPathBestEffort({ context, config, ...job });
      if (result.success || !result.retryable) break;
    }
    if (result?.success || result?.retryable === false) rmSync(path, { force: true });
  })().finally(() => {
    desktopActionPersistenceInFlight.delete(path);
  });
  desktopActionPersistenceInFlight.set(path, task);
}

function unrefDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

async function registerDesktopActionPathBestEffort(params: {
  context: {
    env: NodeJS.ProcessEnv | Record<string, string>;
    agentRole?: AgentRole;
    fetchImpl?: typeof fetch;
    recordTelemetry?: (event: string, fields: Record<string, unknown>) => void;
  };
  config: { controlPlaneUrl: string; sessionId: string; sandboxAuthToken: string };
  execution: DesktopCliExecution;
  scenarioId: string;
  toolResult: DesktopToolResult;
}): Promise<DesktopActionPersistenceResult> {
  const persistenceStartedAt = Date.now();
  const { config, context, execution, scenarioId, toolResult } = params;
  const baseTelemetryFields = desktopTelemetryBaseFields(context.env);
  const phase = desktopActionPathPhase(context);
  if (!isRegisterableDesktopAction(toolResult.action)) {
    return recordDesktopPersistenceResult(context, toolResult, phase, {
      success: false,
      retryable: false,
      failureCode: "invalid_action",
      screenshotUploaded: false,
      uploadMs: 0,
      registrationMs: 0,
      totalMs: Date.now() - persistenceStartedAt,
    });
  }
  const action = toolResult.action;

  let uploadWarningCode: string | null = null;
  const uploadStartedAt = Date.now();
  const uploadResult = await uploadDesktopActionScreenshot({
    config,
    context,
    phase,
    scenarioId,
    toolResult,
  });
  if (uploadResult.warningCode) {
    uploadWarningCode = uploadResult.warningCode;
  }
  const uploadMs = Date.now() - uploadStartedAt;
  if (uploadResult.retryable) {
    return recordDesktopPersistenceResult(context, toolResult, phase, {
      success: false,
      retryable: true,
      failureCode: uploadWarningCode,
      screenshotUploaded: false,
      uploadMs,
      registrationMs: 0,
      totalMs: Date.now() - persistenceStartedAt,
    });
  }

  const row: RegisterDesktopActionPathRowRequest = {
    actionId: toolResult.actionId,
    promptId: null,
    phase,
    action,
    label: desktopActionPathLabel(toolResult),
    status: desktopActionPathStatus(toolResult, execution),
    activeWindowTitle: toolResult.activeWindow.title,
    warningCode: toolResult.warning?.code ?? uploadWarningCode,
    errorCode: toolResult.error?.code ?? (execution.timedOut ? "action_timeout" : null),
    screenshot: uploadResult.screenshot,
    createdAtMs: toolResult.startedAtMs,
    updatedAtMs: Math.max(toolResult.startedAtMs, toolResult.completedAtMs),
  };

  const registrationStartedAt = Date.now();
  let result: DesktopActionPersistenceResult;
  try {
    const response = await (context.fetchImpl ?? fetch)(
      `${config.controlPlaneUrl}/api/sessions/${encodeURIComponent(config.sessionId)}/desktop/action-path`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.sandboxAuthToken}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(row),
        signal: createTimeoutAwareSignal(undefined, DESKTOP_ACTION_PATH_REGISTER_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const failureCode = `register_http_${response.status}`;
      result = {
        success: false,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        screenshotUploaded: Boolean(uploadResult.screenshot),
        failureCode,
        uploadMs,
        registrationMs: Date.now() - registrationStartedAt,
        totalMs: Date.now() - persistenceStartedAt,
      };
    } else {
      result = {
        success: true,
        retryable: false,
        screenshotUploaded: Boolean(uploadResult.screenshot),
        failureCode: null,
        uploadMs,
        registrationMs: Date.now() - registrationStartedAt,
        totalMs: Date.now() - persistenceStartedAt,
      };
    }
  } catch (error) {
    result = {
      success: false,
      retryable: true,
      screenshotUploaded: Boolean(uploadResult.screenshot),
      failureCode: error instanceof Error && error.name === "TimeoutError" ? "register_timeout" : "register_failed",
      uploadMs,
      registrationMs: Date.now() - registrationStartedAt,
      totalMs: Date.now() - persistenceStartedAt,
    };
  }
  return recordDesktopPersistenceResult(context, toolResult, phase, result, baseTelemetryFields);
}

function recordDesktopPersistenceResult(
  context: DesktopActionPersistenceContext,
  toolResult: DesktopToolResult,
  phase: DesktopActionPathPhase,
  result: DesktopActionPersistenceResult,
  baseTelemetryFields = desktopTelemetryBaseFields(context.env),
): DesktopActionPersistenceResult {
  context.recordTelemetry?.("desktop.action_path_register", {
    ...baseTelemetryFields,
    action: toolResult.action,
    actionId: toolResult.actionId,
    phase,
    ...result,
  });
  context.recordTelemetry?.("desktop.tool_action_persistence", {
    ...baseTelemetryFields,
    action: toolResult.action,
    actionId: toolResult.actionId,
    success: result.success,
    failureCode: result.failureCode,
    uploadMs: result.uploadMs,
    registrationMs: result.registrationMs,
    persistenceTotalMs: result.totalMs,
  });
  return result;
}

function isRegisterableDesktopAction(action: string): action is DesktopActionPathAction {
  return DESKTOP_ACTION_PATH_ACTION_SET.has(action);
}

function desktopActionPathPhase(context: {
  env: NodeJS.ProcessEnv | Record<string, string>;
  agentRole?: AgentRole;
}): DesktopActionPathPhase {
  const role = context.agentRole ?? context.env.ARCANIST_AGENT_ROLE;
  return role === "verification" ? "verification_operator" : "agent";
}

function desktopActionPathStatus(result: DesktopToolResult, execution: DesktopCliExecution): DesktopActionPathStatus {
  if (result.ok && !execution.timedOut) return "completed";
  if (result.error?.code === "desktop_unavailable") return "desktop_unavailable";
  if (result.error?.code === "screenshot_failed" || result.error?.code === "screenshot_capture_failed")
    return "screenshot_failed";
  if (result.error?.code === "screenshot_quota_exceeded") return "quota_exceeded";
  return "action_failed";
}

function desktopActionPathLabel(result: DesktopToolResult): string {
  return `Desktop ${result.action.replaceAll("_", " ")}`;
}

function desktopScreenshotCaptureMode(screenshot: DesktopScreenshot): "full_display" | null {
  return screenshot.captureMode === "full_display" ? "full_display" : null;
}

function desktopScreenshotDisplayName(screenshot: DesktopScreenshot): string | null {
  return typeof screenshot.displayName === "string" && screenshot.displayName.length > 0
    ? screenshot.displayName
    : null;
}

function desktopActionPathCallbackConfig(env: NodeJS.ProcessEnv | Record<string, string>): {
  controlPlaneUrl: string;
  sessionId: string;
  sandboxAuthToken: string;
} | null {
  const controlPlaneUrl = normalizeControlPlaneUrl(env.CONTROL_PLANE_URL ?? env.ARCANIST_API_URL);
  const sessionId = stringEnv(env, "SESSION_ID");
  const sandboxAuthToken = stringEnv(env, "SANDBOX_AUTH_TOKEN");
  if (!controlPlaneUrl || !sessionId || !sandboxAuthToken) return null;
  return { controlPlaneUrl, sessionId, sandboxAuthToken };
}

async function uploadDesktopActionScreenshot(params: {
  config: { controlPlaneUrl: string; sessionId: string; sandboxAuthToken: string };
  context: { fetchImpl?: typeof fetch };
  phase: DesktopActionPathPhase;
  scenarioId: string;
  toolResult: DesktopToolResult;
}): Promise<{ screenshot: DesktopActionScreenshotRef | null; warningCode: string | null; retryable: boolean }> {
  const { config, context, phase, scenarioId, toolResult } = params;
  if (!toolResult.screenshot) return { screenshot: null, warningCode: null, retryable: false };

  let rootDir: string;
  try {
    rootDir = desktopScenarioImageRoot(scenarioId);
  } catch {
    return { screenshot: null, warningCode: "desktop_action_screenshot_invalid_scenario", retryable: false };
  }

  const label = `${toolResult.action} current screenshot`;
  const image = await validateDynamicToolImageContentItem({
    imagePath: toolResult.screenshot.path,
    rootDir,
    label,
    detail: "high",
    maxBytes: DESKTOP_ACTION_SCREENSHOT_UPLOAD_MAX_BYTES,
  });
  if (!image.ok) {
    return { screenshot: null, warningCode: `desktop_action_screenshot_${image.code}`, retryable: false };
  }

  try {
    const body = await readFileAsync(image.item.path);
    const extension =
      image.item.mimeType === "image/jpeg" ? "jpg" : image.item.mimeType === "image/webp" ? "webp" : "png";
    const artifactFilename = `${toolResult.actionId}-${toolResult.action}.${extension}`;
    const response = await (context.fetchImpl ?? fetch)(
      `${config.controlPlaneUrl}/api/sessions/${encodeURIComponent(config.sessionId)}/artifacts`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.sandboxAuthToken}`,
          "content-type": image.item.mimeType,
          "x-artifact-type": "screenshot",
          "x-artifact-label": artifactFilename,
          "x-artifact-display-label": encodeURIComponent(label),
          "x-artifact-kind": DESKTOP_ACTION_SCREENSHOT_KIND,
          "x-desktop-action-id": toolResult.actionId,
          "x-desktop-phase": phase,
          "x-desktop-scenario-id": scenarioId,
        },
        body,
        signal: createTimeoutAwareSignal(undefined, DESKTOP_ACTION_SCREENSHOT_UPLOAD_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      return {
        screenshot: null,
        warningCode: `desktop_action_screenshot_upload_http_${response.status}`,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      };
    }
    const payload = (await response.json()) as {
      artifact?: { id?: unknown; label?: unknown; viewUrl?: unknown };
    };
    const artifactId = typeof payload.artifact?.id === "string" ? payload.artifact.id : null;
    const viewUrl = typeof payload.artifact?.viewUrl === "string" ? payload.artifact.viewUrl : null;
    if (!artifactId || !viewUrl) {
      return { screenshot: null, warningCode: "desktop_action_screenshot_upload_invalid_response", retryable: false };
    }
    const responseLabel = typeof payload.artifact?.label === "string" ? payload.artifact.label : label;
    return {
      screenshot: {
        actionId: toolResult.actionId,
        artifactId,
        kind: DESKTOP_ACTION_SCREENSHOT_KIND,
        artifactAccessVisibility: "private",
        label: responseLabel,
        viewUrl,
        width: image.item.width,
        height: image.item.height,
        bytes: image.item.bytes,
        captureMode: desktopScreenshotCaptureMode(toolResult.screenshot),
        displayName: desktopScreenshotDisplayName(toolResult.screenshot),
        capturedAtMs: toolResult.completedAtMs,
        status: "available",
      },
      warningCode: null,
      retryable: false,
    };
  } catch (error) {
    return {
      screenshot: null,
      warningCode:
        error instanceof Error && error.name === "TimeoutError"
          ? "desktop_action_screenshot_upload_timeout"
          : "desktop_action_screenshot_upload_failed",
      retryable: true,
    };
  }
}

function mapDesktopToolErrorCode(errorCode: string | null | undefined, timedOut: boolean): DynamicToolErrorCode {
  if (timedOut || errorCode === "action_timeout") return DYNAMIC_TOOL_ERROR_CODES.TIMED_OUT;
  switch (errorCode) {
    case "desktop_unavailable":
    case "browser_missing":
      return DYNAMIC_TOOL_ERROR_CODES.MISSING_BINARY;
    case "desktop_busy":
      return DYNAMIC_TOOL_ERROR_CODES.LIMIT_EXCEEDED;
    case "recording_already_active":
      return DYNAMIC_TOOL_ERROR_CODES.LIMIT_EXCEEDED;
    case "not_recording":
    case "invalid_request":
    case "path_containment_failed":
      return DYNAMIC_TOOL_ERROR_CODES.INVALID_INPUT;
    case "screenshot_quota_exceeded":
      return DYNAMIC_TOOL_ERROR_CODES.LIMIT_EXCEEDED;
    case "screenshot_failed":
    case "screenshot_capture_failed":
    case "focus_not_proven":
    case "desktop_protocol_mismatch":
    case "action_failed":
    case "invalid_cli_output":
    default:
      return DYNAMIC_TOOL_ERROR_CODES.EXECUTION_FAILED;
  }
}

function buildDesktopCliArgs(toolName: string, input: Record<string, unknown>, bridgeBundleSha256: string): string[] {
  const args = [
    toolName,
    "--json",
    "--desktop-protocol-version",
    DESKTOP_PROTOCOL_VERSION,
    "--bridge-bundle-sha256",
    bridgeBundleSha256,
  ];
  addOptionalStringArg(args, "--scenario-id", input.scenarioId);
  addOptionalStringArg(args, "--action-id", input.actionId);
  addOptionalStringArg(args, "--purpose", input.purpose);
  addOptionalNumberArg(args, "--x", input.x);
  addOptionalNumberArg(args, "--y", input.y);
  addOptionalNumberArg(args, "--button", input.button);
  addOptionalStringArg(args, "--text", input.text);
  addOptionalStringArg(args, "--keys", input.keys);
  addOptionalNumberArg(args, "--amount", input.amount);
  addOptionalNumberArg(args, "--from-x", input.fromX);
  addOptionalNumberArg(args, "--from-y", input.fromY);
  addOptionalNumberArg(args, "--to-x", input.toX);
  addOptionalNumberArg(args, "--to-y", input.toY);
  addOptionalStringArg(args, "--command", input.command);
  addOptionalStringArg(args, "--url", input.url);
  addOptionalStringArg(args, "--window-id", input.windowId);
  addOptionalStringArg(args, "--title", input.title);
  addOptionalStringArg(args, "--target-window-id", input.targetWindowId);
  addOptionalStringArg(args, "--label", input.label);
  addOptionalStringArg(args, "--recording-id", input.recordingId);
  addOptionalBooleanArg(args, "--acknowledge-no-secrets", input.acknowledgeNoSecrets);
  addOptionalStringArg(args, "--reason", input.reason);
  return args;
}

function addOptionalStringArg(args: string[], flag: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) return;
  args.push(flag, value);
}

function addOptionalNumberArg(args: string[], flag: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  args.push(flag, String(value));
}

function addOptionalBooleanArg(args: string[], flag: string, value: unknown): void {
  if (typeof value !== "boolean") return;
  args.push(flag, value ? "true" : "false");
}

function stringEnv(env: NodeJS.ProcessEnv | Record<string, string>, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function desktopTelemetryBaseFields(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string | null> {
  const sessionId = stringEnv(env, "SESSION_ID");
  return {
    agentRuntimeBackend: stringEnv(env, "ARCANIST_AGENT_RUNTIME_BACKEND"),
    modelId: stringEnv(env, "MODEL"),
    sessionIdHash: sessionId ? sha256Hex(sessionId) : null,
    sandboxTemplateId: stringEnv(env, "E2B_TEMPLATE_ID") ?? stringEnv(env, "E2B_SANDBOX_TEMPLATE"),
    resourceProfile: stringEnv(env, "ARCANIST_RESOURCE_PROFILE"),
  };
}

function claimFirstOpenAttempt(toolName: string, env: NodeJS.ProcessEnv | Record<string, string>): boolean | null {
  if (toolName !== DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME) return null;
  const sessionId = stringEnv(env, "SESSION_ID");
  if (!sessionId) return true;
  const key = sha256Hex(sessionId);
  if (firstOpenAttemptSessions.has(key)) return false;
  if (firstOpenAttemptSessions.size >= FIRST_OPEN_SESSION_SET_MAX) {
    const oldest = firstOpenAttemptSessions.values().next().value as string | undefined;
    if (oldest) firstOpenAttemptSessions.delete(oldest);
  }
  firstOpenAttemptSessions.add(key);
  return true;
}

function desktopToolInputSchema(toolName: string): Record<string, unknown> {
  const commonProperties = {
    scenarioId: {
      type: "string",
      description: "Optional desktop evidence scenario id under /tmp/phase-evidence/desktop.",
    },
    actionId: { type: "string", description: "Optional caller-supplied action id for idempotent action tracking." },
    includeRecentScreenshots: {
      type: "boolean",
      description:
        "Opt in to one low-detail previous screenshot for before/after comparison. Current screenshot only by default.",
    },
  };
  const targetWindowIdProperty = {
    type: "string",
    pattern: "^0x[0-9A-Fa-f]+$",
    description: "Optional X11 window id that must be focused before the action executes.",
  };
  switch (toolName) {
    case DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME:
      return objectSchema(commonProperties);
    case DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME:
      return objectSchema(commonProperties);
    case DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME:
      return objectSchema({ actionId: commonProperties.actionId });
    case DESKTOP_CLICK_DYNAMIC_TOOL_NAME:
      return objectSchema(
        {
          ...commonProperties,
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "number", minimum: 1, maximum: 5 },
          targetWindowId: targetWindowIdProperty,
        },
        ["x", "y"],
      );
    case DESKTOP_TYPE_DYNAMIC_TOOL_NAME:
      return objectSchema({ ...commonProperties, text: { type: "string" }, targetWindowId: targetWindowIdProperty }, [
        "text",
      ]);
    case DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME:
      return objectSchema({ ...commonProperties, keys: { type: "string" }, targetWindowId: targetWindowIdProperty }, [
        "keys",
      ]);
    case DESKTOP_SCROLL_DYNAMIC_TOOL_NAME:
      return objectSchema(
        {
          ...commonProperties,
          x: { type: "number" },
          y: { type: "number" },
          amount: { type: "number", minimum: -20, maximum: 20, not: { const: 0 } },
          targetWindowId: targetWindowIdProperty,
        },
        ["x", "y", "amount"],
      );
    case DESKTOP_DRAG_DYNAMIC_TOOL_NAME:
      return objectSchema(
        {
          ...commonProperties,
          fromX: { type: "number" },
          fromY: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
          targetWindowId: targetWindowIdProperty,
        },
        ["fromX", "fromY", "toX", "toY"],
      );
    case DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME:
      return objectSchema(
        {
          ...commonProperties,
          url: {
            type: "string",
            pattern: "^https?://",
            description: "Preferred: HTTP(S) URL to open in the preinstalled Chromium browser.",
          },
          command: {
            type: "string",
            description: "Explicit app command. Use url instead when opening a web page.",
          },
        },
        [],
        { oneOf: [{ required: ["url"] }, { required: ["command"] }] },
      );
    case DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME:
      return objectSchema(
        {
          ...commonProperties,
          windowId: { type: "string" },
          title: { type: "string" },
        },
        [],
        { oneOf: [{ required: ["windowId"] }, { required: ["title"] }] },
      );
    case DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME:
      return objectSchema(
        {
          ...commonProperties,
          label: { type: "string" },
          acknowledgeNoSecrets: { type: "boolean", const: true },
          recordingId: { type: "string" },
        },
        ["label", "acknowledgeNoSecrets"],
      );
    case DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME:
      return objectSchema({
        ...commonProperties,
        reason: { type: "string", enum: ["operator_stop", "interrupted", "pause", "resume", "stale"] },
      });
    case DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME:
      return objectSchema({ actionId: commonProperties.actionId });
    default:
      return objectSchema({});
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
    ...extra,
  };
}

function isDesktopToolResult(value: unknown): value is DesktopToolResult {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.ok === "boolean" &&
    typeof record.actionId === "string" &&
    typeof record.action === "string" &&
    typeof record.startedAtMs === "number" &&
    typeof record.completedAtMs === "number" &&
    record.display !== null &&
    typeof record.display === "object" &&
    record.activeWindow !== null &&
    typeof record.activeWindow === "object" &&
    (record.screenshot === null || isDesktopScreenshot(record.screenshot)) &&
    Array.isArray(record.recentScreenshots) &&
    record.recentScreenshots.every(isDesktopRecentScreenshot) &&
    (record.warning === null || isDesktopToolResultWarning(record.warning)) &&
    (record.error === null || isDesktopToolResultError(record.error)) &&
    (record.desktopProtocol === undefined || isDesktopProtocolIdentity(record.desktopProtocol)) &&
    (record.desktopRuntime === undefined || isDesktopRuntimeIdentity(record.desktopRuntime)) &&
    (record.desktopReadiness === undefined || isDesktopReadiness(record.desktopReadiness)) &&
    (record.timings === undefined || isDesktopCliStageTimings(record.timings))
  );
}

function isDesktopRuntimeIdentity(value: unknown): value is DesktopRuntimeIdentity {
  const record = asRecord(value);
  if (!record) return false;
  return (
    (record.browserStatus === "ready" || record.browserStatus === "missing") &&
    (record.browserSource === "configured" || record.browserSource === "path") &&
    (record.browserConfiguredPath === null || typeof record.browserConfiguredPath === "string") &&
    (record.browserResolvedPath === null || typeof record.browserResolvedPath === "string") &&
    typeof record.browserSymlink === "boolean" &&
    typeof record.browserPlatformProtected === "boolean" &&
    (record.supervisorGeneration === null || typeof record.supervisorGeneration === "string")
  );
}

function isDesktopCliStageTimings(value: unknown): value is DesktopCliStageTimings {
  const record = asRecord(value);
  if (!record) return false;
  return (
    isNonNegativeInteger(record.readinessMs) &&
    isNonNegativeInteger(record.queueMs) &&
    isNonNegativeInteger(record.commandMs) &&
    isNonNegativeInteger(record.metadataMs) &&
    isNonNegativeInteger(record.screenshotCaptureMs)
  );
}

function isDesktopProtocolIdentity(value: unknown): value is DesktopProtocolIdentity {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.version === "string" &&
    typeof record.cliSha256 === "string" &&
    typeof record.supervisorSha256 === "string" &&
    typeof record.bridgeBundleSha256 === "string"
  );
}

function isDesktopReadiness(value: unknown): value is DesktopReadiness {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.lazyStartRequested === "boolean" &&
    isNonNegativeInteger(record.waitMs) &&
    DESKTOP_READINESS_OUTCOMES.some((outcome) => outcome === record.outcome) &&
    (record.healthCheckMode === null ||
      record.healthCheckMode === "full" ||
      record.healthCheckMode === "lightweight" ||
      record.healthCheckMode === "none")
  );
}

function isDesktopScreenshot(value: unknown): value is DesktopScreenshot {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.path === "string" &&
    record.path.length > 0 &&
    isPositiveInteger(record.width) &&
    isPositiveInteger(record.height) &&
    isPositiveInteger(record.bytes) &&
    (record.mimeType === "image/jpeg" || record.mimeType === "image/png" || record.mimeType === "image/webp") &&
    (record.encodedBytes === undefined || isPositiveInteger(record.encodedBytes)) &&
    (record.extension === undefined ||
      record.extension === ".webp" ||
      record.extension === ".png" ||
      record.extension === ".jpg" ||
      record.extension === ".jpeg") &&
    (record.encodingMode === undefined ||
      record.encodingMode === "lossless" ||
      record.encodingMode === "q88" ||
      record.encodingMode === "q80" ||
      record.encodingMode === "legacy") &&
    (record.encoder === undefined ||
      record.encoder === null ||
      record.encoder === "scrot-imlib2" ||
      record.encoder === "ffmpeg-libwebp") &&
    (record.fallbackUsed === undefined || typeof record.fallbackUsed === "boolean") &&
    isDesktopScreenshotPurpose(record.purpose)
  );
}

function normalizeDesktopToolResult(result: DesktopToolResult): DesktopToolResult {
  if (!result.screenshot) return result;
  const extension =
    result.screenshot.extension ??
    (result.screenshot.mimeType === "image/webp"
      ? ".webp"
      : result.screenshot.mimeType === "image/jpeg"
        ? ".jpg"
        : ".png");
  return {
    ...result,
    screenshot: {
      ...result.screenshot,
      encodedBytes: result.screenshot.encodedBytes ?? result.screenshot.bytes,
      extension,
      encodingMode: result.screenshot.encodingMode ?? "legacy",
      encoder: result.screenshot.encoder ?? null,
      fallbackUsed: result.screenshot.fallbackUsed ?? false,
    },
  };
}

function isDesktopRecentScreenshot(value: unknown): value is DesktopRecentScreenshot {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.actionId === "string" &&
    record.actionId.length > 0 &&
    typeof record.path === "string" &&
    record.path.length > 0 &&
    isNonNegativeInteger(record.capturedAtMs) &&
    isDesktopScreenshotPurpose(record.purpose)
  );
}

function isDesktopToolResultWarning(value: unknown): value is DesktopToolResultWarning {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.code === "string" && record.code.length > 0 && typeof record.message === "string";
}

function isDesktopToolResultError(value: unknown): value is DesktopToolResultError {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.code === "string" &&
    record.code.length > 0 &&
    typeof record.message === "string" &&
    typeof record.retryable === "boolean"
  );
}

function isDesktopScreenshotPurpose(value: unknown): value is DesktopScreenshot["purpose"] {
  return value === "action_feedback" || value === "observe" || value === "proof_candidate";
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
