import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const DESKTOP_CLI = resolve(REPO_ROOT, "apps/sandbox-e2b/scripts/cycloid-desktop");
const CLI_TEST_TIMEOUT_MS = 90000;
const WEBP_1280X720_BASE64 =
  "UklGRk4AAABXRUJQVlA4TEEAAAAv/8SzAAdQwIIUuP8BBW3bMOUPvzuO6H+G//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//znP/+rAQA=";

const tempDirs: string[] = [];

type DesktopToolResult = {
  ok: boolean;
  actionId: string;
  action: string;
  display: { width: number; height: number; scale: 1 };
  activeWindow: {
    id: string | null;
    title: string | null;
    process: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  };
  pointer: { x: number; y: number } | null;
  screenshot: {
    path: string;
    evidencePath?: string;
    width: number;
    height: number;
    bytes: number;
    encodedBytes: number;
    extension: ".webp" | ".png" | ".jpg" | ".jpeg";
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    encodingMode: "lossless" | "q88" | "q80" | "legacy";
    encoder: "scrot-imlib2" | "ffmpeg-libwebp" | null;
    fallbackUsed: boolean;
    purpose: "observe" | "proof_candidate" | "action_feedback";
  } | null;
  recentScreenshots: Array<{ actionId: string; path: string; capturedAtMs: number; purpose: string }>;
  warning: { code: string; message: string } | null;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    safeToRetry?: boolean;
    recommendedNextTool?: string | null;
    expectedWindowId?: string | null;
    actualWindowId?: string | null;
  } | null;
  desktopProtocol: {
    version: string;
    cliSha256: string;
    supervisorSha256: string;
    bridgeBundleSha256: string;
  };
  desktopRuntime: {
    browserStatus: "ready" | "missing";
    browserSource: "configured" | "path";
    browserConfiguredPath: string | null;
    browserResolvedPath: string | null;
    browserSymlink: boolean;
    browserPlatformProtected: boolean;
    supervisorGeneration: string | null;
  };
  desktopReadiness: {
    lazyStartRequested: boolean;
    waitMs: number;
    outcome: string;
    healthCheckMode: string | null;
  };
  recording?: {
    status: "idle" | "recording" | "completed" | "failed" | "interrupted";
    recordingId: string | null;
    scenarioId: string | null;
    label: string | null;
    manifestPath: string | null;
    rawWebmPath: string | null;
    overlayWebmPath: string | null;
    evidencePath: string | null;
    overlayStatus: "applied" | "failed" | "not_attempted";
    startedAtMs: number | null;
    stoppedAtMs: number | null;
    durationMs: number | null;
    bytes: number | null;
    maxDurationMs: number;
    maxBytes: number;
    fps: number;
    codec: "vp8";
    failureReason: string | null;
  };
  health?: unknown;
  windows?: Array<{
    id: string;
    desktop: number;
    title: string;
    process: string | null;
    bounds: { x: number; y: number; width: number; height: number };
  }>;
};

