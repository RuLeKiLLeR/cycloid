import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { normalizeBaseUrl } from "../../../shared/utils/url.js";
import { CliError } from "./errors.js";

export interface CliConfig {
  apiUrl: string;
  token: string;
}

interface CliConfigOverrides {
  apiUrl?: string;
  token?: string;
  json?: boolean;
}

const CONFIG_DIR = join(homedir(), ".cycloid");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const PROJECT_CONFIG_FILE = ".cycloid-cli.json";
const DEFAULT_API_URL = "https://app.trycycloid.com";

function loadFileConfig(): Partial<CliConfig> | null {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<CliConfig>;
  } catch {
    return null;
  }
}

export function loadConfig(overrides: CliConfigOverrides = {}): CliConfig | null {
  const fileConfig = loadFileConfig();
  const completeEnvOrFlagConfig = resolveCompleteEnvOrFlagConfig(overrides);
  if (completeEnvOrFlagConfig) return validateAndNormalizeConfig(completeEnvOrFlagConfig);

  const projectConfig = loadProjectConfig();
  const envOrFlagConfig = resolveEnvOrFlagConfig(overrides, projectConfig !== null);
  const apiUrl = envOrFlagConfig?.apiUrl ?? projectConfig?.apiUrl ?? fileConfig?.apiUrl;
  const token = envOrFlagConfig?.token ?? projectConfig?.token ?? fileConfig?.token;
  if (!apiUrl || !token) return null;

  const config = validateAndNormalizeConfig({ apiUrl, token });
  if (projectConfig && !envOrFlagConfig && !overrides.json) {
    process.stderr.write(`using ${PROJECT_CONFIG_FILE} -> ${config.apiUrl}\n`);
  }
  return config;
}

export function saveConfig(config: CliConfig): void {
  const urlError = validateApiUrl(config.apiUrl);
  if (urlError) throw new CliError("user", urlError);
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...config, apiUrl: normalizeBaseUrl(config.apiUrl) }, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function requireConfig(overrides: CliConfigOverrides): CliConfig {
  const config = loadConfig(overrides);
  if (!config) {
    throw new CliError("auth", "Not logged in.", { hint: "Run `cycloid auth login` or set `ARCANIST_TOKEN`." });
  }
  return config;
}

export function resolveLoginApiUrl(apiUrl?: string): string {
  const raw = apiUrl ?? process.env.ARCANIST_API_URL ?? loadFileConfig()?.apiUrl ?? DEFAULT_API_URL;
  const urlError = validateApiUrl(raw);
  if (urlError) throw new CliError("user", urlError);
  return normalizeBaseUrl(raw);
}

export function loadProjectConfig(cwd = process.cwd()): CliConfig | null {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;

  let current = cwd;
  while (true) {
    const configPath = join(current, PROJECT_CONFIG_FILE);
    if (existsSync(configPath)) return parseProjectConfig(configPath);
    if (current === gitRoot) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function validateApiUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL format";
  }

  if (parsed.username || parsed.password) {
    return "API URL must not include embedded credentials. Use --token or ARCANIST_TOKEN to authenticate.";
  }

  if (parsed.protocol !== "https:" && !isLoopbackHost(parsed)) {
    return "API URL must use HTTPS for non-local hosts";
  }

  return null;
}

function resolveEnvOrFlagConfig(overrides: CliConfigOverrides, projectActive: boolean): Partial<CliConfig> | null {
  const apiUrl = overrides.apiUrl ?? process.env.ARCANIST_API_URL;
  const token = overrides.token ?? process.env.ARCANIST_TOKEN;

  if (!projectActive) {
    if (!apiUrl && !token) return null;
    return { apiUrl, token };
  }

  if ((apiUrl && !token) || (!apiUrl && token)) {
    throw new CliError(
      "user",
      `${PROJECT_CONFIG_FILE} is active; set both ARCANIST_API_URL and ARCANIST_TOKEN, pass both --api-url and --token, or set neither.`,
    );
  }

  if (!apiUrl || !token) return null;
  return { apiUrl, token };
}

function resolveCompleteEnvOrFlagConfig(overrides: CliConfigOverrides): CliConfig | null {
  const apiUrl = overrides.apiUrl ?? process.env.ARCANIST_API_URL;
  const token = overrides.token ?? process.env.ARCANIST_TOKEN;
  if (!apiUrl || !token) return null;
  return { apiUrl, token };
}

function validateAndNormalizeConfig(config: CliConfig): CliConfig {
  const urlError = validateApiUrl(config.apiUrl);
  if (urlError) throw new CliError("user", urlError);
  return { apiUrl: normalizeBaseUrl(config.apiUrl), token: config.token };
}

function findGitRoot(cwd: string): string | null {
  let current = cwd;
  while (true) {
    if (hasGitMetadata(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function hasGitMetadata(repoPath: string): boolean {
  const gitPath = join(repoPath, ".git");
  if (!existsSync(gitPath)) return false;

  try {
    const gitStat = statSync(gitPath);
    if (gitStat.isDirectory()) {
      return existsSync(join(gitPath, "HEAD")) && existsSync(join(gitPath, "config"));
    }

    if (!gitStat.isFile()) return false;

    const gitDir = readGitDirPointer(gitPath);
    if (!gitDir) return false;
    return existsSync(join(resolve(repoPath, gitDir), "HEAD"));
  } catch {
    return false;
  }
}

function readGitDirPointer(gitFilePath: string): string | null {
  const gitDirLine = readFileSync(gitFilePath, "utf-8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("gitdir:"));
  if (!gitDirLine) return null;
  const gitDir = gitDirLine.slice("gitdir:".length).trim();
  return gitDir || null;
}

function parseProjectConfig(configPath: string): CliConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new CliError("user", `${PROJECT_CONFIG_FILE} is not valid JSON.`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CliError("user", `${PROJECT_CONFIG_FILE} must contain both apiUrl and token.`);
  }

  const config = parsed as Partial<CliConfig>;
  if (typeof config.apiUrl !== "string" || typeof config.token !== "string" || !config.apiUrl || !config.token) {
    throw new CliError("user", `${PROJECT_CONFIG_FILE} must contain both apiUrl and token.`);
  }

  let url: URL;
  try {
    url = new URL(config.apiUrl);
  } catch {
    throw new CliError("user", `${PROJECT_CONFIG_FILE} apiUrl must be a valid URL.`);
  }

  if (!isLoopbackHost(url)) {
    throw new CliError("user", `${PROJECT_CONFIG_FILE} apiUrl must be a loopback host.`);
  }

  const urlError = validateApiUrl(config.apiUrl);
  if (urlError) throw new CliError("user", urlError);
  return { apiUrl: normalizeBaseUrl(config.apiUrl), token: config.token };
}

function isLoopbackHost(parsed: URL): boolean {
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
