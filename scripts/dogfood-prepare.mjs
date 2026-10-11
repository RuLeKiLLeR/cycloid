#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT_DIR, "apps/control-plane-worker");
const DEV_VARS_PATH = resolve(WORKER_DIR, ".dev.vars");
const READY_PATH = resolve(ROOT_DIR, ".tmp/dogfood-ready.json");

const DOGFOOD_BUSINESS_ID = "dogfood-cycloid";
const DOGFOOD_GITHUB_ID = 900000001;
const DOGFOOD_LOGIN = "cycloid-dogfood";
const AUTH_STATE_PATH = "/tmp/cycloid-auth/dogfood/storage-state.json";

function toolPath(tool) {
  for (const baseDir of [ROOT_DIR, WORKER_DIR]) {
    const path = resolve(baseDir, "node_modules/.bin", tool);
    if (existsSync(path)) return path;
  }
  throw new Error(`${tool} is not installed; run npm ci or bash scripts/worktree-setup.sh first`);
}

function toolEnv() {
  return {
    ...process.env,
    PATH: `${resolve(ROOT_DIR, "node_modules/.bin")}:${resolve(WORKER_DIR, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
  };
}

function parseDevVars(path) {
  const values = new Map();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([^#=\s][^=]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function sqlString(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
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

function execSqlFile(sql) {
  const tmp = resolve(ROOT_DIR, `.tmp/dogfood-prepare-${process.pid}.sql`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, sql);
  try {
    execSqlFileWithRetry(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function execSqlFileWithRetry(path) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execFileSync(toolPath("wrangler"), ["d1", "execute", "DB", "--local", "--file", path], {
        cwd: WORKER_DIR,
        env: toolEnv(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      return;
    } catch (error) {
      if (attempt === maxAttempts || !isSqliteLockError(error)) throw error;
      sleep(250 * attempt);
    }
  }
}

function isSqliteLockError(error) {
  const output = `${error?.message ?? ""}\n${error?.stderr?.toString?.() ?? ""}`;
  return /SQLITE_(BUSY|LOCKED)|database is locked/i.test(output);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runSeedLocal() {
  toolPath("wrangler");
  execFileSync("bash", ["scripts/seed-local.sh"], {
    cwd: WORKER_DIR,
    env: toolEnv(),
    stdio: "inherit",
  });
}

function modelIntegrationSql(provider, apiKey) {
  if (!apiKey) return "";
  return `
INSERT INTO user_integrations (
  user_id, integration_id, oauth_access_token, oauth_refresh_token, oauth_expires_at,
  api_key, external_user_id, service_url, encrypted,
  last_validated_at, last_validation_status, last_validation_reason_code,
  connected_at, updated_at
)
SELECT id, ${sqlString(provider)}, NULL, NULL, NULL,
  ${sqlString(apiKey)}, NULL, NULL, 0,
  unixepoch() * 1000, 'validated', NULL,
  unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = ${DOGFOOD_GITHUB_ID}
ON CONFLICT(user_id, integration_id) DO UPDATE SET
  api_key = excluded.api_key,
  encrypted = excluded.encrypted,
  last_validated_at = excluded.last_validated_at,
  last_validation_status = excluded.last_validation_status,
  last_validation_reason_code = excluded.last_validation_reason_code,
  updated_at = excluded.updated_at;
`;
}

try {
  if (!existsSync(DEV_VARS_PATH)) {
    throw new Error("apps/control-plane-worker/.dev.vars not found; run npm run dev:env first");
  }

  const values = parseDevVars(DEV_VARS_PATH);
  const sessionToken = process.env.DOGFOOD_SESSION_TOKEN?.trim() || randomHex();
  const repos = (process.env.DOGFOOD_REPOS || values.get("DOGFOOD_REPOS") || "trycycloid/cycloid")
    .split(",")
    .map((repo) => repo.trim())
    .filter(Boolean);
  const defaultRepo =
    process.env.DOGFOOD_DEFAULT_REPO || values.get("DOGFOOD_DEFAULT_REPO") || repos[0] || "trycycloid/cycloid";
  const openaiKey = firstValue(values, ["OPENAI_API_KEY", "OPENAI_API_KEY_INTERNAL_REVIEW", "ARCANIST_OPENAI_API_KEY"]);
  const anthropicKey = firstValue(values, ["ANTHROPIC_API_KEY", "ARCANIST_ANTHROPIC_API_KEY"]);

  execSqlFile(`
INSERT OR IGNORE INTO businesses (id, name, shared_sessions, created_at, updated_at)
VALUES (${sqlString(DOGFOOD_BUSINESS_ID)}, 'Cycloid Dogfood', 0, unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO users (github_id, login, name, email, avatar_url, business_id, created_at, updated_at)
VALUES (
  ${DOGFOOD_GITHUB_ID},
  ${sqlString(DOGFOOD_LOGIN)},
  'Cycloid Dogfood',
  'dogfood@trycycloid.com',
  NULL,
  ${sqlString(DOGFOOD_BUSINESS_ID)},
  unixepoch() * 1000,
  unixepoch() * 1000
)
ON CONFLICT(github_id) DO UPDATE SET
  login = excluded.login,
  name = excluded.name,
  email = excluded.email,
  avatar_url = excluded.avatar_url,
  updated_at = excluded.updated_at;

INSERT INTO business_members (business_id, user_id, role, created_at, updated_at)
SELECT ${sqlString(DOGFOOD_BUSINESS_ID)}, id, 'admin', unixepoch() * 1000, unixepoch() * 1000
FROM users
WHERE github_id = ${DOGFOOD_GITHUB_ID}
ON CONFLICT(business_id, user_id) DO UPDATE SET
  role = excluded.role,
  updated_at = excluded.updated_at;

INSERT INTO auth_sessions (token, user_id, expires_at, created_at)
SELECT ${sqlString(sessionToken)}, id, unixepoch() * 1000 + (30 * 24 * 60 * 60 * 1000), unixepoch() * 1000
FROM users
WHERE github_id = ${DOGFOOD_GITHUB_ID}
ON CONFLICT(token) DO UPDATE SET
  user_id = excluded.user_id,
  expires_at = excluded.expires_at;
`);

  runSeedLocal();

  execSqlFile(`
${modelIntegrationSql("openai", openaiKey)}
${modelIntegrationSql("anthropic", anthropicKey)}
`);

  mkdirSync(dirname(READY_PATH), { recursive: true });
  writeFileSync(
    READY_PATH,
    `${JSON.stringify(
      {
        dogfoodLogin: DOGFOOD_LOGIN,
        dogfoodBusinessId: DOGFOOD_BUSINESS_ID,
        dogfoodSessionToken: sessionToken,
        repos,
        defaultRepo,
        authStatePath: AUTH_STATE_PATH,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  console.error("dogfood prepare: ok");
  console.error(`- user: ${DOGFOOD_LOGIN}`);
  console.error(`- repos: ${repos.join(",")}`);
  console.error(`- auth state: ${AUTH_STATE_PATH}`);
} catch (error) {
  console.error("dogfood prepare: failed");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
