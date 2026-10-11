import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  filterCodexDesktopDynamicToolSpecsForImageFeedback,
  resolveCodexImageFeedbackCapability,
} from "../../apps/sandbox-bridge/src/services/codex-image-feedback";
import {
  DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
  DESKTOP_DRAG_DYNAMIC_TOOL_NAME,
  DESKTOP_DYNAMIC_TOOL_NAMESPACE,
  DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME,
  DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME,
  DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
  DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
  DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME,
  DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME,
  DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME,
  DESKTOP_SCROLL_DYNAMIC_TOOL_NAME,
  DESKTOP_TOOL_TIMEOUT_MS,
  DESKTOP_TYPE_DYNAMIC_TOOL_NAME,
  DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
} from "../../apps/sandbox-bridge/src/services/desktop-dynamic-tool";
import { validateFirstPartyDynamicToolInput } from "../../apps/sandbox-bridge/src/services/dynamic-tool-input-schemas";
import {
  buildAllDynamicToolSpecs,
  executeFirstPartyDynamicToolCall,
  redactFirstPartyDynamicToolInputForPersistence,
  serializeFirstPartyDynamicToolResultForPersistence,
} from "../../apps/sandbox-bridge/src/services/first-party-dynamic-tools";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ0f7wAAAABJRU5ErkJggg==";
const WEBP_1280X720_BASE64 =
  "UklGRk4AAABXRUJQVlA4TEEAAAAv/8SzAAdQwIIUuP8BBW3bMOUPvzuO6H+G//znP//5z3/+85///Oc///nPf/7zn//85z//+c9//vOf//znP/+rAQA=";

const tempDirs: string[] = [];
const DESKTOP_EVIDENCE_ROOT = "/tmp/phase-evidence/desktop";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cycloid-desktop-dynamic-tool-"));
  tempDirs.push(dir);
  return dir;
}