type DesktopRecordingManifest = {
  version: 1;
  scenarioId: string;
  label: string;
  display: { width: number; height: number; scale: 1 };
  recording: {
    status: "completed" | "failed" | "interrupted";
    startedAtMs: number;
    stoppedAtMs: number | null;
    durationMs: number | null;
    rawWebmPath: string | null;
    overlayWebmPath: string | null;
    evidencePath: string | null;
    bytes: number | null;
    codec: "vp8";
    fps: 10;
    overlayStatus: "applied" | "failed" | "not_attempted";
    failureReason: string | null;
  };
  screenshots: Array<unknown>;
  actions: Array<unknown>;
};

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cycloid-desktop-cli-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeFakeDesktopCommands(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeExecutable(
    binDir,
    "xdotool",
    `#!/usr/bin/env bash
set -euo pipefail
log_action() {
  if [ -n "\${FAKE_XDOTOOL_LOG:-}" ]; then
    printf '%s\\n' "$1" >> "$FAKE_XDOTOOL_LOG"
  fi
}
maybe_sleep() {
  if [ -n "\${FAKE_XDOTOOL_STARTED:-}" ]; then
    printf 'started\\n' > "$FAKE_XDOTOOL_STARTED"
  fi
  if [ -n "\${FAKE_XDOTOOL_SLEEP_SECONDS:-}" ]; then
    sleep "$FAKE_XDOTOOL_SLEEP_SECONDS"
  fi
}
maybe_fail() {
  if [ -n "\${FAKE_XDOTOOL_ACTION_EXIT:-}" ]; then
    exit "$FAKE_XDOTOOL_ACTION_EXIT"
  fi
}
case "\${1:-}" in
  getdisplaygeometry)
    printf '1280 720\\n'
    ;;
  getmouselocation)
    printf 'X=44\\nY=55\\nSCREEN=0\\nWINDOW=4194305\\n'
    ;;
  getactivewindow)
    if [ -n "\${FAKE_ACTIVE_WINDOW_ID:-}" ]; then
      printf '%s\\n' "$FAKE_ACTIVE_WINDOW_ID"
      exit 0
    fi
    if [ -n "\${FAKE_ACTIVE_WINDOW_STATE:-}" ] && [ -f "$FAKE_ACTIVE_WINDOW_STATE" ]; then
      cat "$FAKE_ACTIVE_WINDOW_STATE"
      exit 0
    fi
    if [ -n "\${FAKE_BROWSER_WINDOW_READY:-}" ] && [ -f "$FAKE_BROWSER_WINDOW_READY" ]; then
      printf '0x0500001\\n'
    else
      printf '4194305\\n'
    fi
    ;;
  mousemove)
    maybe_sleep
    maybe_fail
    state="clicked"
    if printf '%s\\n' "$*" | grep -q 'mousedown'; then
      state="dragged"
    elif printf '%s\\n' "$*" | grep -q 'click 4\\|click 5'; then
      state="scrolled"
    fi
    if [ -n "\${FAKE_GUI_STATE:-}" ]; then
      printf '%s\\n' "$state" > "$FAKE_GUI_STATE"
    fi
    log_action "xdotool $state"
    ;;
  type)
    maybe_sleep
    maybe_fail
    typed="\${@: -1}"
    if [ -n "\${FAKE_GUI_STATE:-}" ]; then
      printf 'typed:%s\\n' "\${#typed}" > "$FAKE_GUI_STATE"
    fi
    log_action "xdotool type chars=\${#typed}"
    ;;
  key)
    maybe_sleep
    maybe_fail
    if [ -n "\${FAKE_GUI_STATE:-}" ]; then
      printf 'hotkey\\n' > "$FAKE_GUI_STATE"
    fi
    log_action "xdotool hotkey"
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  writeExecutable(
    binDir,
    "wmctrl",
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-lG" ]; then
  printf '0x0300001  0 1 2 640 480 sandbox Background app\\n'
  printf '0x0400001  0 12 34 800 600 sandbox Demo app\\n'
  if [ -n "\${FAKE_BROWSER_WINDOW_READY:-}" ] && [ -f "$FAKE_BROWSER_WINDOW_READY" ]; then
    printf '0x0500001  0 0 0 1280 720 sandbox Chromium\\n'
  fi
  exit 0
fi
if [ "\${1:-}" = "-i" ] && [ "\${2:-}" = "-r" ]; then
  if [ -n "\${FAKE_WMCTRL_LOG:-}" ]; then printf 'maximize:%s:%s\\n' "\${3:-}" "\${5:-}" >> "$FAKE_WMCTRL_LOG"; fi
  exit 0
fi
if [ "\${1:-}" = "-i" ] && [ "\${2:-}" = "-a" ]; then
  if [ -n "\${FAKE_WMCTRL_LOG:-}" ]; then printf 'focus:%s\\n' "\${3:-}" >> "$FAKE_WMCTRL_LOG"; fi
  if [ -n "\${FAKE_ACTIVE_WINDOW_STATE:-}" ]; then printf '%s\\n' "\${3:-}" > "$FAKE_ACTIVE_WINDOW_STATE"; fi
  exit 0
fi
if [ "\${1:-}" = "-a" ]; then
  if [ -n "\${FAKE_WMCTRL_LOG:-}" ]; then printf 'focus-title:%s\\n' "\${2:-}" >> "$FAKE_WMCTRL_LOG"; fi
  exit 0
fi
exit 2
`,
  );
  writeExecutable(
    binDir,
    "chromium",
    `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${FAKE_CHROMIUM_ARGS_LOG:-}" ]; then
  printf '%s\\n' "$*" > "$FAKE_CHROMIUM_ARGS_LOG"
fi
if [ -n "\${FAKE_BROWSER_WINDOW_READY:-}" ]; then
  printf 'ready\\n' > "$FAKE_BROWSER_WINDOW_READY"
fi
exit 0
`,
  );
  writeExecutable(
    binDir,
    "scrot",
    `#!/usr/bin/env bash
set -euo pipefail
target="\${@: -1}"
if [ -n "\${FAKE_SCROT_EXIT:-}" ]; then exit "$FAKE_SCROT_EXIT"; fi
if [ -n "\${FAKE_SCROT_STARTED:-}" ]; then
  printf 'started\\n' > "$FAKE_SCROT_STARTED"
fi
if [ -n "\${FAKE_SCROT_SLEEP_SECONDS:-}" ]; then
  sleep "$FAKE_SCROT_SLEEP_SECONDS"
fi
if [[ "$target" == *.webp ]]; then
  if [ -n "\${FAKE_SCROT_INVALID:-}" ]; then
    printf 'not-a-webp' > "$target"
  else
    printf '%s' "${WEBP_1280X720_BASE64}" | base64 --decode > "$target"
    if [ "\${FAKE_SCROT_OVERSIZE:-0}" = "1" ]; then
      dd if=/dev/zero bs=1M count=3 >> "$target" 2>/dev/null
    fi
    if [ -n "\${FAKE_GUI_STATE:-}" ] && [ -f "$FAKE_GUI_STATE" ]; then
      printf 'screen:%s' "$(cat "$FAKE_GUI_STATE")" >> "$target"
    fi
  fi
elif [ -n "\${FAKE_GUI_STATE:-}" ] && [ -f "$FAKE_GUI_STATE" ]; then
  printf 'screen:%s' "$(cat "$FAKE_GUI_STATE")" > "$target"
else
  printf 'fake-legacy-image-bytes' > "$target"
fi
`,
  );
  writeExecutable(
    binDir,
    "ffmpeg",
    `#!/usr/bin/env bash
set -euo pipefail
target="\${@: -1}"
if [ -n "\${FAKE_FFMPEG_ARGS_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$FAKE_FFMPEG_ARGS_LOG"
fi
quality=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-q:v" ]; then quality="$arg"; fi
  previous="$arg"
done
is_overlay=0
for arg in "$@"; do
  if [ "$arg" = "-vf" ]; then is_overlay=1; fi
done
if [ "$is_overlay" = "1" ] && [ -n "\${FAKE_FFMPEG_OVERLAY_EXIT:-}" ]; then
  exit "$FAKE_FFMPEG_OVERLAY_EXIT"
fi
if [[ "$target" == *.webp ]]; then
  if [ "\${FAKE_FFMPEG_WEBP_EXIT:-0}" != "0" ]; then exit "$FAKE_FFMPEG_WEBP_EXIT"; fi
  printf '%s' "${WEBP_1280X720_BASE64}" | base64 --decode > "$target"
  if [ "\${FAKE_FFMPEG_OVERSIZE_QUALITY:-}" = "$quality" ]; then
    dd if=/dev/zero bs=1M count=3 >> "$target" 2>/dev/null
  fi
  exit "\${FAKE_FFMPEG_EXIT:-0}"
fi
if [ -n "\${FAKE_FFMPEG_STARTED:-}" ]; then
  printf 'started\\n' > "$FAKE_FFMPEG_STARTED"
fi
write_webm() {
  printf '\\x1A\\x45\\xDF\\xA3fake-webm-bytes' > "$target"
}
if [ -n "\${FAKE_FFMPEG_SLEEP_SECONDS:-}" ]; then
  trap 'write_webm; exit 0' INT TERM
  while true; do sleep 0.1; done
fi
write_webm
exit "\${FAKE_FFMPEG_EXIT:-0}"
`,
  );
}

function writeHealth(stateDir: string, health: Record<string, unknown>): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "health.json"), `${JSON.stringify(health)}\n`);
}

function availableHealth(): Record<string, unknown> {
  return {
    ok: true,
    status: "available",
    size: { width: 1280, height: 720 },
    failedComponent: null,
    lastError: null,
  };
}

function unavailableHealth(): Record<string, unknown> {
  return {
    ok: false,
    status: "unavailable",
    size: { width: 0, height: 0 },
    failedComponent: "xvfb",
    lastError: "x_display_unreachable",
  };
}

function baseEnv(dir: string): NodeJS.ProcessEnv {
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "state");
  writeFakeDesktopCommands(binDir);
  writeHealth(stateDir, availableHealth());
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    DISPLAY: ":99",
    ARCANIST_DESKTOP_STATE_DIR: stateDir,
    ARCANIST_DESKTOP_EVIDENCE_ROOT: join(dir, "evidence"),
    ARCANIST_RUNTIME_EVIDENCE_DIR: join(dir, "runtime-evidence"),
    ARCANIST_DESKTOP_CLI_LOG_PATH: join(dir, "desktop-cli.log"),
    FAKE_GUI_STATE: join(dir, "gui-state.txt"),
    FAKE_XDOTOOL_LOG: join(dir, "xdotool.log"),
    FAKE_WMCTRL_LOG: join(dir, "wmctrl.log"),
    FAKE_ACTIVE_WINDOW_STATE: join(dir, "active-window.txt"),
    FAKE_CHROMIUM_ARGS_LOG: join(dir, "chromium-args.log"),
    FAKE_BROWSER_WINDOW_READY: join(dir, "browser-ready"),
  };
}

