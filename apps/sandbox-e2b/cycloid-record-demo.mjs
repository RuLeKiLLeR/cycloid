#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { accessSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WEBM_LIMIT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_VIDEO_SIZE = { width: 1280, height: 720 };
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_HOLD_MS = 2_000;
const CHROMIUM_EXECUTABLE_CANDIDATES = [
  "/usr/local/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

function usage() {
  return `Usage: cycloid-record-demo --url <url> --out <path.webm> [--script <scenario.mjs>] [--storage-state <state.json>]

Records one reviewer-friendly WebM with Playwright recordVideo, a 1280x720 viewport,
visible mouse movement helpers, and a 50 MB size cap.

Scenario scripts may export default or run:
  export default async function ({ page, pause, pointAndClick }) {
    await pointAndClick(page.getByRole("button", { name: /Save/i }));
    await pause(2000);
  }`;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    help: false,
    holdMs: DEFAULT_HOLD_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--url") {
      options.url = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      options.out = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--script") {
      options.script = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--storage-state") {
      options.storageState = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = readPositiveInt(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--hold-ms") {
      options.holdMs = readPositiveInt(readValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.help) {
    return options;
  }
  if (!options.url) {
    throw new Error("--url is required");
  }
  if (!options.out) {
    throw new Error("--out is required");
  }
  if (extname(options.out).toLowerCase() !== ".webm") {
    throw new Error("--out must end with .webm");
  }
  if (options.script) {
    accessSync(resolve(options.script), fsConstants.R_OK);
  }
  if (options.storageState) {
    accessSync(resolve(options.storageState), fsConstants.R_OK);
  }

  return options;
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
      if (!candidate || candidate === "playwright") {
        return require(candidate);
      }
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
  throw new Error(`Chromium is required for cycloid-record-demo; checked ${CHROMIUM_EXECUTABLE_CANDIDATES.join(", ")}`);
}

async function loadScenario(scriptPath) {
  if (!scriptPath) {
    return undefined;
  }
  const moduleUrl = pathToFileURL(resolve(scriptPath)).href;
  const mod = await import(moduleUrl);
  const scenario = mod.default ?? mod.run;
  if (typeof scenario !== "function") {
    throw new Error("--script must export a default function or named run function");
  }
  return scenario;
}

async function pause(page, ms = 1_000) {
  await page.waitForTimeout(ms);
}

async function pointAndClick(page, target, options = {}) {
  const locator = typeof target === "string" ? page.locator(target).first() : target;
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Cannot click target because it is not visible");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: options.steps ?? 24 });
  await page.waitForTimeout(options.beforeMs ?? 700);
  await page.mouse.click(x, y);
  await page.waitForTimeout(options.afterMs ?? 1_200);
}

async function copyVideo(page, outputPath) {
  const video = page.video();
  if (!video) {
    throw new Error("Playwright did not produce a video");
  }
  const sourcePath = await video.path();
  mkdirSync(dirname(outputPath), { recursive: true });
  cpSync(sourcePath, outputPath);
  const size = statSync(outputPath).size;
  if (size > WEBM_LIMIT_BYTES) {
    rmSync(outputPath, { force: true });
    throw new Error(`Recorded WebM is ${size} bytes, exceeding the 50 MB Cycloid artifact limit`);
  }
  return size;
}

export async function recordDemo(options) {
  const { chromium } = loadPlaywright();
  const outputPath = resolve(options.out);
  const videoDir = resolve(dirname(outputPath), `.cycloid-record-demo-${process.pid}`);
  rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });

  let browser;
  let context;
  let page;
  try {
    browser = await chromium.launch({
      executablePath: resolveChromiumExecutable(),
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
    context = await browser.newContext({
      ...(options.storageState ? { storageState: resolve(options.storageState) } : {}),
      viewport: DEFAULT_VIDEO_SIZE,
      recordVideo: { dir: videoDir, size: DEFAULT_VIDEO_SIZE },
    });
    page = await context.newPage();
    page.setDefaultTimeout(Math.min(options.timeoutMs, 30_000));

    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);

    const scenario = await loadScenario(options.script);
    if (scenario) {
      await scenario({
        page,
        context,
        url: options.url,
        pause: (ms) => pause(page, ms),
        pointAndClick: (target, clickOptions) => pointAndClick(page, target, clickOptions),
      });
    } else {
      await page.waitForTimeout(options.holdMs);
    }
    await page.waitForTimeout(options.holdMs);
  } finally {
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }

  if (!page) {
    throw new Error("Browser page was not created");
  }
  const size = await copyVideo(page, outputPath);
  rmSync(videoDir, { recursive: true, force: true });
  return { outputPath, size };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await recordDemo(options);
  process.stdout.write(`Recorded ${result.outputPath} (${result.size} bytes)\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
