#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { constants as fsConstants } from "node:fs";
import {
  accessSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set(["start", "record", "stop", "shot", "close"]);
const DEFAULT_VIEWPORT = "1280x720";
const DEFAULT_MAX_DURATION_MS = 45_000;
const DEFAULT_FRAME_RATE = 10;
const MAX_ALLOWED_DURATION_MS = 120_000;
const MAX_ALLOWED_FRAME_RATE = 30;
const MAX_FRAME_COUNT = 2_000;
const MAX_FRAME_TEMP_BYTES = 200 * 1024 * 1024;
const WEBM_VIDEO_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;
const WEBM_VIDEO_FILENAME = "happy-path.webm";
export const DEFAULT_STATE_ROOT = "/tmp/cycloid-recorder";
export const OPERATOR_EVIDENCE_ROOT = "/tmp/phase-evidence/operator";
const MANIFEST_FILENAME = "manifest.json";
const RECORDER_ERROR_LOG_FILENAME = "recorder-error.log";
const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const SIDECAR_READY_TIMEOUT_MS = 30_000;
const CHROMIUM_EXECUTABLE_CANDIDATES = [
  "/usr/local/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

export class RecorderCliError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "RecorderCliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export function usage() {
  return `Usage: cycloid-recorder [--json] <command> [options]

Recorder-owned browser evidence helper for Cycloid sandboxes.

Commands:
  start   --out-dir <dir> [--storage-state <state.json>] [--viewport 1280x720] [--max-duration-ms 45000] [--frame-rate 10]
  record  --id <recorderId> [--label <label>]
  stop    --id <recorderId> [--label <label>]
  shot    --id <recorderId> <label>
  close   --id <recorderId>

Global options:
  --json          Print machine-readable errors.
  -h, --help      Show this help text.

Phase 4 supports recorder-owned browser start/close, screenshots, CDP
screencast recording, VP8 WebM output, cursor/click overlays, and a private
manifest.`;
}

function commandUsage(command) {
  if (command === "start") {
    return `Usage: cycloid-recorder start --out-dir <dir> [--storage-state <state.json>] [--viewport 1280x720] [--max-duration-ms 45000] [--frame-rate 10]`;
  }
  if (command === "record") {
    return `Usage: cycloid-recorder record --id <recorderId> [--label <label>]`;
  }
  if (command === "stop") {
    return `Usage: cycloid-recorder stop --id <recorderId> [--label <label>]`;
  }
  if (command === "shot") {
    return `Usage: cycloid-recorder shot --id <recorderId> <label>`;
  }
  if (command === "close") {
    return `Usage: cycloid-recorder close --id <recorderId>`;
  }
  return usage();
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new RecorderCliError("invalid_argument", `${flag} requires a value`, {
      hint: "Run `cycloid-recorder --help`.",
    });
  }
  return value;
}

function readPositiveInt(argv, index, flag) {
  const value = readValue(argv, index, flag);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RecorderCliError("invalid_argument", `${flag} must be a positive integer`, {
      hint: commandUsage("start"),
    });
  }
  return parsed;
}

function readBoundedPositiveInt(argv, index, flag, max) {
  const parsed = readPositiveInt(argv, index, flag);
  if (parsed > max) {
    throw new RecorderCliError("invalid_argument", `${flag} must be ${max} or less`, {
      hint: commandUsage("start"),
    });
  }
  return parsed;
}