function runDesktop(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(DESKTOP_CLI, args, {
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  const stdout = result.stdout.trim();
  expect(stdout).not.toBe("");
  return {
    ...result,
    json: JSON.parse(stdout) as DesktopToolResult,
  };
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (readIfExists(path) !== "") {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForPidExit(pid: number, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for pid ${pid} to exit`);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("cycloid-desktop CLI", () => {
  it("preflights a protected Chromium symlink without starting the desktop", () => {
    const dir = makeTempDir();
    const env = baseEnv(dir);
    const browserRoot = join(dir, "platform-browsers");
    const browserExecutable = join(browserRoot, "chromium-1", "chrome-linux", "chrome");
    const stableLink = join(dir, "platform-chromium");
    mkdirSync(join(browserRoot, "chromium-1", "chrome-linux"), { recursive: true });
    writeFileSync(browserExecutable, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(browserExecutable, 0o755);
    symlinkSync(browserExecutable, stableLink);
    env.AGENT_BROWSER_EXECUTABLE_PATH = stableLink;
    env.PLAYWRIGHT_BROWSERS_PATH = browserRoot;

    const result = runDesktop(["preflight", "--json"], env);

    expect(result.status).toBe(0);
    expect(result.json).toMatchObject({
      ok: true,
      action: "preflight",
      desktopRuntime: {
        browserStatus: "ready",
        browserConfiguredPath: stableLink,
        browserResolvedPath: expect.stringContaining("platform-browsers/chromium-1/chrome-linux/chrome"),
        browserSymlink: true,
        browserPlatformProtected: true,
        supervisorGeneration: null,
      },
    });
  });

  it("returns typed browser_missing when the configured platform symlink is dangling", () => {
    const dir = makeTempDir();
    const env = baseEnv(dir);
    env.AGENT_BROWSER_EXECUTABLE_PATH = join(dir, "missing-platform-chromium");
    env.PLAYWRIGHT_BROWSERS_PATH = join(dir, "platform-browsers");

    const result = runDesktop(["preflight", "--json"], env);

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      error: { code: "browser_missing", safeToRetry: true, recommendedNextTool: null },
      desktopRuntime: {
        browserStatus: "missing",
        browserConfiguredPath: env.AGENT_BROWSER_EXECUTABLE_PATH,
        browserResolvedPath: null,
        browserPlatformProtected: false,
      },
    });
  });

  it("rejects a stale bridge protocol with component identity", () => {
    const dir = makeTempDir();
    const env = baseEnv(dir);

    const result = runDesktop(
      ["windows", "--json", "--desktop-protocol-version", "1", "--bridge-bundle-sha256", "bridge-old"],
      env,
    );

    expect(result.status).toBe(1);
    expect(result.json).toMatchObject({
      ok: false,
      error: { code: "desktop_protocol_mismatch", safeToRetry: false, recommendedNextTool: null },
      desktopProtocol: { version: "2", bridgeBundleSha256: "bridge-old" },
    });
    expect(result.json.desktopProtocol.cliSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it(
    "captures observe screenshots as DesktopToolResult JSON",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(["observe", "--json", "--scenario-id", "scenario-1", "--action-id", "observe-1"], env);

      expect(result.status).toBe(0);
      expect(result.json).toMatchObject({
        ok: true,
        actionId: "observe-1",
        action: "observe",
        display: { width: 1280, height: 720, scale: 1 },
        activeWindow: {
          id: "0x0400001",
          title: "Demo app",
          bounds: { x: 12, y: 34, width: 800, height: 600 },
        },
        pointer: { x: 44, y: 55 },
        error: null,
      });
      expect(result.json.screenshot).toMatchObject({
        width: 1280,
        height: 720,
        bytes: expect.any(Number),
        encodedBytes: expect.any(Number),
        extension: ".webp",
        mimeType: "image/webp",
        encodingMode: "lossless",
        encoder: "scrot-imlib2",
        fallbackUsed: false,
        purpose: "observe",
        captureMode: "full_display",
        displayName: ":99",
      });
      expect(result.json.screenshot?.path).toContain(join(dir, "evidence", "scenario-1"));
      expect(statSync(result.json.screenshot!.path).size).toBeGreaterThan(0);
      expect(result.stdout.trim()).toMatch(/^\{.*\}$/);
      expect(readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8")).toContain("event=desktop.screenshot");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "captures screenshot commands as proof candidates",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(["screenshot", "--json", "--scenario-id", "proof-flow", "--action-id", "shot-1"], env);

      expect(result.status).toBe(0);
      expect(result.json.ok).toBe(true);
      expect(result.json.action).toBe("screenshot");
      expect(result.json.screenshot).toMatchObject({
        purpose: "proof_candidate",
        bytes: expect.any(Number),
        encodedBytes: expect.any(Number),
        extension: ".webp",
        mimeType: "image/webp",
        captureMode: "full_display",
        displayName: ":99",
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "captures a validated WebP directly without a PNG intermediate",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(["screenshot", "--json", "--scenario-id", "webp-direct", "--action-id", "shot-1"], env);

      expect(result.status).toBe(0);
      expect(result.json.screenshot).toMatchObject({
        width: 1280,
        height: 720,
        mimeType: "image/webp",
        extension: ".webp",
        encodingMode: "lossless",
        encoder: "scrot-imlib2",
        fallbackUsed: false,
      });
      const screenshotPath = result.json.screenshot!.path;
      const bytes = readFileSync(screenshotPath);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(result.json.screenshot!.bytes).toBe(bytes.length);
      expect(result.json.screenshot!.encodedBytes).toBe(bytes.length);
      expect(readdirSync(join(dir, "evidence", "webp-direct")).filter((name) => name.endsWith(".png"))).toEqual([]);
      expect(
        readdirSync(join(dir, "evidence", "webp-direct")).filter(
          (name) => name.startsWith(".") && name.endsWith(".webp"),
        ),
      ).toEqual([]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "falls back to direct ffmpeg/libwebp X11 capture when scrot WebP is unavailable",
    () => {
      const dir = makeTempDir();
      const argsLog = join(dir, "ffmpeg-args.log");
      const env = { ...baseEnv(dir), FAKE_SCROT_EXIT: "1", FAKE_FFMPEG_ARGS_LOG: argsLog };

      const result = runDesktop(
        ["screenshot", "--json", "--scenario-id", "webp-fallback", "--action-id", "shot-1"],
        env,
      );

      expect(result.status).toBe(0);
      expect(result.json.screenshot).toMatchObject({
        mimeType: "image/webp",
        encoder: "ffmpeg-libwebp",
        fallbackUsed: true,
        width: 1280,
        height: 720,
      });
      expect(readFileSync(argsLog, "utf8")).toContain("x11grab");
      expect(readFileSync(argsLog, "utf8")).toContain("libwebp");
      expect(readFileSync(argsLog, "utf8")).not.toContain("png");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it.each([
    ["q88", "80"],
    ["q80", "88"],
  ] as const)(
    "selects %s after oversized WebP encoding",
    (expectedMode, oversizedQuality) => {
      const dir = makeTempDir();
      const env = {
        ...baseEnv(dir),
        FAKE_SCROT_OVERSIZE: "1",
        FAKE_FFMPEG_OVERSIZE_QUALITY: oversizedQuality,
      };

      const result = runDesktop(["screenshot", "--json", "--scenario-id", expectedMode, "--action-id", "shot-1"], env);

      expect(result.status).toBe(0);
      expect(result.json.screenshot).toMatchObject({
        mimeType: "image/webp",
        encodingMode: expectedMode,
        encodedBytes: expect.any(Number),
      });
      expect(result.json.screenshot!.encodedBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "returns a typed failure and removes invalid WebP temporaries",
    () => {
      const dir = makeTempDir();
      const env = { ...baseEnv(dir), FAKE_SCROT_INVALID: "1", FAKE_FFMPEG_WEBP_EXIT: "1" };

      const result = runDesktop(
        ["screenshot", "--json", "--scenario-id", "invalid-webp", "--action-id", "shot-1"],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        screenshot: null,
        error: {
          code: "screenshot_capture_failed",
          safeToRetry: true,
          recommendedNextTool: "desktop.screenshot",
        },
      });
      expect(readdirSync(join(dir, "evidence", "invalid-webp")).filter((name) => name.endsWith(".webp"))).toEqual([]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "runs an on-demand full health refresh while status remains a lightweight read",
    () => {
      const dir = makeTempDir();
      const supervisorCallsPath = join(dir, "supervisor-calls.log");
      const env = { ...baseEnv(dir), FAKE_SUPERVISOR_CALLS_PATH: supervisorCallsPath };
      writeExecutable(
        join(dir, "bin"),
        "cycloid-desktop-supervisor",
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\${1:-}" >> "\${FAKE_SUPERVISOR_CALLS_PATH:?}"
if [ "\${1:-}" = "health" ]; then
  printf '%s\n' '{"ok":true,"status":"available","healthCheckMode":"full","size":{"width":1280,"height":720},"failedComponent":null,"lastError":null}'
  exit 0
fi
exit 2
`,
      );

      const windows = runDesktop(["windows", "--json", "--action-id", "windows-1"], env);
      const health = runDesktop(["health", "--json", "--action-id", "health-1"], env);
      const status = runDesktop(["status", "--json", "--action-id", "status-1"], env);

      expect(windows.status).toBe(0);
      expect(windows.json.screenshot).toBeNull();
      expect(windows.json.windows).toEqual([
        {
          id: "0x0300001",
          desktop: 0,
          title: "Background app",
          process: null,
          bounds: { x: 1, y: 2, width: 640, height: 480 },
        },
        {
          id: "0x0400001",
          desktop: 0,
          title: "Demo app",
          process: null,
          bounds: { x: 12, y: 34, width: 800, height: 600 },
        },
      ]);
      expect(health.status).toBe(0);
      expect(health.json).toMatchObject({
        ok: true,
        action: "health",
        screenshot: null,
        health: { healthCheckMode: "full" },
        desktopReadiness: {
          lazyStartRequested: false,
          waitMs: expect.any(Number),
          outcome: "already_available",
          healthCheckMode: "full",
        },
      });
      expect(status.status).toBe(0);
      expect(status.json).toMatchObject({ ok: true, action: "status", screenshot: null });
      expect(readFileSync(supervisorCallsPath, "utf8").trim().split("\n")).toEqual(["health"]);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "returns desktop_unavailable JSON without capturing a screenshot",
    () => {
      const dir = makeTempDir();
      const env: NodeJS.ProcessEnv = { ...baseEnv(dir), ARCANIST_DESKTOP_READY_WAIT_SECONDS: "0" };
      writeHealth(env.ARCANIST_DESKTOP_STATE_DIR!, unavailableHealth());

      const result = runDesktop(["observe", "--json", "--scenario-id", "scenario-1"], env);

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        screenshot: null,
        error: { code: "desktop_unavailable", retryable: true },
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "starts the desktop supervisor and waits before reporting unavailable",
    () => {
      const dir = makeTempDir();
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        ARCANIST_DESKTOP_READY_WAIT_SECONDS: "2",
        ARCANIST_DESKTOP_READY_POLL_SECONDS: "0.05",
        ARCANIST_DESKTOP_SUPERVISOR_START_TIMEOUT_SECONDS: "5",
      };
      writeHealth(env.ARCANIST_DESKTOP_STATE_DIR!, unavailableHealth());
      writeExecutable(
        join(dir, "bin"),
        "cycloid-desktop-supervisor",
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "start" ]; then
  cat > "\${ARCANIST_DESKTOP_STATE_DIR}/health.json" <<'JSON'
{"ok":true,"status":"available","size":{"width":1280,"height":720},"failedComponent":null,"lastError":null}
JSON
  exit 0
fi
exit 2
`,
      );

      const result = runDesktop(["observe", "--json", "--scenario-id", "scenario-1"], env);

      expect(
        result.status,
        `${result.stdout}\n${result.stderr}\n${readIfExists(env.ARCANIST_DESKTOP_CLI_LOG_PATH!)}`,
      ).toBe(0);
      expect(result.json).toMatchObject({ ok: true, action: "observe", error: null });
      expect(result.json.desktopReadiness).toMatchObject({
        lazyStartRequested: true,
        waitMs: expect.any(Number),
        outcome: "ready_after_lazy_start",
        healthCheckMode: null,
      });
      const log = readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8");
      expect(log).toContain("event=desktop.ensure outcome=supervisor_start_requested");
      expect(log).toContain("event=desktop.ensure outcome=available");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "fails closed when screenshot quota is exceeded",
    () => {
      const dir = makeTempDir();
      const env = {
        ...baseEnv(dir),
        ARCANIST_DESKTOP_MAX_SCREENSHOTS_PER_SESSION: "0",
      };

      const result = runDesktop(["observe", "--json", "--scenario-id", "scenario-1"], env);

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        screenshot: null,
        error: { code: "screenshot_quota_exceeded", retryable: false },
      });
      expect(result.stderr).toContain("outcome=quota_exceeded");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "returns screenshot_failed when the screenshot subprocess cannot start",
    () => {
      const dir = makeTempDir();
      const env = { ...baseEnv(dir), FAKE_FFMPEG_WEBP_EXIT: "1" };
      writeExecutable(join(dir, "bin"), "scrot", "not a valid executable\n");

      const result = runDesktop(["observe", "--json", "--scenario-id", "scenario-1", "--action-id", "observe-1"], env);

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        screenshot: null,
        error: {
          code: "screenshot_capture_failed",
          retryable: true,
          safeToRetry: true,
          recommendedNextTool: "desktop.screenshot",
        },
      });
      expect(result.stderr).toContain("outcome=screenshot_capture_failed");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "rejects scenario ids that would escape the evidence root",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(["observe", "--json", "--scenario-id", "../escape"], env);

      expect(result.status).toBe(2);
      expect(result.json).toMatchObject({
        ok: false,
        screenshot: null,
        error: { code: "path_containment_failed", retryable: false },
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "runs mutating actions with post-action screenshot feedback",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const click = runDesktop(
        ["click", "--json", "--scenario-id", "gui", "--action-id", "click-1", "--x", "100", "--y", "120"],
        env,
      );
      const hotkey = runDesktop(
        ["hotkey", "--json", "--scenario-id", "gui", "--action-id", "hotkey-1", "--keys", "ctrl+l"],
        env,
      );
      const scroll = runDesktop(
        [
          "scroll",
          "--json",
          "--scenario-id",
          "gui",
          "--action-id",
          "scroll-1",
          "--x",
          "100",
          "--y",
          "120",
          "--amount",
          "2",
        ],
        env,
      );
      const drag = runDesktop(
        [
          "drag",
          "--json",
          "--scenario-id",
          "gui",
          "--action-id",
          "drag-1",
          "--from-x",
          "10",
          "--from-y",
          "20",
          "--to-x",
          "30",
          "--to-y",
          "40",
        ],
        env,
      );
      const focus = runDesktop(
        ["focus_window", "--json", "--scenario-id", "gui", "--action-id", "focus-1", "--window-id", "0x0400001"],
        env,
      );
      const openApp = runDesktop(
        ["open_app", "--json", "--scenario-id", "gui", "--action-id", "open-1", "--command", "true"],
        env,
      );

      for (const result of [click, hotkey, scroll, drag, focus, openApp]) {
        expect(result.status).toBe(0);
        expect(result.json.ok).toBe(true);
        expect(result.json.screenshot).toMatchObject({ purpose: "action_feedback", bytes: expect.any(Number) });
        expect(result.json.activeWindow.title).toBe("Demo app");
      }
      expect(readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8")).toContain("event=desktop.action");
      expect(readFileSync(env.FAKE_WMCTRL_LOG!, "utf8")).toContain("focus:0x0400001");
    },
    CLI_TEST_TIMEOUT_MS * 3,
  );

  it(
    "opens Chromium with ready-to-use defaults and focuses the browser window",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(
        [
          "open_app",
          "--json",
          "--scenario-id",
          "browser",
          "--action-id",
          "open-browser",
          "--url",
          "http://127.0.0.1:3000/",
        ],
        env,
      );

      expect(result.status).toBe(0);
      expect(result.json).toMatchObject({
        ok: true,
        activeWindow: { title: "Chromium" },
        display: { width: 1280, height: 720, scale: 1 },
      });
      const chromiumArgs = readFileSync(env.FAKE_CHROMIUM_ARGS_LOG!, "utf8");
      expect(chromiumArgs).toContain("--new-window");
      expect(chromiumArgs).toContain("--no-first-run");
      expect(chromiumArgs).toContain("--no-default-browser-check");
      expect(chromiumArgs).toContain("--disable-signin-promo");
      expect(chromiumArgs).toContain("--disable-sync");
      expect(chromiumArgs).toContain("SignInProfileCreation");
      expect(chromiumArgs).toContain("--password-store=basic");
      expect(chromiumArgs).toContain("--use-mock-keychain");
      expect(chromiumArgs).toContain("--start-maximized");
      expect(chromiumArgs).toContain("--window-position=0,0");
      expect(chromiumArgs).toContain("--window-size=1280,720");
      expect(chromiumArgs).toContain("--user-data-dir=");
      expect(chromiumArgs).toContain("http://127.0.0.1:3000/");
      expect(readFileSync(join(dir, "state", "chromium-profile", "First Run"), "utf8")).toBe("");
      const chromiumPreferences = JSON.parse(
        readFileSync(join(dir, "state", "chromium-profile", "Default", "Preferences"), "utf8"),
      );
      expect(chromiumPreferences.credentials_enable_service).toBe(false);
      expect(chromiumPreferences.distribution.skip_first_run_ui).toBe(true);
      expect(chromiumPreferences.sync_promo.show_on_first_run_allowed).toBe(false);

      const wmctrlLog = readFileSync(env.FAKE_WMCTRL_LOG!, "utf8");
      expect(wmctrlLog).toContain("maximize:0x0500001:add,maximized_vert,maximized_horz");
      expect(wmctrlLog).toContain("focus:0x0500001");
      expect(readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8")).toContain("event=desktop.open_app_focus");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "returns a retryable error when open_app focus cannot be proven",
    () => {
      const dir = makeTempDir();
      const env: NodeJS.ProcessEnv = { ...baseEnv(dir), FAKE_ACTIVE_WINDOW_ID: "0x0999999" };

      const result = runDesktop(
        [
          "open_app",
          "--json",
          "--scenario-id",
          "gui",
          "--action-id",
          "open-focus-fail",
          "--command",
          "chromium http://127.0.0.1:3000",
        ],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: {
          code: "focus_not_proven",
          retryable: true,
        },
      });
      expect(result.json.screenshot).toMatchObject({ purpose: "action_feedback" });
      expect(readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8")).toContain("event=desktop.open_app_focus");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "fails focus_window when wmctrl exits successfully without changing the active window",
    () => {
      const dir = makeTempDir();
      const env: NodeJS.ProcessEnv = { ...baseEnv(dir), FAKE_ACTIVE_WINDOW_ID: "0x0300001" };

      const result = runDesktop(["focus_window", "--json", "--scenario-id", "focus", "--window-id", "0x0400001"], env);

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        activeWindow: { id: "0x0300001" },
        error: {
          code: "focus_not_proven",
          safeToRetry: true,
          recommendedNextTool: "desktop.windows",
          expectedWindowId: "0x0400001",
        },
      });
      expect(readFileSync(env.FAKE_WMCTRL_LOG!, "utf8").match(/focus:0x0400001/g)).toHaveLength(2);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "focuses targetWindowId before executing a coordinate action",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(
        ["click", "--json", "--scenario-id", "targeted", "--x", "10", "--y", "20", "--target-window-id", "0x0400001"],
        env,
      );

      expect(result.status).toBe(0);
      expect(result.json).toMatchObject({ ok: true, activeWindow: { id: "0x0400001" } });
      expect(readFileSync(env.FAKE_WMCTRL_LOG!, "utf8")).toContain("focus:0x0400001");
      expect(readFileSync(env.FAKE_XDOTOOL_LOG!, "utf8")).toContain("xdotool clicked");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "opens a bare HTTP URL passed through the legacy command field",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(
        [
          "open_app",
          "--json",
          "--scenario-id",
          "browser-compat",
          "--action-id",
          "open-browser-compat",
          "--command",
          "http://127.0.0.1:4173/",
        ],
        env,
      );

      expect(result.status).toBe(0);
      expect(result.json).toMatchObject({ ok: true, activeWindow: { title: "Chromium" } });
      expect(readFileSync(env.FAKE_CHROMIUM_ARGS_LOG!, "utf8")).toContain("http://127.0.0.1:4173/");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "returns browser_missing for URL launch when the platform browser is absent",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);
      rmSync(join(dir, "bin", "chromium"));
      delete env.AGENT_BROWSER_EXECUTABLE_PATH;
      env.ARCANIST_DESKTOP_BROWSER_EXECUTABLE = join(dir, "missing-browser");

      const result = runDesktop(
        ["open_app", "--json", "--scenario-id", "browser-missing", "--url", "http://127.0.0.1:4173/"],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "browser_missing", safeToRetry: true, recommendedNextTool: null },
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "rejects out-of-bounds coordinates before running the action or feedback",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const result = runDesktop(
        ["click", "--json", "--scenario-id", "gui", "--action-id", "bad-click", "--x", "1280", "--y", "1"],
        env,
      );

      expect(result.status).toBe(2);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "invalid_request", retryable: false },
      });
      expect(result.json.screenshot).toBeNull();
      expect(readIfExists(env.FAKE_XDOTOOL_LOG!)).toBe("");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "serializes mutating actions and returns desktop_busy when the action lock is held",
    async () => {
      const dir = makeTempDir();
      const startedPath = join(dir, "xdotool-started");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        ARCANIST_DESKTOP_ACTION_LOCK_TIMEOUT_SECONDS: "0.05",
        FAKE_XDOTOOL_SLEEP_SECONDS: "1",
        FAKE_XDOTOOL_STARTED: startedPath,
      };
      const first = spawn(
        DESKTOP_CLI,
        ["click", "--json", "--scenario-id", "gui", "--action-id", "slow-lock-holder", "--x", "1", "--y", "1"],
        {
          env,
        },
      );
      try {
        await waitForFile(startedPath, 10000);
        const result = runDesktop(
          ["click", "--json", "--scenario-id", "gui", "--action-id", "busy-click", "--x", "1", "--y", "1"],
          env,
        );

        expect(result.status).toBe(1);
        expect(result.json).toMatchObject({
          ok: false,
          screenshot: null,
          error: { code: "desktop_busy", retryable: true },
        });
        expect(readIfExists(env.FAKE_XDOTOOL_LOG!)).not.toContain("busy-click");
      } finally {
        await new Promise<void>((resolvePromise) => {
          first.once("exit", () => resolvePromise());
          first.kill();
          setTimeout(resolvePromise, 1500);
        });
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "releases the action lock before post-action screenshot feedback",
    async () => {
      const dir = makeTempDir();
      const screenshotStartedPath = join(dir, "scrot-started");
      const env = {
        ...baseEnv(dir),
        ARCANIST_DESKTOP_ACTION_LOCK_TIMEOUT_SECONDS: "0.05",
        FAKE_SCROT_SLEEP_SECONDS: "1",
        FAKE_SCROT_STARTED: screenshotStartedPath,
      };
      const first = spawn(
        DESKTOP_CLI,
        ["click", "--json", "--scenario-id", "gui", "--action-id", "feedback-lock-holder", "--x", "1", "--y", "1"],
        { env },
      );
      try {
        await waitForFile(screenshotStartedPath, 10000);
        const second = runDesktop(
          ["click", "--json", "--scenario-id", "gui", "--action-id", "second-action", "--x", "2", "--y", "2"],
          env,
        );

        expect(second.status).toBe(0);
        expect(second.json).toMatchObject({ ok: true, error: null });
      } finally {
        await new Promise<void>((resolvePromise) => {
          first.once("exit", () => resolvePromise());
          first.kill();
          setTimeout(resolvePromise, 1500);
        });
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "times out failed actions and captures the failure screenshot",
    () => {
      const dir = makeTempDir();
      const env = {
        ...baseEnv(dir),
        CYCLOID_DESKTOP_CLICK_TIMEOUT_SECONDS: "0.05",
        FAKE_XDOTOOL_SLEEP_SECONDS: "1",
      };

      const result = runDesktop(
        ["click", "--json", "--scenario-id", "gui", "--action-id", "slow-click", "--x", "1", "--y", "1"],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "action_timeout", retryable: true },
      });
      expect(result.json.screenshot).toMatchObject({ purpose: "action_feedback" });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "honors --timeout-ms for mutating action commands",
    () => {
      const dir = makeTempDir();
      const env = {
        ...baseEnv(dir),
        FAKE_XDOTOOL_SLEEP_SECONDS: "1",
      };

      const result = runDesktop(
        [
          "click",
          "--json",
          "--scenario-id",
          "gui",
          "--action-id",
          "short-timeout-click",
          "--x",
          "1",
          "--y",
          "1",
          "--timeout-ms",
          "50",
        ],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "action_timeout", retryable: true },
      });
      expect(result.json.screenshot).toMatchObject({ purpose: "action_feedback" });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "reports immediate open_app failures instead of treating Popen as success",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);
      writeExecutable(
        join(dir, "bin"),
        "fail-fast-app",
        `#!/bin/sh
exit 7
`,
      );

      const result = runDesktop(
        ["open_app", "--json", "--scenario-id", "gui", "--action-id", "failed-open", "--command", "fail-fast-app"],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "action_failed", message: "open_app exited with code 7", retryable: true },
      });
      expect(result.json.screenshot).toMatchObject({ purpose: "action_feedback" });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "logs desktop action events when xdotool or wmctrl is unavailable",
    () => {
      const dir = makeTempDir();
      const stateDir = join(dir, "state");
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      const pythonPath = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      }).stdout.trim();
      expect(pythonPath).not.toBe("");
      writeExecutable(
        binDir,
        "python3",
        `#!/bin/sh
exec ${JSON.stringify(pythonPath)} "$@"
`,
      );
      writeHealth(stateDir, availableHealth());
      const env = {
        ...process.env,
        PATH: binDir,
        DISPLAY: ":99",
        ARCANIST_DESKTOP_STATE_DIR: stateDir,
        ARCANIST_DESKTOP_EVIDENCE_ROOT: join(dir, "evidence"),
        ARCANIST_DESKTOP_CLI_LOG_PATH: join(dir, "desktop-cli.log"),
      };

      const missingXdotool = runDesktop(
        ["click", "--json", "--scenario-id", "gui", "--action-id", "missing-xdotool", "--x", "1", "--y", "1"],
        env,
      );
      const missingWmctrl = runDesktop(
        ["focus_window", "--json", "--scenario-id", "gui", "--action-id", "missing-wmctrl", "--title", "Demo app"],
        env,
      );

      expect(missingXdotool.status).toBe(1);
      expect(missingXdotool.json.error).toMatchObject({ code: "desktop_unavailable" });
      expect(missingWmctrl.status).toBe(1);
      expect(missingWmctrl.json.error).toMatchObject({ code: "desktop_unavailable" });

      const log = readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8");
      expect(log).toContain("action_id=missing-xdotool outcome=desktop_unavailable dependency=xdotool");
      expect(log).toContain("action_id=missing-wmctrl outcome=desktop_unavailable dependency=wmctrl");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "captures screenshots after failed actions",
    () => {
      const dir = makeTempDir();
      const env = {
        ...baseEnv(dir),
        FAKE_XDOTOOL_ACTION_EXIT: "7",
      };

      const result = runDesktop(
        ["hotkey", "--json", "--scenario-id", "gui", "--action-id", "failed-hotkey", "--keys", "ctrl+x"],
        env,
      );

      expect(result.status).toBe(1);
      expect(result.json).toMatchObject({
        ok: false,
        error: { code: "action_failed", retryable: true },
      });
      expect(result.json.screenshot).toMatchObject({ purpose: "action_feedback" });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "redacts typed values and reports only character count",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);
      const secret = "super-secret-value";

      const result = runDesktop(
        ["type", "--json", "--scenario-id", "gui", "--action-id", "type-1", "--text", secret],
        env,
      );

      expect(result.status).toBe(0);
      expect(result.json).toMatchObject({
        ok: true,
        typedCharacterCount: secret.length,
        inputRedacted: true,
      });
      const combinedOutput = `${result.stdout}\n${result.stderr}\n${readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8")}\n${readIfExists(env.FAKE_XDOTOOL_LOG!)}`;
      expect(combinedOutput).not.toContain(secret);
      expect(combinedOutput).toContain(`typed_character_count=${secret.length}`);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "smokes a tiny GUI target where click and type visibly change screenshots",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const click = runDesktop(
        ["click", "--json", "--scenario-id", "gui", "--action-id", "visible-click", "--x", "5", "--y", "6"],
        env,
      );
      const typed = runDesktop(
        ["type", "--json", "--scenario-id", "gui", "--action-id", "visible-type", "--text", "hello"],
        env,
      );

      expect(readFileSync(click.json.screenshot!.path, "utf8")).toContain("screen:clicked");
      expect(readFileSync(typed.json.screenshot!.path, "utf8")).toContain("screen:typed:5");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "records VP8 WebM walkthroughs and writes the private manifest",
    async () => {
      const dir = makeTempDir();
      const startedPath = join(dir, "ffmpeg-started");
      const argsLog = join(dir, "ffmpeg-args.log");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        FAKE_FFMPEG_SLEEP_SECONDS: "1",
        FAKE_FFMPEG_STARTED: startedPath,
        FAKE_FFMPEG_ARGS_LOG: argsLog,
      };
      let active = false;

      try {
        const start = runDesktop(
          [
            "record_start",
            "--json",
            "--scenario-id",
            "recording-flow",
            "--recording-id",
            "rec-1",
            "--label",
            "settings happy path",
            "--acknowledge-no-secrets",
            "true",
          ],
          env,
        );
        active = true;
        await waitForFile(startedPath, 10000);

        expect(start.status).toBe(0);
        expect(start.json).toMatchObject({
          ok: true,
          action: "record_start",
          recording: {
            status: "recording",
            recordingId: "rec-1",
            scenarioId: "recording-flow",
            label: "settings happy path",
            fps: 10,
            codec: "vp8",
            maxDurationMs: 60000,
            maxBytes: 50 * 1024 * 1024,
          },
        });
        const ffmpegArgs = readFileSync(argsLog, "utf8");
        expect(ffmpegArgs).toContain("-f x11grab");
        expect(ffmpegArgs).toContain("-draw_mouse 1");
        expect(ffmpegArgs).toContain("-framerate 10");
        expect(ffmpegArgs).toContain("-video_size 1280x720");
        expect(ffmpegArgs).toContain("-i :99");
        expect(ffmpegArgs).toContain("-t 60.000");
        expect(ffmpegArgs).toContain("-c:v libvpx");
        expect(ffmpegArgs).toContain(`-fs ${50 * 1024 * 1024}`);

        const status = runDesktop(["record_status", "--json", "--action-id", "record-status-1"], env);
        expect(status.status).toBe(0);
        expect(status.json.recording).toMatchObject({ status: "recording", recordingId: "rec-1" });

        const stop = runDesktop(["record_stop", "--json", "--action-id", "record-stop-1"], env);
        active = false;

        expect(stop.status).toBe(0);
        expect(stop.json).toMatchObject({
          ok: true,
          action: "record_stop",
          recording: {
            status: "completed",
            recordingId: "rec-1",
            fps: 10,
            codec: "vp8",
            overlayStatus: "applied",
            evidencePath: expect.stringContaining("runtime-evidence/desktop-recording-flow-rec-1-walkthrough.webm"),
          },
        });
        const manifestPath = stop.json.recording!.manifestPath!;
        const rawWebmPath = stop.json.recording!.rawWebmPath!;
        const overlayWebmPath = stop.json.recording!.overlayWebmPath!;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DesktopRecordingManifest;
        expect(manifest).toMatchObject({
          version: 1,
          scenarioId: "recording-flow",
          label: "settings happy path",
          display: { width: 1280, height: 720, scale: 1 },
          recording: {
            status: "completed",
            rawWebmPath,
            overlayWebmPath,
            codec: "vp8",
            fps: 10,
            overlayStatus: "applied",
            failureReason: null,
          },
          screenshots: [],
          actions: [],
        });
        expect(manifest.recording.bytes).toBeGreaterThan(0);
        expect(Buffer.from(readFileSync(rawWebmPath)).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        expect(readFileSync(join(dir, "evidence", "recording-flow", ".rec-1-ffmpeg-exit"), "utf8").trim()).toBe("0");
        expect(Buffer.from(readFileSync(overlayWebmPath)).subarray(0, 4)).toEqual(
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
        );

        const secondStop = runDesktop(["record_stop", "--json", "--action-id", "record-stop-2"], env);
        expect(secondStop.status).toBe(1);
        expect(secondStop.json).toMatchObject({ ok: false, error: { code: "not_recording" } });

        const log = readFileSync(env.ARCANIST_DESKTOP_CLI_LOG_PATH!, "utf8");
        expect(log).toContain("event=desktop.recording_start");
        expect(log).toContain("event=desktop.recording_stop");
        expect(log).not.toContain("settings happy path");
      } finally {
        if (active) {
          runDesktop(["record_stop", "--json", "--reason", "interrupted"], env);
        }
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "keeps valid screenshots in the recording manifest when another screenshot path is broken",
    async () => {
      const dir = makeTempDir();
      const startedPath = join(dir, "ffmpeg-started");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        FAKE_FFMPEG_SLEEP_SECONDS: "1",
        FAKE_FFMPEG_STARTED: startedPath,
      };
      let active = false;

      try {
        const start = runDesktop(
          [
            "record_start",
            "--json",
            "--scenario-id",
            "manifest-race",
            "--recording-id",
            "rec-manifest",
            "--label",
            "manifest race",
            "--acknowledge-no-secrets",
            "true",
          ],
          env,
        );
        active = true;
        expect(start.status).toBe(0);
        await waitForFile(startedPath, 10000);

        const scenarioDir = join(dir, "evidence", "manifest-race");
        mkdirSync(scenarioDir, { recursive: true });
        const validPath = join(scenarioDir, "100-valid-observe.webp");
        writeFileSync(validPath, Buffer.from(WEBP_1280X720_BASE64, "base64"));
        symlinkSync(join(scenarioDir, "missing-observe.png"), join(scenarioDir, "101-broken-observe.png"));

        const stop = runDesktop(["record_stop", "--json", "--action-id", "record-stop-manifest"], env);
        active = false;

        expect(stop.status).toBe(0);
        const manifest = JSON.parse(
          readFileSync(stop.json.recording!.manifestPath!, "utf8"),
        ) as DesktopRecordingManifest;
        expect(manifest.screenshots).toHaveLength(1);
        expect(manifest.screenshots[0]).toMatchObject({
          path: expect.stringContaining("/evidence/manifest-race/100-valid-observe.webp"),
          purpose: "observe",
          bytes: Buffer.from(WEBP_1280X720_BASE64, "base64").length,
          encodedBytes: Buffer.from(WEBP_1280X720_BASE64, "base64").length,
          mimeType: "image/webp",
          extension: ".webp",
          width: 1280,
          height: 720,
          encodingMode: "legacy",
        });
      } finally {
        if (active) {
          runDesktop(["record_stop", "--json", "--reason", "interrupted"], env);
        }
      }
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "completes an already-exited recording when stop is called with interrupted reason",
    async () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const start = runDesktop(
        [
          "record_start",
          "--json",
          "--scenario-id",
          "duration-limit",
          "--recording-id",
          "rec-finished",
          "--label",
          "duration limit",
          "--acknowledge-no-secrets",
          "true",
        ],
        env,
      );
      expect(start.status).toBe(0);
      await waitForFile(join(dir, "evidence", "duration-limit", ".rec-finished-ffmpeg-exit"), 10000);
      const state = JSON.parse(readFileSync(join(dir, "state", "recording.json"), "utf8")) as { pid: number };
      await waitForPidExit(state.pid, 10000);

      const stop = runDesktop(
        ["record_stop", "--json", "--reason", "interrupted", "--action-id", "record-stop-finished"],
        env,
      );

      expect(stop.status).toBe(0);
      expect(stop.json).toMatchObject({
        ok: true,
        recording: { status: "completed", recordingId: "rec-finished" },
      });
      const manifest = JSON.parse(readFileSync(stop.json.recording!.manifestPath!, "utf8")) as DesktopRecordingManifest;
      expect(manifest.recording).toMatchObject({
        status: "completed",
        failureReason: null,
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "applies action-trace overlays and redacts typed values from the manifest",
    () => {
      const dir = makeTempDir();
      const argsLog = join(dir, "ffmpeg-overlay-args.log");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        FAKE_FFMPEG_ARGS_LOG: argsLog,
      };
      const secret = "super-secret-value";

      const start = runDesktop(
        [
          "record_start",
          "--json",
          "--scenario-id",
          "overlay-flow",
          "--recording-id",
          "rec-overlay",
          "--label",
          "overlay flow",
          "--acknowledge-no-secrets",
          "true",
        ],
        env,
      );
      expect(start.status).toBe(0);

      const click = runDesktop(
        ["click", "--json", "--scenario-id", "overlay-flow", "--action-id", "click-overlay", "--x", "12", "--y", "34"],
        env,
      );
      const typed = runDesktop(
        ["type", "--json", "--scenario-id", "overlay-flow", "--action-id", "type-overlay", "--text", secret],
        env,
      );
      expect(click.status).toBe(0);
      expect(typed.status).toBe(0);

      const stop = runDesktop(["record_stop", "--json", "--action-id", "stop-overlay"], env);

      expect(stop.status).toBe(0);
      expect(stop.json.recording).toMatchObject({
        status: "completed",
        overlayStatus: "applied",
        evidencePath: expect.stringContaining("runtime-evidence/desktop-overlay-flow-rec-overlay-walkthrough.webm"),
      });
      const manifestText = readFileSync(stop.json.recording!.manifestPath!, "utf8");
      const manifest = JSON.parse(manifestText) as DesktopRecordingManifest;
      expect(manifest.recording.overlayWebmPath).toContain("rec-overlay-walkthrough-overlay.webm");
      expect(manifest.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionId: "click-overlay", type: "click", x: 12, y: 34 }),
          expect.objectContaining({
            actionId: "type-overlay",
            type: "type",
            typedCharacterCount: secret.length,
            inputRedacted: true,
          }),
        ]),
      );
      expect(manifestText).not.toContain(secret);
      const overlayArgs = readFileSync(argsLog, "utf8");
      expect(overlayArgs).toContain("drawbox");
      expect(overlayArgs).toContain("drawtext");
      expect(overlayArgs).not.toContain(secret);
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "does not stage raw WebM when recording overlays fail",
    () => {
      const dir = makeTempDir();
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        FAKE_FFMPEG_OVERLAY_EXIT: "9",
      };

      const start = runDesktop(
        [
          "record_start",
          "--json",
          "--scenario-id",
          "overlay-failure",
          "--recording-id",
          "rec-fail",
          "--label",
          "overlay failure flow",
          "--acknowledge-no-secrets",
          "true",
        ],
        env,
      );
      expect(start.status).toBe(0);
      const click = runDesktop(
        ["click", "--json", "--scenario-id", "overlay-failure", "--action-id", "click-fail", "--x", "10", "--y", "20"],
        env,
      );
      expect(click.status).toBe(0);

      const stop = runDesktop(["record_stop", "--json", "--action-id", "stop-fail"], env);

      expect(stop.status).toBe(1);
      expect(stop.json).toMatchObject({
        ok: false,
        error: { code: "recording_failed", retryable: false },
        recording: {
          status: "failed",
          overlayStatus: "failed",
          overlayWebmPath: null,
          evidencePath: null,
        },
      });
      const manifest = JSON.parse(readFileSync(stop.json.recording!.manifestPath!, "utf8")) as DesktopRecordingManifest;
      expect(manifest.recording).toMatchObject({
        status: "failed",
        rawWebmPath: stop.json.recording!.rawWebmPath,
        overlayWebmPath: null,
        overlayStatus: "failed",
      });
      expect(statSync(stop.json.recording!.rawWebmPath!).mode & 0o777).toBe(0o600);
      expect(readIfExists(join(dir, "runtime-evidence", "desktop-overlay-failure-rec-fail-walkthrough.webm"))).toBe("");
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "automatically stages completed overlay WebM and explicit proof screenshots",
    () => {
      const dir = makeTempDir();
      const env = baseEnv(dir);

      const start = runDesktop(
        [
          "record_start",
          "--json",
          "--scenario-id",
          "selection-flow",
          "--recording-id",
          "rec-select",
          "--label",
          "selection flow",
          "--acknowledge-no-secrets",
          "true",
        ],
        env,
      );
      expect(start.status).toBe(0);
      const proof = runDesktop(
        ["screenshot", "--json", "--scenario-id", "selection-flow", "--action-id", "proof-1"],
        env,
      );
      expect(proof.status).toBe(0);
      expect(proof.json.screenshot?.evidencePath).toMatch(/runtime-evidence\/desktop-selection-flow-proof-\d+\.webp$/);
      const stop = runDesktop(["record_stop", "--json", "--action-id", "stop-select"], env);
      expect(stop.status).toBe(0);
      expect(stop.json.recording?.evidencePath).toContain(
        "runtime-evidence/desktop-selection-flow-rec-select-walkthrough.webm",
      );
      expect(Buffer.from(readFileSync(proof.json.screenshot!.evidencePath!)).subarray(0, 4)).toEqual(
        Buffer.from("RIFF"),
      );
      expect(Buffer.from(readFileSync(stop.json.recording!.evidencePath!)).subarray(0, 4)).toEqual(
        Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      );
      const manifest = JSON.parse(readFileSync(stop.json.recording!.manifestPath!, "utf8")) as DesktopRecordingManifest;
      expect(manifest.recording.evidencePath).toBe(stop.json.recording!.evidencePath);
      expect(manifest.screenshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: proof.json.screenshot!.path,
            mimeType: "image/webp",
            extension: ".webp",
            width: 1280,
            height: 720,
            encodedBytes: proof.json.screenshot!.encodedBytes,
            encodingMode: "lossless",
          }),
        ]),
      );
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "enforces recording size caps in the manifest",
    async () => {
      const dir = makeTempDir();
      const startedPath = join(dir, "ffmpeg-started");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        ARCANIST_DESKTOP_RECORDING_MAX_BYTES: "4",
        FAKE_FFMPEG_SLEEP_SECONDS: "1",
        FAKE_FFMPEG_STARTED: startedPath,
      };

      const start = runDesktop(
        [
          "record_start",
          "--json",
          "--scenario-id",
          "too-large",
          "--recording-id",
          "rec-big",
          "--label",
          "oversized flow",
          "--acknowledge-no-secrets",
          "true",
        ],
        env,
      );
      expect(start.status).toBe(0);
      await waitForFile(startedPath, 10000);

      const stop = runDesktop(["record_stop", "--json", "--action-id", "record-stop-big"], env);

      expect(stop.status).toBe(1);
      expect(stop.json).toMatchObject({
        ok: false,
        error: { code: "recording_failed", retryable: false },
        recording: { status: "failed", maxBytes: 4 },
      });
      const manifest = JSON.parse(readFileSync(stop.json.recording!.manifestPath!, "utf8")) as DesktopRecordingManifest;
      expect(manifest.recording).toMatchObject({
        status: "failed",
        failureReason: "size_limit_exceeded",
        bytes: expect.any(Number),
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    "flushes active recordings as interrupted on resume checks",
    async () => {
      const dir = makeTempDir();
      const startedPath = join(dir, "ffmpeg-started");
      const env: NodeJS.ProcessEnv = {
        ...baseEnv(dir),
        FAKE_FFMPEG_SLEEP_SECONDS: "1",
        FAKE_FFMPEG_STARTED: startedPath,
      };

      const start = runDesktop(
        [
          "record_start",
          "--json",
          "--scenario-id",
          "resume-flow",
          "--recording-id",
          "rec-resume",
          "--label",
          "resume interrupted flow",
          "--acknowledge-no-secrets",
          "true",
        ],
        env,
      );
      expect(start.status).toBe(0);
      await waitForFile(startedPath, 10000);

      const status = runDesktop(["record_status", "--json", "--resume-check", "--action-id", "resume-check"], env);

      expect(status.status).toBe(0);
      expect(status.json).toMatchObject({
        ok: true,
        recording: { status: "interrupted", recordingId: "rec-resume" },
      });
      const manifest = JSON.parse(
        readFileSync(status.json.recording!.manifestPath!, "utf8"),
      ) as DesktopRecordingManifest;
      expect(manifest.recording).toMatchObject({
        status: "interrupted",
        failureReason: "resume_check",
        rawWebmPath: status.json.recording!.rawWebmPath,
      });
    },
    CLI_TEST_TIMEOUT_MS,
  );
});
