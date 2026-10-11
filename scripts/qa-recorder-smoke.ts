import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { classifyE2EArtifactType } from "../apps/sandbox-bridge/src/utils/artifact-classification.js";
import { WEBM_VIDEO_SIZE_LIMIT_BYTES } from "../shared/constants/artifacts.js";
import { stringifyError } from "../shared/utils/errors.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RECORDER = resolve(REPO_ROOT, "apps/sandbox-e2b/cycloid-recorder.mjs");
const OPERATOR_EVIDENCE_ROOT = "/tmp/phase-evidence/operator";

type RecorderStart = {
  recorderId: string;
  cdpUrl: string;
  outDir: string;
};

type RecorderCommandResult = {
  recorderId: string;
  outDir: string;
  path?: string;
  video?: string;
  screenshot?: string;
  manifest?: string;
  frameCount?: number | null;
};

function runRecorder(args: string[]): RecorderStart | RecorderCommandResult {
  const result = spawnSync(process.execPath, [RECORDER, "--json", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `cycloid-recorder ${args.join(" ")} failed with exit ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as RecorderStart | RecorderCommandResult;
}

function runOptional(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assertCondition(address && typeof address !== "string", "Smoke app did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function startSmokeApp() {
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Cycloid recorder smoke</title>
          <style>
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              font-family: system-ui, sans-serif;
              background: #f6f7f9;
              color: #17202a;
            }
            main {
              width: min(520px, calc(100vw - 48px));
              padding: 24px;
              border: 1px solid #d4d9e2;
              border-radius: 8px;
              background: #ffffff;
            }
            label,
            button,
            output {
              display: block;
              margin-top: 16px;
            }
            input,
            button {
              font: inherit;
              min-height: 40px;
            }
            button {
              padding: 0 16px;
              border: 0;
              border-radius: 6px;
              background: #0b6bcb;
              color: white;
            }
            output {
              min-height: 24px;
              color: #0f6b3f;
            }
          </style>
        </head>
        <body>
          <main>
            <h1>Recorder smoke</h1>
            <p>Clicking the button proves Playwright drove the recorder-owned browser.</p>
            <label>
              Private note
              <input id="private-note" type="password" autocomplete="off" />
            </label>
            <button id="save-button" type="button">Save setting</button>
            <output id="status" aria-live="polite">Waiting</output>
          </main>
          <script>
            document.getElementById("save-button").addEventListener("click", () => {
              document.getElementById("status").textContent = "Saved by recorder smoke";
              history.pushState({}, "", "/saved/ghp_1234567890abcdefghijklmnop?token=sk-1234567890abcdefghijklmnopQRSTUV");
            });
          </script>
        </body>
      </html>`);
  });
  return server;
}

function countVideoFrames(videoPath: string, manifestFrameCount: number | null) {
  const ffprobeFrames = runOptional("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    videoPath,
  ]);
  if (ffprobeFrames && Number(ffprobeFrames) > 0) {
    return { frameCount: Number(ffprobeFrames), source: "ffprobe" };
  }
  if (manifestFrameCount !== null && manifestFrameCount > 0) {
    return { frameCount: manifestFrameCount, source: "manifest" };
  }
  throw new Error("Recorded WebM did not report any video frames");
}