function readViewport(value) {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (!match) {
    throw new RecorderCliError("invalid_argument", "--viewport must use WIDTHxHEIGHT, for example 1280x720", {
      hint: commandUsage("start"),
    });
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function rejectExtraPositionals(command, positionals) {
  if (positionals.length === 0) {
    return;
  }
  throw new RecorderCliError("invalid_argument", `${command} received unexpected argument: ${positionals[0]}`, {
    hint: commandUsage(command),
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function loadJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonFile(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendTextFile(path, value) {
  appendFileSync(path, value, "utf8");
}

function currentIso(deps = {}) {
  const now = deps.now ? deps.now() : new Date();
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function readLogTail(path) {
  if (!existsSync(path)) {
    return "";
  }
  const text = readFileSync(path, "utf8").trim();
  if (!text) {
    return "";
  }
  return text.slice(-2_000);
}

function pathIsInside(root, candidate) {
  const childRelative = relative(root, candidate);
  return (
    childRelative === "" ||
    (childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative))
  );
}

export function operatorEvidenceRoot() {
  return join(process.env.ARCANIST_PHASE_EVIDENCE_DIR || "/tmp/phase-evidence", "operator");
}

function ensureContainedExistingOutDir(outDir) {
  const operatorRoot = operatorEvidenceRoot();
  const root = resolve(operatorRoot);
  const requested = resolve(outDir);
  if (!pathIsInside(root, requested)) {
    throw new RecorderCliError("invalid_out_dir", `Recorder state outDir must stay under ${operatorRoot}`);
  }
  mkdirSync(root, { recursive: true });
  mkdirSync(requested, { recursive: true });
  const realRoot = realpathSync(root);
  const realRequested = realpathSync(requested);
  if (!pathIsInside(realRoot, realRequested)) {
    throw new RecorderCliError("invalid_out_dir", `Recorder state outDir must stay under ${operatorRoot}`);
  }
  return requested;
}

function ensureContainedOutDir(outDir) {
  const operatorRoot = operatorEvidenceRoot();
  const root = resolve(operatorRoot);
  const requested = resolve(outDir);
  if (!pathIsInside(root, requested)) {
    throw new RecorderCliError("invalid_out_dir", `--out-dir must stay under ${operatorRoot}`, {
      hint: commandUsage("start"),
    });
  }

  mkdirSync(root, { recursive: true });
  mkdirSync(requested, { recursive: true });
  const realRoot = realpathSync(root);
  const realRequested = realpathSync(requested);
  if (!pathIsInside(realRoot, realRequested)) {
    throw new RecorderCliError("invalid_out_dir", `--out-dir must stay under ${operatorRoot}`, {
      hint: commandUsage("start"),
    });
  }
  return requested;
}

function validateStorageState(storageState) {
  if (!storageState) {
    return undefined;
  }
  const storageStatePath = resolve(storageState);
  try {
    accessSync(storageStatePath, fsConstants.R_OK);
    const stats = statSync(storageStatePath);
    if (!stats.isFile()) {
      throw new Error("not a file");
    }
    const parsed = loadJsonFile(storageStatePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RecorderCliError("invalid_storage_state", `--storage-state is not readable Playwright JSON: ${detail}`, {
      hint: commandUsage("start"),
    });
  }
  return storageStatePath;
}

function createRecorderId() {
  return `rec_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function statePath(stateRoot, recorderId) {
  return join(stateRoot, recorderId, "state.json");
}

function manifestPath(outDir) {
  return join(outDir, MANIFEST_FILENAME);
}

function recorderErrorLogPath(outDir) {
  return join(outDir, RECORDER_ERROR_LOG_FILENAME);
}

function assertRecorderId(recorderId) {
  if (!/^rec_[a-f0-9]{16}$/.test(recorderId)) {
    throw new RecorderCliError("invalid_recorder_id", `Invalid recorder id: ${recorderId}`);
  }
}

function normalizeLoopbackUrl(rawUrl, expectedProtocol) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RecorderCliError("invalid_cdp_url", "Recorder sidecar returned an invalid CDP URL");
  }
  if (url.protocol !== expectedProtocol) {
    throw new RecorderCliError("invalid_cdp_url", `Recorder URL must use ${expectedProtocol}`);
  }
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new RecorderCliError("invalid_cdp_url", "Recorder CDP URL must be loopback-only");
  }
  if (url.hostname === "[::1]") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of [
    "playwright",
    "/usr/lib/node_modules/playwright",
    "/usr/local/lib/node_modules/playwright",
    join(process.env.NODE_PATH ?? "", "playwright"),
  ]) {
    try {
      return require(candidate);
    } catch {
      // Try the next globally installed location.
    }
  }
  throw new Error("Playwright is not installed; the sandbox template must install playwright globally");
}

export function resolveChromiumExecutable() {
  for (const candidate of CHROMIUM_EXECUTABLE_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const { chromium } = loadPlaywright();
  const playwrightPath = chromium.executablePath();
  if (existsSync(playwrightPath)) {
    return playwrightPath;
  }
  const cachedPath = resolveInstalledPlaywrightChromium(playwrightPath);
  if (cachedPath) {
    return cachedPath;
  }
  throw new Error(
    `Chromium is required for cycloid-recorder; checked ${CHROMIUM_EXECUTABLE_CANDIDATES.join(", ")}, ${playwrightPath}`,
  );
}

function resolveInstalledPlaywrightChromium(expectedPath) {
  const marker = `${sep}chromium-`;
  const markerIndex = expectedPath.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const suffixStart = expectedPath.indexOf(sep, markerIndex + marker.length);
  if (suffixStart < 0) {
    return undefined;
  }
  const cacheRoot = expectedPath.slice(0, markerIndex);
  const suffix = expectedPath.slice(suffixStart + 1);
  if (!existsSync(cacheRoot)) {
    return undefined;
  }
  const revisions = readdirSync(cacheRoot)
    .map((entry) => {
      const match = /^chromium-(\d+)$/.exec(entry);
      return match ? { entry, revision: Number(match[1]) } : undefined;
    })
    .filter((entry) => entry !== undefined)
    .sort((left, right) => right.revision - left.revision);
  for (const revision of revisions) {
    const candidate = join(cacheRoot, revision.entry, suffix);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function waitForBrowserWebSocket(port) {
  const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const body = await response.json();
        if (typeof body.webSocketDebuggerUrl === "string") {
          return normalizeLoopbackUrl(body.webSocketDebuggerUrl, "ws:");
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chromium CDP endpoint: ${lastError}`);
}

async function waitForDevToolsPort(userDataDir) {
  const path = join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILENAME);
  const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        const [portLine] = readFileSync(path, "utf8").trim().split(/\r?\n/);
        const port = Number(portLine);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          return port;
        }
        lastError = "invalid port file";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Chromium ${DEVTOOLS_ACTIVE_PORT_FILENAME}: ${lastError}`);
}

function parseStorageStateForInit(storageStatePath) {
  if (!storageStatePath) {
    return { cookies: [], origins: [] };
  }
  const parsed = loadJsonFile(storageStatePath);
  return {
    cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
    origins: Array.isArray(parsed.origins) ? parsed.origins : [],
  };
}

function createManifest({ label = null, outcomeLabel = null, startedAt, viewport, lifecycleStatus }) {
  return {
    schemaVersion: 1,
    tool: "cycloid-recorder",
    label,
    outcomeLabel,
    lifecycleStatus,
    startedAt,
    stoppedAt: null,
    durationMs: null,
    viewport,
    video: null,
    screenshots: [],
    actions: [],
    redactions: {
      inputValuesRendered: false,
      storageStateCopied: false,
      cdpUrlPublished: false,
    },
  };
}

const RECORDER_OVERLAY_VERSION = 1;
const TOKEN_LIKE_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+=_-]{40,}|[a-f0-9]{32,})\b/gi;

export function redactTokenLikeText(value, fallback = "action") {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const redacted = trimmed.replace(TOKEN_LIKE_PATTERN, "[redacted]").slice(0, 120).trim();
  return redacted || fallback;
}

function sanitizeRecorderLabel(label) {
  if (typeof label !== "string") {
    return null;
  }
  const sanitized = redactTokenLikeText(label, "action");
  return sanitized === "action" && !label.trim() ? null : sanitized;
}

export function clampOverlayCoordinate(value, max) {
  const parsed = Number(value);
  const upperBound = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 0;
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(upperBound, Math.max(0, Math.round(parsed)));
}

export function clampOverlayPoint(point, viewport) {
  return {
    x: clampOverlayCoordinate(point?.x, viewport?.width),
    y: clampOverlayCoordinate(point?.y, viewport?.height),
  };
}

export function shouldReinjectRecorderOverlay({ existingVersion, isTopLevelNavigation, isSpaRouteChange }) {
  return existingVersion !== RECORDER_OVERLAY_VERSION || isTopLevelNavigation === true || isSpaRouteChange === true;
}

export function shouldAckScreencastFrame(currentRecording) {
  return currentRecording?.abortStarted !== true;
}

function sanitizeManifestUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const parsed = new URL(value, "http://recorder.local");
    const sanitized = `${parsed.origin}${parsed.pathname}`;
    return redactTokenLikeText(sanitized, null);
  } catch {
    return null;
  }
}

export function sanitizeManifestAction(action, viewport) {
  if (!action || typeof action !== "object") {
    return null;
  }
  const type = typeof action.type === "string" ? redactTokenLikeText(action.type, "action") : "action";
  const label = sanitizeRecorderLabel(action.label) ?? type;
  const point = clampOverlayPoint(action.target, viewport);
  const width = clampOverlayCoordinate(action.target?.width, viewport?.width);
  const height = clampOverlayCoordinate(action.target?.height, viewport?.height);
  const startedAtMs = Number(action.startedAtMs);
  return {
    id: typeof action.id === "string" && /^act_\d+$/.test(action.id) ? action.id : `act_${Date.now()}`,
    type,
    label,
    urlBefore: sanitizeManifestUrl(action.urlBefore),
    urlAfter: sanitizeManifestUrl(action.urlAfter),
    target: {
      x: point.x,
      y: point.y,
      width,
      height,
    },
    startedAtMs: Number.isFinite(startedAtMs) && startedAtMs >= 0 ? Math.round(startedAtMs) : null,
    completedAtMs: null,
    status: "success",
  };
}

export function createRecorderOverlayScript() {
  return `(() => {
  const VERSION = ${RECORDER_OVERLAY_VERSION};
  const TOKEN_LIKE_PATTERN = ${TOKEN_LIKE_PATTERN.toString()};
  const ROOT_ID = "__cycloid-recorder-overlay";
  const STYLE_ID = "__cycloid-recorder-overlay-style";
  const MAX_ACTIONS = 250;

  function redactLabel(value, fallback = "action") {
    if (typeof value !== "string") {
      return fallback;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    const redacted = trimmed.replace(TOKEN_LIKE_PATTERN, "[redacted]").slice(0, 80).trim();
    return redacted || fallback;
  }

  function viewport() {
    const doc = document.documentElement;
    return {
      width: window.innerWidth || doc.clientWidth || 0,
      height: window.innerHeight || doc.clientHeight || 0,
    };
  }

  function clamp(value, max) {
    const parsed = Number(value);
    const upper = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 0;
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return Math.min(upper, Math.max(0, Math.round(parsed)));
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(value || window.location.href, window.location.href);
      return redactLabel(parsed.origin + parsed.pathname, null);
    } catch {
      return null;
    }
  }

  const previous = window.__cycloidRecorder;
  if (previous && previous.version === VERSION && typeof previous.reinstall === "function") {
    previous.reinstall();
    return;
  }

  const state = {
    installedAt: performance.now(),
    actions: [],
    labelTimer: null,
    routeUrl: safeUrl(window.location.href),
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = \`
      #\${ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        overflow: hidden;
        contain: layout style paint;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #\${ROOT_ID} .arc-recorder-cursor {
        position: fixed;
        left: 0;
        top: 0;
        width: 16px;
        height: 16px;
        border: 2px solid #ffffff;
        border-radius: 999px;
        background: rgba(14, 165, 233, 0.95);
        box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.75), 0 8px 20px rgba(0, 0, 0, 0.28);
        transform: translate(-40px, -40px);
        transition: transform 120ms ease-out;
      }
      #\${ROOT_ID} .arc-recorder-ring {
        position: fixed;
        width: 38px;
        height: 38px;
        margin-left: -19px;
        margin-top: -19px;
        border: 3px solid #f97316;
        border-radius: 999px;
        box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.9), 0 0 16px rgba(249, 115, 22, 0.65);
        animation: arc-recorder-ring 520ms ease-out forwards;
      }
      #\${ROOT_ID} .arc-recorder-label {
        position: fixed;
        left: 14px;
        bottom: 14px;
        max-width: min(360px, calc(100vw - 28px));
        padding: 5px 8px;
        border-radius: 6px;
        background: rgba(17, 24, 39, 0.92);
        color: #ffffff;
        font-size: 12px;
        line-height: 1.25;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.25);
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 120ms ease-out, transform 120ms ease-out;
      }
      #\${ROOT_ID} .arc-recorder-label[data-visible="true"] {
        opacity: 1;
        transform: translateY(0);
      }
      @keyframes arc-recorder-ring {
        0% { opacity: 0.95; transform: scale(0.45); }
        100% { opacity: 0; transform: scale(1.35); }
      }
    \`;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRoot() {
    ensureStyle();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.setAttribute("aria-hidden", "true");
      root.innerHTML = '<div class="arc-recorder-cursor"></div><div class="arc-recorder-label"></div>';
      (document.body || document.documentElement).appendChild(root);
    }
    return root;
  }

  function cursor() {
    return ensureRoot().querySelector(".arc-recorder-cursor");
  }

  function labelElement() {
    return ensureRoot().querySelector(".arc-recorder-label");
  }

  function pointFromEvent(event) {
    const size = viewport();
    if (typeof event.clientX === "number" && typeof event.clientY === "number") {
      return {
        x: clamp(event.clientX, size.width),
        y: clamp(event.clientY, size.height),
      };
    }
    const target = event.target && typeof event.target.getBoundingClientRect === "function" ? event.target : null;
    if (target) {
      const rect = target.getBoundingClientRect();
      return {
        x: clamp(rect.left + rect.width / 2, size.width),
        y: clamp(rect.top + rect.height / 2, size.height),
      };
    }
    return { x: 0, y: 0 };
  }

  function targetBox(event, point) {
    const size = viewport();
    const target = event.target && typeof event.target.getBoundingClientRect === "function" ? event.target : null;
    if (!target) {
      return { x: point.x, y: point.y, width: 0, height: 0 };
    }
    const rect = target.getBoundingClientRect();
    return {
      x: clamp(rect.left, size.width),
      y: clamp(rect.top, size.height),
      width: clamp(rect.width, size.width),
      height: clamp(rect.height, size.height),
    };
  }

  function moveCursor(x, y) {
    const point = {
      x: clamp(x, viewport().width),
      y: clamp(y, viewport().height),
    };
    const node = cursor();
    if (node) {
      node.style.transform = \`translate(\${point.x - 8}px, \${point.y - 8}px)\`;
    }
    return point;
  }

  function note(label) {
    const node = labelElement();
    if (!node) {
      return;
    }
    node.textContent = redactLabel(label, "action");
    node.dataset.visible = "true";
    if (state.labelTimer) {
      window.clearTimeout(state.labelTimer);
    }
    state.labelTimer = window.setTimeout(() => {
      node.dataset.visible = "false";
    }, 900);
  }

  function hideLabel() {
    const node = labelElement();
    if (node) {
      node.dataset.visible = "false";
    }
  }

  function remember(type, label, point, target) {
    const action = {
      id: \`act_\${state.actions.length + 1}\`,
      type: redactLabel(type, "action"),
      label: redactLabel(label, "action"),
      urlBefore: safeUrl(window.location.href),
      urlAfter: safeUrl(window.location.href),
      target,
      startedAtMs: Math.max(0, Math.round(performance.now() - state.installedAt)),
      status: "success",
    };
    state.actions.push(action);
    if (state.actions.length > MAX_ACTIONS) {
      state.actions.splice(0, state.actions.length - MAX_ACTIONS);
    }
    window.setTimeout(() => {
      action.urlAfter = safeUrl(window.location.href);
    }, 120);
    return action;
  }

  function showClick(x, y, label = "click") {
    const point = moveCursor(x, y);
    const ring = document.createElement("div");
    ring.className = "arc-recorder-ring";
    ring.style.left = \`\${point.x}px\`;
    ring.style.top = \`\${point.y}px\`;
    ensureRoot().appendChild(ring);
    window.setTimeout(() => ring.remove(), 650);
    note(label);
    return point;
  }

  function handlePointer(event) {
    const point = pointFromEvent(event);
    moveCursor(point.x, point.y);
  }

  function handleClick(event) {
    const point = pointFromEvent(event);
    showClick(point.x, point.y, "click");
    remember("click", "click", point, targetBox(event, point));
  }

  function handleGeneric(event, type, label) {
    const point = pointFromEvent(event);
    moveCursor(point.x, point.y);
    note(label);
    remember(type, label, point, targetBox(event, point));
  }

  function handleRouteChange() {
    const nextUrl = safeUrl(window.location.href);
    if (nextUrl && nextUrl !== state.routeUrl) {
      state.routeUrl = nextUrl;
      ensureRoot();
      note("route changed");
    }
  }

  const listenerOptions = { capture: true, passive: true };
  document.addEventListener("pointerdown", handlePointer, listenerOptions);
  document.addEventListener("click", handleClick, listenerOptions);
  document.addEventListener("input", (event) => handleGeneric(event, "input", "input changed"), listenerOptions);
  document.addEventListener("change", (event) => handleGeneric(event, "change", "selection changed"), listenerOptions);
  document.addEventListener("submit", (event) => handleGeneric(event, "submit", "form submitted"), listenerOptions);
  document.addEventListener("scroll", (event) => handleGeneric(event, "scroll", "scroll"), listenerOptions);
  document.addEventListener("keydown", (event) => handleGeneric(event, "keydown", "key pressed"), listenerOptions);
  window.addEventListener("popstate", handleRouteChange, listenerOptions);

  for (const method of ["pushState", "replaceState"]) {
    const original = window.history[method];
    if (typeof original === "function") {
      window.history[method] = function recorderHistoryWrapper(...args) {
        const result = original.apply(this, args);
        window.setTimeout(handleRouteChange, 0);
        return result;
      };
    }
  }

  const observer = new MutationObserver(() => {
    if (!document.getElementById(ROOT_ID)) {
      ensureRoot();
    }
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  ensureRoot();
  window.__cycloidRecorder = {
    version: VERSION,
    showClick,
    note,
    hideLabel,
    exportActions: () => state.actions.map((action) => ({ ...action, target: { ...action.target } })),
    reinstall: ensureRoot,
  };
})();`;
}

function readManifestForState(state) {
  const outDir = ensureContainedExistingOutDir(state.outDir);
  const path = manifestPath(outDir);
  if (existsSync(path)) {
    return loadJsonFile(path);
  }
  return createManifest({
    startedAt: state.createdAt ?? currentIso(),
    viewport: state.viewport,
    lifecycleStatus: state.lifecycleStatus ?? "idle",
  });
}

function writeManifestForState(state, manifest) {
  const outDir = ensureContainedExistingOutDir(state.outDir);
  writeJsonFile(manifestPath(outDir), manifest);
}

function durationFrom(startedAt, stoppedAt) {
  const started = Date.parse(startedAt);
  const stopped = Date.parse(stoppedAt);
  if (!Number.isFinite(started) || !Number.isFinite(stopped) || stopped < started) {
    return null;
  }
  return stopped - started;
}

function flushManifestFailure(state, error, deps = {}) {
  try {
    const stoppedAt = currentIso(deps);
    const manifest = readManifestForState(state);
    writeManifestForState(state, {
      ...manifest,
      lifecycleStatus: "failed",
      stoppedAt,
      durationMs: durationFrom(manifest.startedAt, stoppedAt),
      lastError: {
        message: error instanceof Error ? error.message : String(error),
      },
    });
  } catch {
    // Failure flushing is best-effort and must not hide the original command error.
  }
}

function writeRecorderErrorLog(outDir, error, details = {}) {
  const safeOutDir = ensureContainedExistingOutDir(outDir);
  const message = error instanceof Error ? error.message : String(error);
  appendTextFile(
    recorderErrorLogPath(safeOutDir),
    `${JSON.stringify({
      at: new Date().toISOString(),
      message,
      ...details,
    })}\n`,
  );
}

function frameDirectory(outDir) {
  return join(ensureContainedExistingOutDir(outDir), ".frames");
}

function videoPath(outDir) {
  return join(ensureContainedExistingOutDir(outDir), WEBM_VIDEO_FILENAME);
}

function removeFileBestEffort(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort cleanup must not hide the original recorder failure.
  }
}

function removeDirectoryBestEffort(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup must not hide the original recorder failure.
  }
}

export function cleanupFailedCaptureArtifacts({ outDir, frameDir, keepFrames = false }) {
  const safeOutDir = ensureContainedExistingOutDir(outDir);
  removeFileBestEffort(videoPath(safeOutDir));
  if (!keepFrames) {
    try {
      const safeFrameDir = resolve(frameDir);
      if (pathIsInside(safeOutDir, safeFrameDir)) {
        removeDirectoryBestEffort(safeFrameDir);
      }
    } catch {
      // Best-effort cleanup must not hide the original recorder failure.
    }
  }
}

function runProcess(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) {
        stderr = stderr.slice(-8_000);
      }
    });
    child.once("error", rejectRun);
    child.once("close", (code) => {
      if (code === 0) {
        resolveRun({ stderr });
        return;
      }
      rejectRun(new Error(`ffmpeg exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

export async function encodeFramesToWebm(
  { outDir, frameDir, frameRate, videoFilename = WEBM_VIDEO_FILENAME },
  deps = {},
) {
  const safeOutDir = ensureContainedExistingOutDir(outDir);
  const safeFrameDir = resolve(frameDir);
  if (!pathIsInside(safeOutDir, safeFrameDir)) {
    throw new RecorderCliError("invalid_frame_dir", "Frame temp directory must stay under the recorder outDir");
  }
  const outputPath = resolve(safeOutDir, videoFilename);
  if (!pathIsInside(safeOutDir, outputPath) || !outputPath.endsWith(".webm")) {
    throw new RecorderCliError("invalid_video_path", "Video output path must stay under the recorder outDir");
  }

  await (deps.runProcess ?? runProcess)("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-framerate",
    String(frameRate),
    "-start_number",
    "1",
    "-i",
    join(safeFrameDir, "frame-%06d.jpg"),
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-cpu-used",
    "4",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outputPath,
  ]);

  const sizeBytes = statSync(outputPath).size;
  if (sizeBytes > WEBM_VIDEO_SIZE_LIMIT_BYTES) {
    removeFileBestEffort(outputPath);
    throw new RecorderCliError(
      "video_too_large",
      `Encoded WebM is ${sizeBytes} bytes, exceeding the ${WEBM_VIDEO_SIZE_LIMIT_BYTES} byte publish limit`,
    );
  }
  return { video: videoFilename, path: outputPath, sizeBytes };
}

export function sanitizeScreenshotFilename(label) {
  if (typeof label !== "string" || label.trim() === "") {
    throw new RecorderCliError("invalid_screenshot_label", "Screenshot label must be a non-empty string");
  }
  if (/[\\/]/.test(label) || label.split(/[\\/]+/).some((part) => part === "..")) {
    throw new RecorderCliError("invalid_screenshot_label", "Screenshot label must not contain path separators");
  }
  const withoutExtension = redactTokenLikeText(label, "screenshot")
    .trim()
    .replace(/\.png$/i, "");
  const sanitized = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_]{2,}/g, "-")
    .slice(0, 96);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new RecorderCliError("invalid_screenshot_label", "Screenshot label did not produce a safe filename");
  }
  return `${sanitized}.png`;
}

function resolveScreenshotPath(outDir, label) {
  const safeOutDir = ensureContainedExistingOutDir(outDir);
  const filename = sanitizeScreenshotFilename(label);
  const outputPath = resolve(safeOutDir, filename);
  if (!pathIsInside(safeOutDir, outputPath)) {
    throw new RecorderCliError("invalid_screenshot_label", "Screenshot path must stay under the recorder outDir");
  }
  return { filename, outputPath };
}

function readRequestBody(request) {
  return new Promise((resolveRead, rejectRead) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        rejectRead(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolveRead(body ? JSON.parse(body) : {});
      } catch {
        rejectRead(new Error("request body must be JSON"));
      }
    });
    request.on("error", rejectRead);
  });
}

function writeJsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function activePage(context) {
  const pages = context.pages();
  if (pages.length === 0) {
    throw new Error("Recorder browser has no active page");
  }
  return pages[pages.length - 1];
}

async function waitForPageFonts(page) {
  await page.evaluate(async () => {
    const fontSet = document.fonts;
    if (!fontSet || typeof fontSet.ready?.then !== "function") {
      return;
    }
    await Promise.race([
      fontSet.ready,
      new Promise((resolve) => {
        window.setTimeout(resolve, 5000);
      }),
    ]);
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
  });
}

async function applyStorageState(context, storageStatePath) {
  const state = parseStorageStateForInit(storageStatePath);
  if (state.cookies.length > 0) {
    await context.addCookies(state.cookies);
  }
  const localStorageByOrigin = state.origins
    .filter((entry) => typeof entry?.origin === "string" && Array.isArray(entry.localStorage))
    .map((entry) => ({
      origin: entry.origin,
      localStorage: entry.localStorage
        .filter((item) => typeof item?.name === "string" && typeof item?.value === "string")
        .map((item) => ({ name: item.name, value: item.value })),
    }))
    .filter((entry) => entry.localStorage.length > 0);
  if (localStorageByOrigin.length > 0) {
    await context.addInitScript((origins) => {
      const match = origins.find((entry) => entry.origin === window.location.origin);
      if (!match) {
        return;
      }
      for (const item of match.localStorage) {
        window.localStorage.setItem(item.name, item.value);
      }
    }, localStorageByOrigin);
  }
}

async function listenOnLoopback(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to bind recorder control server");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function runSidecar(configPath) {
  const config = loadJsonFile(configPath);
  const { chromium } = loadPlaywright();
  const executablePath = resolveChromiumExecutable();

  let context;
  let server;
  let closing = false;
  let recording = null;
  let recordingCompleted = false;
  let overlayInitInstalled = false;

  async function closeAndExit(exitCode) {
    if (closing) {
      return;
    }
    closing = true;
    try {
      if (context) {
        await context.close();
      }
    } finally {
      if (server) {
        server.close();
      }
      process.exit(exitCode);
    }
  }

  process.once("SIGTERM", () => {
    void closeAndExit(0);
  });
  process.once("SIGINT", () => {
    void closeAndExit(0);
  });

  try {
    rmSync(config.userDataDir, { recursive: true, force: true });
    mkdirSync(config.userDataDir, { recursive: true });
    context = await chromium.launchPersistentContext(config.userDataDir, {
      executablePath,
      headless: true,
      viewport: config.viewport,
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${config.cdpPort}`,
      ],
    });
    await applyStorageState(context, config.storageState);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize(config.viewport);

    function writeSidecarManifest(patch) {
      const manifest = readManifestForState(config);
      writeManifestForState(config, {
        ...manifest,
        ...patch,
        updatedAt: currentIso(),
      });
    }

    async function failRecording(error, patch = {}) {
      writeRecorderErrorLog(config.outDir, error, patch);
      const stoppedAt = currentIso();
      const manifest = readManifestForState(config);
      writeManifestForState(config, {
        ...manifest,
        ...patch,
        lifecycleStatus: "failed",
        stoppedAt,
        durationMs: durationFrom(manifest.startedAt, stoppedAt),
        lastError: {
          message: error instanceof Error ? error.message : String(error),
        },
        updatedAt: stoppedAt,
      });
    }

    async function injectRecorderOverlay(page) {
      try {
        await page.evaluate(createRecorderOverlayScript());
      } catch (error) {
        writeRecorderErrorLog(config.outDir, error, { overlay: "inject_failed" });
      }
    }

    async function ensureRecorderOverlay(page) {
      if (!overlayInitInstalled) {
        await context.addInitScript({ content: createRecorderOverlayScript() });
        overlayInitInstalled = true;
      }
      await injectRecorderOverlay(page);
    }

    async function collectOverlayActions(page) {
      try {
        const actions = await page.evaluate(() => window.__cycloidRecorder?.exportActions?.() ?? []);
        if (!Array.isArray(actions)) {
          return [];
        }
        return actions
          .map((action) => sanitizeManifestAction(action, config.viewport))
          .filter((action) => action !== null);
      } catch (error) {
        writeRecorderErrorLog(config.outDir, error, { overlay: "actions_unavailable" });
        return [];
      }
    }

    async function stopCapture({ outcomeLabel = null, reason = "manual" } = {}) {
      const safeOutcomeLabel = sanitizeRecorderLabel(outcomeLabel);
      if (!recording) {
        if (recordingCompleted) {
          const manifest = readManifestForState(config);
          return {
            video: typeof manifest.video === "string" ? manifest.video : WEBM_VIDEO_FILENAME,
            path: videoPath(config.outDir),
            manifest: manifestPath(config.outDir),
            frameCount: typeof manifest.recording?.frameCount === "number" ? manifest.recording.frameCount : null,
            droppedFrames:
              typeof manifest.recording?.droppedFrames === "number" ? manifest.recording.droppedFrames : null,
            sizeBytes: typeof manifest.recording?.sizeBytes === "number" ? manifest.recording.sizeBytes : null,
            autoStopped: manifest.lifecycleStatus === "auto_stopped",
            stopReason: manifest.recording?.stopReason ?? "already_stopped",
          };
        }
        throw new Error("Recorder is not recording");
      }
      if (recording.stopping) {
        throw new Error("Recorder is already stopping");
      }

      const currentRecording = recording;
      currentRecording.stopping = true;
      if (currentRecording.stopTimer) {
        clearTimeout(currentRecording.stopTimer);
      }

      let overlayActions = [];
      try {
        try {
          currentRecording.page.off("framenavigated", currentRecording.onFrameNavigated);
        } catch {
          // Best-effort listener cleanup when the page is already gone.
        }
        try {
          currentRecording.cdp.off("Page.screencastFrame", currentRecording.onFrame);
        } catch {
          // Older CDP session implementations still stop after Page.stopScreencast.
        }
        await currentRecording.cdp.send("Page.stopScreencast");
        await currentRecording.cdp.detach();
        overlayActions = await collectOverlayActions(currentRecording.page);
        const encodeResult = await encodeFramesToWebm({
          outDir: config.outDir,
          frameDir: currentRecording.frameDir,
          frameRate: config.frameRate,
        });
        const stoppedAt = currentIso();
        const manifest = readManifestForState(config);
        const lifecycleStatus = reason === "duration_limit" || reason === "frame_limit" ? "auto_stopped" : "completed";
        writeManifestForState(config, {
          ...manifest,
          outcomeLabel: safeOutcomeLabel,
          lifecycleStatus,
          stoppedAt,
          durationMs: durationFrom(manifest.startedAt, stoppedAt),
          video: encodeResult.video,
          actions: overlayActions,
          recording: {
            frameCount: currentRecording.frameCount,
            droppedFrames: currentRecording.droppedFrames,
            tempFrameBytes: currentRecording.tempFrameBytes,
            stopReason: reason,
            sizeBytes: encodeResult.sizeBytes,
          },
          updatedAt: stoppedAt,
        });
        if (!config.keepFrames) {
          rmSync(currentRecording.frameDir, { recursive: true, force: true });
        }
        recording = null;
        recordingCompleted = true;
        return {
          video: encodeResult.video,
          path: encodeResult.path,
          manifest: manifestPath(config.outDir),
          frameCount: currentRecording.frameCount,
          droppedFrames: currentRecording.droppedFrames,
          sizeBytes: encodeResult.sizeBytes,
          autoStopped: lifecycleStatus === "auto_stopped",
          stopReason: reason,
        };
      } catch (error) {
        recording = null;
        cleanupFailedCaptureArtifacts({
          outDir: config.outDir,
          frameDir: currentRecording.frameDir,
          keepFrames: config.keepFrames,
        });
        await failRecording(error, {
          recording: {
            frameCount: currentRecording.frameCount,
            droppedFrames: currentRecording.droppedFrames,
            tempFrameBytes: currentRecording.tempFrameBytes,
            stopReason: reason,
          },
          actions: overlayActions,
        });
        throw error;
      }
    }

    async function requestAutoStop(reason) {
      if (!recording || recording.stopping) {
        return;
      }
      try {
        await stopCapture({
          reason,
          outcomeLabel: reason === "duration_limit" ? "max duration reached" : "frame limit reached",
        });
      } catch {
        // stopCapture already wrote recorder-error.log and a partial manifest.
      }
    }

    async function abortRecording(currentRecording, error, patch) {
      currentRecording.abortStarted = true;
      currentRecording.stopping = true;
      if (currentRecording.stopTimer) {
        clearTimeout(currentRecording.stopTimer);
      }
      try {
        currentRecording.page.off("framenavigated", currentRecording.onFrameNavigated);
      } catch {
        // Best-effort cleanup after capture failure.
      }
      try {
        currentRecording.cdp.off("Page.screencastFrame", currentRecording.onFrame);
      } catch {
        // Best-effort cleanup after capture failure.
      }
      try {
        await currentRecording.cdp.send("Page.stopScreencast");
      } catch {
        // Best-effort cleanup after capture failure.
      }
      try {
        await currentRecording.cdp.detach();
      } catch {
        // Best-effort cleanup after capture failure.
      }
      if (recording === currentRecording) {
        recording = null;
      }
      await failRecording(error, patch);
    }

    async function writeScreencastFrame(frame) {
      if (!recording || recording.stopping) {
        return;
      }
      const currentRecording = recording;
      try {
        const now = Date.now();
        if (
          currentRecording.lastFrameAtMs !== null &&
          now - currentRecording.lastFrameAtMs < currentRecording.frameIntervalMs
        ) {
          currentRecording.droppedFrames += 1;
          return;
        }
        if (currentRecording.frameCount >= currentRecording.maxFrameCount) {
          currentRecording.droppedFrames += 1;
          void requestAutoStop("frame_limit");
          return;
        }
        const data = Buffer.from(frame.data, "base64");
        if (currentRecording.tempFrameBytes + data.byteLength > MAX_FRAME_TEMP_BYTES) {
          throw new Error(`Frame temp directory exceeded ${MAX_FRAME_TEMP_BYTES} bytes`);
        }
        currentRecording.frameCount += 1;
        currentRecording.lastFrameAtMs = now;
        currentRecording.tempFrameBytes += data.byteLength;
        const framePath = join(
          currentRecording.frameDir,
          `frame-${String(currentRecording.frameCount).padStart(6, "0")}.jpg`,
        );
        writeFileSync(framePath, data);
        appendTextFile(
          currentRecording.timestampsPath,
          `${JSON.stringify({
            frame: currentRecording.frameCount,
            timestamp: frame.metadata?.timestamp ?? null,
            receivedAtMs: now - currentRecording.startedAtMs,
          })}\n`,
        );
      } catch (error) {
        currentRecording.droppedFrames += 1;
        await abortRecording(currentRecording, error, {
          recording: {
            frameCount: currentRecording.frameCount,
            droppedFrames: currentRecording.droppedFrames,
            tempFrameBytes: currentRecording.tempFrameBytes,
            stopReason: "frame_write_failed",
          },
        });
      } finally {
        if (!shouldAckScreencastFrame(currentRecording)) {
          return;
        }
        try {
          await currentRecording.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
        } catch (error) {
          await abortRecording(currentRecording, error, {
            recording: {
              frameCount: currentRecording.frameCount,
              droppedFrames: currentRecording.droppedFrames,
              tempFrameBytes: currentRecording.tempFrameBytes,
              stopReason: "ack_failed",
            },
          });
        }
      }
    }

    async function startCapture(label = null) {
      if (recording) {
        throw new Error("Recorder is already recording");
      }
      if (recordingCompleted) {
        throw new Error("Recorder already produced a video");
      }
      const active = activePage(context);
      const safeLabel = sanitizeRecorderLabel(label);
      await ensureRecorderOverlay(active);
      const cdp = await context.newCDPSession(active);
      const frames = frameDirectory(config.outDir);
      rmSync(frames, { recursive: true, force: true });
      mkdirSync(frames, { recursive: true });
      const timestampsPath = join(frames, "timestamps.jsonl");
      writeFileSync(timestampsPath, "");
      const startedAt = currentIso();
      const maxFrameCount = Math.min(
        MAX_FRAME_COUNT,
        Math.ceil((config.maxDurationMs / 1000) * config.frameRate) + config.frameRate,
      );
      const onFrameNavigated = (frame) => {
        if (
          frame === active.mainFrame() &&
          shouldReinjectRecorderOverlay({
            existingVersion: null,
            isTopLevelNavigation: true,
            isSpaRouteChange: false,
          })
        ) {
          setTimeout(() => {
            void injectRecorderOverlay(active);
          }, 0);
        }
      };
      active.on("framenavigated", onFrameNavigated);
      recording = {
        cdp,
        page: active,
        frameDir: frames,
        timestampsPath,
        frameCount: 0,
        droppedFrames: 0,
        tempFrameBytes: 0,
        lastFrameAtMs: null,
        frameIntervalMs: Math.floor(1000 / config.frameRate),
        startedAtMs: Date.now(),
        maxFrameCount,
        stopping: false,
        stopTimer: null,
        onFrameNavigated,
        onFrame: (frame) => {
          void writeScreencastFrame(frame);
        },
      };
      cdp.on("Page.screencastFrame", recording.onFrame);
      await cdp.send("Page.enable");
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: config.viewport.width,
        maxHeight: config.viewport.height,
        everyNthFrame: 1,
      });
      recording.stopTimer = setTimeout(() => {
        void requestAutoStop("duration_limit");
      }, config.maxDurationMs);
      writeSidecarManifest({
        label: safeLabel,
        startedAt,
        stoppedAt: null,
        durationMs: null,
        lifecycleStatus: "recording",
        video: null,
        recording: {
          frameCount: 0,
          droppedFrames: 0,
          maxFrameCount,
          maxDurationMs: config.maxDurationMs,
          frameRate: config.frameRate,
        },
      });
      return {
        startedAt,
        frameDir: frames,
        maxDurationMs: config.maxDurationMs,
        frameRate: config.frameRate,
        maxFrameCount,
      };
    }

    const control = await listenOnLoopback(async (request, response) => {
      if (request.method !== "POST") {
        writeJsonResponse(response, 404, { error: "not_found" });
        return;
      }
      if (request.url === "/close") {
        let stopResult = null;
        if (recording) {
          try {
            stopResult = await stopCapture({ reason: "close", outcomeLabel: "closed while recording" });
          } catch (error) {
            writeJsonResponse(response, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
            await closeAndExit(1);
            return;
          }
        }
        writeJsonResponse(response, 200, { ok: true, ...(stopResult ? { stopResult } : {}) });
        await closeAndExit(0);
        return;
      }
      if (request.url === "/record") {
        try {
          const body = await readRequestBody(request);
          const result = await startCapture(typeof body.label === "string" ? body.label : null);
          writeJsonResponse(response, 200, { ok: true, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/already recording|already produced a video/i.test(message)) {
            await failRecording(error);
          }
          writeJsonResponse(response, 400, {
            error: message,
          });
        }
        return;
      }
      if (request.url === "/stop") {
        try {
          const body = await readRequestBody(request);
          const result = await stopCapture({
            outcomeLabel: typeof body.label === "string" ? body.label : null,
            reason: "manual",
          });
          writeJsonResponse(response, 200, { ok: true, ...result });
        } catch (error) {
          writeJsonResponse(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (request.url === "/shot") {
        try {
          const body = await readRequestBody(request);
          if (typeof body.path !== "string") {
            throw new Error("shot requires a screenshot path");
          }
          const outDir = ensureContainedExistingOutDir(config.outDir);
          const screenshotPath = resolve(body.path);
          if (!pathIsInside(outDir, screenshotPath)) {
            throw new Error("screenshot path must stay under recorder outDir");
          }
          const page = activePage(context);
          await waitForPageFonts(page);
          await page.screenshot({ path: screenshotPath });
          writeJsonResponse(response, 200, { ok: true, path: screenshotPath });
        } catch (error) {
          writeJsonResponse(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      writeJsonResponse(response, 404, { error: "not_found" });
    });
    server = control.server;

    const cdpPort = Number(config.cdpPort) > 0 ? Number(config.cdpPort) : await waitForDevToolsPort(config.userDataDir);
    const cdpUrl = await waitForBrowserWebSocket(cdpPort);
    writeJsonFile(config.readyPath, {
      pid: process.pid,
      cdpUrl,
      controlUrl: control.url,
    });
  } catch (error) {
    writeJsonFile(config.errorPath, {
      message: error instanceof Error ? error.message : String(error),
    });
    await closeAndExit(1);
  }

  await new Promise(() => undefined);
}

async function launchSidecar(config) {
  writeJsonFile(config.configPath, config);
  const logFd = openSync(config.logPath, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__sidecar", config.configPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();

  const deadline = Date.now() + SIDECAR_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(config.readyPath)) {
      return loadJsonFile(config.readyPath);
    }
    if (existsSync(config.errorPath)) {
      const error = loadJsonFile(config.errorPath);
      const logTail = readLogTail(config.logPath);
      throw new RecorderCliError(
        "browser_start_failed",
        `${error.message ?? "Recorder sidecar failed to start"}${logTail ? `\n${logTail}` : ""}`,
      );
    }
    await sleep(100);
  }
  const logTail = readLogTail(config.logPath);
  throw new RecorderCliError(
    "browser_start_failed",
    `Timed out waiting for recorder sidecar to start${logTail ? `\n${logTail}` : ""}`,
  );
}

export async function startRecorder(options, deps = {}) {
  const stateRoot = deps.stateRoot ?? DEFAULT_STATE_ROOT;
  const outDir = ensureContainedOutDir(options.outDir);
  const storageState = validateStorageState(options.storageState);
  const recorderId = deps.recorderId ?? createRecorderId();
  assertRecorderId(recorderId);
  const createdAt = currentIso(deps);

  const recorderDir = join(stateRoot, recorderId);
  const userDataDir = join(recorderDir, "profile");
  rmSync(recorderDir, { recursive: true, force: true });
  mkdirSync(recorderDir, { recursive: true });
  const initialManifest = createManifest({
    startedAt: createdAt,
    viewport: options.viewport,
    lifecycleStatus: "starting",
  });
  writeJsonFile(manifestPath(outDir), initialManifest);

  const cdpPort = deps.cdpPort ?? 0;
  const sidecarConfig = {
    recorderId,
    outDir,
    storageState,
    viewport: options.viewport,
    maxDurationMs: options.maxDurationMs,
    frameRate: options.frameRate,
    userDataDir,
    cdpPort,
    configPath: join(recorderDir, "sidecar-config.json"),
    readyPath: join(recorderDir, "sidecar-ready.json"),
    errorPath: join(recorderDir, "sidecar-error.json"),
    logPath: join(recorderDir, "sidecar.log"),
    keepFrames: process.env.ARCANIST_RECORDER_KEEP_FRAMES === "1",
  };

  try {
    const launchResult = await (deps.launchSidecar ?? launchSidecar)(sidecarConfig);
    const cdpUrl = normalizeLoopbackUrl(launchResult.cdpUrl, "ws:");
    const controlUrl = normalizeLoopbackUrl(launchResult.controlUrl, "http:");
    const state = {
      schemaVersion: 1,
      recorderId,
      pid: launchResult.pid,
      cdpUrl,
      controlUrl,
      outDir,
      userDataDir,
      viewport: options.viewport,
      maxDurationMs: options.maxDurationMs,
      frameRate: options.frameRate,
      createdAt,
      lifecycleStatus: "idle",
    };
    writeJsonFile(statePath(stateRoot, recorderId), state);
    writeJsonFile(manifestPath(outDir), {
      ...initialManifest,
      lifecycleStatus: "idle",
      updatedAt: currentIso(deps),
    });
    return { recorderId, cdpUrl, outDir };
  } catch (error) {
    flushManifestFailure(
      {
        outDir,
        viewport: options.viewport,
        createdAt,
        lifecycleStatus: "starting",
      },
      error,
      deps,
    );
    rmSync(recorderDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeSidecar(controlUrl) {
  const closeUrl = new URL(controlUrl);
  closeUrl.pathname = "/close";
  closeUrl.search = "";
  closeUrl.hash = "";
  const response = await fetch(closeUrl, { method: "POST" });
  if (!response.ok) {
    let message = `Recorder sidecar returned HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // Preserve the HTTP status message when the sidecar response is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

async function postSidecarJson(controlUrl, pathname, body) {
  const url = new URL(controlUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Recorder sidecar returned HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // Preserve the HTTP status message when the sidecar response is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

async function sidecarShot(controlUrl, screenshotPath) {
  await postSidecarJson(controlUrl, "/shot", { path: screenshotPath });
}

async function sidecarRecord(controlUrl, label) {
  return postSidecarJson(controlUrl, "/record", { label });
}

async function sidecarStop(controlUrl, label) {
  return postSidecarJson(controlUrl, "/stop", { label });
}

function signalRecorderProcess(pid, deps = {}) {
  const killProcess = deps.killProcess ?? ((targetPid, signal) => process.kill(targetPid, signal));
  try {
    killProcess(pid, "SIGTERM");
  } catch {
    // Best-effort cleanup when the sidecar control endpoint cannot be reached.
  }
}

function loadLiveRecorderState(recorderId, deps = {}) {
  assertRecorderId(recorderId);
  const stateRoot = deps.stateRoot ?? DEFAULT_STATE_ROOT;
  const path = statePath(stateRoot, recorderId);
  if (!existsSync(path)) {
    throw new RecorderCliError("unknown_recorder", `Unknown recorder id: ${recorderId}`);
  }

  const state = loadJsonFile(path);
  if (!state.pid || !(deps.isProcessAlive ?? isProcessAlive)(state.pid)) {
    flushManifestFailure(state, new Error(`Recorder is no longer running: ${recorderId}`), deps);
    rmSync(dirname(path), { recursive: true, force: true });
    throw new RecorderCliError("stale_recorder", `Recorder is no longer running: ${recorderId}`);
  }
  return { state, path };
}

export async function takeScreenshot(recorderId, label, deps = {}) {
  const { state } = loadLiveRecorderState(recorderId, deps);
  const { filename, outputPath } = resolveScreenshotPath(state.outDir, label);

  try {
    await (deps.sidecarShot ?? sidecarShot)(state.controlUrl, outputPath);
    const manifest = readManifestForState(state);
    const screenshots = Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
    writeManifestForState(state, {
      ...manifest,
      updatedAt: currentIso(deps),
      screenshots: screenshots.includes(filename) ? screenshots : [...screenshots, filename],
    });
    return { recorderId, outDir: state.outDir, screenshot: filename, path: outputPath };
  } catch (error) {
    flushManifestFailure(state, error, deps);
    throw new RecorderCliError(
      "screenshot_failed",
      `Recorder screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeRecorderState(path, state) {
  writeJsonFile(path, state);
}

export async function startRecording(recorderId, label = null, deps = {}) {
  const { state, path } = loadLiveRecorderState(recorderId, deps);
  const safeLabel = sanitizeRecorderLabel(label);
  if (state.lifecycleStatus === "recording") {
    throw new RecorderCliError("already_recording", `Recorder is already recording: ${recorderId}`);
  }
  if (state.lifecycleStatus === "completed" || state.lifecycleStatus === "auto_stopped") {
    throw new RecorderCliError("recording_completed", `Recorder already produced a video: ${recorderId}`);
  }

  try {
    const result = await (deps.sidecarRecord ?? sidecarRecord)(state.controlUrl, safeLabel);
    const startedAt = result.startedAt ?? currentIso(deps);
    const nextState = {
      ...state,
      lifecycleStatus: "recording",
      recordingStartedAt: startedAt,
    };
    writeRecorderState(path, nextState);
    const manifest = readManifestForState(nextState);
    writeManifestForState(nextState, {
      ...manifest,
      label: safeLabel,
      startedAt,
      stoppedAt: null,
      durationMs: null,
      lifecycleStatus: "recording",
      video: null,
      recording: {
        ...(manifest.recording && typeof manifest.recording === "object" ? manifest.recording : {}),
        frameRate: state.frameRate,
        maxDurationMs: state.maxDurationMs,
        ...(typeof result.maxFrameCount === "number" ? { maxFrameCount: result.maxFrameCount } : {}),
      },
      updatedAt: currentIso(deps),
    });
    return {
      recorderId,
      outDir: state.outDir,
      label: safeLabel,
      startedAt,
      frameRate: state.frameRate,
      maxDurationMs: state.maxDurationMs,
    };
  } catch (error) {
    if (error instanceof RecorderCliError) {
      throw error;
    }
    writeRecorderErrorLog(state.outDir, error);
    flushManifestFailure(state, error, deps);
    throw new RecorderCliError(
      "record_failed",
      `Recorder capture failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function stopRecording(recorderId, label = null, deps = {}) {
  const { state, path } = loadLiveRecorderState(recorderId, deps);
  const safeLabel = sanitizeRecorderLabel(label);
  if (state.lifecycleStatus !== "recording") {
    throw new RecorderCliError("not_recording", `Recorder is not recording: ${recorderId}`);
  }

  try {
    const result = await (deps.sidecarStop ?? sidecarStop)(state.controlUrl, safeLabel);
    const stoppedAt = currentIso(deps);
    const lifecycleStatus = result.autoStopped ? "auto_stopped" : "completed";
    const nextState = {
      ...state,
      lifecycleStatus,
      recordingStoppedAt: stoppedAt,
    };
    writeRecorderState(path, nextState);
    const manifest = readManifestForState(nextState);
    writeManifestForState(nextState, {
      ...manifest,
      outcomeLabel: safeLabel ?? manifest.outcomeLabel ?? null,
      lifecycleStatus,
      stoppedAt: manifest.stoppedAt ?? stoppedAt,
      durationMs: manifest.durationMs ?? durationFrom(manifest.startedAt, stoppedAt),
      video: typeof result.video === "string" ? result.video : WEBM_VIDEO_FILENAME,
      recording: {
        ...(manifest.recording && typeof manifest.recording === "object" ? manifest.recording : {}),
        ...(typeof result.frameCount === "number" ? { frameCount: result.frameCount } : {}),
        ...(typeof result.droppedFrames === "number" ? { droppedFrames: result.droppedFrames } : {}),
        ...(typeof result.sizeBytes === "number" ? { sizeBytes: result.sizeBytes } : {}),
        ...(typeof result.stopReason === "string" ? { stopReason: result.stopReason } : {}),
      },
      updatedAt: stoppedAt,
    });
    return {
      recorderId,
      outDir: state.outDir,
      video: typeof result.video === "string" ? result.video : WEBM_VIDEO_FILENAME,
      path: typeof result.path === "string" ? result.path : videoPath(state.outDir),
      manifest: manifestPath(state.outDir),
      frameCount: typeof result.frameCount === "number" ? result.frameCount : null,
      droppedFrames: typeof result.droppedFrames === "number" ? result.droppedFrames : null,
      autoStopped: result.autoStopped === true,
    };
  } catch (error) {
    if (error instanceof RecorderCliError) {
      throw error;
    }
    writeRecorderErrorLog(state.outDir, error);
    flushManifestFailure(state, error, deps);
    throw new RecorderCliError(
      "stop_failed",
      `Recorder capture failed to stop: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function closeRecorder(recorderId, deps = {}) {
  const { state, path } = loadLiveRecorderState(recorderId, deps);

  let closeResult = {};
  try {
    closeResult = (await (deps.closeSidecar ?? closeSidecar)(state.controlUrl)) ?? {};
  } catch (error) {
    writeRecorderErrorLog(state.outDir, error);
    flushManifestFailure(state, error, deps);
    signalRecorderProcess(state.pid, deps);
    throw new RecorderCliError(
      "stale_recorder",
      `Recorder could not be closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const stoppedAt = currentIso(deps);
  const manifest = readManifestForState(state);
  const finalVideo = closeResult.stopResult?.video ?? manifest.video;
  const finalVideoPath =
    closeResult.stopResult?.path ?? (typeof finalVideo === "string" ? videoPath(state.outDir) : null);
  writeManifestForState(state, {
    ...manifest,
    lifecycleStatus: "closed",
    stoppedAt,
    durationMs: durationFrom(manifest.startedAt, stoppedAt),
    ...(closeResult.stopResult?.video ? { video: closeResult.stopResult.video } : {}),
    ...(closeResult.stopResult
      ? {
          recording: {
            ...(manifest.recording && typeof manifest.recording === "object" ? manifest.recording : {}),
            ...(typeof closeResult.stopResult.frameCount === "number"
              ? { frameCount: closeResult.stopResult.frameCount }
              : {}),
            ...(typeof closeResult.stopResult.droppedFrames === "number"
              ? { droppedFrames: closeResult.stopResult.droppedFrames }
              : {}),
            ...(typeof closeResult.stopResult.sizeBytes === "number"
              ? { sizeBytes: closeResult.stopResult.sizeBytes }
              : {}),
            stopReason: closeResult.stopResult.stopReason ?? "close",
          },
        }
      : {}),
    updatedAt: stoppedAt,
  });
  rmSync(dirname(path), { recursive: true, force: true });
  return {
    recorderId,
    outDir: state.outDir,
    manifest: manifestPath(state.outDir),
    ...(typeof finalVideo === "string"
      ? {
          video: finalVideo,
          path: finalVideoPath,
          ...(closeResult.stopResult ? { autoStopped: true } : {}),
        }
      : {}),
  };
}

function requireOption(command, options, key, flag) {
  if (!options[key]) {
    throw new RecorderCliError("invalid_argument", `${flag} is required`, {
      hint: commandUsage(command),
    });
  }
}

function parseCommandOptions(command, argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (command === "start" && arg === "--out-dir") {
      options.outDir = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (command === "start" && arg === "--storage-state") {
      options.storageState = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (command === "start" && arg === "--viewport") {
      options.viewport = readViewport(readValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (command === "start" && arg === "--max-duration-ms") {
      options.maxDurationMs = readBoundedPositiveInt(argv, index, arg, MAX_ALLOWED_DURATION_MS);
      index += 1;
      continue;
    }
    if (command === "start" && arg === "--frame-rate") {
      options.frameRate = readBoundedPositiveInt(argv, index, arg, MAX_ALLOWED_FRAME_RATE);
      index += 1;
      continue;
    }
    if ((command === "record" || command === "stop" || command === "shot" || command === "close") && arg === "--id") {
      options.id = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if ((command === "record" || command === "stop") && arg === "--label") {
      options.label = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new RecorderCliError("invalid_argument", `Unknown option for ${command}: ${arg}`, {
        hint: commandUsage(command),
      });
    }
    positionals.push(arg);
  }

  if (options.help) {
    return { ...options, positionals };
  }

  if (command === "start") {
    rejectExtraPositionals(command, positionals);
    requireOption(command, options, "outDir", "--out-dir");
    return {
      outDir: options.outDir,
      storageState: options.storageState,
      viewport: options.viewport ?? readViewport(DEFAULT_VIEWPORT),
      maxDurationMs: options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
      frameRate: options.frameRate ?? DEFAULT_FRAME_RATE,
    };
  }

  if (command === "record" || command === "stop") {
    rejectExtraPositionals(command, positionals);
    requireOption(command, options, "id", "--id");
    return { id: options.id, label: options.label };
  }

  if (command === "shot") {
    requireOption(command, options, "id", "--id");
    if (positionals.length !== 1) {
      throw new RecorderCliError("invalid_argument", "shot requires exactly one screenshot label", {
        hint: commandUsage(command),
      });
    }
    return { id: options.id, label: positionals[0] };
  }

  rejectExtraPositionals(command, positionals);
  requireOption(command, options, "id", "--id");
  return { id: options.id };
}

export function parseArgs(argv) {
  const global = { json: false, help: false };
  let index = 0;

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      global.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      global.help = true;
      continue;
    }
    break;
  }

  const rest = argv.slice(index);

  if (global.help) {
    return { ...global };
  }

  const command = rest[0];
  if (!command) {
    throw new RecorderCliError("invalid_argument", "A command is required", {
      hint: "Run `cycloid-recorder --help`.",
    });
  }
  if (!COMMANDS.has(command)) {
    throw new RecorderCliError("invalid_command", `Unknown command: ${command}`, {
      hint: "Run `cycloid-recorder --help`.",
    });
  }

  return {
    ...global,
    command,
    options: parseCommandOptions(command, rest.slice(1)),
  };
}

function writeError(error, json) {
  const code = error instanceof RecorderCliError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof RecorderCliError ? error.hint : undefined;
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { code, message, ...(hint ? { hint } : {}) } })}\n`);
    return;
  }
  process.stderr.write(`Error: ${message}\n`);
  if (hint) {
    process.stderr.write(`Hint: ${hint}\n`);
  }
}

export async function run(argv) {
  let parsed;
  try {
    if (argv[0] === "__sidecar") {
      if (!argv[1]) {
        throw new RecorderCliError("invalid_argument", "__sidecar requires a config path");
      }
      await runSidecar(resolve(argv[1]));
      return 0;
    }
    parsed = parseArgs(argv);
    if (parsed.help && !parsed.command) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.options?.help) {
      process.stdout.write(`${commandUsage(parsed.command)}\n`);
      return 0;
    }
    if (parsed.command === "start") {
      const result = await startRecorder(parsed.options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (parsed.command === "close") {
      const result = await closeRecorder(parsed.options.id);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (parsed.command === "shot") {
      const result = await takeScreenshot(parsed.options.id, parsed.options.label);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (parsed.command === "record") {
      const result = await startRecording(parsed.options.id, parsed.options.label ?? null);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (parsed.command === "stop") {
      const result = await stopRecording(parsed.options.id, parsed.options.label ?? null);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
  } catch (error) {
    const json = parsed?.json === true || argv.includes("--json");
    writeError(error, json);
    return error instanceof RecorderCliError ? error.exitCode : 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  const exitCode = await run(process.argv.slice(2));
  process.exit(exitCode);
}
