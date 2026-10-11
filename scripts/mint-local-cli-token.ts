#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeSha256Hex } from "../apps/control-plane-worker/src/crypto";
import { stringifyError } from "../shared/utils/errors.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = resolve(ROOT_DIR, "apps/control-plane-worker");
const LOCAL_TOKEN_PATH = resolve(ROOT_DIR, ".cycloid-local-token");
const PROJECT_CONFIG_PATH = resolve(ROOT_DIR, ".cycloid-cli.json");
const PORTS_PATH = resolve(ROOT_DIR, ".worktree-ports");
const TOKEN_BYTES = 32;
const TOKEN_SCOPE = "write";

interface Options {
  userId: number | null;
  force: boolean;
  writeConfig: boolean;
}

interface D1Result<Row> {
  results?: Row[];
  success?: boolean;
  error?: string;
}

interface UserRow {
  id: number;
}

interface TokenRow {
  id: number;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const token = await mintOrReuseLocalCliToken(options);
  process.stdout.write(`${token}\n`);
}

export async function mintOrReuseLocalCliToken(options: Options): Promise<string> {
  if (!options.force) {
    const cachedToken = readCachedToken();
    if (cachedToken && (await tokenExists(cachedToken))) {
      if (options.writeConfig) writeLocalConfig(cachedToken);
      return cachedToken;
    }
  }

  const userId = options.userId ?? resolveLocalUserId();
  const rawToken = createRawToken();
  const tokenHash = await computeSha256Hex(rawToken);
  const now = Date.now();

  executeD1(
    buildInsertCliTokenSql({
      userId,
      tokenHash,
      tokenPrefix: rawToken.slice(0, 8),
      createdAt: now,
      scope: TOKEN_SCOPE,
    }),
  );

  writeSecretFile(LOCAL_TOKEN_PATH, rawToken);
  if (options.writeConfig) writeLocalConfig(rawToken);
  return rawToken;
}

export function buildInsertCliTokenSql(input: {
  userId: number;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: number;
  scope: "write";
}): string {
  assertPositiveInteger(input.userId, "user_id");
  assertHex(input.tokenHash, "token_hash", 64);
  assertTokenPrefix(input.tokenPrefix);
  assertPositiveInteger(input.createdAt, "created_at");

  return `INSERT INTO cli_tokens (user_id, token_hash, token_prefix, created_at, scope, expires_at) VALUES (${input.userId}, ${sqlString(input.tokenHash)}, ${sqlString(input.tokenPrefix)}, ${input.createdAt}, ${sqlString(input.scope)}, NULL)`;
}

export async function hashLocalCliToken(rawToken: string): Promise<string> {
  return computeSha256Hex(rawToken);
}

function parseArgs(argv: string[]): Options {
  let userId: number | null = null;
  let force = false;
  let writeConfig = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--write-config") {
      writeConfig = true;
      continue;
    }
    if (arg === "--user-id") {
      const value = argv[index + 1];
      if (!value) throw new Error("--user-id requires a value");
      userId = parsePositiveInteger(value, "--user-id");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { userId, force, writeConfig };
}

function readCachedToken(): string | null {
  if (!existsSync(LOCAL_TOKEN_PATH)) return null;
  const token = readFileSync(LOCAL_TOKEN_PATH, "utf8").trim();
  return /^arc_[a-f0-9]{64}$/.test(token) ? token : null;
}

async function tokenExists(rawToken: string): Promise<boolean> {
  const tokenHash = await computeSha256Hex(rawToken);
  const rows = queryD1<TokenRow>(
    `SELECT id FROM cli_tokens WHERE token_hash = ${sqlString(tokenHash)} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${Date.now()}) LIMIT 1`,
  );
  return rows.length > 0;
}

function resolveLocalUserId(): number {
  const githubId = readGithubUserId();
  if (githubId !== null) {
    const githubRows = queryD1<UserRow>(`SELECT id FROM users WHERE github_id = ${githubId} LIMIT 2`);
    if (githubRows.length === 1) return githubRows[0].id;
    if (githubRows.length > 1) throw new Error(`Multiple local users match GitHub id ${githubId}; pass --user-id.`);
    process.stderr.write(`${githubUserFallbackWarning(githubId)}\n`);
  }

  const rows = queryD1<UserRow>("SELECT id FROM users ORDER BY id LIMIT 2");
  if (rows.length === 1) return rows[0].id;
  if (rows.length === 0) throw new Error("No local users found. Run bash scripts/worktree-setup.sh first.");
  throw new Error("Multiple local users found and gh user did not match exactly; pass --user-id.");
}

function readGithubUserId(): number | null {
  try {
    const output = execFileSync("gh", ["api", "user", "--jq", ".id"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) return null;
    return parsePositiveInteger(output, "GitHub user id");
  } catch {
    return null;
  }
}

function queryD1<Row>(sql: string): Row[] {
  const result = executeD1(sql);
  return result.flatMap((entry) => entry.results ?? []) as Row[];
}

function executeD1<Row = unknown>(sql: string): Array<D1Result<Row>> {
  const output = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql], {
    cwd: WORKER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output) as Array<D1Result<Row>>;
  for (const [index, result] of parsed.entries()) {
    if (result.success === false) throw new Error(describeD1Failure(result, index));
  }
  return parsed;
}

export function describeD1Failure(result: D1Result<unknown>, index: number): string {
  const detail = result.error?.trim();
  return detail ? `Local D1 command ${index + 1} failed: ${detail}` : `Local D1 command ${index + 1} failed.`;
}

export function githubUserFallbackWarning(githubId: number): string {
  return `warn: GitHub id ${githubId} not found in local users; falling back to singleton local user check.`;
}

function createRawToken(): string {
  return `arc_${randomBytes(TOKEN_BYTES).toString("hex")}`;
}

function writeLocalConfig(rawToken: string): void {
  const apiPort = readApiPort();
  writeSecretFile(
    PROJECT_CONFIG_PATH,
    `${JSON.stringify({ apiUrl: `http://localhost:${apiPort}`, token: rawToken }, null, 2)}\n`,
  );
}

function readApiPort(): number {
  if (!existsSync(PORTS_PATH)) return 3000;
  const match = /^API_PORT=(\d+)$/m.exec(readFileSync(PORTS_PATH, "utf8"));
  if (!match) throw new Error(".worktree-ports is missing API_PORT.");
  return parsePositiveInteger(match[1], "API_PORT");
}

function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

function assertHex(value: string, name: string, length: number): void {
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(value))
    throw new Error(`${name} must be ${length} lowercase hex chars.`);
}

function assertTokenPrefix(value: string): void {
  if (!/^arc_[a-f0-9]{4}$/.test(value)) throw new Error("token_prefix must match the local CLI token prefix.");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${stringifyError(error)}\n`);
    process.exit(1);
  });
}