async function closeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function main() {
  const server = startSmokeApp();
  const appUrl = await listen(server);
  const scenarioId = `qa-recorder-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outDir = join(OPERATOR_EVIDENCE_ROOT, scenarioId);
  const authDir = mkdtempSync(join(tmpdir(), "qa-recorder-smoke-auth-"));
  const storageStatePath = join(authDir, "state.json");
  const storageStateCookieSecret = "ghp_storage_state_cookie_1234567890";
  const storageStateLocalSecret = "sk-storage-state-local-1234567890abcdefghijkl";
  const typedInputValue = "typed-private-value-7319";
  let recorderId: string | null = null;

  writeFileSync(
    storageStatePath,
    JSON.stringify({
      cookies: [
        {
          name: "qa_recorder_cookie",
          value: storageStateCookieSecret,
          domain: "127.0.0.1",
          path: "/",
        },
      ],
      origins: [
        {
          origin: appUrl,
          localStorage: [{ name: "qa-recorder-local-secret", value: storageStateLocalSecret }],
        },
      ],
    }),
  );

  try {
    const started = runRecorder([
      "start",
      "--out-dir",
      outDir,
      "--storage-state",
      storageStatePath,
      "--viewport",
      "1280x720",
      "--max-duration-ms",
      "15000",
      "--frame-rate",
      "10",
    ]) as RecorderStart;
    recorderId = started.recorderId;

    const browser = await chromium.connectOverCDP(started.cdpUrl);
    try {
      const context = browser.contexts()[0];
      assertCondition(context, "Recorder CDP browser did not expose a Playwright context");
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`${appUrl}/?token=ghp_1234567890abcdefghijklmnop`);
      await page.getByRole("button", { name: "Save setting" }).waitFor();

      const beforeShot = runRecorder(["shot", "--id", recorderId, "before-click"]) as RecorderCommandResult;
      runRecorder(["record", "--id", recorderId, "--label", "button click smoke"]);
      await page.getByLabel("Private note").fill(typedInputValue);
      await page.getByRole("button", { name: "Save setting" }).click();
      await page.getByText("Saved by recorder smoke").waitFor();
      await page.waitForTimeout(1200);
      const afterShot = runRecorder(["shot", "--id", recorderId, "after-click"]) as RecorderCommandResult;
      const stopped = runRecorder([
        "stop",
        "--id",
        recorderId,
        "--label",
        "saved state visible",
      ]) as RecorderCommandResult;
      runRecorder(["close", "--id", recorderId]);
      recorderId = null;

      const videoPath = stopped.path ?? join(outDir, stopped.video ?? "happy-path.webm");
      const videoStats = statSync(videoPath);
      assertCondition(videoStats.size > 0, `Recorded WebM is empty: ${videoPath}`);
      assertCondition(
        videoStats.size < WEBM_VIDEO_SIZE_LIMIT_BYTES,
        `Recorded WebM is ${videoStats.size} bytes, exceeding the 50 MB artifact cap`,
      );

      const manifestPath = join(outDir, "manifest.json");
      const manifestText = readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(manifestText) as {
        video?: string;
        screenshots?: string[];
        redactions?: Record<string, boolean>;
        recording?: { frameCount?: number };
      };
      const frameCheck = countVideoFrames(videoPath, manifest.recording?.frameCount ?? null);

      for (const forbidden of [
        started.cdpUrl,
        storageStateCookieSecret,
        storageStateLocalSecret,
        typedInputValue,
        "ghp_1234567890abcdefghijklmnop",
        "sk-1234567890abcdefghijklmnopQRSTUV",
      ]) {
        assertCondition(!manifestText.includes(forbidden), `Manifest leaked redacted value: ${forbidden}`);
      }
      assertCondition(manifest.redactions?.inputValuesRendered === false, "Manifest redaction flag changed");
      assertCondition(manifest.redactions?.storageStateCopied === false, "Manifest says storage state was copied");
      assertCondition(manifest.redactions?.cdpUrlPublished === false, "Manifest says cdpUrl was published");
      assertCondition(manifest.video === "happy-path.webm", "Manifest did not record the WebM artifact");
      assertCondition(
        Array.isArray(manifest.screenshots) &&
          manifest.screenshots.includes("before-click.png") &&
          manifest.screenshots.includes("after-click.png"),
        "Manifest did not record both proof screenshots",
      );
      assertCondition(classifyE2EArtifactType("happy-path.webm") === "video", ".webm did not classify as video");

      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            appUrl,
            outDir,
            video: videoPath,
            videoBytes: videoStats.size,
            frameCheck,
            screenshots: [beforeShot.path, afterShot.path],
            manifest: manifestPath,
            artifactType: classifyE2EArtifactType("happy-path.webm"),
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await browser.close();
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          outDir,
          manifest: join(outDir, "manifest.json"),
          error: stringifyError(error),
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  } finally {
    if (recorderId) {
      try {
        runRecorder(["close", "--id", recorderId]);
      } catch (error) {
        process.stderr.write(
          `Failed to close recorder ${recorderId}: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    }
    await closeServer(server);
  }
}

await main();
