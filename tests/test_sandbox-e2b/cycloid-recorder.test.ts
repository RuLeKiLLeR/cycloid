import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const RECORDER = resolve(REPO_ROOT, "apps/sandbox-e2b/cycloid-recorder.mjs");

function runRecorder(args: string[]) {
  return spawnSync(process.execPath, [RECORDER, ...args], {
    encoding: "utf8",
  });
}

describe("cycloid-recorder", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function tempStateRoot() {
    const path = mkdtempSync(join(tmpdir(), "cycloid-recorder-state-"));
    cleanupPaths.push(path);
    return path;
  }

  function tempOutDir(name = "settings-flow") {
    const path = join("/tmp/phase-evidence/operator", `vitest-${process.pid}-${Date.now()}-${name}`);
    cleanupPaths.push(path);
    return path;
  }

  function tempPhaseEvidenceRoot() {
    const path = mkdtempSync(join(tmpdir(), "cycloid-phase-evidence-"));
    cleanupPaths.push(path);
    return path;
  }

  function validStorageState() {
    const path = join(mkdtempSync(join(tmpdir(), "cycloid-recorder-auth-")), "state.json");
    cleanupPaths.push(resolve(path, ".."));
    writeFileSync(
      path,
      JSON.stringify({
        cookies: [{ name: "sid", value: "test", domain: "127.0.0.1", path: "/" }],
        origins: [
          {
            origin: "http://127.0.0.1:3000",
            localStorage: [{ name: "theme", value: "dark" }],
          },
        ],
      }),
    );
    return path;
  }

  it("ships a discoverable command skeleton", () => {
    expect(existsSync(RECORDER)).toBe(true);
    if (!existsSync(RECORDER)) {
      return;
    }

    const source = readFileSync(RECORDER, "utf8");
    expect(source).toContain("#!/usr/bin/env node");

    const result = runRecorder(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: cycloid-recorder");
    expect(result.stdout).toContain("start   --out-dir <dir>");
    expect(result.stdout).toContain("record  --id <recorderId>");
    expect(result.stdout).toContain("stop    --id <recorderId>");
    expect(result.stdout).toContain("shot    --id <recorderId> <label>");
    expect(result.stdout).toContain("close   --id <recorderId>");
    expect(result.stdout).toContain("Phase 4 supports recorder-owned browser start/close, screenshots");
    expect(result.stdout).toContain("cursor/click overlays");
  });

  it("waits for page web fonts before capturing screenshots", () => {
    const source = readFileSync(RECORDER, "utf8");

    expect(source).toContain("async function waitForPageFonts(page)");
    expect(source).toContain("document.fonts");
    expect(source).toContain("fontSet.ready");
    expect(source).toContain("await waitForPageFonts(page)");
    expect(source.indexOf("await waitForPageFonts(page)")).toBeLessThan(source.indexOf("await page.screenshot"));
  });

  it("prints command-specific help without executing the stub", () => {
    const result = runRecorder(["start", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(
      "Usage: cycloid-recorder start --out-dir <dir> [--storage-state <state.json>] [--viewport 1280x720] [--max-duration-ms 45000] [--frame-rate 10]",
    );
  });

  it("parses start defaults without launching a browser", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      parseArgs: (argv: string[]) => unknown;
    };

    expect(mod.parseArgs(["start", "--out-dir", "/tmp/phase-evidence/operator/settings-flow"])).toMatchObject({
      command: "start",
      options: {
        outDir: "/tmp/phase-evidence/operator/settings-flow",
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
    });
  });

  it("starts a recorder with loopback CDP output and persisted local state", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir();

    const result = await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1440, height: 900 },
        maxDurationMs: 30_000,
        frameRate: 12,
      },
      {
        stateRoot,
        recorderId: "rec_1111111111111111",
        cdpPort: 43001,
        launchSidecar: async () => ({
          pid: process.pid,
          cdpUrl: "ws://127.0.0.1:43001/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43002",
        }),
      },
    );

    expect(result).toEqual({
      recorderId: "rec_1111111111111111",
      cdpUrl: "ws://127.0.0.1:43001/devtools/browser/test",
      outDir,
    });
    const state = JSON.parse(readFileSync(join(stateRoot, "rec_1111111111111111/state.json"), "utf8"));
    expect(state).toMatchObject({
      recorderId: "rec_1111111111111111",
      cdpUrl: "ws://127.0.0.1:43001/devtools/browser/test",
      controlUrl: "http://127.0.0.1:43002/",
      outDir,
      viewport: { width: 1440, height: 900 },
      maxDurationMs: 30_000,
      frameRate: 12,
      lifecycleStatus: "idle",
    });
    expect(state.userDataDir).toContain(stateRoot);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      tool: "cycloid-recorder",
      label: null,
      outcomeLabel: null,
      lifecycleStatus: "idle",
      startedAt: expect.any(String),
      stoppedAt: null,
      durationMs: null,
      viewport: { width: 1440, height: 900 },
      video: null,
      screenshots: [],
      redactions: {
        inputValuesRendered: false,
        storageStateCopied: false,
        cdpUrlPublished: false,
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("devtools/browser");
  });

  it("keeps recorder output under the configured phase evidence root", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const originalPhaseEvidenceDir = process.env.ARCANIST_PHASE_EVIDENCE_DIR;
    const phaseEvidenceRoot = tempPhaseEvidenceRoot();
    const stateRoot = tempStateRoot();
    const outDir = join(phaseEvidenceRoot, "operator", "custom-root-flow");
    process.env.ARCANIST_PHASE_EVIDENCE_DIR = phaseEvidenceRoot;

    try {
      const result = await mod.startRecorder(
        {
          outDir,
          viewport: { width: 1280, height: 720 },
          maxDurationMs: 45_000,
          frameRate: 10,
        },
        {
          stateRoot,
          recorderId: "rec_1212121212121212",
          launchSidecar: async () => ({
            pid: process.pid,
            cdpUrl: "ws://127.0.0.1:43011/devtools/browser/test",
            controlUrl: "http://127.0.0.1:43012",
          }),
        },
      );

      expect(result.outDir).toBe(outDir);
      expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
    } finally {
      if (originalPhaseEvidenceDir === undefined) {
        delete process.env.ARCANIST_PHASE_EVIDENCE_DIR;
      } else {
        process.env.ARCANIST_PHASE_EVIDENCE_DIR = originalPhaseEvidenceDir;
      }
    }
  });

  it("sanitizes screenshot labels into safe png filenames", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      sanitizeScreenshotFilename: (label: string) => string;
    };
    const secret = "ghp_1234567890abcdefghijklmnop";

    expect(mod.sanitizeScreenshotFilename("Settings saved!")).toBe("Settings-saved.png");
    expect(mod.sanitizeScreenshotFilename("settings.saved.png")).toBe("settings.saved.png");
    expect(mod.sanitizeScreenshotFilename("  before edit  ")).toBe("before-edit.png");
    expect(mod.sanitizeScreenshotFilename(`callback ${secret}`)).toBe("callback-redacted.png");
    expect(() => mod.sanitizeScreenshotFilename("../escape")).toThrow(/path separators/);
    expect(() => mod.sanitizeScreenshotFilename("")).toThrow(/non-empty/);
  });

  it("lets Chromium allocate the CDP port by default", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("dynamic-cdp-flow");
    let configuredCdpPort: unknown;

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_abababababababab",
        launchSidecar: async (config: Record<string, unknown>) => {
          configuredCdpPort = config.cdpPort;
          return {
            pid: process.pid,
            cdpUrl: "ws://127.0.0.1:43161/devtools/browser/test",
            controlUrl: "http://127.0.0.1:43162",
          };
        },
      },
    );

    expect(configuredCdpPort).toBe(0);
  });

  it("captures a screenshot through the sidecar and tracks it in the manifest", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      takeScreenshot: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("shot-flow");
    const secret = "ghp_1234567890abcdefghijklmnop";
    let capturedPath: string | undefined;

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_bbbbbbbbbbbbbbbb",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43051/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43052",
        }),
      },
    );

    await expect(
      mod.takeScreenshot("rec_bbbbbbbbbbbbbbbb", "settings saved", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarShot: async (_controlUrl: string, path: string) => {
          capturedPath = path;
          writeFileSync(path, "png");
        },
      }),
    ).resolves.toMatchObject({
      recorderId: "rec_bbbbbbbbbbbbbbbb",
      outDir,
      screenshot: "settings-saved.png",
    });
    expect(capturedPath).toBe(join(outDir, "settings-saved.png"));

    await expect(
      mod.takeScreenshot("rec_bbbbbbbbbbbbbbbb", `callback ${secret}`, {
        stateRoot,
        isProcessAlive: () => true,
        sidecarShot: async (_controlUrl: string, path: string) => {
          capturedPath = path;
          writeFileSync(path, "png");
        },
      }),
    ).resolves.toMatchObject({
      recorderId: "rec_bbbbbbbbbbbbbbbb",
      outDir,
      screenshot: "callback-redacted.png",
    });
    expect(capturedPath).toBe(join(outDir, "callback-redacted.png"));

    const manifestText = readFileSync(join(outDir, "manifest.json"), "utf8");
    expect(manifestText).not.toContain(secret);
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({
      lifecycleStatus: "idle",
      screenshots: ["settings-saved.png", "callback-redacted.png"],
      updatedAt: expect.any(String),
      redactions: {
        inputValuesRendered: false,
        storageStateCopied: false,
        cdpUrlPublished: false,
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("43051");
  });

  it("preserves recording lifecycle when capturing a screenshot mid-recording", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      takeScreenshot: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("shot-during-recording-flow");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_beefbeefbeefbeef",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43071/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43072",
        }),
      },
    );

    await mod.startRecording("rec_beefbeefbeefbeef", "settings happy path", {
      stateRoot,
      isProcessAlive: () => true,
      sidecarRecord: async () => ({
        startedAt: "2026-07-03T00:00:10.000Z",
        maxFrameCount: 460,
      }),
    });

    await expect(
      mod.takeScreenshot("rec_beefbeefbeefbeef", "settings before save", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarShot: async (_controlUrl: string, path: string) => {
          writeFileSync(path, "png");
        },
      }),
    ).resolves.toMatchObject({
      recorderId: "rec_beefbeefbeefbeef",
      outDir,
      screenshot: "settings-before-save.png",
    });

    expect(JSON.parse(readFileSync(join(stateRoot, "rec_beefbeefbeefbeef/state.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "recording",
      recordingStartedAt: "2026-07-03T00:00:10.000Z",
    });
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      label: "settings happy path",
      lifecycleStatus: "recording",
      screenshots: ["settings-before-save.png"],
      video: null,
    });
  });

  it("rejects screenshot path traversal labels before calling the sidecar", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      takeScreenshot: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("bad-shot-flow");
    let sidecarCalled = false;

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_cccccccccccccccc",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43061/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43062",
        }),
      },
    );

    await expect(
      mod.takeScreenshot("rec_cccccccccccccccc", "../escape", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarShot: async () => {
          sidecarCalled = true;
        },
      }),
    ).rejects.toThrow(/path separators/);
    expect(sidecarCalled).toBe(false);
  });

  it("flushes a partial manifest when screenshot capture fails", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      takeScreenshot: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("shot-failure-flow");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_dddddddddddddddd",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43071/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43072",
        }),
        now: () => new Date("2026-07-03T00:00:00.000Z"),
      },
    );

    await expect(
      mod.takeScreenshot("rec_dddddddddddddddd", "after failure", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarShot: async () => {
          throw new Error("browser page crashed");
        },
        now: () => new Date("2026-07-03T00:00:05.000Z"),
      }),
    ).rejects.toThrow(/browser page crashed/);

    const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      lifecycleStatus: "failed",
      startedAt: "2026-07-03T00:00:00.000Z",
      stoppedAt: "2026-07-03T00:00:05.000Z",
      durationMs: 5000,
      screenshots: [],
      lastError: { message: "browser page crashed" },
    });
  });

  it("records and stops a screencast through the sidecar state machine", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      stopRecording: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("record-flow");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_1212121212121212",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43101/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43102",
        }),
      },
    );

    await expect(
      mod.startRecording("rec_1212121212121212", "settings happy path", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarRecord: async () => ({
          startedAt: "2026-07-03T00:00:10.000Z",
          maxFrameCount: 460,
        }),
      }),
    ).resolves.toMatchObject({
      recorderId: "rec_1212121212121212",
      outDir,
      label: "settings happy path",
      startedAt: "2026-07-03T00:00:10.000Z",
      frameRate: 10,
      maxDurationMs: 45_000,
    });

    expect(JSON.parse(readFileSync(join(stateRoot, "rec_1212121212121212/state.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "recording",
      recordingStartedAt: "2026-07-03T00:00:10.000Z",
    });
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      label: "settings happy path",
      lifecycleStatus: "recording",
      startedAt: "2026-07-03T00:00:10.000Z",
      video: null,
      recording: {
        frameRate: 10,
        maxDurationMs: 45_000,
        maxFrameCount: 460,
      },
    });

    await expect(
      mod.stopRecording("rec_1212121212121212", "saved state visible", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarStop: async () => ({
          video: "happy-path.webm",
          path: join(outDir, "happy-path.webm"),
          frameCount: 24,
          droppedFrames: 3,
          sizeBytes: 4096,
          autoStopped: false,
          stopReason: "manual",
        }),
        now: () => new Date("2026-07-03T00:00:14.000Z"),
      }),
    ).resolves.toMatchObject({
      recorderId: "rec_1212121212121212",
      outDir,
      video: "happy-path.webm",
      path: join(outDir, "happy-path.webm"),
      frameCount: 24,
      droppedFrames: 3,
      autoStopped: false,
    });

    expect(JSON.parse(readFileSync(join(stateRoot, "rec_1212121212121212/state.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "completed",
      recordingStoppedAt: "2026-07-03T00:00:14.000Z",
    });
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      outcomeLabel: "saved state visible",
      lifecycleStatus: "completed",
      video: "happy-path.webm",
      recording: {
        frameCount: 24,
        droppedFrames: 3,
        sizeBytes: 4096,
        stopReason: "manual",
      },
    });
  });

  it("redacts token-like strings from recorder labels before writing manifests", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      redactTokenLikeText: (value: string, fallback?: string) => string;
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
      stopRecording: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const secret = "ghp_1234567890abcdefghijklmnop";
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("redacted-label-flow");
    let labelSentToSidecar: string | null = null;
    let stopLabelSentToSidecar: string | null = null;

    expect(mod.redactTokenLikeText(`save ${secret}`)).toBe("save [redacted]");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_1717171717171717",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43151/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43152",
        }),
      },
    );

    await mod.startRecording("rec_1717171717171717", `settings ${secret}`, {
      stateRoot,
      isProcessAlive: () => true,
      sidecarRecord: async (_controlUrl: string, label: string) => {
        labelSentToSidecar = label;
        return { startedAt: "2026-07-03T00:00:00.000Z" };
      },
    });
    await mod.stopRecording("rec_1717171717171717", `done ${secret}`, {
      stateRoot,
      isProcessAlive: () => true,
      sidecarStop: async (_controlUrl: string, label: string) => {
        stopLabelSentToSidecar = label;
        return {
          video: "happy-path.webm",
          path: join(outDir, "happy-path.webm"),
          frameCount: 1,
          droppedFrames: 0,
          sizeBytes: 128,
          autoStopped: false,
          stopReason: "manual",
        };
      },
    });

    expect(labelSentToSidecar).toBe("settings [redacted]");
    expect(stopLabelSentToSidecar).toBe("done [redacted]");
    const manifestText = readFileSync(join(outDir, "manifest.json"), "utf8");
    expect(manifestText).not.toContain(secret);
    expect(JSON.parse(manifestText)).toMatchObject({
      label: "settings [redacted]",
      outcomeLabel: "done [redacted]",
    });
  });

  it("clamps overlay coordinates and sanitizes manifest actions", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      clampOverlayPoint: (
        point: Record<string, unknown>,
        viewport: Record<string, unknown>,
      ) => { x: number; y: number };
      sanitizeManifestAction: (
        action: Record<string, unknown>,
        viewport: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    };
    const secret = "sk-1234567890abcdefghijklmnopQRSTUV";

    expect(mod.clampOverlayPoint({ x: -50, y: 9999 }, { width: 1280, height: 720 })).toEqual({
      x: 0,
      y: 720,
    });
    expect(
      mod.sanitizeManifestAction(
        {
          id: "act_1",
          type: "click",
          label: `save ${secret}`,
          urlBefore: `http://127.0.0.1/settings?token=${secret}`,
          urlAfter: `http://127.0.0.1/settings/${secret}`,
          target: { x: 2000, y: -5, width: 9000, height: 30 },
          startedAtMs: 12.4,
        },
        { width: 1280, height: 720 },
      ),
    ).toEqual({
      id: "act_1",
      type: "click",
      label: "save [redacted]",
      urlBefore: "http://127.0.0.1/settings",
      urlAfter: "http://127.0.0.1/settings/[redacted]",
      target: { x: 1280, y: 0, width: 1280, height: 30 },
      startedAtMs: 12,
      completedAtMs: null,
      status: "success",
    });
  });

  it("decides when overlay reinjection is required", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      shouldReinjectRecorderOverlay: (input: Record<string, unknown>) => boolean;
    };

    expect(
      mod.shouldReinjectRecorderOverlay({
        existingVersion: 1,
        isTopLevelNavigation: false,
        isSpaRouteChange: false,
      }),
    ).toBe(false);
    expect(
      mod.shouldReinjectRecorderOverlay({
        existingVersion: 1,
        isTopLevelNavigation: true,
        isSpaRouteChange: false,
      }),
    ).toBe(true);
    expect(
      mod.shouldReinjectRecorderOverlay({
        existingVersion: 0,
        isTopLevelNavigation: false,
        isSpaRouteChange: false,
      }),
    ).toBe(true);
  });

  it("skips screencast frame ack after an abort has started", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      shouldAckScreencastFrame: (recording: Record<string, unknown>) => boolean;
    };

    expect(mod.shouldAckScreencastFrame({ abortStarted: false })).toBe(true);
    expect(mod.shouldAckScreencastFrame({ abortStarted: true })).toBe(false);
  });

  it("installs a passive non-interactive overlay without rendering input values", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      createRecorderOverlayScript: () => string;
    };
    const secret = "ghp_1234567890abcdefghijklmnop";
    const happyWindow = new Window({
      url: `http://127.0.0.1/settings?token=${secret}`,
    });

    happyWindow.document.body.innerHTML = `
      <input id="api-key" value="${secret}" />
      <button id="save">Save ${secret}</button>
    `;
    happyWindow.eval(mod.createRecorderOverlayScript());

    const input = happyWindow.document.getElementById("api-key");
    const button = happyWindow.document.getElementById("save");
    expect(input).not.toBeNull();
    expect(button).not.toBeNull();

    input?.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
    button?.dispatchEvent(
      new happyWindow.MouseEvent("click", {
        bubbles: true,
        clientX: 5000,
        clientY: -25,
      }),
    );

    const overlay = happyWindow.document.getElementById("__cycloid-recorder-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("style") ?? "").not.toContain("pointer-events");
    expect(
      happyWindow.getComputedStyle(overlay as unknown as Parameters<typeof happyWindow.getComputedStyle>[0])
        .pointerEvents,
    ).toBe("none");
    expect(overlay?.textContent).not.toContain(secret);

    const recorderWindow = happyWindow as unknown as {
      __cycloidRecorder: { exportActions: () => Array<Record<string, unknown>> };
    };
    const actions = recorderWindow.__cycloidRecorder.exportActions();
    expect(actions).toHaveLength(2);
    expect(JSON.stringify(actions)).not.toContain(secret);
    expect(actions).toMatchObject([
      { type: "input", label: "input changed", urlBefore: "http://127.0.0.1/settings" },
      {
        type: "click",
        label: "click",
        urlBefore: "http://127.0.0.1/settings",
        target: { y: 0 },
      },
    ]);
  });

  it("rejects double record and idle stop without calling the sidecar", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
      stopRecording: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("invalid-record-flow");
    let sidecarRecordCalls = 0;
    let sidecarStopCalls = 0;

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_1313131313131313",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43111/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43112",
        }),
      },
    );

    await expect(
      mod.stopRecording("rec_1313131313131313", "not started", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarStop: async () => {
          sidecarStopCalls += 1;
        },
      }),
    ).rejects.toThrow(/not recording/);
    expect(sidecarStopCalls).toBe(0);

    await mod.startRecording("rec_1313131313131313", "first", {
      stateRoot,
      isProcessAlive: () => true,
      sidecarRecord: async () => {
        sidecarRecordCalls += 1;
        return { startedAt: "2026-07-03T00:00:00.000Z" };
      },
    });
    await expect(
      mod.startRecording("rec_1313131313131313", "second", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarRecord: async () => {
          sidecarRecordCalls += 1;
        },
      }),
    ).rejects.toThrow(/already recording/);
    expect(sidecarRecordCalls).toBe(1);
  });

  it("writes recorder-error.log and a partial manifest when stop encoding fails", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
      stopRecording: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("encode-failure-flow");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_1414141414141414",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43121/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43122",
        }),
      },
    );
    await mod.startRecording("rec_1414141414141414", "broken", {
      stateRoot,
      isProcessAlive: () => true,
      sidecarRecord: async () => ({ startedAt: "2026-07-03T00:00:00.000Z" }),
    });

    await expect(
      mod.stopRecording("rec_1414141414141414", "failed", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarStop: async () => {
          throw new Error("ffmpeg exited with code 1");
        },
        now: () => new Date("2026-07-03T00:00:03.000Z"),
      }),
    ).rejects.toThrow(/ffmpeg exited with code 1/);

    expect(readFileSync(join(outDir, "recorder-error.log"), "utf8")).toContain("ffmpeg exited with code 1");
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "failed",
      stoppedAt: "2026-07-03T00:00:03.000Z",
      durationMs: 3000,
      lastError: { message: "ffmpeg exited with code 1" },
    });
  });

  it("records auto-stop status returned by the sidecar", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
      stopRecording: (
        recorderId: string,
        label: string,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("autostop-flow");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 1000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_1616161616161616",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43141/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43142",
        }),
      },
    );
    await mod.startRecording("rec_1616161616161616", "auto", {
      stateRoot,
      isProcessAlive: () => true,
      sidecarRecord: async () => ({ startedAt: "2026-07-03T00:00:00.000Z" }),
    });

    await expect(
      mod.stopRecording("rec_1616161616161616", "duration reached", {
        stateRoot,
        isProcessAlive: () => true,
        sidecarStop: async () => ({
          video: "happy-path.webm",
          path: join(outDir, "happy-path.webm"),
          frameCount: 5,
          droppedFrames: 1,
          sizeBytes: 1024,
          autoStopped: true,
          stopReason: "duration_limit",
        }),
      }),
    ).resolves.toMatchObject({
      autoStopped: true,
      frameCount: 5,
      droppedFrames: 1,
    });

    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "auto_stopped",
      recording: {
        stopReason: "duration_limit",
      },
    });
  });

  it("auto-stops recording on close and preserves final artifact paths", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      startRecording: (recorderId: string, label: string, deps: Record<string, unknown>) => Promise<unknown>;
      closeRecorder: (recorderId: string, deps: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("close-autostop-flow");

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_1515151515151515",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43131/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43132",
        }),
      },
    );
    await mod.startRecording("rec_1515151515151515", "close flow", {
      stateRoot,
      isProcessAlive: () => true,
      sidecarRecord: async () => ({ startedAt: "2026-07-03T00:00:00.000Z" }),
    });

    await expect(
      mod.closeRecorder("rec_1515151515151515", {
        stateRoot,
        isProcessAlive: () => true,
        closeSidecar: async () => ({
          stopResult: {
            video: "happy-path.webm",
            path: join(outDir, "happy-path.webm"),
            frameCount: 12,
            droppedFrames: 2,
            sizeBytes: 2048,
            stopReason: "close",
          },
        }),
        now: () => new Date("2026-07-03T00:00:02.000Z"),
      }),
    ).resolves.toMatchObject({
      recorderId: "rec_1515151515151515",
      outDir,
      manifest: join(outDir, "manifest.json"),
      video: "happy-path.webm",
      path: join(outDir, "happy-path.webm"),
      autoStopped: true,
    });
    expect(existsSync(join(stateRoot, "rec_1515151515151515/state.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "closed",
      video: "happy-path.webm",
      recording: {
        frameCount: 12,
        droppedFrames: 2,
        sizeBytes: 2048,
        stopReason: "close",
      },
    });
  });

  it("encodes VP8 WebM and rejects output above the publish cap", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      encodeFramesToWebm: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const outDir = tempOutDir("encode-cap-flow");
    const frameDir = join(outDir, ".frames");
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(join(frameDir, "frame-000001.jpg"), "jpeg");

    await expect(
      mod.encodeFramesToWebm(
        { outDir, frameDir, frameRate: 10 },
        {
          runProcess: async (_command: string, args: string[]) => {
            expect(args).toContain("libvpx");
            const outputPath = args.at(-1);
            expect(outputPath).toBeDefined();
            writeFileSync(outputPath as string, Buffer.alloc(128));
          },
        },
      ),
    ).resolves.toMatchObject({
      video: "happy-path.webm",
      path: join(outDir, "happy-path.webm"),
      sizeBytes: 128,
    });
    expect(statSync(join(outDir, "happy-path.webm")).size).toBe(128);

    await expect(
      mod.encodeFramesToWebm(
        { outDir, frameDir, frameRate: 10 },
        {
          runProcess: async (_command: string, args: string[]) => {
            const outputPath = args.at(-1);
            expect(outputPath).toBeDefined();
            writeFileSync(outputPath as string, Buffer.alloc(50 * 1024 * 1024 + 1));
          },
        },
      ),
    ).rejects.toThrow(/exceeding the 52428800 byte publish limit/);
    expect(existsSync(join(outDir, "happy-path.webm"))).toBe(false);
  });

  it("cleans failed capture artifacts without removing kept frames", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      cleanupFailedCaptureArtifacts: (options: Record<string, unknown>) => void;
    };
    const outDir = tempOutDir("failed-capture-cleanup-flow");
    const frameDir = join(outDir, ".frames");
    mkdirSync(frameDir, { recursive: true });
    writeFileSync(join(frameDir, "frame-000001.jpg"), "jpeg");
    writeFileSync(join(outDir, "happy-path.webm"), "oversized");

    mod.cleanupFailedCaptureArtifacts({ outDir, frameDir, keepFrames: false });

    expect(existsSync(frameDir)).toBe(false);
    expect(existsSync(join(outDir, "happy-path.webm"))).toBe(false);

    const keptFrameDir = join(outDir, ".kept-frames");
    mkdirSync(keptFrameDir, { recursive: true });
    writeFileSync(join(keptFrameDir, "frame-000001.jpg"), "jpeg");
    writeFileSync(join(outDir, "happy-path.webm"), "oversized");

    mod.cleanupFailedCaptureArtifacts({ outDir, frameDir: keptFrameDir, keepFrames: true });

    expect(existsSync(keptFrameDir)).toBe(true);
    expect(existsSync(join(outDir, "happy-path.webm"))).toBe(false);
  });

  it("accepts optional Playwright storage state without copying it into recorder state", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("auth-flow");
    const storageState = validStorageState();

    await mod.startRecorder(
      {
        outDir,
        storageState,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_2222222222222222",
        launchSidecar: async (config: Record<string, unknown>) => {
          expect(config.storageState).toBe(storageState);
          return {
            pid: process.pid,
            cdpUrl: "ws://localhost:43011/devtools/browser/test",
            controlUrl: "http://localhost:43012",
          };
        },
      },
    );

    const persisted = readFileSync(join(stateRoot, "rec_2222222222222222/state.json"), "utf8");
    expect(persisted).not.toContain("sid");
    expect(persisted).not.toContain("theme");
    expect(JSON.parse(persisted)).toMatchObject({
      cdpUrl: "ws://127.0.0.1:43011/devtools/browser/test",
      controlUrl: "http://127.0.0.1:43012/",
    });
  });

  it("rejects output directories outside /tmp/phase-evidence/operator", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };

    await expect(
      mod.startRecorder(
        {
          outDir: "/tmp/phase-evidence/operator/../escape",
          viewport: { width: 1280, height: 720 },
          maxDurationMs: 45_000,
          frameRate: 10,
        },
        {
          stateRoot: tempStateRoot(),
          recorderId: "rec_3333333333333333",
          launchSidecar: async () => {
            throw new Error("should not launch");
          },
        },
      ),
    ).rejects.toThrow(/--out-dir must stay under/);
  });

  it("rejects missing or invalid storage state before launching the sidecar", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };

    await expect(
      mod.startRecorder(
        {
          outDir: tempOutDir("missing-auth"),
          storageState: "/tmp/cycloid-recorder-missing-state.json",
          viewport: { width: 1280, height: 720 },
          maxDurationMs: 45_000,
          frameRate: 10,
        },
        {
          stateRoot: tempStateRoot(),
          recorderId: "rec_4444444444444444",
          launchSidecar: async () => {
            throw new Error("should not launch");
          },
        },
      ),
    ).rejects.toThrow(/--storage-state is not readable Playwright JSON/);
  });

  it("rejects non-loopback CDP endpoints from the sidecar", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();

    await expect(
      mod.startRecorder(
        {
          outDir: tempOutDir("bad-cdp"),
          viewport: { width: 1280, height: 720 },
          maxDurationMs: 45_000,
          frameRate: 10,
        },
        {
          stateRoot,
          recorderId: "rec_5555555555555555",
          launchSidecar: async () => ({
            pid: process.pid,
            cdpUrl: "ws://0.0.0.0:43001/devtools/browser/test",
            controlUrl: "http://127.0.0.1:43002",
          }),
        },
      ),
    ).rejects.toThrow(/loopback-only/);
    expect(existsSync(join(stateRoot, "rec_5555555555555555/state.json"))).toBe(false);
  });

  it("closes a live recorder and removes local state", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      closeRecorder: (recorderId: string, deps: Record<string, unknown>) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("close-flow");
    let closedUrl: string | undefined;

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_6666666666666666",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43021/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43022",
        }),
      },
    );

    await expect(
      mod.closeRecorder("rec_6666666666666666", {
        stateRoot,
        isProcessAlive: () => true,
        closeSidecar: async (controlUrl: string) => {
          closedUrl = controlUrl;
        },
      }),
    ).resolves.toEqual({
      recorderId: "rec_6666666666666666",
      outDir,
      manifest: join(outDir, "manifest.json"),
    });
    expect(closedUrl).toBe("http://127.0.0.1:43022/");
    expect(existsSync(join(stateRoot, "rec_6666666666666666/state.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "closed",
      stoppedAt: expect.any(String),
      durationMs: expect.any(Number),
    });
  });

  it("rejects unknown and stale recorder ids", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      closeRecorder: (recorderId: string, deps: Record<string, unknown>) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();

    await expect(
      mod.closeRecorder("rec_7777777777777777", {
        stateRoot,
      }),
    ).rejects.toThrow(/Unknown recorder id/);

    await mod.startRecorder(
      {
        outDir: tempOutDir("stale-flow"),
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_8888888888888888",
        launchSidecar: async () => ({
          pid: 999999,
          cdpUrl: "ws://127.0.0.1:43031/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43032",
        }),
      },
    );

    await expect(
      mod.closeRecorder("rec_8888888888888888", {
        stateRoot,
        isProcessAlive: () => false,
      }),
    ).rejects.toThrow(/Recorder is no longer running/);
    expect(existsSync(join(stateRoot, "rec_8888888888888888/state.json"))).toBe(false);
  });

  it("signals the recorder process when a live sidecar rejects close", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      startRecorder: (
        options: Record<string, unknown>,
        deps: Record<string, unknown>,
      ) => Promise<Record<string, string>>;
      closeRecorder: (recorderId: string, deps: Record<string, unknown>) => Promise<Record<string, string>>;
    };
    const stateRoot = tempStateRoot();
    const outDir = tempOutDir("close-retry-flow");
    let killedProcess: { pid: number; signal: string } | null = null;

    await mod.startRecorder(
      {
        outDir,
        viewport: { width: 1280, height: 720 },
        maxDurationMs: 45_000,
        frameRate: 10,
      },
      {
        stateRoot,
        recorderId: "rec_aaaaaaaaaaaaaaaa",
        launchSidecar: async () => ({
          pid: 12345,
          cdpUrl: "ws://127.0.0.1:43041/devtools/browser/test",
          controlUrl: "http://127.0.0.1:43042",
        }),
      },
    );

    await expect(
      mod.closeRecorder("rec_aaaaaaaaaaaaaaaa", {
        stateRoot,
        isProcessAlive: () => true,
        closeSidecar: async () => {
          throw new Error("HTTP 404");
        },
        killProcess: (pid: number, signal: string) => {
          killedProcess = { pid, signal };
        },
      }),
    ).rejects.toThrow(/Recorder could not be closed/);
    expect(killedProcess).toEqual({ pid: 12345, signal: "SIGTERM" });
    expect(existsSync(join(stateRoot, "rec_aaaaaaaaaaaaaaaa/state.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))).toMatchObject({
      lifecycleStatus: "failed",
      lastError: { message: "HTTP 404" },
    });
  });

  it("parses command-specific options and positional shot labels", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      parseArgs: (argv: string[]) => unknown;
    };

    expect(
      mod.parseArgs(["start", "--out-dir", "/tmp/phase-evidence/operator/settings-flow", "--viewport", "1440x900"]),
    ).toMatchObject({
      options: { viewport: { width: 1440, height: 900 } },
    });
    expect(mod.parseArgs(["record", "--id", "rec_123", "--label", "settings happy path"])).toMatchObject({
      command: "record",
      options: { id: "rec_123", label: "settings happy path" },
    });
    expect(mod.parseArgs(["shot", "--id", "rec_123", "settings-saved"])).toMatchObject({
      command: "shot",
      options: { id: "rec_123", label: "settings-saved" },
    });
  });

  it("rejects invalid commands and arguments before any recorder work", async () => {
    const mod = (await import(pathToFileURL(RECORDER).href)) as {
      parseArgs: (argv: string[]) => unknown;
    };

    expect(() => mod.parseArgs(["launch"])).toThrow(/Unknown command: launch/);
    expect(() => mod.parseArgs(["start"])).toThrow(/--out-dir is required/);
    expect(() =>
      mod.parseArgs(["start", "--out-dir", "/tmp/phase-evidence/operator/flow", "--viewport", "wide"]),
    ).toThrow(/--viewport must use WIDTHxHEIGHT/);
    expect(() => mod.parseArgs(["record"])).toThrow(/--id is required/);
    expect(() => mod.parseArgs(["shot", "--id", "rec_123"])).toThrow(/shot requires exactly one screenshot label/);
  });

  it("prints machine-readable failure output in json mode", () => {
    const result = runRecorder(["--json", "unknown"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "invalid_command",
        message: "Unknown command: unknown",
        hint: "Run `cycloid-recorder --help`.",
      },
    });
  });

  it("runs video commands through live recorder state", () => {
    const result = runRecorder(["--json", "record", "--id", "rec_9999999999999999"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "unknown_recorder",
        message: "Unknown recorder id: rec_9999999999999999",
      },
    });
  });
});
