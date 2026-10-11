#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_VARS_PATH = resolve(ROOT_DIR, "apps/control-plane-worker/.dev.vars");
const DEV_VARS_EXAMPLE_PATH = resolve(ROOT_DIR, "apps/control-plane-worker/.dev.vars.example");
const MAIN_DEV_VARS_PATH = resolveMainDevVarsPath();

const GENERATED_SECRET_KEYS = [
  "TOKEN_ENCRYPTION_KEY",
  "SANDBOX_RUNTIME_CLEANUP_SECRET",
  "ARCANIST_ADMIN_TOKEN",
  "CI_AUTOMATION_TOKEN",
  "BUILD_CALLBACK_SECRET",
  "EVAL_CALLBACK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
];

const ENV_SOURCE_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "E2B_API_KEY",
  "E2B_DOMAIN",
  "NGROK_DOMAIN",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_INTERNAL_REVIEW",
  "ARCANIST_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ARCANIST_ANTHROPIC_API_KEY",
  "DOGFOOD_REPOS",
  "DOGFOOD_DEFAULT_REPO",
  "E2B_REPO_SANDBOX_TEMPLATE",
  "E2B_REPO_SANDBOX_TEMPLATES",
];

function usage(exitCode = 2) {
  console.error(`Usage: node scripts/dev-env.mjs [--mode basic|session|claude]

Materializes apps/control-plane-worker/.dev.vars from runtime env secrets plus
safe local defaults. Defaults to --mode basic.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  let mode = "basic";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--mode" && argv[index + 1]) {
      mode = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["basic", "session", "claude"].includes(mode)) {
    throw new Error("--mode must be one of: basic, session, claude");
  }
  return { mode };
}

function normalizePrivateKey(raw) {
  let key = String(raw || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\n/g, "\n");
  if (!key.includes("\n")) {
    const match = key.match(/^(-----BEGIN [^-]+-----)\s+(.+?)\s+(-----END [^-]+-----)$/);
    if (match) {
      const body = match[2].replace(/\s+/g, "");
      const chunks = body.match(/.{1,64}/g) ?? [];
      key = [match[1], ...chunks, match[3]].join("\n");
    }
  }
  return key.replace(/\n/g, "\\n");
}

function readDevVars(path) {
  if (!existsSync(path)) return { lines: [], values: new Map() };
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const values = new Map();
  for (const line of lines) {
    const match = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return { lines, values };
}

function resolveMainDevVarsPath() {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const mainRepo = resolve(ROOT_DIR, commonDir, "..");
    const mainDevVars = resolve(mainRepo, "apps/control-plane-worker/.dev.vars");
    return mainDevVars === DEV_VARS_PATH ? "" : mainDevVars;
  } catch {
    return "";
  }
}

function upsert(state, key, value) {
  const cleanValue = String(value ?? "").trim();
  if (!cleanValue) return;
  state.values.set(key, cleanValue);
  const prefix = `${key}=`;
  const index = state.lines.findIndex((line) => line.startsWith(prefix));
  if (index >= 0) {
    state.lines[index] = `${key}=${cleanValue}`;
    return;
  }
  if (state.lines.length > 0 && state.lines[state.lines.length - 1] !== "") state.lines.push("");
  state.lines.push(`${key}=${cleanValue}`);
}

function ensureDevVarsFile() {
  if (existsSync(DEV_VARS_PATH)) return;
  if (existsSync(DEV_VARS_EXAMPLE_PATH)) {
    writeFileSync(DEV_VARS_PATH, readFileSync(DEV_VARS_EXAMPLE_PATH, "utf8"), { mode: 0o600 });
    return;
  }
  writeFileSync(DEV_VARS_PATH, "", { mode: 0o600 });
}

function randomHex() {
  return randomBytes(32).toString("hex");
}

function firstValue(values, keys) {
  for (const key of keys) {
    const value = values.get(key)?.trim();
    if (value) return value;
  }
  return "";
}

function requiredChecks(mode, values) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const allowEphemeralNgrok = process.env.ALLOW_EPHEMERAL_NGROK === "1" || values.get("ALLOW_EPHEMERAL_NGROK") === "1";

  if (mode === "basic") return checks;

  add(
    "github.app",
    Boolean(values.get("GITHUB_APP_ID") && values.get("GITHUB_PRIVATE_KEY")),
    "GITHUB_APP_ID/GITHUB_PRIVATE_KEY",
  );
  add("e2b.key", Boolean(values.get("E2B_API_KEY")), "E2B_API_KEY");
  add(
    "ngrok.domain",
    allowEphemeralNgrok || Boolean(values.get("NGROK_DOMAIN")),
    "NGROK_DOMAIN or ALLOW_EPHEMERAL_NGROK=1",
  );
  add(
    "model.openai",
    Boolean(firstValue(values, ["OPENAI_API_KEY", "OPENAI_API_KEY_INTERNAL_REVIEW", "ARCANIST_OPENAI_API_KEY"])),
    "OPENAI_API_KEY or equivalent",
  );

  if (mode === "claude") {
    add(
      "model.anthropic",
      Boolean(firstValue(values, ["ANTHROPIC_API_KEY", "ARCANIST_ANTHROPIC_API_KEY"])),
      "ANTHROPIC_API_KEY or ARCANIST_ANTHROPIC_API_KEY",
    );
  }

  return checks;
}

try {
  const { mode } = parseArgs(process.argv.slice(2));
  ensureDevVarsFile();
  const state = readDevVars(DEV_VARS_PATH);
  const mainState = MAIN_DEV_VARS_PATH ? readDevVars(MAIN_DEV_VARS_PATH) : { values: new Map() };

  upsert(state, "WORKER_ENV", "local");
  upsert(state, "DOGFOOD_REPOS", state.values.get("DOGFOOD_REPOS") || "trycycloid/cycloid");
  upsert(
    state,
    "SANDBOX_CALLBACK_SECRET",
    state.values.get("SANDBOX_CALLBACK_SECRET") || "local-dev-sandbox-callback-secret",
  );
  upsert(
    state,
    "E2B_SANDBOX_TEMPLATE",
    state.values.get("E2B_SANDBOX_TEMPLATE") || `cycloid-sandbox-dev-${process.env.USER || "local"}`,
  );

  for (const key of GENERATED_SECRET_KEYS) {
    upsert(state, key, state.values.get(key) || randomHex());
  }

  for (const key of ENV_SOURCE_KEYS) {
    const value = process.env[key]?.trim() || mainState.values.get(key)?.trim();
    if (!value) continue;
    upsert(state, key, key === "GITHUB_PRIVATE_KEY" ? normalizePrivateKey(value) : value);
  }

  upsert(
    state,
    "DOGFOOD_DEFAULT_REPO",
    state.values.get("DOGFOOD_DEFAULT_REPO") || firstValue(state.values, ["DOGFOOD_REPOS"]).split(",")[0],
  );

  writeFileSync(DEV_VARS_PATH, `${state.lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });

  const checks = requiredChecks(mode, state.values);
  const failed = checks.filter((check) => !check.ok);
  console.error(`dev env: ${failed.length === 0 ? "ok" : "failed"} (${mode})`);
  for (const check of checks) {
    console.error(`- ${check.name}: ${check.ok ? "ok" : "missing"} (${check.detail})`);
  }

  if (failed.length > 0) {
    console.error(`next: provide missing runtime secrets, then rerun npm run dev:env -- --mode ${mode}`);
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