function writeFakeDesktopCli(dir: string, body: string = defaultFakeDesktopCliBody()): string {
  const cliPath = join(dir, "cycloid-desktop");
  writeFileSync(cliPath, body);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function writeFakeDesktopCliWebp(dir: string): string {
  return writeFakeDesktopCli(
    dir,
    defaultFakeDesktopCliBody()
      .replaceAll(PNG_1X1_BASE64, WEBP_1280X720_BASE64)
      .replaceAll(".png", ".webp")
      .replaceAll("image/png", "image/webp"),
  );
}

function scenarioIdForDir(dir: string): string {
  const id = basename(dir).slice(0, 80);
  tempDirs.push(join(DESKTOP_EVIDENCE_ROOT, id));
  return id;
}

function defaultFakeDesktopCliBody(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const png = Buffer.from(${JSON.stringify(PNG_1X1_BASE64)}, "base64");
const command = process.argv[2] || "unknown";
const args = process.argv.slice(3);
const options = {};
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--json") continue;
  const key = args[i].replace(/^--/, "");
  options[key] = args[i + 1];
  i += 1;
}
const now = Date.now();
const scenarioId = options["scenario-id"] || "default";
const actionId = options["action-id"] || command + "-1";
const root = process.env.ARCANIST_DESKTOP_EVIDENCE_ROOT || "/tmp/phase-evidence/desktop";
const scenarioDir = path.join(root, scenarioId);
fs.mkdirSync(scenarioDir, { recursive: true });
let fakeError = process.env.FAKE_DESKTOP_ERROR || null;
if (process.env.FAKE_DESKTOP_BUSY_ONCE_PATH) {
  if (fs.existsSync(process.env.FAKE_DESKTOP_BUSY_ONCE_PATH)) {
    fakeError = null;
  } else {
    fs.writeFileSync(process.env.FAKE_DESKTOP_BUSY_ONCE_PATH, "busy\\n");
    fakeError = "desktop_busy";
  }
}
function writeImage(name) {
  const imagePath = path.join(scenarioDir, name);
  fs.writeFileSync(imagePath, png);
  return imagePath;
}
let screenshot = null;
const recentScreenshots = [];
if (!["windows", "record_start", "record_stop", "record_status"].includes(command)) {
  recentScreenshots.push({
    actionId: "recent-a",
    path: writeImage(String(now - 2) + "-recent-a-observe.png"),
    capturedAtMs: now - 2,
    purpose: "observe",
  });
  recentScreenshots.push({
    actionId: "recent-b",
    path: writeImage(String(now - 1) + "-recent-b-action_feedback.png"),
    capturedAtMs: now - 1,
    purpose: "action_feedback",
  });
  const purpose = command === "screenshot" ? "proof_candidate" : command === "observe" ? "observe" : "action_feedback";
  screenshot = {
    path: writeImage(String(now) + "-" + actionId + "-" + purpose + ".png"),
    width: 1280,
    height: 720,
    bytes: png.length,
    mimeType: "image/png",
    purpose,
    captureMode: "full_display",
    displayName: ":99",
  };
  if (process.env.FAKE_DESKTOP_MALFORMED_SCREENSHOT) {
    screenshot = { path: 42, width: "wide", height: 720, bytes: png.length, mimeType: "image/png", purpose };
  }
  if (process.env.FAKE_DESKTOP_MISSING_SCREENSHOT && screenshot) {
    screenshot.path = path.join(scenarioDir, String(now) + "-missing.png");
  }
}
const result = {
  ok: fakeError ? false : true,
  actionId,
  action: command,
  startedAtMs: now - 10,
  completedAtMs: now,
  display: { width: 1280, height: 720, scale: 1 },
  activeWindow: { id: "0x0400001", title: "Demo app", process: null, bounds: { x: 1, y: 2, width: 300, height: 200 } },
  pointer: { x: 44, y: 55 },
  screenshot,
  recentScreenshots,
  warning: process.env.FAKE_DESKTOP_WARNING
    ? { code: "desktop_low_signal", message: "desktop warning from cli" }
    : null,
  error: fakeError
    ? { code: fakeError, message: "fake desktop failure", retryable: true, safeToRetry: true, recommendedNextTool: "desktop." + command }
    : null,
  desktopReadiness: {
    lazyStartRequested: true,
    waitMs: 1642,
    outcome: "ready_after_lazy_start",
    healthCheckMode: "full",
  },
  timings: {
    readinessMs: 1642,
    queueMs: 12,
    commandMs: 34,
    metadataMs: 56,
    screenshotCaptureMs: 78,
  },
  desktopProtocol: {
    version: options["desktop-protocol-version"] || "missing",
    cliSha256: ${JSON.stringify("a".repeat(64))},
    supervisorSha256: ${JSON.stringify("b".repeat(64))},
    bridgeBundleSha256: options["bridge-bundle-sha256"] || "unknown",
  },
  typedCharacterCount: command === "type" ? Number(process.env.FAKE_TYPED_COUNT || 0) : null,
  inputRedacted: command === "type",
};
if (process.env.FAKE_DESKTOP_MALFORMED_READINESS) {
  result.desktopReadiness.waitMs = "slow";
}
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
`;
}

function envForFakeCli(cliPath: string): Record<string, string> {
  return {
    ARCANIST_CUA_ENABLED: "1",
    ARCANIST_DESKTOP_CLI_PATH: cliPath,
    ARCANIST_DESKTOP_EVIDENCE_ROOT: DESKTOP_EVIDENCE_ROOT,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("desktop dynamic tools", () => {
  it("does not register desktop tools without the internal computer-use capability", () => {
    expect(buildAllDynamicToolSpecs({}).some((tool) => tool.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE)).toBe(false);
  });

  it("registers the desktop command specs once", () => {
    const names = buildAllDynamicToolSpecs({ ARCANIST_CUA_ENABLED: "1" })
      .filter((tool) => tool.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE)
      .map((tool) => tool.name);

    expect(names).toEqual([
      DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
      DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME,
      DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      DESKTOP_TYPE_DYNAMIC_TOOL_NAME,
      DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME,
      DESKTOP_SCROLL_DYNAMIC_TOOL_NAME,
      DESKTOP_DRAG_DYNAMIC_TOOL_NAME,
      DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
      DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME,
      DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
      DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME,
      DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME,
    ]);
  });

  it("allows verification sessions to operate the desktop", () => {
    const names = buildAllDynamicToolSpecs({ ARCANIST_CUA_ENABLED: "1" }, { agentRole: "verification" })
      .filter((tool) => tool.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE)
      .map((tool) => tool.name);

    expect(names).toEqual([
      DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
      DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME,
      DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      DESKTOP_TYPE_DYNAMIC_TOOL_NAME,
      DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME,
      DESKTOP_SCROLL_DYNAMIC_TOOL_NAME,
      DESKTOP_DRAG_DYNAMIC_TOOL_NAME,
      DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
      DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME,
      DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
      DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME,
      DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME,
    ]);
  });

  it("validates every desktop command input schema", () => {
    const validInputs: Array<[string, unknown]> = [
      [DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", actionId: "observe-1" }],
      [DESKTOP_SCREENSHOT_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1" }],
      [DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME, { actionId: "windows-1" }],
      [DESKTOP_CLICK_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", x: 1, y: 2, button: 1, targetWindowId: "0x0400001" }],
      [DESKTOP_TYPE_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", text: "hello" }],
      [DESKTOP_HOTKEY_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", keys: "ctrl+l" }],
      [DESKTOP_SCROLL_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", x: 1, y: 2, amount: -3 }],
      [DESKTOP_DRAG_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", fromX: 1, fromY: 2, toX: 3, toY: 4 }],
      [DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", url: "http://localhost:3000" }],
      [DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", command: "chromium http://localhost:3000" }],
      [DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", windowId: "0x0400001" }],
      [DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", title: "Demo app" }],
      [
        DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
        { scenarioId: "flow-1", label: "settings happy path", acknowledgeNoSecrets: true },
      ],
      [DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME, { scenarioId: "flow-1", reason: "operator_stop" }],
      [DESKTOP_RECORD_STATUS_DYNAMIC_TOOL_NAME, { actionId: "record-status-1" }],
    ];

    for (const [name, input] of validInputs) {
      expect(validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, name, input)).toMatchObject({
        ok: true,
      });
      expect(
        validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, name, { ...(input as object), extra: true }),
      ).toMatchObject({ ok: false });
    }

    expect(
      validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_CLICK_DYNAMIC_TOOL_NAME, { x: 1 }),
    ).toMatchObject({ ok: false });
    expect(
      validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME, {
        windowId: "0x1",
        title: "Demo",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME, {
        scenarioId: "flow-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_SCROLL_DYNAMIC_TOOL_NAME, {
        x: 1,
        y: 2,
        amount: 0,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateFirstPartyDynamicToolInput(DESKTOP_DYNAMIC_TOOL_NAMESPACE, DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME, {
        scenarioId: "flow-1",
        label: "settings happy path",
        acknowledgeNoSecrets: false,
      }),
    ).toMatchObject({ ok: false });
  });

  it("publishes desktop input schemas with focus and scroll constraints", () => {
    const desktopSpecs = buildAllDynamicToolSpecs({ ARCANIST_CUA_ENABLED: "1" }).filter(
      (tool) => tool.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE,
    );
    const scrollSchema = desktopSpecs.find((tool) => tool.name === DESKTOP_SCROLL_DYNAMIC_TOOL_NAME)?.inputSchema;
    const focusSchema = desktopSpecs.find((tool) => tool.name === DESKTOP_FOCUS_WINDOW_DYNAMIC_TOOL_NAME)?.inputSchema;
    const openAppSchema = desktopSpecs.find((tool) => tool.name === DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME)?.inputSchema;
    const scrollProperties = (scrollSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;

    expect(scrollProperties.amount).toMatchObject({
      not: { const: 0 },
    });
    expect(scrollProperties.targetWindowId).toMatchObject({ pattern: "^0x[0-9A-Fa-f]+$" });
    expect(focusSchema).toMatchObject({
      oneOf: [{ required: ["windowId"] }, { required: ["title"] }],
    });
    expect(openAppSchema).toMatchObject({
      oneOf: [{ required: ["url"] }, { required: ["command"] }],
    });
  });

  it("keeps desktop tools registered when the backend image-feedback gate fails", () => {
    const emitted: unknown[] = [];
    const specs = buildAllDynamicToolSpecs({ ARCANIST_CUA_ENABLED: "1" });
    const filtered = filterCodexDesktopDynamicToolSpecsForImageFeedback({
      specs,
      capability: resolveCodexImageFeedbackCapability({
        nativeToolResultImages: false,
        syntheticImageContext: false,
        jsonSerializedContentItems: true,
      }),
      modelId: "gpt-test",
      emitUnsupported: (fields) => emitted.push(fields),
    });

    expect(specs.some((spec) => spec.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE)).toBe(true);
    expect(filtered.some((spec) => spec.namespace === DESKTOP_DYNAMIC_TOOL_NAMESPACE)).toBe(true);
    expect(emitted).toEqual([
      expect.objectContaining({
        event: "desktop.model_image_feedback_unsupported",
        backend: "codex",
        modelId: "gpt-test",
        registrationBlocked: false,
      }),
    ]);
  });

  it("returns one recent screenshot when requested and records model-visible stage latency", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const scenarioId = scenarioIdForDir(dir);
    const telemetry: Array<{ event: string; fields: Record<string, unknown> }> = [];

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "click-1", x: 10, y: 20, includeRecentScreenshots: true },
      {
        env: {
          ...envForFakeCli(cliPath),
          SESSION_ID: "session-secret-123",
          E2B_SANDBOX_TEMPLATE: "desktop-template-v1",
          ARCANIST_RESOURCE_PROFILE: "mem8192-cpu4",
          ARCANIST_AGENT_RUNTIME_BACKEND: "codex",
          MODEL: "gpt-test",
        },
        recordTelemetry: (event, fields) => telemetry.push({ event, fields }),
      },
    );

    expect(result.success).toBe(true);
    expect(result.contentItems[0]).toMatchObject({ type: "inputText" });
    expect(result.contentItems.slice(1)).toEqual([
      expect.objectContaining({ type: "inputImage", detail: "high", label: "click current screenshot" }),
      expect.objectContaining({ type: "inputImage", detail: "low", label: "recent-a previous desktop screenshot" }),
    ]);
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "desktop.tool_action",
          fields: expect.objectContaining({
            action: "click",
            success: true,
            screenshotPresent: true,
            sessionIdHash: sha256Hex("session-secret-123"),
            sandboxTemplateId: "desktop-template-v1",
            resourceProfile: "mem8192-cpu4",
            agentRuntimeBackend: "codex",
            modelId: "gpt-test",
            desktopLazyStartRequested: true,
            desktopReadyWaitMs: 1642,
            desktopReadinessOutcome: "ready_after_lazy_start",
            desktopHealthCheckMode: "full",
            desktopProtocolVersion: DESKTOP_PROTOCOL_VERSION,
            desktopCliSha256: "a".repeat(64),
            desktopSupervisorSha256: "b".repeat(64),
            attemptCount: 1,
            retryCount: 0,
            recoveryReason: null,
            readinessMs: 1642,
            queueMs: 12,
            commandMs: 34,
            metadataMs: 56,
            screenshotCaptureMs: 78,
            imageReadValidationEncodeMs: expect.any(Number),
            modelVisibleTotalMs: expect.any(Number),
            persistenceOffCriticalPath: true,
          }),
        }),
        expect.objectContaining({
          event: "desktop.model_image_feedback",
          fields: expect.objectContaining({
            action: "click",
            imageCount: 2,
            success: true,
            sessionIdHash: sha256Hex("session-secret-123"),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(telemetry)).not.toContain("session-secret-123");
  });

  it("uploads current screenshots and registers desktop action path rows", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCliWebp(dir);
    const scenarioId = scenarioIdForDir(dir);
    const telemetry: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = init?.headers as Record<string, string>;

      if (url === "http://control-plane.test/api/sessions/s-1/artifacts") {
        expect(init?.method).toBe("POST");
        expect(headers.authorization).toBe("Bearer sandbox-token");
        expect(headers["content-type"]).toBe("image/webp");
        expect(headers["x-artifact-type"]).toBe("screenshot");
        expect(headers["x-artifact-kind"]).toBe("desktop_action_screenshot");
        expect(headers["x-desktop-action-id"]).toBe("click-1");
        expect(headers["x-desktop-phase"]).toBe("verification_operator");
        expect(headers["x-desktop-scenario-id"]).toBe(scenarioId);
        expect((init?.body as Uint8Array).byteLength).toBeGreaterThan(0);
        return new Response(
          JSON.stringify({
            ok: true,
            artifact: {
              id: "artifact-1",
              label: "click current screenshot",
              viewUrl: "/api/sessions/s-1/artifacts/artifact-1/view?filename=click-1-click.webp",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url === "http://control-plane.test/api/sessions/s-1/desktop/action-path") {
        expect(init?.method).toBe("POST");
        expect(headers.authorization).toBe("Bearer sandbox-token");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          actionId: "click-1",
          promptId: null,
          phase: "verification_operator",
          action: "click",
          label: "Desktop click",
          status: "completed",
          activeWindowTitle: "Demo app",
          warningCode: null,
          errorCode: null,
        });
        expect(body.screenshot).toMatchObject({
          actionId: "click-1",
          artifactId: "artifact-1",
          kind: "desktop_action_screenshot",
          artifactAccessVisibility: "private",
          viewUrl: "/api/sessions/s-1/artifacts/artifact-1/view?filename=click-1-click.webp",
          captureMode: "full_display",
          displayName: ":99",
          status: "available",
        });
        expect(body.screenshot.width).toBe(1280);
        expect(body.screenshot.height).toBe(720);
        expect(body.screenshot.bytes).toBeGreaterThan(0);
        return new Response(
          JSON.stringify({
            ok: true,
            row: { ...body, sessionId: "s-1", desktopActionSeq: 1 },
            idempotent: false,
            updated: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`unexpected request: ${url}`);
    });

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "click-1", x: 10, y: 20 },
      {
        env: {
          ...envForFakeCli(cliPath),
          CONTROL_PLANE_URL: "http://control-plane.test",
          SESSION_ID: "s-1",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
        },
        agentRole: "verification",
        fetchImpl: fetchImpl as typeof fetch,
        recordTelemetry: (event, fields) => telemetry.push({ event, fields }),
      },
    );

    expect(result.success).toBe(true);
    expect(result.contentItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "inputImage",
          mimeType: "image/webp",
          width: 1280,
          height: 720,
        }),
      ]),
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "desktop.action_path_register",
          fields: expect.objectContaining({
            action: "click",
            actionId: "click-1",
            phase: "verification_operator",
            success: true,
            screenshotUploaded: true,
            failureCode: null,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(telemetry)).not.toContain("sandbox-token");
  });

  it("maps desktop CLI failures to dynamic tool failures while preserving screenshot feedback", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const scenarioId = scenarioIdForDir(dir);

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "busy", x: 10, y: 20 },
      { env: { ...envForFakeCli(cliPath), FAKE_DESKTOP_ERROR: "desktop_busy" } },
    );

    expect(result).toMatchObject({ success: false, errorCode: "limit_exceeded" });
    expect(result.contentItems.some((item) => item.type === "inputImage")).toBe(true);
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text.split("\n\nRecovery:")[0])).toMatchObject({
      ok: false,
      error: { code: "desktop_busy" },
    });
  });

  it("retries desktop_busy once for safe read calls", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const busyOncePath = join(dir, "busy-once");
    const telemetry: Array<{ event: string; fields: Record<string, unknown> }> = [];

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
      { actionId: "windows-after-busy" },
      {
        env: { ...envForFakeCli(cliPath), FAKE_DESKTOP_BUSY_ONCE_PATH: busyOncePath },
        recordTelemetry: (event, fields) => telemetry.push({ event, fields }),
      },
    );

    expect(result.success).toBe(true);
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "desktop.tool_action",
          fields: expect.objectContaining({ attemptCount: 2, recoveryReason: "desktop_busy" }),
        }),
      ]),
    );
  });

  it("fails closed with desktop_protocol_mismatch when the CLI handshake is stale", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(
      dir,
      `#!/usr/bin/env node
const now = Date.now();
process.stdout.write(JSON.stringify({
  ok: true,
  actionId: "stale-cli",
  action: "windows",
  startedAtMs: now,
  completedAtMs: now,
  display: { width: 1280, height: 720, scale: 1 },
  activeWindow: { title: null, process: null, bounds: null },
  pointer: null,
  screenshot: null,
  recentScreenshots: [],
  warning: null,
  error: null
}));
`,
    );

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
      { actionId: "stale-cli" },
      { env: envForFakeCli(cliPath) },
    );

    expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: {
        code: "desktop_protocol_mismatch",
        safeToRetry: false,
        recommendedNextTool: null,
      },
    });
  });

  it("fails closed on malformed desktop screenshot JSON without crashing", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const scenarioId = scenarioIdForDir(dir);

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "malformed-screenshot", x: 10, y: 20 },
      { env: { ...envForFakeCli(cliPath), FAKE_DESKTOP_MALFORMED_SCREENSHOT: "1" } },
    );

    expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
    expect(result.contentItems.some((item) => item.type === "inputImage")).toBe(false);
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      screenshot: null,
      error: { code: "invalid_cli_output" },
    });
  });

  it("fails closed on malformed desktop readiness telemetry", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_WINDOWS_DYNAMIC_TOOL_NAME,
      { actionId: "malformed-readiness" },
      { env: { ...envForFakeCli(cliPath), FAKE_DESKTOP_MALFORMED_READINESS: "1" } },
    );

    expect(result).toMatchObject({ success: false, errorCode: "execution_failed" });
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: { code: "invalid_cli_output" },
    });
  });

  it("preserves image-feedback warnings when the desktop CLI already returned a warning", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const scenarioId = scenarioIdForDir(dir);

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_CLICK_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "warning", x: 10, y: 20 },
      {
        env: {
          ...envForFakeCli(cliPath),
          FAKE_DESKTOP_MISSING_SCREENSHOT: "1",
          FAKE_DESKTOP_WARNING: "1",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.contentItems.some((item) => item.type === "inputImage")).toBe(false);
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({
      warning: {
        code: "model_image_feedback_failed",
        message: expect.stringContaining("Existing desktop warning (desktop_low_signal): desktop warning from cli"),
      },
    });
    expect(text).toContain("Dynamic tool image path must point to a regular file.");
  });

  it("allows observe to wait for first-use desktop readiness before returning CLI JSON", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(
      dir,
      `#!/usr/bin/env node
const command = process.argv[2] || "unknown";
const args = process.argv.slice(3);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const now = Date.now();
const result = {
  ok: true,
  actionId: "observe-after-ready",
  action: command,
  startedAtMs: now - 10,
  completedAtMs: now,
  display: { width: 1280, height: 720, scale: 1 },
  activeWindow: { id: "0x0400001", title: "Demo app", process: null, bounds: null },
  pointer: null,
  screenshot: null,
  recentScreenshots: [],
  warning: null,
  error: null,
  desktopProtocol: {
    version: valueAfter("--desktop-protocol-version") || "missing",
    cliSha256: "${"a".repeat(64)}",
    supervisorSha256: "${"b".repeat(64)}",
    bridgeBundleSha256: valueAfter("--bridge-bundle-sha256") || "unknown",
  },
};
setTimeout(() => {
  process.stdout.write(JSON.stringify(result));
}, 5500);
`,
    );

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
      { scenarioId: "default", actionId: "observe-after-ready" },
      { env: envForFakeCli(cliPath) },
    );

    expect(result.success).toBe(true);
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: true, action: "observe", actionId: "observe-after-ready" });
  }, 10_000);

  it("keeps image bytes out of persisted dynamic tool results", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const scenarioId = scenarioIdForDir(dir);

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_OBSERVE_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "observe-1" },
      { env: envForFakeCli(cliPath) },
    );
    const persisted = serializeFirstPartyDynamicToolResultForPersistence(result) ?? "";

    expect(result.contentItems.some((item) => item.type === "inputImage")).toBe(true);
    expect(persisted).toContain("inputText");
    expect(persisted).not.toContain("inputImage");
    expect(persisted).not.toContain(PNG_1X1_BASE64);
  });

  it("redacts typed text before persistence", () => {
    const redacted = redactFirstPartyDynamicToolInputForPersistence(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_TYPE_DYNAMIC_TOOL_NAME,
      {
        scenarioId: "flow-1",
        text: "super-secret",
      },
    );

    expect(redacted).toEqual({
      scenarioId: "flow-1",
      text: "[redacted]",
      typedCharacterCount: 12,
      inputRedacted: true,
    });
  });

  it("sanitizes open_app URL queries before persistence", () => {
    const redacted = redactFirstPartyDynamicToolInputForPersistence(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_OPEN_APP_DYNAMIC_TOOL_NAME,
      {
        scenarioId: "flow-1",
        url: "https://example.com/app/settings?token=secret#session-secret",
      },
    );

    expect(redacted).toMatchObject({
      scenarioId: "flow-1",
      urlSanitized: true,
    });
    expect(String(redacted.url)).toContain("https://example.com/app/settings");
    expect(String(redacted.url)).toContain("[url_sha256:");
    expect(String(redacted.url)).not.toContain("token=secret");
    expect(String(redacted.url)).not.toContain("session-secret");
  });

  it("wraps desktop recording commands as text-only tool results", async () => {
    const dir = makeTempDir();
    const cliPath = writeFakeDesktopCli(dir);
    const scenarioId = scenarioIdForDir(dir);

    const result = await executeFirstPartyDynamicToolCall(
      DESKTOP_DYNAMIC_TOOL_NAMESPACE,
      DESKTOP_RECORD_START_DYNAMIC_TOOL_NAME,
      { scenarioId, actionId: "record-start-1", label: "settings happy path", acknowledgeNoSecrets: true },
      { env: envForFakeCli(cliPath) },
    );

    expect(result.success).toBe(true);
    expect(result.contentItems).toEqual([expect.objectContaining({ type: "inputText" })]);
    const text = result.contentItems.find((item) => item.type === "inputText")?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ ok: true, action: "record_start", screenshot: null });
  });

  it("gives record_stop longer than the CLI overlay timeout", () => {
    expect(DESKTOP_TOOL_TIMEOUT_MS[DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME]).toBe(45_000);
    expect(DESKTOP_TOOL_TIMEOUT_MS[DESKTOP_RECORD_STOP_DYNAMIC_TOOL_NAME]).toBeGreaterThan(30_000);
  });
});
